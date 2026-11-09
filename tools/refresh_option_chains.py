#!/usr/bin/env python3
"""Refresh calc/data/chains/{SYMBOL}.json from public delayed option quotes.

US names come from CBOE's delayed JSON. HK names come from the HKEX market-data
widget (delayed at least 15 minutes): a page token, then getoptioncontractlist
and getderivativesoption for the stock's HKATS code (TCH for 0700.HK). HKEX
does not publish a free options HTTP API; this is the same delayed chain the
stock-options page shows. Quotes are per share.

The calculator on GitHub Pages reads these files when a live fetch is blocked.
Format is parsed by calc/chain.js (chainsFromCompact).

Usage:
  python3 tools/refresh_option_chains.py
  python3 tools/refresh_option_chains.py NVDA 0700.HK
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "calc" / "data" / "chains"
CAL_PATH = ROOT / "calc" / "data" / "hkex_calendar.json"
SPECS_PATH = ROOT / "calc" / "hk_options.js"
US_DEFAULT = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "GOOGL", "AMD", "SPY", "QQQ"]
HK_DEFAULT = [
    "0700.HK", "9988.HK", "3690.HK", "1810.HK", "0941.HK", "0883.HK",
    "0388.HK", "1299.HK", "1211.HK", "0005.HK", "2800.HK",
    "0823.HK", "1833.HK", "2823.HK",
]
OCC = re.compile(r"^([A-Z0-9.]+)(\d{6})([CP])(\d{8})$")
SPEC_RE = re.compile(r'"(\d{4}\.HK)"\s*:\s*\[\s*\d+\s*,\s*"([A-Z0-9]+)"')
TOKEN_RE = re.compile(r'return\s+"([^"]+)"')
TOKEN_PAGE = (
    "https://www.hkex.com.hk/Market-Data/Securities-Prices/"
    "Equities/Equities-Quote?sym=700&sc_lang=en"
)
CALENDAR_PAGE = (
    "https://www.hkex.com.hk/Services/Trading/Derivatives/Overview/"
    "Trading-Calendar-and-Holiday-Schedule?sc_lang=en"
)
WIDGET = "https://www1.hkex.com.hk/hkexwidget/data"
UA = "Mozilla/5.0 (compatible; alphaview-option-chain/1.0)"
HKT = timezone(timedelta(hours=8))
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


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


def comma_num(x) -> float:
    if x is None:
        return 0.0
    s = str(x).replace(",", "").strip()
    if not s or s == "-":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def http_get(url: str, timeout: int = 60, accept: str = "*/*") -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.hkex.com.hk/",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def unwrap_jsonp(text: str) -> dict:
    i, j = text.find("{"), text.rfind("}")
    if i < 0 or j < i:
        raise RuntimeError("response was not JSONP")
    return json.loads(text[i:j + 1])


def normalize_symbol(raw: str) -> str:
    s = raw.strip().upper()
    if re.fullmatch(r"\d{1,5}", s):
        return f"{int(s):04d}.HK"
    m = re.fullmatch(r"(\d{1,5})\.HK", s)
    if m:
        return f"{int(m.group(1)):04d}.HK"
    return s


def load_specs() -> dict[str, str]:
    text = SPECS_PATH.read_text(encoding="utf-8")
    return {m.group(1): m.group(2) for m in SPEC_RE.finditer(text)}


def expiry_from_contract_id(cid: str) -> str:
    """Business day before the last weekday of the contract month.

    HKEX stock options expire the trading day before the last trading day of
    the month. This ignores holidays; the published calendar wins when present.
    """
    month, year = int(cid[:2]), int(cid[2:])
    if month == 12:
        last = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    while last.weekday() >= 5:
        last -= timedelta(days=1)
    exp = last - timedelta(days=1)
    while exp.weekday() >= 5:
        exp -= timedelta(days=1)
    return exp.isoformat()


def parse_short_date(s: str) -> date | None:
    s = re.sub(r"<[^>]+>", "", s).replace("\xa0", "").replace("&nbsp;", "").strip()
    if not s:
        return None
    for fmt in ("%d-%b-%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def fetch_hk_calendar() -> dict[str, str]:
    """Map contract id MMYYYY -> expiry ISO from the stock-options calendar."""
    html = http_get(CALENDAR_PAGE, timeout=60, accept="text/html")
    tables = list(re.finditer(r'<table class="table migrate"[^>]*>([\s\S]*?)</table>', html, re.I))
    prev = 0
    chosen = None
    for m in tables:
        preamble = re.sub(r"<[^>]+>", " ", html[prev:m.start()])
        preamble = re.sub(r"\s+", " ", preamble).lower()
        prev = m.end()
        if "stock futures and options" in preamble and "weekly stock" not in preamble:
            chosen = m.group(1)
            break
    out: dict[str, str] = {}
    if not chosen:
        return out
    month_no = {name: i + 1 for i, name in enumerate(MONTHS)}
    for row in re.findall(r"<tr>([\s\S]*?)</tr>", chosen):
        cells = re.findall(r"<t[hd][^>]*>([\s\S]*?)</t[hd]>", row)
        if len(cells) < 2:
            continue
        label = re.sub(r"<[^>]+>", "", cells[0]).replace("\xa0", "").replace("&nbsp;", "").strip()
        if not re.fullmatch(r"[A-Za-z]{3}-\d{2}", label):
            continue
        exp = parse_short_date(cells[1])
        mon, yy = label.split("-")
        mon_i = month_no.get(mon[:3].title())
        if not exp or not mon_i:
            continue
        out[f"{mon_i:02d}{2000 + int(yy)}"] = exp.isoformat()
    return out


def hk_token() -> str:
    html = http_get(TOKEN_PAGE, timeout=40, accept="text/html")
    token = next((m.group(1) for m in TOKEN_RE.finditer(html) if m.group(1) != "Base64-AES-Encrypted-Token"), None)
    if not token:
        raise RuntimeError("HKEX widget token not found")
    return urllib.parse.unquote(token)


def hk_widget(token: str, api: str, **params) -> dict:
    qs = {"lang": "eng", "token": token, "qid": str(int(datetime.now().timestamp() * 1000)), "callback": "cb"}
    qs.update({k: v for k, v in params.items() if v is not None})
    raw = http_get(f"{WIDGET}/{api}?{urllib.parse.urlencode(qs)}", timeout=40)
    payload = unwrap_jsonp(raw)
    data = payload.get("data") or {}
    rc = str(data.get("responsecode") or "")
    if rc and rc not in ("000", "0"):
        raise RuntimeError(f"HKEX {api} {rc}: {data.get('responsemsg')}")
    return data


def hk_asof(lastupd: str | None) -> str:
    if lastupd:
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
            try:
                return datetime.strptime(lastupd.strip(), fmt).strftime("%Y-%m-%d %H:%M") + " HKT"
            except ValueError:
                continue
    return datetime.now(HKT).strftime("%Y-%m-%d %H:%M HKT")


def fetch_cboe(sym: str) -> dict:
    url = f"https://cdn-api.cboe.com/api/global/delayed_quotes/options/{sym}.json"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def score(bid: float, ask: float, iv: float, oi: float, vol: float) -> tuple:
    return (1 if bid > 0 and ask > 0 else 0, oi, vol, 1 if iv > 0 else 0)


def compact_cboe(payload: dict, sym: str) -> dict:
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


def compact_hk(sym: str, ats: str, token: str, calendar: dict[str, str]) -> dict:
    cons = hk_widget(token, "getoptioncontractlist", ats=ats, type="1").get("conlist") or []
    if not cons:
        raise RuntimeError(f"{sym}: no option months for {ats}")
    code = str(int(sym.split(".")[0]))
    try:
        quote = hk_widget(token, "getequityquote", sym=code).get("quote") or {}
    except Exception:
        quote = {}
    spot = comma_num(quote.get("ls")) or comma_num(quote.get("hc")) or None
    book: dict[str, dict[tuple, tuple]] = {}
    stamps: list[str] = []
    for con in cons:
        cid = str(con.get("id") or "")
        if not re.fullmatch(r"\d{6}", cid):
            continue
        probe = hk_widget(token, "getderivativesoption", ats=ats, type="1", con=cid)
        if probe.get("lastupd"):
            stamps.append(probe["lastupd"])
        lo = str(probe.get("min") or "").replace(",", "")
        hi = str(probe.get("max") or "").replace(",", "")
        full = probe
        if lo and hi:
            full = hk_widget(token, "getderivativesoption", ats=ats, type="1", con=cid, fr=lo, to=hi)
            if full.get("lastupd"):
                stamps.append(full["lastupd"])
        exp = calendar.get(cid) or expiry_from_contract_id(cid)
        slot = book.setdefault(exp, {})
        for row in full.get("optionlist") or []:
            strike = comma_num(row.get("strike"))
            if strike <= 0:
                continue
            for cp, side in (("C", "c"), ("P", "p")):
                q = row.get(side) or {}
                bid, ask, last = comma_num(q.get("bd")), comma_num(q.get("as")), comma_num(q.get("ls"))
                iv = comma_num(q.get("iv"))
                if iv > 0:
                    iv = iv / 100
                if not (0.01 < iv < 5):
                    iv = 0
                if bid <= 0 and ask <= 0 and last <= 0:
                    continue
                key = (cp, numish(strike))
                rank = score(bid, ask, iv, comma_num(q.get("oi")), comma_num(q.get("vo")))
                prev = slot.get(key)
                if prev is None or rank > prev[0]:
                    slot[key] = (rank, [
                        key[1],
                        numish(bid) if bid > 0 else 0,
                        numish(ask) if ask > 0 else 0,
                        numish(iv) if iv else 0,
                        numish(last) if last > 0 else 0,
                    ])
    expiries = {}
    for exp in sorted(book):
        calls, puts = [], []
        for (cp, _strike), (_rank, row) in sorted(book[exp].items(), key=lambda kv: (kv[0][0], kv[0][1])):
            (calls if cp == "C" else puts).append(row)
        if calls or puts:
            expiries[exp] = {"c": calls, "p": puts}
    if not expiries:
        raise RuntimeError(f"{sym}: no {ats} quotes")
    return {
        "symbol": sym,
        "source": "HKEX delayed",
        "ats": ats,
        "asOf": max((hk_asof(s) for s in stamps), default=hk_asof(None)),
        "spot": numish(spot) if spot else None,
        "expiries": expiries,
    }


def load_index() -> dict:
    try:
        return json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"symbols": {}}


def write_symbol(sym: str, data: dict) -> dict:
    path = OUT / f"{sym}.json"
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    n = sum(len(v["c"]) + len(v["p"]) for v in data["expiries"].values())
    print(f"{sym} {path.stat().st_size} bytes  {data['asOf']}  {len(data['expiries'])} expiries  {n} quotes  {data['source']}")
    return {"asOf": data["asOf"], "expirations": len(data["expiries"]), "quotes": n,
            "bytes": path.stat().st_size, "source": data["source"]}


def print_samples(data: dict) -> None:
    if data["symbol"] == "NVDA":
        row = next((r for r in data["expiries"].get("2026-12-24", {}).get("p", []) if r[0] == 150), None)
        if row:
            bid, ask = row[1], row[2]
            mid = (bid + ask) / 2 if bid and ask else (bid or ask or row[4])
            print(f"  2026-12-24 150 put  bid {bid}  ask {ask}  mid {mid}  iv {row[3]}")
    if data["symbol"] != "0700.HK" or not data.get("spot"):
        return
    spot = float(data["spot"])
    for exp, sides in data["expiries"].items():
        if exp < "2026-11-01" or exp > "2026-12-31":
            continue
        best = None
        for row in sides.get("p") or []:
            if not row[1] or not row[2]:
                continue
            dist = abs(float(row[0]) - spot)
            if best is None or dist < best[0]:
                best = (dist, row)
        if not best:
            continue
        row = best[1]
        mid = (row[1] + row[2]) / 2
        print(f"  {exp} put strike {row[0]} near spot {spot}  bid {row[1]}  ask {row[2]}  mid {mid}  iv {row[3]}")


def main(argv: list[str]) -> int:
    syms = [normalize_symbol(s) for s in argv if s.strip()] or (US_DEFAULT + HK_DEFAULT)
    specs = load_specs()
    OUT.mkdir(parents=True, exist_ok=True)
    hk_syms = [s for s in syms if s.endswith(".HK")]
    us_syms = [s for s in syms if not s.endswith(".HK")]
    calendar: dict[str, str] = {}
    token = None
    if hk_syms:
        calendar = fetch_hk_calendar()
        if not calendar:
            print("WARN HKEX calendar parse failed; using weekday expiry rule", file=sys.stderr)
        else:
            mismatches = [cid for cid, iso in calendar.items() if expiry_from_contract_id(cid) != iso]
            print(f"HKEX calendar {len(calendar)} months, weekday-rule mismatches {len(mismatches)}")
            CAL_PATH.parent.mkdir(parents=True, exist_ok=True)
            CAL_PATH.write_text(json.dumps({
                "source": "HKEX Stock Futures and Options trading calendar",
                "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "expiries": calendar,
            }, indent=2) + "\n", encoding="utf-8")
        token = hk_token()

    index = load_index()
    symbols = dict(index.get("symbols") or {})
    failed = []

    for sym in us_syms:
        try:
            data = compact_cboe(fetch_cboe(sym), sym)
        except Exception as e:  # noqa: BLE001 — one bad symbol should not drop the rest
            print(f"FAIL {sym}: {e}", file=sys.stderr)
            failed.append(sym)
            continue
        symbols[sym] = write_symbol(sym, data)
        print_samples(data)

    def one_hk(sym: str) -> tuple[str, dict]:
        ats = specs.get(sym)
        if not ats:
            raise RuntimeError(f"no HKATS code in hk_options.js")
        assert token is not None
        return sym, compact_hk(sym, ats, token, calendar)

    if hk_syms:
        workers = min(4, len(hk_syms))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(one_hk, sym): sym for sym in hk_syms}
            for fut in as_completed(futs):
                sym = futs[fut]
                try:
                    sym, data = fut.result()
                except Exception as e:  # noqa: BLE001
                    print(f"FAIL {sym}: {e}", file=sys.stderr)
                    failed.append(sym)
                    continue
                symbols[sym] = write_symbol(sym, data)
                print_samples(data)

    index = {
        "source": "CBOE delayed + HKEX delayed",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "symbols": dict(sorted(symbols.items())),
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    if failed and len(failed) == len(syms):
        return 1
    if failed:
        print("partial failure: " + ", ".join(failed), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
