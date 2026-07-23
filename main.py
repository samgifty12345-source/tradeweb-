import os
import uuid
import json
from typing import Dict

import httpx
from fastapi import FastAPI, HTTPException, Body, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from metaapi_cloud_sdk import MetaApi

METAAPI_TOKEN = os.getenv("METAAPI_TOKEN")
if not METAAPI_TOKEN:
    raise RuntimeError("METAAPI_TOKEN env var is not set")

api = MetaApi(METAAPI_TOKEN)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# accountId -> live RPC connection (in-memory; fine for single-user/dev use)
connections: Dict[str, object] = {}


async def _connect_account(login: str, password: str, server: str, platform: str = "mt5"):
    """Shared connect logic — used by both the manual login and the autotrade loop.
    MetaApi keeps the account deployed/running in ITS OWN cloud once deployed, so this
    reconnects to that same always-on instance rather than spinning up anything new."""
    account_api = api.metatrader_account_api

    existing_accounts = await account_api.get_accounts_with_infinite_scroll_pagination()
    account = next(
        (a for a in existing_accounts if a.login == login and a.server == server),
        None,
    )

    if account is None:
        account = await account_api.create_account(
            {
                "name": f"{login}-{server}-{uuid.uuid4().hex[:6]}",
                "type": "cloud",
                "login": login,
                "password": password,
                "server": server,
                "platform": platform,
                "magic": 1000,
            }
        )

    await account.deploy()
    await account.wait_connected()

    connection = account.get_rpc_connection()
    await connection.connect()
    await connection.wait_synchronized()

    connections[account.id] = connection
    return account.id, connection


@app.post("/api/connect")
async def connect(payload: dict = Body(...)):
    login = payload.get("login")
    password = payload.get("password")
    server = payload.get("server")
    platform = payload.get("platform", "mt5")

    if not all([login, password, server]):
        raise HTTPException(400, "login, password, server are required")

    try:
        account_id, _ = await _connect_account(login, password, server, platform)
        return {"accountId": account_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Connect failed: {str(e)}")


def _get_connection(account_id: str):
    conn = connections.get(account_id)
    if not conn:
        raise HTTPException(404, "No active connection for this accountId. Call /api/connect again.")
    return conn


@app.get("/api/account/{account_id}")
async def get_account_info(account_id: str):
    conn = _get_connection(account_id)
    info = await conn.get_account_information()
    return info


@app.get("/api/positions/{account_id}")
async def get_positions(account_id: str):
    conn = _get_connection(account_id)
    positions = await conn.get_positions()
    return positions


@app.get("/api/price/{account_id}/{symbol}")
async def get_price(account_id: str, symbol: str):
    conn = _get_connection(account_id)
    price = await conn.get_symbol_price(symbol)
    return price


async def _place_trade(conn, symbol: str, side: str, volume: float, sl=None, tp=None):
    opts = {}
    if sl:
        opts["stopLoss"] = float(sl)
    if tp:
        opts["takeProfit"] = float(tp)

    if side == "buy":
        return await conn.create_market_buy_order(symbol, float(volume), **opts)
    elif side == "sell":
        return await conn.create_market_sell_order(symbol, float(volume), **opts)
    else:
        raise HTTPException(400, "side must be 'buy' or 'sell'")


@app.post("/api/trade/{account_id}")
async def place_trade(account_id: str, payload: dict = Body(...)):
    conn = _get_connection(account_id)
    symbol = payload.get("symbol")
    side = payload.get("side")
    volume = payload.get("volume")
    sl = payload.get("sl")
    tp = payload.get("tp")

    if not all([symbol, side, volume]):
        raise HTTPException(400, "symbol, side, volume are required")

    return await _place_trade(conn, symbol, side, volume, sl, tp)


@app.post("/api/close/{account_id}/{position_id}")
async def close_position(account_id: str, position_id: str):
    conn = _get_connection(account_id)
    result = await conn.close_position(position_id)
    return result


TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "")


async def _fetch_candles(symbol: str, interval: str = "15min", outputsize: int = 50):
    if not TWELVEDATA_API_KEY:
        raise HTTPException(500, "TWELVEDATA_API_KEY is not set on the server")

    # Twelve Data wants "XAU/USD" style, not "XAUUSD" — normalize either input
    clean = symbol.upper().replace(" ", "")
    if "/" not in clean and len(clean) == 6:
        clean = f"{clean[:3]}/{clean[3:]}"

    url = "https://api.twelvedata.com/time_series"
    params = {
        "symbol": clean,
        "interval": interval,
        "outputsize": outputsize,
        "apikey": TWELVEDATA_API_KEY,
    }
    async with httpx.AsyncClient() as client:
        r = await client.get(url, params=params)

    if r.status_code != 200:
        raise HTTPException(502, "Failed to fetch chart data")

    data = r.json()
    if data.get("status") == "error":
        raise HTTPException(502, data.get("message", "Chart data source returned an error"))

    values = data.get("values", [])
    candles = [
        {
            "time": v["datetime"],
            "open": float(v["open"]),
            "high": float(v["high"]),
            "low": float(v["low"]),
            "close": float(v["close"]),
        }
        for v in reversed(values)
    ]
    return candles


@app.get("/api/chart")
async def get_chart(symbol: str, interval: str = "5min", outputsize: int = 100):
    candles = await _fetch_candles(symbol, interval, outputsize)
    return {"symbol": symbol.upper(), "candles": candles}


# ---------------- Autotrade (AI-driven, triggered by a free external cron) ----------------

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
AUTOTRADE_SECRET = os.getenv("AUTOTRADE_SECRET", "")
MT_LOGIN = os.getenv("MT_LOGIN", "")
MT_PASSWORD = os.getenv("MT_PASSWORD", "")
MT_SERVER = os.getenv("MT_SERVER", "")
MT_PLATFORM = os.getenv("MT_PLATFORM", "mt5")
TRADE_SYMBOL = os.getenv("TRADE_SYMBOL", "XAUUSD")
TRADE_VOLUME = float(os.getenv("TRADE_VOLUME", "0.01"))
MAX_OPEN_POSITIONS = int(os.getenv("MAX_OPEN_POSITIONS", "1"))

GEMINI_MODEL = "gemini-2.5-flash"

STRATEGY_PROMPT = """You are a disciplined ICT / Smart Money Concepts forex and gold trader.
You will be given the most recent {n} candles for {symbol} on the {interval} timeframe,
oldest first, as JSON: [{{time, open, high, low, close}}, ...].

Analyze the candles for: liquidity sweeps, break of structure (BOS), change of character (CHoCH),
fair value gaps (FVG), and order blocks. Only recommend a trade when there is a clear, high-probability
setup. Most of the time the correct answer is "hold" — do not force a trade.

Respond with ONLY raw JSON (no markdown, no code fences, no extra text), in exactly this shape:
{{"action": "buy" | "sell" | "hold", "stop_loss": number | null, "take_profit": number | null, "reason": "one short sentence"}}

stop_loss and take_profit must be realistic absolute prices for {symbol}, consistent with recent price levels.
If action is "hold", stop_loss and take_profit must be null.
Candles:
{candles_json}
"""


async def _ask_gemini(symbol: str, interval: str, candles: list) -> dict:
    if not GEMINI_API_KEY:
        raise HTTPException(500, "GEMINI_API_KEY is not set on the server")

    prompt = STRATEGY_PROMPT.format(
        n=len(candles),
        symbol=symbol,
        interval=interval,
        candles_json=json.dumps(candles),
    )

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    headers = {"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"}
    body = {"contents": [{"parts": [{"text": prompt}]}]}

    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(url, headers=headers, json=body)

    if r.status_code != 200:
        raise HTTPException(502, f"Gemini call failed: {r.text[:300]}")

    data = r.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        raise HTTPException(502, f"Unexpected Gemini response: {json.dumps(data)[:300]}")

    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    text = text.strip()

    try:
        decision = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(502, f"Gemini did not return valid JSON: {text[:300]}")

    return decision


from datetime import datetime, timezone

autotrade_log = []  # in-memory log of recent AI decisions, newest last


@app.get("/api/autotrade")
async def autotrade(secret: str = Query(...)):
    """Hit this URL from a free external cron (e.g. cron-job.org) every 15 min.
    Runs while you sleep — no separate server/VPS needed, since MetaApi already
    keeps the MT5 account deployed and connected in its own cloud."""
    if not AUTOTRADE_SECRET or secret != AUTOTRADE_SECRET:
        raise HTTPException(403, "Invalid secret")

    if not all([MT_LOGIN, MT_PASSWORD, MT_SERVER]):
        raise HTTPException(500, "MT_LOGIN, MT_PASSWORD, MT_SERVER env vars must be set for autotrade")

    entry = {"time": datetime.now(timezone.utc).isoformat()}
    try:
        account_id, conn = await _connect_account(MT_LOGIN, MT_PASSWORD, MT_SERVER, MT_PLATFORM)

        positions = await conn.get_positions()
        if len(positions) >= MAX_OPEN_POSITIONS:
            entry.update({"status": "skipped", "reason": f"{len(positions)} open position(s), max is {MAX_OPEN_POSITIONS}"})
            autotrade_log.append(entry)
            del autotrade_log[:-50]
            return entry

        candles = await _fetch_candles(TRADE_SYMBOL, interval="15min", outputsize=50)
        decision = await _ask_gemini(TRADE_SYMBOL, "15min", candles)

        action = decision.get("action", "hold")
        if action not in ("buy", "sell"):
            entry.update({"status": "hold", "decision": decision})
            autotrade_log.append(entry)
            del autotrade_log[:-50]
            return entry

        result = await _place_trade(
            conn, TRADE_SYMBOL, action, TRADE_VOLUME,
            sl=decision.get("stop_loss"), tp=decision.get("take_profit"),
        )
        entry.update({"status": "trade_placed", "decision": decision, "result": str(result)})
        autotrade_log.append(entry)
        del autotrade_log[:-50]
        return entry

    except HTTPException as e:
        entry.update({"status": "error", "reason": str(e.detail)})
        autotrade_log.append(entry)
        del autotrade_log[:-50]
        raise
    except Exception as e:
        entry.update({"status": "error", "reason": str(e)})
        autotrade_log.append(entry)
        del autotrade_log[:-50]
        raise HTTPException(502, f"Autotrade failed: {str(e)}")


@app.get("/api/autotrade/log")
async def get_autotrade_log():
    return list(reversed(autotrade_log))


# serve the frontend
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")
