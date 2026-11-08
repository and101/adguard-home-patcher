# Live Query Log controls

Click **Start Live View** to start polling. The button turns into **Pause Live View**, and a **Clear view** button appears next to it. Clear view only empties the table in your browser; the server's Query Log isn't touched.

If you've scrolled down to older rows, new queries are held back behind a "17 new queries — Show newest" bar. Clicking it shows them and jumps back to the top.

The screenshots below were taken from the production build using the browser test harness with fixed sample data (blocked queries for `google.com`). Desktop is 1440×900 and mobile 390×844; the tests also cover 320×740.

## How live polling works

Live View polls about once a second, waiting for each request to finish before starting the next. Each poll fetches the newest 100 entries with your current filters, then keeps reading older pages until it finds the entries it saw last time.

It also re-reads a short window behind that point: the last 3 seconds, or 500 entries, whichever comes first. AdGuard Home can make an entry visible slightly after newer ones. When it saves its memory buffer to disk, entries vanish from memory a moment before they reach the file, and concurrent queries can be stored a few microseconds out of order. Re-reading the window picks up those late entries and puts them in the right place. Entries already shown are matched by their contents and count, so nothing appears twice.

The first poll after you start (or change filters) just sets a baseline; it doesn't load history. Pausing, switching tabs, going offline or a failed request doesn't lose your place. Hidden or offline tabs stop polling and catch up when they come back. After an error it waits five seconds before retrying, and shows at most one error toast per outage. The checkpoint is kept in memory only, so reloading the page starts fresh.

Catching up is capped at 20 requests of 100 entries and 5 seconds per cycle. If it hits that limit, or the previous checkpoint has disappeared from the server, it shows a **Gap detected** warning and carries on from the newest page instead of retrying the same backfill. A checkpoint that is missing for a single poll is retried once first, since a disk flush can hide it briefly. The warning stays until you change filters or start a new session.

The table keeps at most 500 displayed rows and 500 queued rows.

## Status indicator

- **Live / Synced:** caught up, no known gaps.
- **Catching up:** starting, resuming or fetching extra pages.
- **Reconnecting:** requests are failing or the browser is offline.
- **Suspended:** the tab is hidden.
- **Gap detected:** continuity couldn't be confirmed. Shown alongside the other states.
- **Paused:** Live View is off. Normal history paging still works.

The indicator is an ARIA live region, so screen readers announce changes.

**Clear view** cancels the current poll, removes the rows from the table and hides anything at or older than the newest entry already seen. It never calls the server's clear endpoint.

## What can still be missed

AdGuard Home's [Query Log API](https://github.com/AdguardTeam/AdGuardHome/blob/v0.107.79/openapi/openapi.yaml#L190-L255) has no unique event ID or snapshot token, so the browser can't *prove* it saw every event; it can only check overlap. In normal operation the late window closes the known holes, and the release build tests this by polling continuously against the official binary while it repeatedly flushes its buffer to disk.

These cases still can't be recovered, and show a gap warning when they're detectable:

- History removed on the server: clearing the log, retention expiring, or turning the log off.
- A tab that stays hidden or offline for longer than the server keeps history, or a backlog larger than one cycle's budget.
- Changes to the server clock that move timestamps by more than the window.
- A full page that ends in several entries sharing one timestamp. The API's `older_than` cursor is exclusive and must be a timestamp the server returned, so more entries at that timestamp could be hidden. AdGuard Home records nanosecond timestamps, so this is very unlikely.

Entries that are completely identical, down to the nanosecond, are counted correctly but can't be told apart.

Everything here lives in the frontend patch. The AdGuard Home binary, DNS handling and stored history are unchanged.

## Desktop, inactive

![Desktop Query Log with Start Live View](query-log-desktop-inactive.png)

## Desktop, live

![Desktop Query Log with Pause Live View and Clear view](query-log-desktop-live.png)

## Mobile, inactive

<img src="query-log-mobile-390-inactive.png" alt="Mobile Query Log with Start Live View" width="390">

## Mobile, live

<img src="query-log-mobile-390-live.png" alt="Mobile Query Log with Pause Live View and Clear view on one row" width="390">

## Mobile, queued queries

<img src="query-log-mobile-390-pending.png" alt="Mobile Query Log scrolled down with a bar showing 17 new queries" width="390">
