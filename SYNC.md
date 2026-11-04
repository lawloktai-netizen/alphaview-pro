# AlphaView / Ricky's Investment sync notes

## Holdings prices
- `holdings.json` and `data/snap_a7f3e9c2.json` must stay identical.
- On every sync (daily routine **and** on-demand refresh), pull live positions from **Futu** (`account_positions` + funds) and **IBKR** (`get_account_positions` + balances).
- Always rewrite `seedPrice` / `seedMv` / `seedPl` / `seedTodayPl` from broker data **even when portfolio composition is unchanged**.
- The static GitHub Pages site cannot call Futu/IBKR MCP from the browser. Freshness = last successful sync before the user opens the page.
- `app.js` uses broker snapshot prices on page load for holdings P&L. Yahoo/Tencent are soft fallback only when `seedPrice` is missing (e.g. crypto). TradingView widgets remain live for indices / calendar / earnings.

## Routine prompt reminder
Update the `daily-alphaview-portfolio-sync` routine so it always refreshes broker prices on each run, not only when qty/cost composition changes.
