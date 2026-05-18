"""Feature engineering v2: cross-asset + multi-timeframe + regime + lags.

Diferencias vs features.py:
- Cross-asset: spy_ret_*, ticker_minus_spy_ret_*, rolling corr con SPY
- Multi-timeframe: EMAs y ret sobre buckets 5m y 15m (calculados intraday)
- Lagged momentum: ret_5m lag 5/15/30 — capta decaimiento
- Volume z-score (per-ticker rolling 30d)
- ATR percentile rolling (régimen)
- Position in N-min range (high/low proximity)
- Time-of-day flags: open/midday/lunch/close
- Drawdown / runup en últimas 30/60 min

Espera DataFrame con columnas: ts, open, high, low, close, volume
Para cross-asset, pasar spy_bars: DataFrame con (ts, close, volume) de SPY alineado por ts.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from features import (
    add_returns, add_ema, add_rsi, add_atr, add_bollinger,
    add_vwap_intraday, add_rvol, add_microstructure,
)


def add_temporal_v2(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    dt = pd.to_datetime(out["ts"], unit="ms", utc=True)
    # Convert to NY time for intraday bucketing
    ny = dt.dt.tz_convert("America/New_York")
    out["dow"] = ny.dt.dayofweek
    out["minute_of_day"] = ny.dt.hour * 60 + ny.dt.minute
    # NYSE open = 9:30 = 570 min; close = 16:00 = 960 min
    out["minute_since_open"] = (out["minute_of_day"] - 570).clip(lower=0)
    out["minute_to_close"] = (960 - out["minute_of_day"]).clip(lower=0)
    # Session buckets
    out["is_opening_30m"] = ((out["minute_since_open"] >= 0) & (out["minute_since_open"] < 30)).astype(int)
    out["is_lunch"] = ((out["minute_of_day"] >= 720) & (out["minute_of_day"] < 780)).astype(int)  # 12:00-13:00
    out["is_closing_30m"] = ((out["minute_to_close"] > 0) & (out["minute_to_close"] <= 30)).astype(int)
    out["is_midday"] = (1 - out["is_opening_30m"] - out["is_lunch"] - out["is_closing_30m"]).clip(lower=0)
    return out


def add_lagged_returns(df: pd.DataFrame, lags=(5, 15, 30)) -> pd.DataFrame:
    """Ret 5m visto desde 5, 15, 30 barras atrás — capta si el momentum persiste o decae."""
    out = df.copy()
    if "ret_5m" not in out.columns:
        out["ret_5m"] = np.log(out["close"]).diff(5)
    for lag in lags:
        out[f"ret_5m_lag_{lag}"] = out["ret_5m"].shift(lag)
    return out


def add_volume_zscore(df: pd.DataFrame, window: int = 390 * 5) -> pd.DataFrame:
    """Z-score del volumen vs rolling ventana de ~5 sesiones de 1m bars."""
    out = df.copy()
    mu = out["volume"].rolling(window, min_periods=60).mean()
    sd = out["volume"].rolling(window, min_periods=60).std()
    out["vol_zscore"] = (out["volume"] - mu) / sd.replace(0, np.nan)
    return out


def add_atr_percentile(df: pd.DataFrame, atr_col: str = "atr_pct", window: int = 390 * 10) -> pd.DataFrame:
    """ATR% percentile rolling — identifica régimen de alta/baja volatilidad."""
    out = df.copy()
    out["atr_pct_pctile"] = out[atr_col].rolling(window, min_periods=60).rank(pct=True)
    return out


def add_range_position(df: pd.DataFrame, lookbacks=(15, 30, 60)) -> pd.DataFrame:
    """Posición del close dentro del rango [low_N, high_N] de las últimas N barras."""
    out = df.copy()
    for n in lookbacks:
        hi = out["high"].rolling(n).max()
        lo = out["low"].rolling(n).min()
        out[f"range_pos_{n}m"] = (out["close"] - lo) / (hi - lo).replace(0, np.nan)
    return out


def add_runup_drawdown(df: pd.DataFrame, lookbacks=(30, 60)) -> pd.DataFrame:
    """Cuánto subió desde el mínimo de N min (runup) y cuánto cayó desde el máximo (drawdown)."""
    out = df.copy()
    for n in lookbacks:
        lo = out["low"].rolling(n).min()
        hi = out["high"].rolling(n).max()
        out[f"runup_{n}m"] = (out["close"] - lo) / lo.replace(0, np.nan)
        out[f"drawdown_{n}m"] = (out["close"] - hi) / hi.replace(0, np.nan)
    return out


def merge_spy(df: pd.DataFrame, spy_bars: pd.DataFrame | None) -> pd.DataFrame:
    """Mergea contexto SPY al ticker. spy_bars: ts, close (1m bars).
    Genera spy_ret_*, ticker_minus_spy_ret_*, rolling_corr_spy."""
    out = df.copy()
    if spy_bars is None or spy_bars.empty:
        # Fill with neutrals so feature columns existen
        for w in (5, 15, 30):
            out[f"spy_ret_{w}m"] = 0.0
            out[f"rel_strength_{w}m"] = 0.0
        out["corr_spy_30m"] = 0.0
        return out

    spy = spy_bars[["ts", "close"]].rename(columns={"close": "spy_close"}).sort_values("ts")
    out = out.sort_values("ts").reset_index(drop=True)
    out = pd.merge_asof(out, spy, on="ts", direction="backward")
    spy_log = np.log(out["spy_close"])
    ticker_log = np.log(out["close"])
    for w in (5, 15, 30):
        out[f"spy_ret_{w}m"] = spy_log.diff(w)
        out[f"rel_strength_{w}m"] = ticker_log.diff(w) - spy_log.diff(w)
    # Rolling 30m correlation of 1m returns
    tr1 = ticker_log.diff(1)
    sr1 = spy_log.diff(1)
    out["corr_spy_30m"] = tr1.rolling(30).corr(sr1)
    out = out.drop(columns=["spy_close"])
    return out


def add_tf_aggregates(df: pd.DataFrame) -> pd.DataFrame:
    """Multi-timeframe: ret y EMA spread sobre buckets 5m y 15m derivados del 1m."""
    out = df.copy()
    log_close = np.log(out["close"])
    # 5m and 15m equivalent returns (still per-bar, just longer window)
    out["ret_60m"] = log_close.diff(60)
    out["ret_120m"] = log_close.diff(120)
    # Slower EMA spreads
    for p in (100, 200):
        ema = out["close"].ewm(span=p, adjust=False).mean()
        out[f"ema_{p}_spread"] = (out["close"] - ema) / ema
    return out


def build_features_v2(bars: pd.DataFrame, spy_bars: pd.DataFrame | None = None) -> pd.DataFrame:
    """Pipeline v2. bars: DF del ticker; spy_bars opcional para cross-asset.

    Devuelve DF con columnas crudas + features v2.
    """
    df = bars.copy().sort_values("ts").reset_index(drop=True)
    df = add_returns(df)
    df = add_ema(df)
    df = add_rsi(df)
    df = add_atr(df)
    df = add_bollinger(df)
    df = add_vwap_intraday(df)
    df = add_rvol(df)
    df = add_temporal_v2(df)
    df = add_microstructure(df)
    df = add_lagged_returns(df)
    df = add_volume_zscore(df)
    df = add_atr_percentile(df)
    df = add_range_position(df)
    df = add_runup_drawdown(df)
    df = add_tf_aggregates(df)
    df = merge_spy(df, spy_bars)
    return df


FEATURE_COLS_V2 = [
    # Base momentum
    "ret_1m", "ret_3m", "ret_5m", "ret_15m", "ret_30m", "ret_60m", "ret_120m",
    # Trend
    "ema_9_spread", "ema_20_spread", "ema_50_spread", "ema_100_spread", "ema_200_spread",
    "ema_9_20_gap",
    # Oscillator / vol
    "rsi_14", "atr_pct", "atr_pct_pctile",
    "bb_width", "bb_pos",
    # Volume / liquidity
    "rvol", "vol_zscore",
    # VWAP
    "vwap_spread", "above_vwap",
    # Lagged momentum
    "ret_5m_lag_5", "ret_5m_lag_15", "ret_5m_lag_30",
    # Range position
    "range_pos_15m", "range_pos_30m", "range_pos_60m",
    # Runup/drawdown
    "runup_30m", "runup_60m", "drawdown_30m", "drawdown_60m",
    # Temporal
    "dow", "minute_of_day", "minute_since_open", "minute_to_close",
    "is_opening_30m", "is_lunch", "is_closing_30m", "is_midday",
    # Microstructure
    "hl_pct", "body_pct", "body_to_range", "up_candle",
    # Cross-asset SPY
    "spy_ret_5m", "spy_ret_15m", "spy_ret_30m",
    "rel_strength_5m", "rel_strength_15m", "rel_strength_30m",
    "corr_spy_30m",
]
