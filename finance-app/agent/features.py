"""Feature engineering desde minute_bars OHLCV.

Convierte velas 1m crudas en features que un modelo puede aprender:
- Momentum: returns sobre ventanas múltiples
- Trend: EMA9, EMA20, EMA50 + spreads relativos
- Volatilidad: ATR, std de returns, Bollinger width
- Volumen: RVOL (volume / promedio), volumen anormal
- VWAP: precio relativo a VWAP intraday
- Microestructura: high-low spread, body-vs-range
- Temporal: minuto del día, día de la semana, time-since-open

Todas las features son SIN look-ahead: solo usan datos hasta el bar actual.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def add_returns(df: pd.DataFrame, windows=(1, 3, 5, 15, 30)) -> pd.DataFrame:
    """Returns logaritmicos sobre N barras (1m cada una)."""
    out = df.copy()
    log_close = np.log(out["close"])
    for w in windows:
        out[f"ret_{w}m"] = log_close.diff(w)
    return out


def add_ema(df: pd.DataFrame, periods=(9, 20, 50)) -> pd.DataFrame:
    out = df.copy()
    for p in periods:
        out[f"ema_{p}"] = out["close"].ewm(span=p, adjust=False).mean()
        out[f"ema_{p}_spread"] = (out["close"] - out[f"ema_{p}"]) / out[f"ema_{p}"]
    # Trend signal: 9 > 20 > 50 = strong up
    if 9 in periods and 20 in periods:
        out["ema_9_20_gap"] = (out["ema_9"] - out["ema_20"]) / out["ema_20"]
    return out


def add_rsi(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    out = df.copy()
    delta = out["close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    out["rsi_14"] = 100 - 100 / (1 + rs)
    return out


def add_atr(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    out = df.copy()
    high_low = out["high"] - out["low"]
    high_close = (out["high"] - out["close"].shift()).abs()
    low_close = (out["low"] - out["close"].shift()).abs()
    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    out[f"atr_{period}"] = tr.ewm(alpha=1 / period, adjust=False).mean()
    out["atr_pct"] = out[f"atr_{period}"] / out["close"]
    return out


def add_bollinger(df: pd.DataFrame, period: int = 20, n_std: float = 2.0) -> pd.DataFrame:
    out = df.copy()
    ma = out["close"].rolling(period).mean()
    sd = out["close"].rolling(period).std()
    out["bb_mid"] = ma
    out["bb_upper"] = ma + n_std * sd
    out["bb_lower"] = ma - n_std * sd
    out["bb_width"] = (out["bb_upper"] - out["bb_lower"]) / ma
    out["bb_pos"] = (out["close"] - out["bb_lower"]) / (out["bb_upper"] - out["bb_lower"])
    return out


def add_vwap_intraday(df: pd.DataFrame) -> pd.DataFrame:
    """VWAP que se resetea cada día (UTC date)."""
    out = df.copy()
    out["_date"] = pd.to_datetime(out["ts"], unit="ms", utc=True).dt.date
    typical = (out["high"] + out["low"] + out["close"]) / 3
    pv = typical * out["volume"]
    out["_pv_cum"] = pv.groupby(out["_date"]).cumsum()
    out["_v_cum"] = out["volume"].groupby(out["_date"]).cumsum()
    out["vwap"] = out["_pv_cum"] / out["_v_cum"].replace(0, np.nan)
    out["vwap_spread"] = (out["close"] - out["vwap"]) / out["vwap"]
    out["above_vwap"] = (out["close"] >= out["vwap"]).astype(int)
    return out.drop(columns=["_date", "_pv_cum", "_v_cum"])


def add_rvol(df: pd.DataFrame, lookback_minutes: int = 30, days: int = 5) -> pd.DataFrame:
    """Relative volume vs rolling avg de mismos N minutos."""
    out = df.copy()
    out["vol_ma"] = out["volume"].rolling(lookback_minutes).mean()
    out["rvol"] = out["volume"] / out["vol_ma"].replace(0, np.nan)
    return out


def add_temporal(df: pd.DataFrame) -> pd.DataFrame:
    """Hora del día y día de la semana (UTC). NYSE abre 13:30 UTC en horario estándar."""
    out = df.copy()
    dt = pd.to_datetime(out["ts"], unit="ms", utc=True)
    out["dow"] = dt.dt.dayofweek          # 0=Mon, 4=Fri
    out["minute_of_day"] = dt.dt.hour * 60 + dt.dt.minute
    out["minute_since_open"] = (out["minute_of_day"] - 13 * 60 - 30).clip(lower=0)
    out["minute_to_close"] = (16 * 60 - (out["minute_of_day"] - 13 * 60 - 30) - 0).clip(lower=0)
    return out


def add_microstructure(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    rng = out["high"] - out["low"]
    body = (out["close"] - out["open"]).abs()
    out["hl_pct"] = rng / out["close"]
    out["body_pct"] = body / out["close"]
    out["body_to_range"] = body / rng.replace(0, np.nan)
    out["up_candle"] = (out["close"] >= out["open"]).astype(int)
    return out


def build_features(bars: pd.DataFrame) -> pd.DataFrame:
    """Pipeline completo. Espera DataFrame con columnas: ts, open, high, low, close, volume."""
    df = bars.copy()
    df = df.sort_values("ts").reset_index(drop=True)
    df = add_returns(df)
    df = add_ema(df)
    df = add_rsi(df)
    df = add_atr(df)
    df = add_bollinger(df)
    df = add_vwap_intraday(df)
    df = add_rvol(df)
    df = add_temporal(df)
    df = add_microstructure(df)
    return df


FEATURE_COLS = [
    "ret_1m", "ret_3m", "ret_5m", "ret_15m", "ret_30m",
    "ema_9_spread", "ema_20_spread", "ema_50_spread", "ema_9_20_gap",
    "rsi_14",
    "atr_pct",
    "bb_width", "bb_pos",
    "vwap_spread", "above_vwap",
    "rvol",
    "dow", "minute_of_day", "minute_since_open", "minute_to_close",
    "hl_pct", "body_pct", "body_to_range", "up_candle",
]
