"""One-shot public market archive for signal research. No account or order API."""
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SYMBOLS = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR", "LINK-EUR", "ADA-EUR", "DOGE-EUR", "SHIB-EUR", "PEPE-EUR"]
END = int(time.time()) // 900 * 900
START = END - 31 * 86400
RUN_ID = datetime.fromtimestamp(END, timezone.utc).strftime("%Y-%m-%dT%H%MZ")
OUT = ROOT / "reports" / "execution-v1" / RUN_ID
OUT.mkdir(parents=True, exist_ok=False)
(OUT / "raw").mkdir()
records = []
next_request = 0.0


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def get_public(name, path, query):
    global next_request
    if not path.startswith(("/api/1.0/public/", "/api/2.0/public/")):
        raise ValueError("public_endpoints_only")
    url = "https://revx.revolut.com" + path + "?" + urllib.parse.urlencode(query)
    time.sleep(max(0, next_request - time.monotonic()))
    next_request = time.monotonic() + 1.15
    observed = datetime.now(timezone.utc).isoformat()
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Mirsad-ReadOnly-Research/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            content = response.read(5_000_001)
            status = response.status
        if len(content) > 5_000_000:
            raise ValueError("response_too_large")
        data = json.loads(content)
        (OUT / "raw" / (name + ".json")).write_bytes(content)
        record = {"name": name, "url": url, "observedAt": observed, "status": status,
                  "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content),
                  "returnedRows": len(data.get("data", [])) if isinstance(data, dict) and isinstance(data.get("data"), list) else None}
    except urllib.error.HTTPError as error:
        record = {"name": name, "url": url, "observedAt": observed, "status": error.code, "error": "http_error"}
        data = None
        if error.code in (401, 403, 429):
            records.append(record)
            write_json(OUT / "requests.json", records)
            raise RuntimeError("access_or_rate_limit_stop_" + str(error.code)) from error
    except (OSError, ValueError) as error:
        record = {"name": name, "url": url, "observedAt": observed, "status": None, "error": str(error)}
        data = None
    records.append(record)
    write_json(OUT / "requests.json", records)
    return data


files = ["config/execution-v1.json", "src/lib/execution/v1/model.ts", "src/lib/execution/v1/strategy.ts", "src/lib/execution/v1/historical.ts"]
manifest = {
    "kind": "source_signal_research_only", "createdAt": datetime.now(timezone.utc).isoformat(),
    "gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    "symbols": SYMBOLS, "region": "EEA", "intervalSeconds": 900,
    "requestedStart": START, "requestedEnd": END, "olderProbeDaysAgo": [60, 90, 180],
    "source": "Revolut X public EEA", "accountRead": False, "ordersSubmitted": False,
    "strategyFiles": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files},
    "config": json.loads((ROOT / files[0]).read_text()),
    "predefinedAnalysis": {
        "warmupBars": 1000, "forwardBars": [4, 16, 96], "barrierHorizonBars": 96,
        "stopFraction": "0.02", "targetFraction": "0.04", "split": "chronological_equal_halves_after_common_warmup",
        "tuning": False, "universeSelection": "nine_candidates_selected_before_collection; current EUR listings only; not launch-cohort research",
        "executionPnl": None, "benchmark": "same-symbol unconditional forward close change; descriptive only",
        "currentCostFormula": "spread/ask + 2 * current_taker_fee; top-of-book indication only, no historical cost claim",
        "currentTakerFee": "0.0009",
        "feeScheduleVerifiedOn": "2026-09-27",
        "feeSource": "https://cdn.revolut.com/terms_and_conditions/pdf/crypto_exchange_fees_95c20100_1.0.0_1789138348_en.pdf"
    }
}
write_json(OUT / "manifest.json", manifest)
get_public("pairs", "/api/1.0/public/configuration/pairs", {"region": "EEA"})
print(json.dumps({"output": str(OUT), "requestedDays": 31, "symbols": SYMBOLS}), flush=True)
for symbol in SYMBOLS:
    for index, lower in enumerate(range(START, END, 7 * 86400)):
        upper = min(END, lower + 7 * 86400)
        get_public(symbol + "-window-" + str(index), "/api/1.0/public/candles/" + symbol,
                   {"interval": 15, "since": lower * 1000, "until": upper * 1000, "region": "EEA"})
    for days in manifest["olderProbeDaysAgo"]:
        lower = END - days * 86400
        get_public(symbol + "-probe-" + str(days), "/api/1.0/public/candles/" + symbol,
                   {"interval": 15, "since": lower * 1000, "until": (lower + 86400) * 1000, "region": "EEA"})
    get_public(symbol + "-book", "/api/2.0/public/order-book/" + symbol, {"limit": 50, "region": "EEA"})
    print(json.dumps({"collected": symbol, "completedRequests": len(records)}), flush=True)

# Check whether the same source's public trades expose older observations.
# These samples are retained as evidence only, never converted to replacement candles.
for days in (30, 90):
    lower = END - days * 86400
    data = get_public("BTC-EUR-trades-probe-" + str(days), "/api/1.0/public/trades/all",
                     {"symbol": "BTC-EUR", "start_date": lower * 1000, "end_date": (lower + 86400) * 1000,
                      "limit": 10, "region": "EEA"})
    print(json.dumps({"publicTradesProbeDaysAgo": days, "rows": len(data.get("data", [])) if data else None}), flush=True)

archive_checks = []
lower = (END - 90 * 86400) * 1000
upper = lower + 86400000
for symbol in SYMBOLS:
    query = {"symbol": symbol, "start_date": lower, "end_date": upper, "limit": 100, "region": "EEA"}
    body = get_public(symbol + "-older-trades-first-page", "/api/1.0/public/trades/all", query)
    if body is None:
        archive_checks.append({"symbol": symbol, "error": "public_trade_request_failed"})
        continue
    rows = body.get("data", [])
    valid = all(lower <= row["timestamp"] <= upper and row["symbol"].replace("/", "-") == symbol and row.get("region") == "EEA" for row in rows)
    if not valid:
        raise ValueError("historical_trade_range_or_symbol_mismatch")
    cursor = body.get("metadata", {}).get("next_cursor")
    check = {"symbol": symbol, "requestedFrom": datetime.fromtimestamp(lower / 1000, timezone.utc).isoformat(),
             "requestedUntil": datetime.fromtimestamp(upper / 1000, timezone.utc).isoformat(),
             "firstPageRows": len(rows), "allRowsInRequestedWindowAndRegion": valid,
             "morePages": bool(cursor), "completeDay": not bool(cursor)}
    if symbol == "BTC-EUR" and cursor:
        second = get_public(symbol + "-older-trades-second-page", "/api/1.0/public/trades/all", dict(query, cursor=cursor))
        if second is not None:
            next_rows = second.get("data", [])
            if not all(lower <= row["timestamp"] <= upper and row["symbol"].replace("/", "-") == symbol and row.get("region") == "EEA" for row in next_rows):
                raise ValueError("historical_trade_page_range_mismatch")
            if set(row["id"] for row in rows) & set(row["id"] for row in next_rows):
                raise ValueError("historical_trade_page_duplicate")
            if next_rows and rows and max(row["timestamp"] for row in next_rows) > min(row["timestamp"] for row in rows):
                raise ValueError("historical_trade_page_order_mismatch")
            check.update(secondPageRows=len(next_rows), paginationVerified=True,
                         completeDay=not bool(second.get("metadata", {}).get("next_cursor")))
    archive_checks.append(check)
body = get_public("BTC-EUR-older-candles-until-only", "/api/1.0/public/candles/BTC-EUR",
                  {"interval": 15, "until": upper, "region": "EEA"})
archive_checks.append({"symbol": "BTC-EUR", "alternativeCandleQuery": "until_only_15m_90days",
                       "rows": len(body.get("data", [])) if body is not None else None})
write_json(OUT / "older-archive-checks.json", archive_checks)
manifest["collectionFinishedAt"] = datetime.now(timezone.utc).isoformat()
manifest["requestCount"] = len(records)
manifest["failedRequests"] = sum(row.get("status") != 200 for row in records)
write_json(OUT / "manifest.json", manifest)
print(json.dumps({"finished": str(OUT), "requests": len(records), "failedRequests": manifest["failedRequests"]}), flush=True)
