import os
import uuid
from typing import Dict

import httpx
from fastapi import FastAPI, HTTPException, Body
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


@app.post("/api/connect")
async def connect(payload: dict = Body(...)):
    login = payload.get("login")
    password = payload.get("password")
    server = payload.get("server")
    platform = payload.get("platform", "mt5")  # "mt4" or "mt5"

    if not all([login, password, server]):
        raise HTTPException(400, "login, password, server are required")

    account_api = api.metatrader_account_api

    # reuse an existing MetaApi account entry if we've already registered this login+server
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

    return {"accountId": account.id}


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


@app.post("/api/trade/{account_id}")
async def place_trade(account_id: str, payload: dict = Body(...)):
    conn = _get_connection(account_id)

    symbol = payload.get("symbol")
    side = payload.get("side")  # "buy" or "sell"
    volume = payload.get("volume")
    sl = payload.get("sl")
    tp = payload.get("tp")

    if not all([symbol, side, volume]):
        raise HTTPException(400, "symbol, side, volume are required")

    opts = {}
    if sl:
        opts["stopLoss"] = float(sl)
    if tp:
        opts["takeProfit"] = float(tp)

    if side == "buy":
        result = await conn.create_market_buy_order(symbol, float(volume), **opts)
    elif side == "sell":
        result = await conn.create_market_sell_order(symbol, float(volume), **opts)
    else:
        raise HTTPException(400, "side must be 'buy' or 'sell'")

    return result


@app.post("/api/close/{account_id}/{position_id}")
async def close_position(account_id: str, position_id: str):
    conn = _get_connection(account_id)
    result = await conn.close_position(position_id)
    return result


TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "")


@app.get("/api/chart/{symbol}")
async def get_chart(symbol: str, interval: str = "5min", outputsize: int = 100):
    """Free live candle data via Twelve Data (works from servers, unlike Yahoo's
    endpoint which frequently blocks non-browser traffic). Free API key required —
    sign up at twelvedata.com, no card needed."""
    if not TWELVEDATA_API_KEY:
        raise HTTPException(500, "TWELVEDATA_API_KEY is not set on the server")

    url = "https://api.twelvedata.com/time_series"
    params = {
        "symbol": symbol.upper(),
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

    return {"symbol": symbol.upper(), "candles": candles}


# serve the frontend
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    return FileResponse("static/index.html")
