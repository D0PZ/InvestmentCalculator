"""FastAPI predict service v2.

Modelos soportados (en orden de preferencia):
 1) models/standalone_lgbm.joblib  — v2 features + ATR labels + calibrator
 2) models/tuned_xgb.joblib        — baseline v1 tuneado
 3) models/baseline_xgb.joblib     — baseline v1 default

Endpoints:
  GET  /health                       — estado, modelo, threshold
  POST /reload                       — recarga el modelo desde disco
  POST /predict {symbol, bars}       — score de UN ticker. Si modelo v2, usa cache SPY.
  POST /signals_batch {tickers}      — evalúa N tickers de la watchlist con bars históricos del DB.
                                       Devuelve los que pasan threshold ML.

Setup:
    uvicorn predict_service:app --host 127.0.0.1 --port 8001
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import List, Optional

import joblib
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from features import build_features as build_features_v1, FEATURE_COLS as FEATURE_COLS_V1

try:
    from features_v2 import build_features_v2, FEATURE_COLS_V2
except Exception:
    build_features_v2 = None
    FEATURE_COLS_V2 = []

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")
load_dotenv(ROOT / ".env", override=True)

_db_env = os.getenv("DB_PATH")
if _db_env:
    DB_PATH = Path(_db_env)
    if not DB_PATH.is_absolute():
        DB_PATH = (ROOT.parent / DB_PATH).resolve()
else:
    DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"
PER_TICKER_DIR = MODELS / "per_ticker"
CANDIDATES = [MODELS / "standalone_lgbm.joblib",
              MODELS / "tuned_xgb.joblib",
              MODELS / "baseline_xgb.joblib"]
SPY_REFRESH_SEC = int(os.getenv("ML_SPY_REFRESH_SEC", "60"))

app = FastAPI(title="finance-app ML predict v2")

_state = {
    "model": None, "calibrator": None, "feature_cols": None,
    "loaded_at": None, "meta": None, "version": "v1",
    "model_path": None, "threshold": 0.6, "label_cfg": None,
    "per_ticker": {},  # symbol -> {model, threshold, label_cfg, feature_cols}
}

_spy_cache = {"df": None, "last": 0}
_spy_lock = threading.Lock()


def _load_spy(lookback_minutes: int = 60 * 24 * 5):
    """Carga SPY bars del DB con un lookback configurable (default 5 sesiones)."""
    if not DB_PATH.exists():
        return pd.DataFrame(columns=["ts", "close", "volume"])
    cutoff_ms = int((time.time() - lookback_minutes * 60) * 1000)
    con = sqlite3.connect(str(DB_PATH))
    try:
        df = pd.read_sql_query(
            "SELECT ts, close, volume FROM minute_bars WHERE ticker='SPY' AND ts>=? ORDER BY ts",
            con, params=(cutoff_ms,),
        )
    finally:
        con.close()
    return df


def _ensure_spy_cache():
    if _state["version"] != "v2":
        return None
    with _spy_lock:
        if time.time() - _spy_cache["last"] > SPY_REFRESH_SEC:
            _spy_cache["df"] = _load_spy()
            _spy_cache["last"] = time.time()
        return _spy_cache["df"]


def load_model():
    chosen = next((p for p in CANDIDATES if p.exists()), None)
    if chosen is None:
        raise RuntimeError(f"No model found. Tried: {[str(p) for p in CANDIDATES]}")
    payload = joblib.load(chosen)
    _state["model"] = payload["model"]
    _state["calibrator"] = payload.get("calibrator")
    _state["feature_cols"] = payload.get("feature_cols", FEATURE_COLS_V1)
    _state["meta"] = {k: v for k, v in payload.items() if k not in ("model", "calibrator")}
    _state["threshold"] = float(payload.get("threshold", 0.6))
    _state["label_cfg"] = payload.get("label_cfg")
    _state["model_path"] = str(chosen)
    _state["loaded_at"] = time.time()
    if set(_state["feature_cols"]) == set(FEATURE_COLS_V2 or []):
        _state["version"] = "v2"
    elif "calibrator" in payload:
        _state["version"] = "v2"
    else:
        _state["version"] = "v1"
    print(f"Loaded universal model: {chosen.name}  version={_state['version']}  threshold={_state['threshold']}")

    # Load per-ticker models if present
    _state["per_ticker"] = {}
    if PER_TICKER_DIR.exists():
        for p in PER_TICKER_DIR.glob("*.joblib"):
            sym = p.stem.upper()
            try:
                pt = joblib.load(p)
                metrics = pt.get("metrics") or {}
                best = metrics.get("best") or {}
                _state["per_ticker"][sym] = {
                    "model": pt["model"],
                    "feature_cols": pt.get("feature_cols", FEATURE_COLS_V2),
                    "threshold": float(pt.get("threshold", 0.5)),
                    "label_cfg": pt.get("label_cfg"),
                    "auc": metrics.get("auc"),
                    "winrate": best.get("winrate"),
                    "net_per_trade": best.get("net_per_trade"),
                    "profitable": (best.get("net_per_trade") or 0) > 0,
                    "path": str(p),
                }
            except Exception as e:
                print(f"failed to load per-ticker {p.name}: {e}")
        n = len(_state["per_ticker"])
        profitable = [s for s, m in _state["per_ticker"].items() if m["profitable"]]
        print(f"Loaded {n} per-ticker models, {len(profitable)} marked profitable: {profitable}")


class Bar(BaseModel):
    t: int = Field(..., description="timestamp ms epoch")
    o: float
    h: float
    l: float
    c: float
    v: float = 0.0


class PredictRequest(BaseModel):
    symbol: str
    bars: List[Bar]


class SignalsBatchRequest(BaseModel):
    tickers: List[str]
    threshold: Optional[float] = None
    lookback_bars: int = 120
    only_passing: bool = True


@app.on_event("startup")
def _startup():
    load_model()
    _ensure_spy_cache()


@app.get("/health")
def health():
    return {
        "ok": _state["model"] is not None,
        "model_path": _state["model_path"],
        "version": _state["version"],
        "threshold": _state["threshold"],
        "loaded_at": _state["loaded_at"],
        "feature_count": len(_state["feature_cols"] or []),
        "spy_cache_size": len(_spy_cache["df"]) if _spy_cache["df"] is not None else 0,
        "meta": _state["meta"],
    }


@app.post("/reload")
def reload_endpoint():
    load_model()
    _spy_cache["last"] = 0
    _ensure_spy_cache()
    return {"ok": True, "loaded_at": _state["loaded_at"], "version": _state["version"]}


def _bars_to_df(bars: List[Bar]) -> pd.DataFrame:
    rows = [{"ts": b.t, "open": b.o, "high": b.h, "low": b.l, "close": b.c, "volume": b.v} for b in bars]
    return pd.DataFrame(rows).sort_values("ts").reset_index(drop=True)


def _pick_model(symbol: str):
    """Devuelve (model, calibrator, feature_cols, threshold, label_cfg, model_kind)."""
    pt = _state["per_ticker"].get(symbol.upper())
    if pt is not None:
        return (pt["model"], None, pt["feature_cols"], pt["threshold"], pt["label_cfg"],
                f"per_ticker:{symbol}")
    return (_state["model"], _state["calibrator"], _state["feature_cols"],
            _state["threshold"], _state["label_cfg"], "universal")


def _score_one(df_bars: pd.DataFrame, symbol: str) -> dict:
    model, calibrator, feature_cols, threshold, label_cfg, kind = _pick_model(symbol)
    if model is None:
        return {"ok": False, "symbol": symbol, "error": "no_model"}
    if _state["version"] == "v2" or kind.startswith("per_ticker"):
        spy = _ensure_spy_cache()
        feats = build_features_v2(df_bars, spy_bars=spy)
    else:
        feats = build_features_v1(df_bars)
    feats[feature_cols] = feats[feature_cols].replace([np.inf, -np.inf], np.nan)
    last = feats.iloc[[-1]]
    if last[feature_cols].isna().any(axis=1).iloc[0]:
        missing = last[feature_cols].isna().sum(axis=0)
        missing_cols = [c for c in feature_cols if missing.get(c, 0) > 0]
        return {"ok": False, "symbol": symbol, "error": "feature_nan",
                "missing_features": missing_cols[:10]}
    X = last[feature_cols]
    prob_raw = float(model.predict_proba(X)[0, 1])
    prob = prob_raw
    if calibrator is not None:
        prob = float(calibrator.transform([prob_raw])[0])
    snap = {col: float(last[col].iloc[0]) for col in feature_cols}
    return {
        "ok": True,
        "symbol": symbol,
        "prob": prob,
        "prob_raw": prob_raw,
        "threshold": threshold,
        "model_kind": kind,
        "label_cfg": label_cfg,
        "ts": int(last["ts"].iloc[0]),
        "atr_pct": float(last["atr_pct"].iloc[0]) if "atr_pct" in last.columns else None,
        "feature_snapshot": snap,
    }


@app.post("/predict")
def predict(req: PredictRequest):
    if _state["model"] is None and not _state["per_ticker"]:
        raise HTTPException(503, "no model loaded")
    if len(req.bars) < 60:
        raise HTTPException(400, f"need >=60 bars, got {len(req.bars)}")
    df = _bars_to_df(req.bars)
    out = _score_one(df, req.symbol)
    if not out["ok"]:
        raise HTTPException(422, out)
    out["passes"] = out["prob"] >= out["threshold"]
    out["meta"] = _state["meta"]
    return out


def _load_recent_bars(ticker: str, n: int = 120) -> pd.DataFrame:
    if not DB_PATH.exists():
        return pd.DataFrame()
    con = sqlite3.connect(str(DB_PATH))
    try:
        df = pd.read_sql_query(
            "SELECT ts, open, high, low, close, volume FROM minute_bars "
            "WHERE ticker=? ORDER BY ts DESC LIMIT ?",
            con, params=(ticker, n),
        )
    finally:
        con.close()
    return df.iloc[::-1].reset_index(drop=True)


@app.post("/signals_batch")
def signals_batch(req: SignalsBatchRequest):
    """Evalúa N tickers con bars del DB. Devuelve los que pasan threshold (o todos).
    El threshold puede venir override o usar el per-ticker (model-specific)."""
    if _state["model"] is None and not _state["per_ticker"]:
        raise HTTPException(503, "no model loaded")
    override = req.threshold
    out_signals = []
    errors = []
    for t in req.tickers:
        bars = _load_recent_bars(t, n=req.lookback_bars)
        if len(bars) < 60:
            errors.append({"symbol": t, "error": "insufficient_bars", "n": len(bars)})
            continue
        try:
            res = _score_one(bars, t)
        except Exception as e:
            errors.append({"symbol": t, "error": str(e)})
            continue
        if not res.get("ok"):
            errors.append(res)
            continue
        thr = override if override is not None else res["threshold"]
        res["effective_threshold"] = thr
        res["passes"] = res["prob"] >= thr
        if req.only_passing and not res["passes"]:
            continue
        out_signals.append(res)
    out_signals.sort(key=lambda x: x["prob"], reverse=True)
    return {
        "ok": True,
        "threshold_override": override,
        "version": _state["version"],
        "n_evaluated": len(req.tickers),
        "n_passing": len(out_signals),
        "signals": out_signals,
        "errors": errors,
    }


@app.get("/models")
def list_models():
    """Endpoint informativo: listar modelos cargados y métricas guardadas."""
    return {
        "universal": {
            "path": _state["model_path"],
            "version": _state["version"],
            "threshold": _state["threshold"],
            "label_cfg": _state["label_cfg"],
        },
        "per_ticker": [
            {
                "symbol": sym,
                "threshold": m["threshold"],
                "auc": m["auc"],
                "winrate": m["winrate"],
                "net_per_trade": m["net_per_trade"],
                "profitable": m["profitable"],
                "label_cfg": m["label_cfg"],
            }
            for sym, m in _state["per_ticker"].items()
        ],
    }
