# AlphaView / Ricky's Investment sync notes

## Holdings prices
- `holdings.json` and `data/snap_a7f3e9c2.json` must stay identical.
- On every sync (daily routine **and** on-demand refresh), pull live positions from **Futu** (`account_positions` + funds) and **IBKR** (`get_account_positions` + balances).
- Always rewrite `seedPrice` / `seedMv` / `seedPl` / `seedTodayPl` from broker data **even when portfolio composition is unchanged**.
- The static GitHub Pages site cannot call Futu/IBKR MCP from the browser. Freshness = last successful sync before the user opens the page, or the last on-demand sync they triggered from the page.
- `app.js` uses broker snapshot prices on page load for holdings P&L. Yahoo/Tencent are soft fallback only when `seedPrice` is missing (e.g. crypto). TradingView widgets remain live for indices / calendar / earnings. Auto Yahoo polling stays off.

## On-demand sync (page icon)
- The refresh icon（accessible name「更新券商持倉」）does **not** call Futu/IBKR itself. It POSTs Ricky's webhook for the **AlphaView on-demand sync** routine (`mode: 'cors'`, sender key in the configured header).
- Config resolution: `localStorage` key `alphaview.syncTrigger` (set once in the in-page modal), then optional gitignored `data/sync-trigger.json`. Shape: `data/sync-trigger.example.json`. No real key is committed.
- First click with no config opens a zh-HK modal. Cancel does nothing. The gear (or a long-press / right-click on the icon) reopens it so the URL and key can be replaced or cleared.
- After the webhook returns, the page polls `data/snap_a7f3e9c2.json?t=` until `syncedAt` / `syncedAtISO` changes, or about 140s. It then reloads the snap and runs `applyBrokerSnapshotQuotes()` (same path as a snapshot reload, including the soft fallback for names missing `seedPrice`).
- If the webhook is OK but the snap never changes, the status shows「逾時：後台可能仍在同步，請稍後再按」and still does one final snap reload.
- The webhook host must allow browser POSTs from `https://lawloktai-netizen.github.io`. If the preflight fails, the icon shows a cross-origin error. A CORS-friendly proxy can be dropped in later by changing the saved URL; the page does not call the brokers directly.
- The daily morning routine is unchanged. On-demand is extra: site icon → webhook routine → push snap to `main` → page poll.

## Routine prompt reminder
Update the `daily-alphaview-portfolio-sync` routine so it always refreshes broker prices on each run, not only when qty/cost composition changes.
