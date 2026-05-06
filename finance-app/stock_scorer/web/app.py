"""FastAPI backend for the Stock Scorer web dashboard.

Exposes:
  GET  /            → index.html
  GET  /api/state   → last computed state (JSON)
  WS   /ws          → live streaming updates (JSON)
"""

import asyncio
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..scorer import ScoringModel, score_tickers
from ..patterns import load_patterns
from ..positions import load_positions, Position
from ..live_monitor import fetch_current_prices
from ..intraday import build_intraday_features_parallel
from ..config import SP100_TICKERS, QUICK_TICKERS, SP500_EXTENDED

BASE_DIR = Path(__file__).parent

app = FastAPI(title="Stock Scorer Dashboard")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

# ─── Shared state ─────────────────────────────────────────────────────────────
_state: dict[str, Any] = {
    "cycle": 0,
    "timestamp": "",
    "model_kind": "Heurístico",
    "tickers": QUICK_TICKERS,
    "scores": [],
    "positions": [],
    "orders": [],
    "refresh": 30,
}

_clients: list[WebSocket] = []


# ─── Serializers ──────────────────────────────────────────────────────────────

def _nan_safe(v):
    """Return None if NaN, else the value."""
    try:
        if v != v:
            return None
        return v
    except TypeError:
        return v


def _score_to_dict(r, intra=None) -> dict:
    verdict_text, verdict_reasons = r.verdict
    d = {
        "ticker": r.ticker,
        "score": round(r.score, 3),
        "last_price": round(r.last_price, 2) if _nan_safe(r.last_price) else None,
        "rsi": round(r.rsi, 1) if _nan_safe(r.rsi) else None,
        "p_up": round(r.p_up, 3) if _nan_safe(r.p_up) else None,
        "p_down": round(r.p_down, 3) if _nan_safe(r.p_down) else None,
        "expected_return": round(r.expected_return * 100, 2) if _nan_safe(r.expected_return) else None,
        "action": r.action,
        "verdict": verdict_text,
        "verdict_reasons": verdict_reasons,
        "verdict_color": r.verdict_color,
        "intra_signal": None,
        "vwap_dist": None,
        "momentum_1h": None,
        "trade_plan": None,
    }
    if r.trade_plan:
        d["trade_plan"] = {
            "entry": round(r.trade_plan.entry, 2),
            "stop_loss": round(r.trade_plan.stop_loss, 2),
            "take_profit": round(r.trade_plan.take_profit, 2),
            "risk_pct": round(r.trade_plan.risk_pct * 100, 2),
            "reward_pct": round(r.trade_plan.reward_pct * 100, 2),
            "risk_reward": round(r.trade_plan.risk_reward, 2),
            "position_size_pct": round(r.trade_plan.position_size_pct * 100, 1),
        }
    if intra and intra.n_bars > 0:
        d["intra_signal"] = intra.signal
        d["vwap_dist"] = round(intra.vwap_dist * 100, 2) if _nan_safe(intra.vwap_dist) else None
        d["momentum_1h"] = round(intra.momentum_1h * 100, 2) if _nan_safe(intra.momentum_1h) else None
    return d


def _position_to_dict(pos: Position, current_price: float | None) -> dict:
    pnl = pos.pnl_pct(current_price) if current_price else None
    dist_sl = pos.distance_to_sl(current_price) if current_price else None
    dist_tp = pos.distance_to_tp(current_price) if current_price else None

    alert = None
    if current_price:
        if current_price <= pos.stop_loss:
            alert = "VENDER YA"
        elif current_price >= pos.take_profit:
            alert = "TOMAR GANANCIA"
        elif dist_sl is not None and dist_sl <= 0.01:
            alert = "CERCA DEL SL"
        elif dist_tp is not None and dist_tp <= 0.01:
            alert = "CERCA DEL TP"

    return {
        "ticker": pos.ticker,
        "entry_price": pos.entry_price,
        "stop_loss": pos.stop_loss,
        "take_profit": pos.take_profit,
        "shares": pos.shares,
        "entry_date": pos.entry_date,
        "horizon_days": pos.horizon_days,
        "days_open": pos.days_open,
        "notes": pos.notes,
        "current_price": round(current_price, 2) if current_price else None,
        "pnl_pct": round(pnl * 100, 2) if pnl is not None else None,
        "pnl_usd": round((current_price - pos.entry_price) * pos.shares, 2) if current_price else None,
        "dist_sl_pct": round(dist_sl * 100, 2) if dist_sl is not None else None,
        "dist_tp_pct": round(dist_tp * 100, 2) if dist_tp is not None else None,
        "market_value": round(current_price * pos.shares, 2) if current_price else None,
        "cost_basis": round(pos.entry_price * pos.shares, 2),
        "alert": alert,
    }


# ─── Broadcast ────────────────────────────────────────────────────────────────

async def broadcast(data: dict) -> None:
    dead = []
    for ws in _clients:
        try:
            await ws.send_json(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in _clients:
            _clients.remove(ws)


# ─── Background scoring loop ──────────────────────────────────────────────────

async def scoring_loop(refresh: int, no_intraday: bool) -> None:
    loop = asyncio.get_event_loop()
    model = await loop.run_in_executor(None, ScoringModel.load)
    patterns = await loop.run_in_executor(None, load_patterns)

    if model.is_trained() and model.clf_up is not None:
        _state["model_kind"] = "XGBoost + P(↑↓)"
    elif model.is_trained():
        _state["model_kind"] = "XGBoost"
    if patterns:
        _state["model_kind"] += f" · {len(patterns)} patrones"

    _state["refresh"] = refresh

    while True:
        try:
            tickers = _state["tickers"]

            results = await loop.run_in_executor(
                None, lambda: score_tickers(tickers, model=model, patterns=patterns)
            )

            intra_map: dict = {}
            if not no_intraday:
                intra_map = await loop.run_in_executor(
                    None, lambda: build_intraday_features_parallel(tickers, days=2)
                )

            scores_list = [_score_to_dict(r, intra_map.get(r.ticker)) for r in results]
            orders = [s for s in scores_list
                      if s["verdict"] in ("COMPRAR YA", "COMPRAR (parcial)", "VENDER SI TIENES")]

            positions = await loop.run_in_executor(None, load_positions)
            pos_tickers = [p.ticker for p in positions]
            prices: dict = {}
            if pos_tickers:
                prices = await loop.run_in_executor(
                    None, lambda: fetch_current_prices(pos_tickers)
                )
            positions_list = [_position_to_dict(p, prices.get(p.ticker)) for p in positions]

            _state["cycle"] += 1
            _state["timestamp"] = time.strftime("%H:%M:%S")
            _state["scores"] = scores_list
            _state["positions"] = positions_list
            _state["orders"] = orders

            await broadcast({
                "type": "update",
                "cycle": _state["cycle"],
                "timestamp": _state["timestamp"],
                "model_kind": _state["model_kind"],
                "refresh": refresh,
                "scores": scores_list,
                "positions": positions_list,
                "orders": orders,
            })

        except Exception as exc:
            await broadcast({"type": "error", "message": str(exc)})

        await asyncio.sleep(refresh)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "templates" / "index.html")


@app.get("/api/state")
async def get_state():
    return _state


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    _clients.append(ws)
    # Send current state immediately on connect
    if _state["scores"] or _state["positions"]:
        await ws.send_json({
            "type": "update",
            "cycle": _state["cycle"],
            "timestamp": _state["timestamp"],
            "model_kind": _state["model_kind"],
            "refresh": _state["refresh"],
            "scores": _state["scores"],
            "positions": _state["positions"],
            "orders": _state["orders"],
        })
    else:
        await ws.send_json({"type": "loading", "message": "Calculando scores iniciales..."})
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        if ws in _clients:
            _clients.remove(ws)
