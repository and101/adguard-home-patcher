// Real DNS -> unchanged official binary -> HTTP Query Log -> production recovery helper/UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { withOfficialServer, loadProductionRecovery, waitFor } = require('./querylog-real-api-helpers.cjs');

const source = path.resolve(process.argv[2]);
const binary = path.resolve(process.argv[3]);
const tag = process.argv[4];

async function check(environment) {
    const { base, marker, request, sendQueries, directory } = environment;
    const production = await loadProductionRecovery(source, directory);
    const { recoverLiveLogs, compareTimes, normalizeLogs, LIVE_LOG_RECOVERY_MAX_PAGES,
        LIVE_LOG_RECOVERY_MAX_DURATION_MS, LIVE_LOG_LATE_WINDOW_ROWS } = production;
    const budgetRows = LIVE_LOG_RECOVERY_MAX_PAGES * 100;
    // AdGuard Home's file search seeks the exact stored timestamp given as older_than, so the helper
    // must only send cursors the server returned. A synthetic cursor silently skips file-backed rows.
    const serverCursor = (returned, cursor) => assert.ok(cursor === undefined || returned.has(cursor),
        `Recovery sent a cursor the server never returned: ${cursor}`);
    const names = rows => rows.map(row => row.question.name.replace(/\.$/, ''));
    const ordered = rows => {
        for (let index = 1; index < rows.length; index += 1) {
            assert.ok(compareTimes(rows[index - 1].time, rows[index].time) > 0,
                `Expected strictly descending real timestamps: ${rows[index - 1].time}, ${rows[index].time}`);
        }
    };
    const queryPage = async (search, olderThan, signal, responseStatus = 'all') => {
        const params = new URLSearchParams({ limit: '100', search, response_status: responseStatus });
        if (olderThan !== undefined) params.set('older_than', olderThan);
        assert.equal(params.has('offset'), false);
        const response = await (await request(`/control/querylog?${params}`, { signal })).json();
        assert.ok(Array.isArray(response.data));
        assert.ok(response.data.length <= 100);
        assert.equal(typeof response.oldest, 'string');
        for (const row of response.data) {
            assert.ok(row.question.name.includes(search), `Filter leaked ${row.question.name}`);
            assert.equal(row.status, 'NOERROR');
            assert.match(row.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/);
            if (olderThan) assert.ok(compareTimes(row.time, olderThan) < 0, 'older_than must be strictly exclusive');
        }
        ordered(response.data);
        if (response.data.length) {
            assert.equal(response.oldest, response.data.at(-1).time,
                'Nonempty page cursor must preserve the oldest returned timestamp byte-for-byte');
        }
        if (olderThan && response.oldest) {
            assert.ok(compareTimes(response.oldest, olderThan) < 0, 'Cursor must advance strictly backwards');
        }
        return response;
    };
    const collect = async (search, responseStatus = 'all') => {
        const pages = [];
        const rows = [];
        let cursor;
        for (let index = 0; index < 40; index += 1) {
            const page = await queryPage(search, cursor, undefined, responseStatus);
            pages.push({ size: page.data.length, requested: cursor, oldest: page.oldest });
            rows.push(...page.data);
            if (!page.oldest) {
                assert.equal(new Set(names(rows)).size, rows.length, 'Real cursor pages duplicated a domain');
                ordered(rows);
                return { rows, pages };
            }
            // Preserve the server's complete RFC3339Nano string without Date/ISO conversion.
            cursor = page.oldest;
        }
        assert.fail(`Real API did not exhaust within 40 pages: ${JSON.stringify(pages)}`);
    };
    const expectDomains = (rows, expected) => {
        const actual = new Set(names(rows));
        const missing = expected.filter(name => !actual.has(name));
        assert.equal(missing.length, 0,
            `Only ${actual.size}/${expected.length} expected DNS records visible; missing ${missing.slice(0, 8).join(', ')}`);
        assert.equal(actual.size, expected.length, 'Unexpected or duplicated matching queries');
    };
    const awaitRecords = async expected => waitFor(`${expected.length} real Query Log records`, async () => {
        const result = await collect(marker);
        expectDomains(result.rows, expected);
        return result;
    });
    const recovery = async (checkpoint, options = {}, responseStatus = 'all') => {
        const calls = [];
        const original = structuredClone(checkpoint);
        const signal = AbortSignal.timeout(LIVE_LOG_RECOVERY_MAX_DURATION_MS);
        const returned = new Set();
        const result = await recoverLiveLogs(async cursor => {
            calls.push(cursor);
            serverCursor(returned, cursor);
            const page = await queryPage(marker, cursor, signal, responseStatus);
            returned.add(page.oldest);
            return { logs: normalizeLogs(page.data), oldest: page.oldest };
        }, checkpoint, { ...options, signal });
        assert.equal(result.error, undefined, `Recovery API error: ${result.error}`);
        assert.deepEqual(checkpoint, original, 'Recovery must not mutate its input checkpoint');
        return { result, calls };
    };

    // Retain the existing official-binary static frontend and recent-stats smoke assertions.
    const index = await fs.readFile(path.join(source, 'build/static/index.html'), 'utf8');
    const mainScript = index.match(/main\.[a-f0-9]+\.js/)[0];
    assert.ok((await (await request('/')).text()).includes(mainScript));
    assert.equal(typeof (await (await request('/control/stats?recent=3600000')).json()).num_dns_queries, 'number');

    const anchor = `anchor.${marker}`;
    await sendQueries([anchor]);
    await awaitRecords([anchor]);
    const initial = await recovery(null);
    assert.equal(initial.calls.length, 1);
    assert.equal(initial.result.gap, false);
    assert.equal(initial.result.logs[0].domain, anchor);
    const checkpoint = initial.result.checkpoint;
    const rewrittenBaseline = await recovery(null, {}, 'rewritten');
    assert.deepEqual(rewrittenBaseline.result, initial.result,
        'The supported rewritten filter must include the genuine rewrite checkpoint');

    // The browser, when enabled by the existing gate, talks directly to the same official API.
    let browser;
    let closingBrowser;
    const closeBrowser = () => browser && (closingBrowser ||= browser.close());
    let page;
    let syncStatus;
    const uiRequests = [];
    const uiViolations = [];
    const uiErrors = [];
    try {
        if (process.env.BROWSER_TEST === '1') {
            const upstreamRequire = createRequire(path.join(source, 'client/package.json'));
            const { chromium, expect } = upstreamRequire('@playwright/test');
            browser = await chromium.launch({
                executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
                args: ['--no-sandbox'],
                // The environment owns signal/watchdog cleanup, including this browser.
                handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
            });
            environment.onCleanup(closeBrowser);
            const context = await browser.newContext({ locale: 'en-US' });
            // Network guard only: every permitted API response comes from the real binary.
            await context.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== base || url.pathname === '/control/querylog_clear') {
                    uiViolations.push(url.href);
                    return route.abort();
                }
                return route.continue();
            });
            const login = await context.request.post(`${base}/control/login`, {
                data: { name: environment.username, password: environment.password },
            });
            assert.equal(login.status(), 200, 'Disposable browser login');
            page = await context.newPage();
            page.setDefaultTimeout(10000);
            page.on('pageerror', error => uiErrors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') uiErrors.push(message.text()); });
            page.on('request', request => {
                const url = new URL(request.url());

                if (url.pathname === '/control/querylog' && url.searchParams.get('limit') === '100') {
                    if (url.searchParams.get('search') !== marker
                        || url.searchParams.get('response_status') !== 'all' || url.searchParams.has('offset')) {
                        uiViolations.push(url.href);
                    }
                    uiRequests.push(url.searchParams.get('older_than'));
                }
            });
            await page.goto(`${base}/#logs?search=${marker}&response_status=all`);
            await page.bringToFront();
            await expect(page.getByRole('button', { name: 'Start Live View', exact: true })).toBeVisible();
            await page.waitForLoadState('networkidle');
            await page.clock.install();
            await page.clock.pauseAt(new Date(Date.now() + 100));
            await page.getByRole('button', { name: 'Start Live View', exact: true }).press('Enter');
            await page.clock.runFor(1000);
            syncStatus = page.locator('.logs__sync-status[role="status"]');
            await expect(syncStatus).toHaveText('Live / Synced');
            assert.equal(uiRequests.length, 1);
        }

        const burst = Array.from({ length: 251 }, (_, index) =>
            `test-${String(index + 1).padStart(4, '0')}.burst.${marker}`);
        await sendQueries(burst);
        const normal = await awaitRecords([anchor, ...burst]);
        // Verify memory + file reads (64-entry buffer), without reading or inserting log records.
        const diskLog = await fs.stat(path.join(directory, 'data/querylog.json'));
        assert.ok(diskLog.size > 0, 'Generated traffic must exercise file-backed query-log reads');
        const pagination = await collect(`burst.${marker}`);
        expectDomains(pagination.rows, burst);
        assert.deepEqual(pagination.pages.map(item => item.size), [100, 100, 51, 0]);
        assert.deepEqual(names(pagination.rows), [...burst].reverse(), 'Newest matching queries must appear first');
        assert.ok(pagination.rows.some(row => /\.\d{4,9}(?:Z|[+-]\d\d:\d\d)$/.test(row.time)), 'Sub-millisecond API precision retained');
        const boundary = pagination.rows[99];
        const afterBoundary = await queryPage(`burst.${marker}`, boundary.time);
        assert.ok(!names(afterBoundary.data).includes(boundary.question.name), 'Exact timestamp excludes its boundary record');
        assert.equal(afterBoundary.data[0].question.name, pagination.rows[100].question.name);
        console.log(`Real pagination (251 DNS queries): ${JSON.stringify(pagination.pages)}`);

        // Exercise effective status filtering, not just the no-op "all" parameter.
        // The same real records must paginate identically with rewritten, while
        // blocked must exclude them. All cursor requests retain both filters.
        const rewritten = await collect(`burst.${marker}`, 'rewritten');
        assert.deepEqual(rewritten, pagination, 'Status-filtered pagination must retain every rewrite');
        const blocked = await collect(`burst.${marker}`, 'blocked');
        assert.deepEqual(blocked.rows, [], 'Rewrite traffic must not leak through the blocked filter');
        assert.equal(blocked.pages.at(-1).oldest, '');

        const caughtUp = await recovery(checkpoint);
        assert.equal(caughtUp.result.gap, false, `Unexpected recovery gap: ${caughtUp.result.reason}`);
        // The third page holds the anchor. Nothing older exists for this marker, so the late-arrival
        // window is only covered by reading on to the empty final page.
        assert.deepEqual(caughtUp.calls, normal.pages.map(item => item.requested));
        assert.deepEqual(caughtUp.result.logs.map(row => row.domain), [...burst].reverse().concat(anchor));
        assert.equal(new Set(caughtUp.result.logs.map(row => row.liveKey)).size, 252);
        assert.equal(caughtUp.result.checkpoint.time, normal.rows[0].time);
        assert.notEqual(caughtUp.result.checkpoint.time, checkpoint.time);
        console.log('Production recovery: 251/251 new queries + previous checkpoint, 4 pages, ordered/deduplicated, no gap');

        const filteredCatchUp = await recovery(rewrittenBaseline.result.checkpoint, {}, 'rewritten');
        assert.deepEqual(filteredCatchUp, caughtUp, 'Production catch-up must preserve the effective status filter');
        console.log('Real status filters: rewritten -> 100,100,51,0; blocked -> 0; filtered recovery -> 251/251');

        // Reuse the same dataset to test a deliberately smaller recovery budget, independently of the
        // later production-budget overflow. The late window is off so only the budget is exercised.
        const reducedBudget = await recovery(checkpoint, { maxPages: 2, lateWindowMs: 0 });
        assert.deepEqual(reducedBudget.calls, caughtUp.calls.slice(0, 2));
        assert.equal(reducedBudget.result.reason, 'page-budget');
        assert.equal(reducedBudget.result.gap, true, 'A missing checkpoint must never claim continuity');
        assert.deepEqual(reducedBudget.result.logs.map(row => row.domain), [...burst].reverse().slice(0, 200));
        assert.deepEqual(reducedBudget.result.checkpoint, caughtUp.result.checkpoint,
            'Incomplete recovery must rebase to the newest observed checkpoint');
        const reducedRebase = await recovery(reducedBudget.result.checkpoint, { maxPages: 2, lateWindowMs: 0 });
        assert.equal(reducedRebase.calls.length, 1, 'Reduced-budget gap must not repeat historical backfill');
        assert.equal(reducedRebase.result.gap, false);
        assert.deepEqual(reducedRebase.result.checkpoint, reducedBudget.result.checkpoint);
        console.log('Reduced recovery budget: exactly 2 pages / 200 rows -> page-budget gap -> 1-page rebase');

        if (page) {
            const { expect } = createRequire(path.join(source, 'client/package.json'))('@playwright/test');
            const start = uiRequests.length;
            await page.clock.runFor(1000);
            await expect(syncStatus).toHaveText('Live / Synced');
            await expect(page.getByTestId('querylog_cell')).toHaveCount(252);
            assert.equal(uiRequests.length - start, 4);
        }

        const overflow = Array.from({ length: budgetRows + 120 }, (_, index) =>
            `overflow-${String(index + 1).padStart(4, '0')}.${marker}`);
        await sendQueries(overflow);
        const expected = [anchor, ...burst, ...overflow];
        const beforeGap = await awaitRecords(expected);
        const limited = await recovery(caughtUp.result.checkpoint);
        assert.equal(limited.calls.length, LIVE_LOG_RECOVERY_MAX_PAGES);
        assert.equal(limited.result.logs.length, budgetRows);
        assert.equal(limited.result.gap, true);
        assert.equal(limited.result.reason, 'page-budget');
        const next = await recovery(limited.result.checkpoint);
        // The checkpoint is on the first page; only the bounded late window is re-read behind it.
        const windowPages = Math.ceil((LIVE_LOG_LATE_WINDOW_ROWS + 1) / 100) + 1;
        assert.ok(next.calls.length <= windowPages, `Rebased polling read ${next.calls.length} pages`);
        assert.equal(next.result.gap, false, 'New overlap is observable; prior gap remains a lifecycle/UI warning');
        if (page) {
            const { expect } = createRequire(path.join(source, 'client/package.json'))('@playwright/test');
            const start = uiRequests.length;
            await page.clock.runFor(1000);
            await expect(syncStatus).toContainText('Gap detected');
            assert.equal(uiRequests.length - start, LIVE_LOG_RECOVERY_MAX_PAGES);
            await expect(page.getByTestId('querylog_cell')).toHaveCount(500);
            const rebaseStart = uiRequests.length;
            const rebaseResponse = page.waitForResponse(response => {
                const url = new URL(response.url());
                return url.pathname === '/control/querylog' && url.searchParams.get('limit') === '100'
                    && !url.searchParams.has('older_than');
            });
            // Availability triggers an observable Catching up -> Gap transition.
            // The final gap-only status then proves this recovery cycle finished,
            // rather than merely observing the warning from the preceding cycle.
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            await expect(syncStatus).toContainText('Catching up');
            await page.clock.runFor(1);
            const response = await rebaseResponse;
            assert.equal(response.status(), 200, 'Rebased UI poll must succeed');
            assert.equal(await response.finished(), null, 'Rebased UI response must finish successfully');
            await expect(syncStatus).toHaveText('Gap detected — some queries may not have been recovered.');
            const rebaseRequests = uiRequests.length - rebaseStart;
            assert.ok(rebaseRequests >= 1 && rebaseRequests <= windowPages,
                `Completed rebased UI cycle must not repeat the backfill (${rebaseRequests} requests)`);
            console.log('Real-API production UI: Synced after 251 arrivals; sticky Gap after budget overflow; '
                + `rebased poll ${rebaseRequests} page(s)`);
        } else {
            console.log('Real-API browser scenario not requested (BROWSER_TEST != 1); DNS/API/helper checks executed');
        }
        assert.deepEqual(uiViolations, [], 'Browser network/filter/clear constraints');
        assert.deepEqual(uiErrors, [], 'Production UI errors');
        const afterGap = await collect(marker);
        expectDomains(afterGap.rows, expected);
        assert.deepEqual(afterGap.rows.map(row => [row.question.name, row.time]),
            beforeGap.rows.map(row => [row.question.name, row.time]), 'Recovery must leave server history unchanged');
        console.log(`Real DNS integration passed: ${expected.length}/${expected.length} genuine queries verified; `
            + 'page budget -> explicit gap -> bounded rebase; server history unchanged');

        // Poll continuously with the production helper while queries arrive and the 64-entry memory
        // buffer is flushed to disk again and again. Every query must be observed, with no gap.
        const stream = async (label, lateWindowMs) => {
            const search = `${label}.stream.${marker}`;
            const domains = Array.from({ length: 1200 }, (_, index) => `q-${String(index + 1).padStart(4, '0')}.${search}`);
            const seen = new Set();
            const gaps = [];
            let current = null;
            let polls = 0;
            const poll = async () => {
                const returned = new Set();
                const result = await recoverLiveLogs(async cursor => {
                    serverCursor(returned, cursor);
                    const response = await queryPage(search, cursor);
                    returned.add(response.oldest);
                    return { logs: normalizeLogs(response.data), oldest: response.oldest };
                }, current, { lateWindowMs });
                assert.equal(result.error, undefined, `Streaming recovery API error: ${result.error}`);
                if (result.gap) gaps.push(result.reason);
                result.logs.forEach(row => seen.add(row.domain));
                current = result.checkpoint;
                polls += 1;
            };
            await poll();
            let sending = true;
            const sender = sendQueries(domains).finally(() => { sending = false; });
            while (sending) {
                await poll();
                await delay(2);
            }
            await sender;
            await waitFor(`${domains.length} streamed records`, async () => {
                const all = await collect(search);
                assert.equal(all.rows.length, domains.length);
            });
            await poll();
            return { missing: domains.filter(domain => !seen.has(domain)), gaps, polls };
        };
        const withoutWindow = await stream('plain', 0);
        console.log(`Streaming without late window: ${withoutWindow.missing.length} missed, `
            + `gaps ${JSON.stringify(withoutWindow.gaps)}, ${withoutWindow.polls} polls (informational)`);
        const withWindow = await stream('late', undefined);
        assert.deepEqual(withWindow.missing, [], 'Live polling missed queries');
        assert.deepEqual(withWindow.gaps, [], 'Live polling reported a gap during steady traffic');
        console.log(`Streaming with production late window: 1200/1200 observed, no gap, ${withWindow.polls} polls`);
    } catch (error) {
        if (page) console.error('Real-API browser diagnostics:', {
            url: page.url(), body: (await page.locator('body').textContent()).slice(0, 4000), uiRequests, uiViolations, uiErrors,
        });
        throw error;
    } finally {
        await closeBrowser();
    }
}

withOfficialServer(source, binary, tag, check).catch(error => { console.error(error); process.exitCode = 1; });
