# AlphaView / Ricky's Investment sync notes

## Holdings prices
- `holdings.json` and `data/snap_a7f3e9c2.json` must stay identical.
- On every sync (daily routine **and** on-demand refresh), pull live positions from **Futu** (`account_positions` + funds) and **IBKR** (`get_account_positions` + balances).
- Always rewrite `seedPrice` / `seedMv` / `seedPl` / `seedTodayPl` from broker data **even when portfolio composition is unchanged**.
- The static GitHub Pages site cannot call Futu/IBKR MCP from the browser. Freshness = the last snap published to `main`. The refresh icon only reloads that file. A live Futu/IB pull is started by saying「同步」in the **Publish To Web** chat, or by the daily morning routine.
- `app.js` uses broker snapshot prices on page load for holdings P&L. Yahoo/Tencent are soft fallback only when `seedPrice` is missing (e.g. crypto). TradingView widgets remain live for indices / calendar / earnings. Auto Yahoo polling stays off.

## Refresh icon (published snapshot)
- The round refresh icon（accessible name「更新券商持倉」）does **not** call Futu/IBKR and does **not** require a webhook or `localStorage` config.
- A click cache-busts `data/snap_a7f3e9c2.json?t=` and runs the same snapshot reload path as before: `applySnapPayload()`, then `applyBrokerSnapshotQuotes()` (including the soft fallback for names missing `seedPrice`). It does not start Yahoo auto polling.
- Brief status next to the icon:「已載入快照」plus the snap's sync time (`syncedAt`). The existing「持倉券商快照 · 同步 …」line keeps that time after the brief status clears.
- A short dismissible zh-HK hint (not a blocking modal) says: 靜態網站唔可以直連券商；撳呢度會載入最新已發布快照。要即時拉富途／IB，喺 **Publish To Web** chat 講「同步」。Dismissal is remembered in `localStorage` key `alphaview.snapHintDismissed`.

## Optional advanced webhook
- Gear, long-press, or right-click on the round icon opens a panel. It explains the chat「同步」path and can store a URL + sender key if one is ever available. It never gates the main icon.
- The mobile routine panel often shows only “When a webhook fires” and no copyable URL or sender key, so webhook setup is optional and easy to skip.
- Config resolution, only when that panel's「用 Webhook 觸發」is used: `localStorage` key `alphaview.syncTrigger`, then optional gitignored `data/sync-trigger.json`. Shape: `data/sync-trigger.example.json`. No real key is committed.
- That optional action POSTs the saved webhook (`mode: 'cors'`, sender key in the configured header), then polls `data/snap_a7f3e9c2.json?t=` until `syncedAt` / `syncedAtISO` changes, or about 140s, and reloads via `applyBrokerSnapshotQuotes()`.
- If the webhook is OK but the snap never changes, the status shows「逾時：後台可能仍在同步，請稍後再按」and still does one final snap reload.
- The webhook host must allow browser POSTs from `https://lawloktai-netizen.github.io`. If the preflight fails, the icon shows a cross-origin error. A CORS-friendly proxy can be dropped in later by changing the saved URL; the page does not call the brokers directly.
- The daily morning routine is unchanged. Live freshness: chat「同步」(or the morning routine) pushes a new snap to `main`, then the round icon loads it.

## Routine prompt reminder
Update the `daily-alphaview-portfolio-sync` routine so it always refreshes broker prices on each run, not only when qty/cost composition changes.
