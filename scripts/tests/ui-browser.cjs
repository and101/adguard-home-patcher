// Drive the patched production web interface in Chromium against the official
// AdGuard Home binary: Live Query Log controls and the extra dashboard ranges,
// at desktop and phone widths.
//
// Usage: node ui-browser.cjs <source> <binary> <tag> [screenshot-dir]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { withOfficialServer, waitFor } = require('./querylog-real-api-helpers.cjs');

const source = path.resolve(process.argv[2]);
const binary = path.resolve(process.argv[3]);
const tag = process.argv[4];
const screenshots = process.argv[5] ? path.resolve(process.argv[5]) : '';
const { chromium, expect: baseExpect } = createRequire(path.join(source, 'client_v2/package.json'))('@playwright/test');
const expect = baseExpect.configure({ timeout: 10000 });
const HOUR = 3600000;

const VIEWPORTS = [
    { name: 'desktop', viewport: { width: 1280, height: 900 }, rows: 'query-log-actions-cell' },
    { name: 'mobile-390', viewport: { width: 390, height: 844 }, rows: 'query-log-card' },
];

async function check(environment) {
    const { base, marker, sendQueries, username, password } = environment;
    let sequence = 0;
    const send = count => sendQueries(Array.from({ length: count }, () => `q-${String(++sequence).padStart(4, '0')}.ui.${marker}`));
    await sendQueries([`anchor.ui.${marker}`]);
    await send(40);

    const browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--no-sandbox'],
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    environment.onCleanup(() => browser.close());

    for (const { name, viewport, rows } of VIEWPORTS) {
        const context = await browser.newContext({ viewport, locale: 'en-US' });
        const violations = [];
        const errors = [];
        const requests = [];
        let failLive = 0;
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            // Every response comes from the real binary; only its server clear endpoint and other origins are blocked.
            if (url.origin !== base || url.pathname === '/control/querylog_clear') {
                violations.push(url.href);
                return route.abort();
            }
            if (url.pathname === '/control/querylog' && url.searchParams.get('limit') === '100' && failLive > 0) {
                failLive -= 1;
                return route.fulfill({ status: 503, body: 'temporary query log failure' });
            }
            return route.continue();
        });
        const login = await context.request.post(`${base}/control/login`, { data: { name: username, password } });
        assert.equal(login.status(), 200, 'Disposable browser login');
        await context.addInitScript(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            // Toasts close by themselves, so count every one that is shown.
            window.toastCount = 0;
            const seen = new WeakSet();
            new MutationObserver(() => {
                document.querySelectorAll('[data-testid="toast"]').forEach(toast => {
                    if (!seen.has(toast)) {
                        seen.add(toast);
                        window.toastCount += 1;
                    }
                });
            }).observe(document, { childList: true, subtree: true });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        // A reload aborts in-flight requests, which the interface reports as failed fetches.
        let reloading = false;
        page.on('console', message => {
            if (message.type() === 'error' && !(reloading && message.text().includes('Failed to fetch'))) {
                errors.push(message.text());
            }
        });
        const reload = async () => {
            reloading = true;
            try {
                await page.reload();
            } finally {
                reloading = false;
            }
        };
        page.on('request', request => {
            const url = new URL(request.url());
            if (url.pathname.startsWith('/control/querylog') || url.pathname === '/control/stats') {
                requests.push(url);
            }
        });
        const shot = async label => {
            if (screenshots) await page.screenshot({ path: path.join(screenshots, `${label}-${name}.png`) });
        };
        const noHorizontalOverflow = async label => {
            const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
            assert.ok(overflow <= 0, `${name} ${label}: page scrolls horizontally by ${overflow}px`);
        };
        const liveRequests = () => requests.filter(url => url.pathname === '/control/querylog'
            && url.searchParams.get('limit') === '100');

        // ---- Live Query Log ----
        await page.goto(`${base}/#/logs?search=${marker}`);
        const status = page.getByTestId('query-log-live-status');
        const start = page.getByRole('button', { name: 'Start Live View', exact: true });
        const pause = page.getByRole('button', { name: 'Pause Live View', exact: true });
        const clear = page.getByRole('button', { name: 'Clear view', exact: true });
        const pending = page.getByTestId('query-log-live-pending');
        const visibleRows = page.getByTestId(rows);
        await expect(start).toBeVisible();
        await expect(status).toHaveText('Paused');
        await expect(clear).toHaveCount(0);
        await expect(visibleRows.first()).toBeVisible();
        await noHorizontalOverflow('paused Query Log');
        await shot('query-log-inactive');

        await start.click();
        await expect(status).toHaveText('Live / Synced');
        await expect(pause).toBeVisible();
        await expect(clear).toBeVisible();
        assert.equal(await page.evaluate(() => localStorage.getItem('query_log_live')), 'true');
        for (const url of liveRequests()) {
            assert.equal(url.searchParams.get('search'), marker, 'Live requests keep the search filter');
            assert.ok(!url.searchParams.has('offset'), 'Live requests use server cursors only');
        }

        // New queries appear by themselves while the newest rows are on screen.
        const before = await visibleRows.count();
        await send(3);
        await expect(visibleRows).toHaveCount(before + 3);
        await noHorizontalOverflow('live Query Log');
        await shot('query-log-live');

        // Reading older rows freezes the view and queues arrivals behind "Show newest".
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await page.waitForTimeout(300);
        const frozen = await visibleRows.count();
        const firstRow = await visibleRows.first().textContent();
        await send(2);
        await expect(pending).toHaveText('2 new queries — Show newest');
        await expect(pending).toBeInViewport();
        assert.equal(await visibleRows.count(), frozen, 'Queued arrivals must not change the visible rows');
        assert.equal(await visibleRows.first().textContent(), firstRow);
        // No paused-mode pagination while Live View shows the newest window.
        assert.ok(!requests.some(url => url.pathname === '/control/querylog'
            && url.searchParams.get('limit') !== '100' && url.searchParams.get('older_than')),
        'Live View must not page into older history');
        await noHorizontalOverflow('pending arrivals');
        await shot('query-log-pending');
        await pending.click();
        await expect(pending).toHaveCount(0);
        await expect(visibleRows).toHaveCount(frozen + 2);
        await waitFor('scrolled to the newest rows', async () =>
            assert.ok(await page.evaluate(() => window.scrollY) < 200));

        // Clear view empties only the browser view; later arrivals still appear.
        await clear.click();
        await expect(visibleRows).toHaveCount(0);
        await page.waitForTimeout(1500);
        await expect(visibleRows).toHaveCount(0);
        await send(1);
        await expect(visibleRows).toHaveCount(1);

        // A hidden tab stops polling and resumes when visible again.
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(status).toHaveText('Suspended');
        const hiddenStart = liveRequests().length;
        await page.waitForTimeout(2500);
        assert.equal(liveRequests().length, hiddenStart, 'No polling while the tab is hidden');
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect(status).toHaveText('Live / Synced');

        // A failed request keeps the rows, shows one error and retries after the back-off.
        const toastsBefore = await page.evaluate(() => window.toastCount);
        failLive = 2;
        await expect(status).toHaveText('Reconnecting');
        await expect(visibleRows).toHaveCount(1);
        await expect(status).toHaveText('Live / Synced', { timeout: 15000 });
        assert.equal(await page.evaluate(() => window.toastCount) - toastsBefore, 1, 'One error toast per outage');

        // The preference survives a reload in both directions.
        await pause.click();
        await expect(status).toHaveText('Paused');
        await reload();
        await expect(start).toBeVisible();
        await start.click();
        await reload();
        await expect(status).toHaveText('Live / Synced');
        await pause.click();

        // ---- Dashboard ranges ----
        const statsRecent = () => requests.filter(url => url.pathname === '/control/stats')
            .map(url => url.searchParams.get('recent'));
        await page.goto(`${base}/#/dashboard`);
        // CSS module class names are hashed; the period select is the one showing a period.
        const period = page.getByRole('combobox').filter({ hasText: /^(Last \d+ (hours?|days?)|Today)$/ });
        await expect(period).toBeVisible();
        const choose = async label => {
            await period.click();
            await page.getByRole('option', { name: label, exact: true }).click();
        };
        await period.click();
        for (const label of ['Last 1 hour', 'Last 6 hours', 'Last 12 hours', 'Today', 'Last 24 hours',
            'Last 7 days', 'Custom…']) {
            await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
        }
        // The disposable server keeps statistics for seven days.
        await expect(page.getByRole('option', { name: 'Last 30 days', exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');

        await choose('Last 1 hour');
        await waitFor('1-hour stats request', async () => assert.equal(statsRecent().at(-1), String(HOUR)));
        await expect(period).toContainText('Last 1 hour');
        await shot('dashboard-1h');

        await choose('Today');
        const today = await page.evaluate(hour => {
            const now = new Date();
            const midnight = new Date(now);
            midnight.setHours(0, 0, 0, 0);
            return (Math.floor((now - midnight) / hour) + 1) * hour;
        }, HOUR);
        await waitFor('Today stats request', async () => assert.equal(statsRecent().at(-1), String(today)));
        await reload();
        await expect(period).toContainText('Today');
        await waitFor('Today restored after reload', async () => assert.equal(statsRecent().at(-1), String(today)));

        await choose('Custom…');
        const custom = page.getByTestId('stats-custom-period');
        await expect(custom).toBeVisible();
        const value = custom.locator('input[type="number"]');
        const apply = page.getByTestId('stats-custom-period-apply');
        await value.fill('0');
        await apply.click();
        await expect(page.getByTestId('stats-custom-period-error')).toHaveText('Enter a whole number greater than zero');
        await value.fill('200');
        await apply.click();
        await expect(page.getByTestId('stats-custom-period-error')).toHaveText('Longer than the statistics retention period');
        await noHorizontalOverflow('custom range editor');
        await shot('dashboard-custom-editor');
        await value.fill('13');
        await apply.click();
        await expect(custom).toHaveCount(0);
        await waitFor('custom stats request', async () => assert.equal(statsRecent().at(-1), String(13 * HOUR)));
        await expect(period).toContainText('Last 13 hours');
        await noHorizontalOverflow('dashboard');
        await shot('dashboard-custom');

        assert.deepEqual(violations, [], `${name}: blocked network requests`);
        // The injected 503 responses are logged by the browser and the error toast.
        const unexpected = errors.filter(text => !/status of 503|temporary query log failure/.test(text));
        assert.deepEqual(unexpected, [], `${name}: browser errors`);
        console.log(`UI ${name}: Live Query Log start/arrivals/queue/clear/suspend/retry/persistence and `
            + 'dashboard 1h/Today/Custom ranges verified');
        await context.close();
    }
}

(async () => {
    if (screenshots) await fs.mkdir(screenshots, { recursive: true });
    await withOfficialServer(source, binary, tag, check, config => {
        config.statistics.interval = '168h';
    });
})().catch(error => { console.error(error); process.exitCode = 1; });
