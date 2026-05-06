"""Features y señales intradía con bars de 5 minutos.

yfinance permite descargar bars de 5min/15min de los últimos 60 días gratis.
Esto NO es tick-level (eso requiere API paga), pero es suficientemente granular
para señales intradía con horizonte 1-4 horas.

LIMITACIONES HONESTAS:
- 15 min de delay en datos (yfinance)
- No sirve para HFT/scalping (latencia >>1s)
- Sí sirve para: detectar breakouts intradía, validar entries del modelo daily,
  monitor en vivo de SL/TP de posiciones abiertas
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import yfinance as yf


# =============================================================================
# DESCARGA DE BARS INTRADÍA
# =============================================================================
def fetch_intraday(ticker: str, days: int = 5, interval: str = "5m") -> pd.DataFrame:
    """Bars intradía recientes. days max=60 con 5m, max=7 con 1m.

    No usa cache SQLite (datos cambian todo el tiempo). TTL implícito por el llamador.
    """
    period_map = {1: "1d", 2: "2d", 5: "5d", 7: "7d", 30: "1mo", 60: "60d"}
    period = period_map.get(days, f"{days}d")
    try:
        df = yf.Ticker(ticker).history(period=period, interval=interval, prepost=False)
        if df.empty:
            return pd.DataFrame()
        df.index = pd.to_datetime(df.index)
        return df[["Open", "High", "Low", "Close", "Volume"]]
    except Exception as exc:  # noqa: BLE001
        print(f"[intraday] {ticker} {interval} falló: {exc}")
        return pd.DataFrame()


# =============================================================================
# INDICADORES INTRADÍA
# =============================================================================
def vwap(df: pd.DataFrame) -> float:
    """Volume-Weighted Average Price del día actual.
    Precio justo según volumen — institucionales lo usan como referencia.
    Si precio > VWAP = compradores dominan; <VWAP = vendedores."""
    if df.empty:
        return float("nan")
    today = df.index[-1].date()
    today_df = df[df.index.date == today]
    if today_df.empty:
        return float("nan")
    typical = (today_df["High"] + today_df["Low"] + today_df["Close"]) / 3
    vol = today_df["Volume"]
    if vol.sum() == 0:
        return float("nan")
    return float((typical * vol).sum() / vol.sum())


def vwap_distance(df: pd.DataFrame) -> float:
    """% de distancia del precio actual al VWAP. Positivo = arriba del VWAP."""
    if df.empty:
        return float("nan")
    v = vwap(df)
    if v != v or v == 0:
        return float("nan")
    return float(df["Close"].iloc[-1] / v - 1)


def intraday_momentum(df: pd.DataFrame, bars: int = 12) -> float:
    """Retorno últimas `bars` barras (12×5min = 1h). Captura momentum intra."""
    if len(df) < bars + 1:
        return float("nan")
    return float(df["Close"].iloc[-1] / df["Close"].iloc[-bars - 1] - 1)


def opening_gap(df: pd.DataFrame) -> float:
    """Gap del open de hoy vs cierre de ayer. >0 = abrió arriba."""
    if df.empty:
        return float("nan")
    today = df.index[-1].date()
    today_df = df[df.index.date == today]
    prev_df = df[df.index.date < today]
    if today_df.empty or prev_df.empty:
        return float("nan")
    return float(today_df["Open"].iloc[0] / prev_df["Close"].iloc[-1] - 1)


def intraday_range_pct(df: pd.DataFrame) -> float:
    """Rango intradía hoy como % del open. >3% = alta volatilidad hoy."""
    if df.empty:
        return float("nan")
    today = df.index[-1].date()
    today_df = df[df.index.date == today]
    if today_df.empty:
        return float("nan")
    high = today_df["High"].max()
    low = today_df["Low"].min()
    open_ = today_df["Open"].iloc[0]
    if open_ == 0:
        return float("nan")
    return float((high - low) / open_)


def relative_volume(df: pd.DataFrame, bars_today: int = 78, bars_avg: int = 5) -> float:
    """Volumen acumulado hoy vs promedio de los últimos `bars_avg` días al
    mismo punto de la sesión. >1.5 = volumen anormalmente alto (atención).

    78 = bars de 5min en una sesión completa de 6.5h."""
    if df.empty:
        return float("nan")
    today = df.index[-1].date()
    today_df = df[df.index.date == today]
    if today_df.empty:
        return float("nan")
    today_vol = today_df["Volume"].sum()

    # Compara contra mismo número de bars en días anteriores
    prev_dates = sorted({d for d in df.index.date if d < today})[-bars_avg:]
    if not prev_dates:
        return float("nan")
    avg_vol_at_same_point = []
    bars_so_far = len(today_df)
    for d in prev_dates:
        day_df = df[df.index.date == d].iloc[:bars_so_far]
        avg_vol_at_same_point.append(day_df["Volume"].sum())
    if not avg_vol_at_same_point or np.mean(avg_vol_at_same_point) == 0:
        return float("nan")
    return float(today_vol / np.mean(avg_vol_at_same_point))


def trend_5min(df: pd.DataFrame, period: int = 20) -> float:
    """+1 si precio > EMA20 de 5min, -1 abajo. Tendencia intradía."""
    if len(df) < period + 1:
        return 0.0
    ema = df["Close"].ewm(span=period, adjust=False).mean()
    if df["Close"].iloc[-1] > ema.iloc[-1]:
        return 1.0
    return -1.0


# =============================================================================
# BUNDLE DE FEATURES INTRADÍA
# =============================================================================
@dataclass
class IntradayFeatures:
    ticker: str
    last_price: float = float("nan")
    vwap_value: float = float("nan")
    vwap_dist: float = float("nan")          # % vs VWAP
    momentum_1h: float = float("nan")        # retorno 12 bars
    momentum_30m: float = float("nan")       # retorno 6 bars
    opening_gap: float = float("nan")
    intra_range: float = float("nan")
    rel_volume: float = float("nan")
    trend_intra: float = 0.0
    n_bars: int = 0

    @property
    def signal(self) -> str:
        """Lectura rápida: ALCISTA / NEUTRO / BAJISTA según features intradía."""
        score = 0
        if self.vwap_dist == self.vwap_dist and self.vwap_dist > 0.005:
            score += 1
        elif self.vwap_dist == self.vwap_dist and self.vwap_dist < -0.005:
            score -= 1
        if self.momentum_1h == self.momentum_1h:
            if self.momentum_1h > 0.005:
                score += 1
            elif self.momentum_1h < -0.005:
                score -= 1
        if self.trend_intra > 0:
            score += 1
        elif self.trend_intra < 0:
            score -= 1
        if self.rel_volume == self.rel_volume and self.rel_volume > 1.5:
            # Alto volumen amplifica la señal existente
            score = int(score * 1.5)

        if score >= 2:
            return "ALCISTA"
        if score <= -2:
            return "BAJISTA"
        return "NEUTRO"


def build_intraday_features(ticker: str, days: int = 5) -> IntradayFeatures:
    """Construye features intradía a partir de bars de 5min."""
    fs = IntradayFeatures(ticker=ticker)
    df = fetch_intraday(ticker, days=days, interval="5m")
    if df.empty:
        return fs
    fs.n_bars = len(df)
    fs.last_price = float(df["Close"].iloc[-1])
    fs.vwap_value = vwap(df)
    fs.vwap_dist = vwap_distance(df)
    fs.momentum_1h = intraday_momentum(df, bars=12)
    fs.momentum_30m = intraday_momentum(df, bars=6)
    fs.opening_gap = opening_gap(df)
    fs.intra_range = intraday_range_pct(df)
    fs.rel_volume = relative_volume(df)
    fs.trend_intra = trend_5min(df)
    return fs


def build_intraday_features_parallel(tickers: list[str], days: int = 5) -> dict[str, IntradayFeatures]:
    """Paralelo: descarga + features de múltiples tickers."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    out: dict[str, IntradayFeatures] = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        futs = {pool.submit(build_intraday_features, tk, days): tk for tk in tickers}
        for fut in as_completed(futs):
            tk = futs[fut]
            try:
                out[tk] = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"[intraday] {tk} error: {exc}")
                out[tk] = IntradayFeatures(ticker=tk)
    return out
