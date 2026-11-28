#!/usr/bin/env python3
"""本地預覽資金流與價格行為草稿。

只做三件事：檢查並提供示範檔、可選用公開 K 線重算價格欄位、可選用環境變數
GEMINI_API_KEY 重寫短評。不落單、不讀持倉、不從網頁收集金鑰。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "schema" / "capital-flow-dashboard.schema.json"
DEMO_PATH = ROOT / "data" / "demo.json"
PUBLIC_PATH = ROOT / "data" / "public-price.json"
COMMENTARY_PATH = ROOT / "data" / "gemini-commentary.json"
GEMINI_CONFIG = ROOT / "config" / "gemini.json"

DEFAULT_SYMBOLS = ["SPX", "MES", "NVDA", "0700.HK", "0883.HK"]
HK_SYMBOLS = ["0700.HK", "0883.HK"]
YAHOO_SPECIAL = {
    "SPX": "^GSPC",
    "MES": "MES=F",
    "BRK.B": "BRK-B",
    "510300.SH": "510300.SS",
}
MARKET_TZ = {"US": "America/New_York", "HK": "Asia/Hong_Kong", "CN": "Asia/Shanghai"}
HKT = timezone(timedelta(hours=8))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")
BANNED_KEYS = {
    "order",
    "orders",
    "orderid",
    "clientorderid",
    "position",
    "positions",
    "holdings",
    "portfolio",
    "account",
    "accountid",
    "password",
    "secret",
    "apikey",
    "api_key",
    "token",
    "qty",
    "quantity",
    "buyingpower",
}
ATR_LABEL = {"contraction": "收縮", "expansion": "擴張", "neutral": "中性"}
BIAS_LABEL = {
    "up": "上升結構",
    "down": "下跌結構",
    "range": "橫行",
    "transition": "過渡",
}
UA = "personal-research-draft/1.0 (local price refresh; not a broker)"


def main() -> None:
    parser = argparse.ArgumentParser(description="本地預覽資金流與價格行為草稿。不落單、不讀持倉。")
    parser.add_argument("--check", action="store_true", help="只檢查 data/demo.json 是否符合合約")
    parser.add_argument("--self-test", action="store_true", help="跑計算自我測試，不連網")
    parser.add_argument("--refresh-public-ohlcv", action="store_true", help="用公開 K 線重算價格欄位，資金流維持示範")
    parser.add_argument("--gemini", action="store_true", help="若環境有 GEMINI_API_KEY，重寫短評")
    parser.add_argument("--no-serve", action="store_true", help="做完檢查或刷新後不啟動預覽")
    parser.add_argument("--port", type=int, default=8741, help="預覽埠，預設 8741")
    args = parser.parse_args()

    if args.self_test:
        run_self_test()
        print("自我測試通過")
        return

    errors = validate_demo_file()
    if errors:
        print("示範檔未通過檢查：")
        for item in errors:
            print(f"- {item}")
        sys.exit(1)
    print(f"示範檔符合 {SCHEMA_PATH.relative_to(ROOT).as_posix()}")

    if args.check:
        return

    extra = None
    if args.refresh_public_ohlcv:
        extra = refresh_public()
    if args.gemini:
        extra = refresh_gemini(extra)
    if args.no_serve:
        return
    serve(args.port, extra)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now_hkt() -> str:
    return datetime.now(HKT).replace(microsecond=0).isoformat()


def r2(value: float) -> float:
    return round(float(value) + 1e-9, 2)


def yahoo_symbol(code: str) -> str:
    """Map a page ticker to a Yahoo Finance chart symbol. Do not invent prices."""
    if code in YAHOO_SPECIAL:
        return YAHOO_SPECIAL[code]
    if code.endswith(".SH"):
        return code[:-3] + ".SS"
    return code


def atr_state(ratio: float) -> str:
    if ratio < 0.90:
        return "contraction"
    if ratio > 1.15:
        return "expansion"
    return "neutral"


def price_versus(distance: float) -> str:
    if distance > 0:
        return "above"
    if distance < 0:
        return "below"
    return "at"


def validate_demo_file() -> list[str]:
    if not SCHEMA_PATH.exists() or not DEMO_PATH.exists():
        return ["找不到 schema 或 data/demo.json"]
    schema = load_json(SCHEMA_PATH)
    demo = load_json(DEMO_PATH)
    errors = schema_errors(demo, schema)
    errors.extend(demo_rules(demo))
    return errors


def schema_errors(instance, schema) -> list[str]:
    try:
        import jsonschema
        from jsonschema import FormatChecker
    except ImportError:
        return fallback_schema_errors(instance, schema)
    validator = jsonschema.Draft202012Validator(schema, format_checker=FormatChecker())
    return [error.message for error in sorted(validator.iter_errors(instance), key=lambda item: list(item.path))]


def fallback_schema_errors(instance, schema) -> list[str]:
    return walk_schema(instance, schema, schema, "$")


def walk_schema(instance, schema, root, path: str) -> list[str]:
    if "$ref" in schema:
        target = root
        for part in schema["$ref"][2:].split("/"):
            target = target[part]
        return walk_schema(instance, target, root, path)

    if "anyOf" in schema:
        for option in schema["anyOf"]:
            if not walk_schema(instance, option, root, path):
                return []
        return [f"{path}: 不符合 anyOf"]

    errors = []
    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not any(type_ok(instance, name) for name in types):
            return [f"{path}: 型別應為 {expected}"]

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: 必須為 {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: 不在允許清單 {schema['enum']}")

    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            errors.append(f"{path}: 文字太短")
        if schema.get("format") == "date" and not DATE_RE.match(instance):
            errors.append(f"{path}: 日期格式不正確")
        if schema.get("format") == "date-time" and not DT_RE.match(instance):
            errors.append(f"{path}: 日期時間格式不正確")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        exclusive = schema.get("exclusiveMinimum")
        if exclusive is not None and not instance > exclusive:
            errors.append(f"{path}: 必須大於 {exclusive}")

    if isinstance(instance, dict) and (expected == "object" or "properties" in schema):
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in props:
                    errors.append(f"{path}.{key}: 不在合約內")
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}.{key}: 缺少")
        for key, sub in props.items():
            if key in instance:
                errors.extend(walk_schema(instance[key], sub, root, f"{path}.{key}"))

    if isinstance(instance, list) and expected == "array":
        if len(instance) < schema.get("minItems", 0):
            errors.append(f"{path}: 項目太少")
        if schema.get("uniqueItems") and len(instance) != len(set(instance)):
            errors.append(f"{path}: 有重複項目")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(instance):
                errors.extend(walk_schema(item, item_schema, root, f"{path}[{index}]"))
    return errors


def type_ok(value, name: str) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "null":
        return value is None
    return False


def demo_rules(doc) -> list[str]:
    errors = []
    meta = doc.get("meta") or {}
    if meta.get("dataMode") != "demo":
        errors.append("示範檔的 dataMode 必須是 demo")
    if "示範" not in str(meta.get("label", "")):
        errors.append("示範檔的 label 必須含有「示範」")
    symbols = doc.get("symbols") or []
    by_symbol = {}
    for item in symbols:
        by_symbol.setdefault(item.get("symbol"), item)
    for code in DEFAULT_SYMBOLS:
        if code not in by_symbol:
            errors.append(f"缺少預設代號 {code}")
    if not all(code in (meta.get("watchlist") or []) for code in DEFAULT_SYMBOLS):
        errors.append("觀察名單必須仍包含 SPX、MES、NVDA、0700.HK、0883.HK")
    kinds = []
    for item in symbols:
        code = item.get("symbol")
        errors.extend(check_symbol_math(item))
        errors.extend(banned_keys(item, code or "?"))
        flow = item.get("flow")
        if flow is not None:
            if flow.get("isDemo") is not True or "示範" not in str(flow.get("demoLabel", "")):
                errors.append(f"{code}: 資金流若出現，必須標成示範數據")
        if code in DEFAULT_SYMBOLS:
            if not flow:
                errors.append(f"{code}: 原五個代號必須保留示範資金流")
            quote = item.get("quote") or {}
            if quote and quote.get("priceKind") not in {"demo", "public_ohlcv"}:
                errors.append(f"{code}: 價格種類不接受")
            note = item.get("commentary") or {}
            if note.get("origin") not in {"demo", "model"} or note.get("locale") != "zh-HK":
                errors.append(f"{code}: 短評應為 zh-HK")
            if item.get("market") == "HK":
                connect = item.get("connectFlow")
                if not connect:
                    errors.append(f"{code}: 原港股示範必須有南北向")
                elif connect.get("isDemo") is not True or "northboundNet" not in connect or "southboundNet" not in connect:
                    errors.append(f"{code}: 南北向必須同時有北向、南向，並標成示範")
            frames = item.get("structure") or {}
            expected = {"daily": "1D", "h4": "4H", "h1": "1H"}
            for key, timeframe in expected.items():
                frame = frames.get(key) or {}
                if frame and frame.get("timeframe") != timeframe:
                    errors.append(f"{code}: {key} 的 timeframe 應為 {timeframe}")
                if frame and frame.get("swingHigh", 0) < frame.get("swingLow", 0):
                    errors.append(f"{code}: {key} 的擺動高點低於低點")
        for alert in item.get("alerts") or []:
            kinds.append((item, alert.get("type")))
    if not any(kind == "distribution" for _, kind in kinds):
        errors.append("至少要有一個派發式背離例子")
    if not any(kind == "accumulation" for _, kind in kinds):
        errors.append("至少要有一個吸籌式背離例子")
    errors.extend(check_divergence_examples(symbols))
    for code in HK_SYMBOLS:
        if code not in by_symbol or not by_symbol[code].get("connectFlow"):
            errors.append(f"{code}: 缺少南北向欄位")
    if not doc.get("sources"):
        errors.append("缺少數據來源")
    errors.extend(banned_keys(doc.get("meta") or {}, "meta"))
    return errors


def check_divergence_examples(symbols) -> list[str]:
    errors = []
    distribution = False
    accumulation = False
    for item in symbols:
        if not item.get("quote") or not item.get("flow") or not (item.get("structure") or {}).get("daily"):
            continue
        last = item["quote"]["last"]
        high = item["structure"]["daily"]["swingHigh"]
        low = item["structure"]["daily"]["swingLow"]
        large = item["flow"]["largeOrderNet"]
        for alert in item.get("alerts") or []:
            if alert.get("type") == "distribution" and last >= high - 0.001 and large < 0:
                distribution = True
            if alert.get("type") == "accumulation" and low and abs(last - low) / abs(low) < 0.02 and large > 0:
                accumulation = True
    if not distribution:
        errors.append("派發例子要同時滿足：價格貼近或等於日線擺動高點，而且大單淨額為負")
    if not accumulation:
        errors.append("吸籌例子要同時滿足：價格貼近日前低（2% 以內），而且大單淨額為正")
    return errors


def check_symbol_math(item) -> list[str]:
    errors = []
    code = item.get("symbol")
    quote = item.get("quote")
    if not quote:
        return errors
    if abs((quote["last"] - quote["previousClose"]) - quote["change"]) > 0.02:
        errors.append(f"{code}: 升跌額與收市價不一致")
    if abs((quote["change"] / quote["previousClose"] * 100) - quote["changePct"]) > 0.03:
        errors.append(f"{code}: 升跌百分比不一致")
    moving = item.get("movingAverages")
    if moving:
        for key, period in (("ma20", 20), ("ma50", 50), ("ma250", 250)):
            ma = moving[key]
            if ma["period"] != period:
                errors.append(f"{code}: {key} 週期不對")
            dist = quote["last"] - ma["value"]
            if abs(dist - ma["distanceAbs"]) > 0.02:
                errors.append(f"{code}: {key} 距離不一致")
            if abs(dist / ma["value"] * 100 - ma["distancePct"]) > 0.03:
                errors.append(f"{code}: {key} 距離百分比不一致")
            if ma["priceVersus"] != price_versus(ma["distanceAbs"]):
                errors.append(f"{code}: {key} 相對位置不一致")
    avwap = item.get("avwap")
    if avwap:
        dist = quote["last"] - avwap["value"]
        if abs(dist - avwap["distanceAbs"]) > 0.02 or abs(dist / avwap["value"] * 100 - avwap["distancePct"]) > 0.03:
            errors.append(f"{code}: AVWAP 距離不一致")
        if avwap["priceVersus"] != price_versus(avwap["distanceAbs"]):
            errors.append(f"{code}: AVWAP 相對位置不一致")
    atr = item.get("atr")
    if atr:
        if abs(atr["value"] / atr["baseline"] - atr["ratio"]) > 0.03:
            errors.append(f"{code}: ATR 比率不一致")
        state = atr_state(atr["ratio"])
        if atr["state"] != state or atr["label"] != ATR_LABEL[state]:
            errors.append(f"{code}: ATR 狀態與比率不一致")
    return errors


def banned_keys(node, label: str) -> list[str]:
    found = []

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower().replace("-", "") in {item.replace("_", "") for item in BANNED_KEYS} or key.lower() in BANNED_KEYS:
                    found.append(key)
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(node)
    return [f"{label}: 出現不屬於本合約的欄位 {name}" for name in found]


def refresh_public() -> Path:
    doc = load_json(DEMO_PATH)
    updated = 0
    failures = []
    logs = []
    total = len(doc["symbols"])
    for index, item in enumerate(doc["symbols"], start=1):
        code = item["symbol"]
        yahoo = yahoo_symbol(code)
        print(f"[{index}/{total}] 正在讀取 {code} → {yahoo}", flush=True)
        try:
            daily = fetch_bars(yahoo, "1d", "5y")
            if len(daily) < 2:
                raise RuntimeError(f"日線不足兩根（{len(daily)}），無法計算升跌")
            intraday = None
            intraday_error = None
            try:
                intraday = fetch_bars(yahoo, "60m", "60d")
            except Exception as exc:  # noqa: BLE001 — 單一日內失敗不推翻日線
                intraday_error = str(exc)
            apply_public_price(item, daily, intraday, MARKET_TZ.get(item["market"], "Asia/Hong_Kong"))
            detail = [
                f"價格、均線、AVWAP、ATR 與已刷新的結構由 {yahoo} 的公開 K 線計算（Yahoo Finance chart 接口）。",
            ]
            if item.get("structure") and intraday:
                detail.append("4 小時由公開 1 小時 K 線合併，1 小時直接使用公開 K 線。")
            elif not item.get("structure"):
                reason = intraday_error or "日線或小時線不足以同時寫全日線、4 小時與 1 小時結構，故省略結構，並無捏造。"
                detail.append(f"本代號暫無由公開 K 線寫成的完整結構。{reason}")
            else:
                detail.append(f"4 小時與 1 小時未能刷新。原因：{intraday_error}")
            if not item.get("movingAverages"):
                detail.append(f"日線只有 {len(daily)} 根，不足 250 根，故不寫 20／50／250 均線，並無用較短窗口冒充 250 日均線。")
            detail.append("這是公開價格，不是暗池、大單、機構或富途資金流。")
            item["sources"] = without_stale_demo_prices(item.get("sources") or [])
            item["sources"] = upsert_source(item["sources"], {
                "id": f"public-ohlcv-{code}",
                "kind": "public_ohlcv",
                "title": "公開行情",
                "detail": "".join(detail),
                "appliesTo": ["price", "movingAverages", "avwap", "atr", "structure"],
            })
            updated += 1
            session = item["quote"]["session"]
            as_of = item["quote"]["asOf"]
            msg = f"成功：{code}（Yahoo {yahoo}）session={session} asOf={as_of} 日線={len(daily)}"
            print(msg, flush=True)
            logs.append(msg)
        except Exception as exc:  # noqa: BLE001 — 向使用者回報單一代號失敗
            fail = f"{code}（Yahoo {yahoo}）: {exc}"
            failures.append(fail)
            print(f"失敗：{fail}", flush=True)
            item["sources"] = upsert_source(item.get("sources") or [], {
                "id": f"public-ohlcv-failed-{code}",
                "kind": "manual",
                "title": "公開行情刷新失敗",
                "detail": f"{code} 未能取得公開 K 線，因此不寫價格、均線、AVWAP、ATR 或結構，亦無捏造數字。原因：{exc}。這不是資金流。",
                "appliesTo": ["price"],
            })
        time.sleep(0.45)

    if updated == 0:
        print("沒有任何代號完成公開行情刷新。")
        for item in failures:
            print(f"- {item}")
        sys.exit(1)

    stamp = now_hkt()
    doc["meta"]["dataMode"] = "mixed"
    doc["meta"]["label"] = "公開行情＋示範資金流"
    doc["meta"]["asOf"] = stamp
    doc["meta"]["timezone"] = "Asia/Hong_Kong"
    doc["meta"]["disclaimer"] = (
        "價格、均線、AVWAP、ATR 與已刷新的結構來自 Yahoo Finance 公開 K 線，不是即時保證，更不是資金流、暗池或機構流向。"
        "SPX、MES、NVDA、0700.HK、0883.HK 的大單、散戶、南北向及背離旗標仍是手作示範，不是真實大單或帳戶持倉，而且可能與新價格不一致。"
        "其餘代號暫無資金流示範，不會套用其他代號的數字。"
        "本工具只做呈現，不提供落單。富途資金流不在這一版。價格圖表若由 TradingView 官方元件顯示，只是公開行情圖表，不是資金流。"
    )
    doc["meta"]["methods"]["avwap"] = (
        "刷新時，錨在近 250 根日線（或可取得的較短窗口）的最低價，由該根起累計典型價乘成交量。沒有成交量時改為等權。"
        "這是公開行情計算，不是機構 AVWAP。"
    )
    doc["meta"]["methods"]["structure"] = (
        "刷新時，用最近最多 80 根 K 線的擺動高低點（左右各 2 根確認）。最後兩個高點與低點同時抬高為上升，"
        "同時下移為下跌；否則再看收市是否落在近 20 根區間中部，以區分橫行與過渡。這是簡化讀法，不是交易訊號。"
        "若小時線不足，則不寫結構，避免用日線冒充 4 小時或 1 小時。"
    )
    doc["meta"]["priceRefresh"] = {
        "at": stamp,
        "provider": "Yahoo Finance chart 接口（公開行情）",
        "note": "只刷新公開價格衍生欄位。資金流、南北向與背離旗標僅在原有示範的五個代號保留，其餘標明暫無資金流示範。不可寫成暗池或機構流向。",
    }
    for source in doc.get("sources") or []:
        if source.get("id") == "demo-file":
            source["detail"] = (
                "原示範檔之中，SPX、MES、NVDA、0700.HK、0883.HK 的資金流、南北向、背離與短評仍是手作例子。"
                "已刷新的價格、均線、AVWAP、ATR 與結構改看公開行情來源，不要再把那些欄位當成手作快照。"
                "其餘代號沒有手作資金流，頁面會標明暫無資金流示範。"
            )
            source["appliesTo"] = ["flow", "connectFlow", "alerts", "commentary"]
    doc["sources"] = upsert_source(doc.get("sources") or [], {
        "id": "public-ohlcv",
        "kind": "public_ohlcv",
        "title": "公開行情刷新",
        "detail": "價格、均線、AVWAP、ATR 與已刷新的結構來自 Yahoo Finance chart 接口的公開 K 線。這只是公開價格，不是暗池、大單、機構或富途資金流。未取得到的代號不會填入捏造數字。",
        "appliesTo": ["price", "movingAverages", "avwap", "atr", "structure"],
    })
    for item in doc["symbols"]:
        note = item.get("commentary")
        if note and note.get("origin") != "model":
            item["commentary"] = {
                "locale": "zh-HK",
                "origin": "demo",
                "label": "示範預填（價格已刷新，短評未重算）",
                "text": "價格、均線、ATR、AVWAP 與結構若已標成公開行情，就只是 Yahoo Finance 的公開 K 線。資金流、南北向與背離旗標仍是原來的示範數字，可能與新價格不一致。這則短評不是模型生成。",
                "modelId": None,
                "generatedAt": None,
            }
    schema = load_json(SCHEMA_PATH)
    errors = schema_errors(doc, schema)
    errors.extend(banned_keys(doc.get("meta") or {}, "meta"))
    for item in doc["symbols"]:
        errors.extend(banned_keys(item, item.get("symbol") or "?"))
        errors.extend(check_symbol_math(item))
        if item.get("symbol") not in DEFAULT_SYMBOLS and item.get("flow"):
            errors.append(f"{item.get('symbol')}: 新代號不應出現資金流數字")
    if errors:
        print("刷新結果不符合合約，未寫入檔案：")
        for item in errors[:40]:
            print(f"- {item}")
        sys.exit(1)
    save_json(PUBLIC_PATH, doc)
    print(f"完成：成功 {updated}／{total}，失敗 {len(failures)}")
    for item in failures:
        print(f"警告：{item}")
    Path(ROOT / "data" / "public-price-refresh.log").write_text(
        "\n".join(logs + ["", "失敗："] + failures) + "\n",
        encoding="utf-8",
    )
    print(f"已寫入 {PUBLIC_PATH.relative_to(ROOT).as_posix()}")
    return PUBLIC_PATH



def apply_public_price(item, daily, intraday, tzname: str) -> None:
    last = daily[-1]
    prev = daily[-2]
    last_px = r2(last["c"])
    prev_px = r2(prev["c"])
    change = r2(last_px - prev_px)
    bar_asof = datetime.fromtimestamp(last["t"], HKT).replace(microsecond=0).isoformat()
    session = ts_date(last["t"], tzname)
    item["quote"] = {
        "last": last_px,
        "previousClose": prev_px,
        "change": change,
        "changePct": r2(change / prev_px * 100) if prev_px else 0,
        "session": session,
        "sessionNote": (
            f"Yahoo Finance 公開日線最後一根，時段日期 {session}，"
            f"該根時間（轉成 HKT）為 {bar_asof}。這是公開價格，不是資金流；若尚未收市，可能仍是未完成的日線。"
        ),
        "asOf": bar_asof,
        "priceKind": "public_ohlcv",
    }
    if len(daily) >= 250:
        closes = [bar["c"] for bar in daily]
        moving = {}
        for period, key in ((20, "ma20"), (50, "ma50"), (250, "ma250")):
            value = r2(sum(closes[-period:]) / period)
            dist = r2(last_px - value)
            moving[key] = {
                "period": period,
                "value": value,
                "distanceAbs": dist,
                "distancePct": r2(dist / value * 100) if value else 0,
                "priceVersus": price_versus(dist),
            }
        item["movingAverages"] = moving
    else:
        item.pop("movingAverages", None)
    if len(daily) >= 15:
        item["avwap"] = compute_avwap(daily, tzname, last_px)
    else:
        item.pop("avwap", None)
    try:
        if len(daily) >= 16:
            item["atr"] = compute_atr(daily)
        else:
            item.pop("atr", None)
    except Exception:
        item.pop("atr", None)
    can_daily = len(daily) >= 15
    h4 = []
    can_intraday = False
    if intraday and len(intraday) >= 15:
        h4 = aggregate_4h(intraday, tzname)
        can_intraday = len(h4) >= 15 and len(intraday) >= 15
    if can_daily and can_intraday:
        if "structure" not in item:
            item["structure"] = {}
        bias, high, low = classify(daily)
        item["structure"]["daily"] = frame("1D", bias, high, low, last_px)
        bias, high, low = classify(h4)
        item["structure"]["h4"] = frame("4H", bias, high, low, h4[-1]["c"])
        bias, high, low = classify(intraday)
        item["structure"]["h1"] = frame("1H", bias, high, low, intraday[-1]["c"])
    elif item.get("structure") and can_daily:
        # 原示範代號：至少更新日線；小時線不足則保留原示範結構，不捏造新的 4 小時／1 小時。
        bias, high, low = classify(daily)
        item["structure"]["daily"] = frame("1D", bias, high, low, last_px)
    elif not item.get("structure"):
        item.pop("structure", None)



def frame(timeframe: str, bias: str, high: float, low: float, last: float) -> dict:
    if bias == "up":
        summary = f"最近兩個擺動高點與低點都在抬高。擺動高 {high:.2f}，擺動低 {low:.2f}。"
    elif bias == "down":
        summary = f"最近兩個擺動高點與低點都在下移。擺動高 {high:.2f}，擺動低 {low:.2f}。"
    elif bias == "range":
        summary = f"收市 {last:.2f} 落在近段區間中部。擺動高 {high:.2f}，擺動低 {low:.2f}。"
    else:
        summary = f"高低點方向不一致，標成過渡。擺動高 {high:.2f}，擺動低 {low:.2f}。"
    return {
        "timeframe": timeframe,
        "bias": bias,
        "label": BIAS_LABEL[bias],
        "summary": summary,
        "swingHigh": r2(high),
        "swingLow": r2(low),
    }


def compute_avwap(daily, tzname: str, last_px: float) -> dict:
    look = daily[-250:]
    anchor_index = min(range(len(look)), key=lambda index: look[index]["l"])
    numerator = 0.0
    denominator = 0.0
    volume_missing = True
    for bar in look[anchor_index:]:
        typical = (bar["h"] + bar["l"] + bar["c"]) / 3
        volume = bar["v"] if bar["v"] and bar["v"] > 0 else 0
        if volume > 0:
            volume_missing = False
        weight = volume if volume > 0 else 1.0
        numerator += typical * weight
        denominator += weight
    value = r2(numerator / denominator) if denominator else r2(last_px)
    anchor = look[anchor_index]
    dist = r2(last_px - value)
    label = "近 250 日最低價（公開行情）"
    if volume_missing:
        label += "；成交量缺失，改為等權典型價"
    if len(look) < 250:
        label = f"近 {len(look)} 日最低價（公開行情，短於 250 日）" + ("；成交量缺失，改為等權典型價" if volume_missing else "")
    return {
        "value": value,
        "anchorDate": ts_date(anchor["t"], tzname),
        "anchorLabel": label,
        "anchorPrice": r2(anchor["l"]),
        "distanceAbs": dist,
        "distancePct": r2(dist / value * 100) if value else 0,
        "priceVersus": price_versus(dist),
    }


def compute_atr(daily) -> dict:
    series = atr_series(daily, 14)
    if not series:
        raise RuntimeError("不足以計算 ATR")
    window = 60 if len(series) >= 60 else len(series)
    baseline_window = series[-window:]
    baseline = sum(baseline_window) / len(baseline_window)
    value = r2(series[-1])
    baseline = r2(baseline)
    ratio = r2(value / baseline) if baseline else 1
    state = atr_state(ratio)
    label_base = f"{window} 個交易日 ATR 均值" if window != 60 else "60 個交易日 ATR 均值"
    return {
        "period": 14,
        "value": value,
        "baseline": baseline,
        "baselineLabel": label_base,
        "ratio": ratio,
        "state": state,
        "label": ATR_LABEL[state],
    }


def atr_series(bars, period: int) -> list[float]:
    true_ranges = []
    for index in range(1, len(bars)):
        true_ranges.append(max(
            bars[index]["h"] - bars[index]["l"],
            abs(bars[index]["h"] - bars[index - 1]["c"]),
            abs(bars[index]["l"] - bars[index - 1]["c"]),
        ))
    if len(true_ranges) < period:
        return []
    value = sum(true_ranges[:period]) / period
    series = [value]
    for true_range in true_ranges[period:]:
        value = (value * (period - 1) + true_range) / period
        series.append(value)
    return series


def classify(bars):
    window = bars[-80:] if len(bars) > 80 else bars
    if len(window) < 15:
        return "transition", window[-1]["h"], window[-1]["l"]
    highs, lows = fractals(window, 2)
    swing_high = highs[-1][1] if highs else max(bar["h"] for bar in window[-20:])
    swing_low = lows[-1][1] if lows else min(bar["l"] for bar in window[-20:])
    if len(highs) >= 2 and len(lows) >= 2:
        higher_high = highs[-1][1] > highs[-2][1]
        higher_low = lows[-1][1] > lows[-2][1]
        lower_high = highs[-1][1] < highs[-2][1]
        lower_low = lows[-1][1] < lows[-2][1]
        if higher_high and higher_low:
            return "up", swing_high, swing_low
        if lower_high and lower_low:
            return "down", swing_high, swing_low
    recent = window[-20:]
    hi = max(bar["h"] for bar in recent)
    lo = min(bar["l"] for bar in recent)
    span = max(hi - lo, 1e-9)
    midpoint = (hi + lo) / 2
    if abs(window[-1]["c"] - midpoint) <= 0.25 * span:
        return "range", swing_high, swing_low
    return "transition", swing_high, swing_low


def fractals(bars, wing: int):
    highs = []
    lows = []
    for index in range(wing, len(bars) - wing):
        high = bars[index]["h"]
        low = bars[index]["l"]
        if all(high > bars[index + offset]["h"] for offset in range(-wing, wing + 1) if offset):
            highs.append((index, high))
        if all(low < bars[index + offset]["l"] for offset in range(-wing, wing + 1) if offset):
            lows.append((index, low))
    return highs, lows


def aggregate_4h(bars, tzname: str):
    zone = ZoneInfo(tzname)
    groups = {}
    for bar in bars:
        stamp = datetime.fromtimestamp(bar["t"], zone)
        key = (stamp.date().isoformat(), stamp.hour // 4)
        groups.setdefault(key, []).append(bar)
    merged = []
    for key in sorted(groups):
        group = groups[key]
        merged.append({
            "t": group[-1]["t"],
            "o": group[0]["o"],
            "h": max(bar["h"] for bar in group),
            "l": min(bar["l"] for bar in group),
            "c": group[-1]["c"],
            "v": sum(bar["v"] for bar in group),
        })
    return merged


def fetch_bars(yahoo_symbol: str, interval: str, range_: str):
    query = urllib.parse.urlencode({
        "interval": interval,
        "range": range_,
        "includePrePost": "false",
        "events": "history",
    })
    quoted = urllib.parse.quote(yahoo_symbol, safe="")
    urls = [
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quoted}?{query}",
        f"https://query2.finance.yahoo.com/v8/finance/chart/{quoted}?{query}",
    ]
    last_error = None
    for attempt in range(1, 4):
        for url in urls:
            request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                return bars_from_chart(payload)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "replace")[:300]
                last_error = RuntimeError(f"公開行情 HTTP {exc.code} {detail}")
                if exc.code not in {429, 500, 502, 503, 504} and attempt == 1 and "query1" in url:
                    continue
                if exc.code not in {429, 500, 502, 503, 504} and "query2" in url:
                    # 非暫時性錯誤，換下一個 host 或結束這輪
                    continue
            except urllib.error.URLError as exc:
                last_error = RuntimeError(f"公開行情連線失敗：{exc.reason}")
            except Exception as exc:  # noqa: BLE001
                last_error = RuntimeError(str(exc))
        time.sleep(min(2 ** attempt, 8))
    raise last_error or RuntimeError("公開行情讀取失敗")


def bars_from_chart(payload):
    chart = payload.get("chart") or {}
    result = chart.get("result") or []
    if not result:
        raise RuntimeError(str(chart.get("error") or "沒有行情結果"))
    block = result[0]
    timestamps = block.get("timestamp") or []
    quote = ((block.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    bars = []
    for index, stamp in enumerate(timestamps):
        try:
            open_, high, low, close = opens[index], highs[index], lows[index], closes[index]
        except IndexError:
            continue
        if None in (open_, high, low, close):
            continue
        volume = volumes[index] if index < len(volumes) and volumes[index] else 0
        bars.append({
            "t": int(stamp),
            "o": float(open_),
            "h": float(high),
            "l": float(low),
            "c": float(close),
            "v": float(volume or 0),
        })
    if not bars:
        raise RuntimeError("沒有可用的 K 線")
    return bars


def ts_date(stamp: int, tzname: str) -> str:
    return datetime.fromtimestamp(stamp, ZoneInfo(tzname)).date().isoformat()


def without_stale_demo_prices(sources):
    price_fields = {"price", "movingAverages", "avwap", "atr", "structure"}
    kept = []
    for source in sources:
        fields = set(source.get("appliesTo") or [])
        if source.get("kind") == "demo" and fields and fields <= price_fields:
            continue
        kept.append(source)
    return kept


def upsert_source(sources, source):
    kept = [item for item in sources if item.get("id") != source["id"]]
    kept.append(source)
    return kept


def refresh_gemini(prefer: Path | None) -> Path | None:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("未設定 GEMINI_API_KEY，保留示範短評。金鑰只從環境變數讀取，不要寫進網頁或檔案。")
        return prefer
    config = load_gemini_config()
    source = prefer if prefer and prefer.exists() else DEMO_PATH
    doc = load_json(source)
    model_id, how = resolve_model(config, key)
    print(f"短評使用模型：{model_id}（{how}）")
    failures = []
    done = 0
    for item in doc["symbols"]:
        try:
            comment = request_comment(config, key, model_id, item)
            if item["flow"].get("isDemo") and "示範" not in comment:
                comment += "資金流為示範數據，不是真實大單或持倉。"
            item["commentary"] = {
                "locale": "zh-HK",
                "origin": "model",
                "label": "模型生成",
                "text": comment,
                "modelId": model_id,
                "generatedAt": now_hkt(),
            }
            item["sources"] = upsert_source(item.get("sources") or [], {
                "id": f"gemini-{item['symbol']}",
                "kind": "model_commentary",
                "title": "模型短評",
                "detail": f"短評由 Gemini 結構化輸出生成，模型 id 為 {model_id}。若資金流標了示範，這段文字不是真實大單。",
                "appliesTo": ["commentary"],
            })
            done += 1
            print(f"已重寫短評：{item['symbol']}")
        except Exception as exc:  # noqa: BLE001 — 保留其他代號已寫好的短評
            failures.append(f"{item['symbol']}: {redact(str(exc), key)}")
    if done == 0:
        print("沒有任何短評完成。")
        for item in failures:
            print(f"- {item}")
        sys.exit(1)
    doc["sources"] = upsert_source(doc.get("sources") or [], {
        "id": "gemini-commentary",
        "kind": "model_commentary",
        "title": "Gemini 短評",
        "detail": f"部分短評由模型 {model_id} 生成。模型 id 來自 config/gemini.json，或在留空時從當時的模型列表發現。這不是交易指示。",
        "appliesTo": ["commentary"],
    })
    schema = load_json(SCHEMA_PATH)
    errors = schema_errors(doc, schema)
    if errors:
        print("短評結果不符合合約，未寫入檔案：")
        for item in errors[:20]:
            print(f"- {item}")
        sys.exit(1)
    save_json(COMMENTARY_PATH, doc)
    for item in failures:
        print(f"警告：{item}")
    print(f"已寫入 {COMMENTARY_PATH.relative_to(ROOT).as_posix()}")
    return COMMENTARY_PATH


def load_gemini_config() -> dict:
    cfg = load_json(GEMINI_CONFIG)
    assert_no_secrets(cfg)
    model_id = cfg.get("modelId") or ""
    if not isinstance(model_id, str):
        raise SystemExit("config/gemini.json 的 modelId 必須是字串")
    model_id = model_id.strip()
    if model_id.startswith("models/"):
        model_id = model_id.split("/", 1)[1]
    if model_id and (len(model_id) > 80 or model_id.startswith("AIza") or not re.fullmatch(r"[A-Za-z0-9._-]+", model_id)):
        raise SystemExit("modelId 看起來不像模型 id。不要把 API 金鑰寫進 config/gemini.json。")
    base = str(cfg.get("apiBase") or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" or parsed.hostname != "generativelanguage.googleapis.com":
        raise SystemExit("apiBase 只接受 https://generativelanguage.googleapis.com")
    return {
        "modelId": model_id,
        "discoverWhenEmpty": bool(cfg.get("discoverWhenEmpty", True)),
        "maxDiscoveryProbes": int(cfg.get("maxDiscoveryProbes") or 6),
        "temperature": float(cfg.get("temperature") or 0.3),
        "maxOutputTokens": int(cfg.get("maxOutputTokens") or 512),
        "apiBase": base,
    }


def assert_no_secrets(cfg) -> None:
    banned = {"apikey", "api_key", "secret", "password", "token", "gemini_api_key"}

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key.lower().replace("-", "_") in banned:
                    raise SystemExit("config/gemini.json 不應存放金鑰。請只用環境變數 GEMINI_API_KEY。")
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, str) and re.search(r"AIza[0-9A-Za-z_-]{20,}", node):
            raise SystemExit("config/gemini.json 含有看起來像 API 金鑰的字串。請刪除。")

    walk(cfg)


def resolve_model(config: dict, key: str) -> tuple[str, str]:
    if config["modelId"]:
        return config["modelId"], "來自 config/gemini.json"
    if not config["discoverWhenEmpty"]:
        raise SystemExit("config/gemini.json 沒有 modelId，而且未開啟自動發現。")
    models = [model for model in list_models(config["apiBase"], key) if eligible_model(model)]
    models.sort(key=lambda model: (unstable_model(model), (model.get("name") or "")))
    probes = 0
    for model in models:
        if probes >= config["maxDiscoveryProbes"]:
            break
        name = (model.get("name") or "").split("/")[-1]
        probes += 1
        try:
            if probe_model(config, key, name):
                return name, "從目前模型列表發現，並通過結構化輸出測試"
        except Exception as exc:  # noqa: BLE001 — 換下一個支援結構化輸出的模型
            print(f"跳過 {name}：{redact(str(exc), key)}")
    raise SystemExit("沒有發現支援結構化輸出的 Gemini 模型。可在 config/gemini.json 填上 modelId 後再試。")


def eligible_model(model) -> bool:
    name = (model.get("name") or "").lower()
    short = name.split("/")[-1]
    if "gemini" not in short:
        return False
    blocked = ("embedding", "imagen", "image", "veo", "aqa", "tts", "audio", "live", "robot", "computer-use", "gemma")
    if any(part in short for part in blocked):
        return False
    methods = model.get("supportedGenerationMethods") or model.get("supportedActions") or []
    return any(str(method).lower() == "generatecontent" for method in methods)


def unstable_model(model) -> bool:
    name = (model.get("name") or "").lower()
    return any(tag in name for tag in ("exp", "preview", "experimental"))


def list_models(base: str, key: str):
    models = []
    token = None
    for _ in range(10):
        query = {"pageSize": "100"}
        if token:
            query["pageToken"] = token
        url = f"{base}/models?{urllib.parse.urlencode(query)}"
        payload = http_json(url, key)
        models.extend(payload.get("models") or [])
        token = payload.get("nextPageToken")
        if not token:
            break
    return models


def probe_model(config: dict, key: str, model_id: str) -> bool:
    text = generate_structured(config, key, model_id, "請在 comment 寫上 ok。", 32, 0)
    data = json.loads(text)
    return isinstance(data.get("comment"), str) and bool(data["comment"].strip())


def request_comment(config: dict, key: str, model_id: str, item) -> str:
    payload = {
        "symbol": item["symbol"],
        "name": item["name"],
        "market": item["market"],
        "quote": item["quote"],
        "structure": {
            key: {"label": frame["label"], "summary": frame["summary"]}
            for key, frame in item["structure"].items()
        },
        "movingAverages": item["movingAverages"],
        "avwap": item["avwap"],
        "atr": item["atr"],
        "flow": item["flow"],
        "connectFlow": item.get("connectFlow"),
        "alerts": item["alerts"],
    }
    prompt = (
        "你是個人讀圖筆記助手。請只根據下面這份已計算的摘要，用繁體中文（香港用語）寫一段 80 至 140 字的短評。\n"
        "必須遵守：\n"
        "- 這是分析呈現，不要建議買入、賣出、加倉、減倉、目標價或落單。\n"
        "- 不要提及帳戶、持倉、保證金或倉位大小。\n"
        "- 若 flow.isDemo 為 true，或 connectFlow.isDemo 為 true，必須寫明有關資金流是示範數據，不是真實大單、暗池、經紀流向或持倉。\n"
        "- 若 quote.priceKind 為 demo，價格也要稱為示範快照；若為 public_ohlcv，價格可稱為公開行情，但仍不可把價格說成資金流。\n"
        "- 只點評市場結構、均線距離、AVWAP、ATR 狀態，以及資金流方向是否構成派發（新高配大單淨流出）或吸籌（回測支持配大單淨流入）。\n\n"
        f"資料：\n{json.dumps(payload, ensure_ascii=False)}\n"
    )
    text = generate_structured(config, key, model_id, prompt, config["maxOutputTokens"], config["temperature"])
    data = json.loads(strip_fence(text))
    comment = data.get("comment")
    if not isinstance(comment, str) or len(comment.strip()) < 40:
        raise RuntimeError("模型沒有交回足夠的 comment")
    return comment.strip()


def generate_structured(config, key: str, model_id: str, prompt: str, max_tokens: int, temperature: float) -> str:
    schemas = [
        {"type": "OBJECT", "properties": {"comment": {"type": "STRING"}}, "required": ["comment"]},
        {"type": "object", "properties": {"comment": {"type": "string"}}, "required": ["comment"]},
    ]
    last_error = None
    for response_schema in schemas:
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
                "responseMimeType": "application/json",
                "responseSchema": response_schema,
            },
        }
        url = f"{config['apiBase']}/models/{urllib.parse.quote(model_id)}:generateContent"
        try:
            payload = http_json(url, key, body)
            return extract_text(payload)
        except RuntimeError as exc:
            last_error = exc
    raise RuntimeError(redact(str(last_error), key))


def extract_text(payload) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("模型沒有候選回覆")
    parts = ((candidates[0].get("content") or {}).get("parts") or [])
    texts = [part.get("text", "") for part in parts if isinstance(part, dict)]
    text = "\n".join(texts).strip()
    if not text:
        raise RuntimeError("模型回覆是空的")
    return strip_fence(text)


def strip_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    return cleaned


def http_json(url: str, key: str, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST" if payload is not None else "GET")
    request.add_header("Accept", "application/json")
    request.add_header("x-goog-api-key", key)
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = redact(exc.read().decode("utf-8", "replace")[:800], key)
        raise RuntimeError(f"HTTP {exc.code} {body}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"連線失敗：{exc.reason}") from None


def redact(text: str, key: str) -> str:
    if key:
        text = text.replace(key, "[redacted]")
    return text


def serve(port: int, extra: Path | None) -> None:
    handler = handler_factory(ROOT)
    bound = None
    server = None
    for candidate in range(port, port + 10):
        try:
            server = ThreadingHTTPServer(("0.0.0.0", candidate), handler)
            bound = candidate
            break
        except OSError:
            continue
    if server is None or bound is None:
        raise SystemExit(f"由 {port} 起連續 10 個埠都無法使用")
    print(f"本地預覽：http://127.0.0.1:{bound}/")
    if extra is not None:
        relative = extra.relative_to(ROOT).as_posix()
        print(f"今次輸出：http://127.0.0.1:{bound}/?data={relative}")
    print("私人草稿，請不要發佈到公開網址。按 Ctrl+C 結束。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止預覽。")
    finally:
        server.server_close()


def handler_factory(directory: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            super().end_headers()

        def log_message(self, fmt, *args):
            print("[preview]", self.address_string(), fmt % args)

    return Handler


def run_self_test() -> None:
    closes = list(range(1, 21))
    assert sum(closes[-5:]) / 5 == 18
    bars = []
    for index, close in enumerate(closes):
        bars.append({"t": index, "o": close, "h": close + 1, "l": close - 0.5, "c": close, "v": 10})
    series = atr_series(bars, 14)
    assert series, "ATR 應該算得出來"
    assert atr_state(0.8) == "contraction"
    assert atr_state(1.0) == "neutral"
    assert atr_state(1.3) == "expansion"
    assert ATR_LABEL[atr_state(1.3)] == "擴張"
    rising = zigzag([10, 14, 11, 16, 13, 18, 15, 20])
    bias, _high, _low = classify(rising)
    assert bias == "up", bias
    falling = zigzag([20, 16, 18, 13, 15, 11, 12, 8])
    bias, _high, _low = classify(falling)
    assert bias == "down", bias
    merged = aggregate_4h(
        [{"t": 1_700_000_000 + hour * 3600, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 1} for hour in range(8)],
        "Asia/Hong_Kong",
    )
    assert len(merged) >= 2


def zigzag(points: list[float]):
    bars = []
    stamp = 0
    for start, end in zip(points, points[1:]):
        for step in range(6):
            price = start + (end - start) * step / 6
            bars.append({"t": stamp, "o": price, "h": price + 0.2, "l": price - 0.2, "c": price, "v": 1000})
            stamp += 1
    return bars


if __name__ == "__main__":
    main()
