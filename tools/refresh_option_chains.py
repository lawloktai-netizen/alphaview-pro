#!/usr/bin/env python3
"""Refresh calc/data/chains/{SYMBOL}.json from CBOE's public delayed option chain.

The calculator on GitHub Pages reads these files when the browser cannot fetch
https://cdn-api.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
(that host does not send Access-Control-Allow-Origin).

Format is parsed by calc/chain.js (chainsFromCompact). Quotes are per share.
Only the standard OCC root is kept (NVDA, not an adjusted deliverable).

Usage:
  python3 tools/refresh_option_chains.py
  python3 tools/refresh_option_chains.py NVDA AAPL SPY
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "calc" / "data" / "chains"
DEFAULT = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "GOOGL", "AMD", "SPY", "QQQ"]
OCC = re.compile(r"^([A-Z0-9.]+)(\d{6})([CP])(\d{8})$")
UA = "Mozilla/5.0 (compatible; alphaview-option-chain/1.0)"


def norm_root(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def iso_from_yymmdd(s: str) -> str | None:
    y, m, d = 2000 + int(s[:2]), int(s[2:4]), int(s[4:6])
    try:
        datetime(y, m, d)
    except ValueError:
        return None
    return f"{y:04d}-{m:02d}-{d:02d}"


def numish(x: float):
    x = round(float(x), 4)
    if abs(x - round(x)) < 1e-9:
        return int(round(x))
    return x


def fetch(sym: str) -> dict:
    url = f"https://cdn-api.cboe.com/api/global/delayed_quotes/options/{sym}.json"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def score(bid: float, ask: float, iv: float, oi: float, vol: float) -> tuple:
    return (1 if bid > 0 and ask > 0 else 0, oi, vol, 1 if iv > 0 else 0)


def compact(payload: dict, sym: str) -> dict:
    data = payload.get("data") or {}
    options = data.get("options") or []
    want = norm_root(sym)
    book: dict[str, dict[tuple, tuple]] = {}
    for o in options:
        m = OCC.match(o.get("option") or "")
        if not m or norm_root(m.group(1)) != want:
            continue
        exp = iso_from_yymmdd(m.group(2))
        if not exp:
            continue
        bid, ask = float(o.get("bid") or 0), float(o.get("ask") or 0)
        last = float(o.get("last_trade_price") or 0)
        iv = float(o.get("iv") or 0)
        if bid <= 0 and ask <= 0 and last <= 0:
            continue
        if iv >= 5:
            iv = iv / 100 if iv < 500 else 0
        if not (0.01 < iv < 5):
            iv = 0
        key = (m.group(3), numish(int(m.group(4)) / 1000))
        rank = score(bid, ask, iv, float(o.get("open_interest") or 0), float(o.get("volume") or 0))
        slot = book.setdefault(exp, {})
        prev = slot.get(key)
        if prev is None or rank > prev[0]:
            slot[key] = (rank, [key[1], numish(bid) if bid > 0 else 0, numish(ask) if ask > 0 else 0,
                                 numish(iv) if iv else 0, numish(last) if last > 0 else 0])
    expiries = {}
    for exp in sorted(book):
        calls, puts = [], []
        for (cp, _strike), (_rank, row) in sorted(book[exp].items(), key=lambda kv: (kv[0][0], kv[0][1])):
            (calls if cp == "C" else puts).append(row)
        if calls or puts:
            expiries[exp] = {"c": calls, "p": puts}
    if not expiries:
        raise RuntimeError(f"{sym}: no standard-root quotes")
    spot = data.get("current_price")
    return {
        "symbol": sym,
        "source": "CBOE delayed",
        "asOf": payload.get("timestamp"),
        "spot": numish(spot) if spot else None,
        "expiries": expiries,
    }


def main(argv: list[str]) -> int:
    syms = [s.strip().upper() for s in argv if s.strip()] or DEFAULT
    OUT.mkdir(parents=True, exist_ok=True)
    index = {
        "source": "CBOE delayed",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "symbols": {},
    }
    failed = []
    for sym in syms:
        try:
            payload = fetch(sym)
            data = compact(payload, sym)
        except Exception as e:  # noqa: BLE001 — one bad symbol should not drop the rest
            print(f"FAIL {sym}: {e}", file=sys.stderr)
            failed.append(sym)
            continue
        path = OUT / f"{sym}.json"
        path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
        n = sum(len(v["c"]) + len(v["p"]) for v in data["expiries"].values())
        index["symbols"][sym] = {"asOf": data["asOf"], "expirations": len(data["expiries"]), "quotes": n, "bytes": path.stat().st_size}
        print(f"{sym} {path.stat().st_size} bytes  {data['asOf']}  {len(data['expiries'])} expiries  {n} quotes")
        row = next((r for r in data["expiries"].get("2026-12-24", {}).get("p", []) if r[0] == 150), None) if sym == "NVDA" else None
        if row:
            bid, ask = row[1], row[2]
            mid = (bid + ask) / 2 if bid and ask else (bid or ask or row[4])
            print(f"  2026-12-24 150 put  bid {bid}  ask {ask}  mid {mid}  iv {row[3]}")
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    if failed and len(failed) == len(syms):
        return 1
    if failed:
        print("partial failure: " + ", ".join(failed), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
