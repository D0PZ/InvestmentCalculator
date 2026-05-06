"""Feature engineering: técnicos + normalización de fundamentales."""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

from . import scrapers
from .config import BENCHMARK


# =============================================================================
# INDICADORES TÉCNICOS
# =============================================================================
def rsi(series: pd.Series, period: int = 14) -> float:
    """RSI clásico (Wilder)."""
    if len(series) < period + 1:
        return float("nan")
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return float(100 - 100 / (1 + rs.iloc[-1]))


def trend_score(close: pd.Series) -> float:
    """+1 si precio > MA50 > MA200, -1 si invertido, 0 mixto."""
    if len(close) < 200:
        return 0.0
    ma50 = close.rolling(50).mean().iloc[-1]
    ma200 = close.rolling(200).mean().iloc[-1]
    p = close.iloc[-1]
    if p > ma50 > ma200:
        return 1.0
    if p < ma50 < ma200:
        return -1.0
    if p > ma200:
        return 0.5
    return -0.5


def momentum(close: pd.Series, days: int = 63) -> float:
    """Retorno los últimos `days` (≈3 meses)."""
    if len(close) < days + 1:
        return float("nan")
    return float(close.iloc[-1] / close.iloc[-days - 1] - 1)


def volume_surge(volume: pd.Series, lookback: int = 20) -> float:
    """Volumen reciente vs promedio (1.0 = normal, >1.5 = surge)."""
    if len(volume) < lookback + 5:
        return 1.0
    recent = volume.iloc[-5:].mean()
    base = volume.iloc[-lookback - 5 : -5].mean()
    if base <= 0:
        return 1.0
    return float(recent / base)


def relative_strength(close: pd.Series, bench_close: pd.Series, days: int = 63) -> float:
    """Retorno - retorno benchmark en `days`."""
    if len(close) < days + 1 or len(bench_close) < days + 1:
        return float("nan")
    r = close.iloc[-1] / close.iloc[-days - 1] - 1
    rb = bench_close.iloc[-1] / bench_close.iloc[-days - 1] - 1
    return float(r - rb)


# =============================================================================
# FEATURES NUEVOS (high-edge factores académicos)
# =============================================================================
def macd_signal(close: pd.Series) -> float:
    """MACD histogram normalizado por precio. Positivo = momentum alcista."""
    if len(close) < 35:
        return float("nan")
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    hist = (macd - signal).iloc[-1]
    return float(hist / close.iloc[-1])


def bollinger_pct(close: pd.Series, period: int = 20, std: float = 2.0) -> float:
    """%B: posición del precio dentro de las bandas. 0 = banda inf, 1 = banda sup.
    >1 sobrecomprado, <0 sobrevendido. Mejor edge cerca de extremos."""
    if len(close) < period + 1:
        return float("nan")
    ma = close.rolling(period).mean().iloc[-1]
    sd = close.rolling(period).std().iloc[-1]
    if sd == 0 or sd != sd:
        return 0.5
    upper = ma + std * sd
    lower = ma - std * sd
    return float((close.iloc[-1] - lower) / (upper - lower))


def adx(df: pd.DataFrame, period: int = 14) -> float:
    """ADX: fuerza de la tendencia (0-100). >25 = tendencia fuerte (trending),
    <20 = mercado lateral (mejor evitar breakouts falsos)."""
    if len(df) < period * 2:
        return float("nan")
    high = df["High"]
    low = df["Low"]
    close = df["Close"]
    plus_dm = (high.diff()).clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)
    # Cuando ambos suben/bajan, el menor se anula
    plus_dm = plus_dm.where(plus_dm > minus_dm, 0)
    minus_dm = minus_dm.where(minus_dm > plus_dm, 0)
    tr = pd.concat([
        (high - low),
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    atr_s = tr.ewm(alpha=1 / period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False).mean() / atr_s.replace(0, np.nan)
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False).mean() / atr_s.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return float(dx.ewm(alpha=1 / period, adjust=False).mean().iloc[-1])


def dist_52w_high(close: pd.Series) -> float:
    """Distancia al máximo de 52 semanas. 0 = en máximo, -0.30 = 30% abajo.
    Factor 'momentum' clásico: estar cerca de máximos predice más subida."""
    if len(close) < 252:
        return float("nan")
    high_52w = close.iloc[-252:].max()
    return float(close.iloc[-1] / high_52w - 1)


def realized_vol(close: pd.Series, days: int = 20) -> float:
    """Volatilidad realizada anualizada. >0.4 = alta vol (más riesgo)."""
    if len(close) < days + 1:
        return float("nan")
    returns = close.pct_change().iloc[-days:]
    return float(returns.std() * np.sqrt(252))


def momentum_short(close: pd.Series, days: int = 10) -> float:
    """Momentum corto plazo (10 días). Complementa el de 3 meses."""
    if len(close) < days + 1:
        return float("nan")
    return float(close.iloc[-1] / close.iloc[-days - 1] - 1)


def gap_freq(df: pd.DataFrame, days: int = 20, threshold: float = 0.02) -> float:
    """Frecuencia de gaps >2% en últimos 20 días. Alto = volatilidad de overnight."""
    if len(df) < days + 1:
        return 0.0
    recent = df.iloc[-days:]
    gaps = (recent["Open"] / recent["Close"].shift() - 1).abs()
    return float((gaps > threshold).sum() / days)


def price_efficiency(close: pd.Series, days: int = 20) -> float:
    """Ratio de eficiencia de Kaufman: |movimiento neto| / suma de movimientos.
    Alto = tendencia limpia, bajo = ruido. Filtra breakouts en mercado lateral."""
    if len(close) < days + 1:
        return float("nan")
    window = close.iloc[-days - 1:]
    net_move = abs(window.iloc[-1] - window.iloc[0])
    total_move = window.diff().abs().sum()
    if total_move == 0:
        return 0.0
    return float(net_move / total_move)


# =============================================================================
# BUNDLE DE FEATURES POR TICKER
# =============================================================================
@dataclass
class FeatureSet:
    ticker: str
    last_price: float = float("nan")
    # fundamentales
    revenue_growth: float = float("nan")
    eps_growth: float = float("nan")
    profit_margin: float = float("nan")
    roe: float = float("nan")
    debt_to_equity: float = float("nan")
    pe_ratio: float = float("nan")
    # técnicos básicos
    rsi_14: float = float("nan")
    trend_ma: float = float("nan")
    momentum_3m: float = float("nan")
    volume_surge: float = float("nan")
    rel_strength_spy: float = float("nan")
    # técnicos avanzados (factores académicos con edge probado)
    macd_hist: float = float("nan")
    bb_pct: float = float("nan")
    adx_14: float = float("nan")
    dist_52w_high: float = float("nan")
    realized_vol: float = float("nan")
    momentum_10d: float = float("nan")
    gap_freq: float = float("nan")
    price_efficiency: float = float("nan")
    # sentimiento
    sentiment: float = 0.0
    n_news: int = 0
    sector: str = ""
    # OHLCV crudo (para risk module: ATR, etc.)
    ohlcv: object = None  # pd.DataFrame, no se serializa

    def as_dict(self) -> dict:
        d = asdict(self)
        d.pop("ohlcv", None)
        return d


def build_features(
    ticker: str,
    bench_close: pd.Series | None = None,
    ohlcv: pd.DataFrame | None = None,
    fund=None,
    news: tuple[float, int] | None = None,
) -> FeatureSet:
    """Construye FeatureSet. Si se pasan ohlcv/fund/news evita re-descargar
    (usado por el scorer paralelo)."""
    fs = FeatureSet(ticker=ticker)
    df = ohlcv if ohlcv is not None else scrapers.fetch_prices(ticker, period="1y", interval="1d")
    if not df.empty:
        fs.ohlcv = df
        close = df["Close"]
        fs.last_price = float(close.iloc[-1])
        fs.rsi_14 = rsi(close)
        fs.trend_ma = trend_score(close)
        fs.momentum_3m = momentum(close)
        fs.volume_surge = volume_surge(df["Volume"])
        # nuevas features avanzadas
        fs.macd_hist = macd_signal(close)
        fs.bb_pct = bollinger_pct(close)
        fs.adx_14 = adx(df)
        fs.dist_52w_high = dist_52w_high(close)
        fs.realized_vol = realized_vol(close)
        fs.momentum_10d = momentum_short(close)
        fs.gap_freq = gap_freq(df)
        fs.price_efficiency = price_efficiency(close)
        if bench_close is not None and not bench_close.empty:
            fs.rel_strength_spy = relative_strength(close, bench_close)

    if fund is None:
        fund = scrapers.fetch_fundamentals(ticker)
    fs.revenue_growth = fund.revenue_growth if fund.revenue_growth is not None else float("nan")
    fs.eps_growth = fund.eps_growth if fund.eps_growth is not None else float("nan")
    fs.profit_margin = fund.profit_margin if fund.profit_margin is not None else float("nan")
    fs.roe = fund.roe if fund.roe is not None else float("nan")
    fs.debt_to_equity = fund.debt_to_equity if fund.debt_to_equity is not None else float("nan")
    fs.pe_ratio = fund.pe_ratio if fund.pe_ratio is not None else float("nan")
    fs.sector = fund.sector

    if news is None:
        news = scrapers.fetch_news_sentiment(ticker)
    s, n = news
    fs.sentiment = s
    fs.n_news = n
    return fs


def get_benchmark_close(period: str = "1y") -> pd.Series:
    df = scrapers.fetch_prices(BENCHMARK, period=period, interval="1d")
    return df["Close"] if not df.empty else pd.Series(dtype=float)
