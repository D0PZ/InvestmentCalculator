"""Scrapers de datos: precios, fundamentales, noticias, macro.

Usa yfinance (Yahoo Finance) como fuente principal — gratis, sin API key,
suficientemente actualizado (delay ~15min en intradía, fundamentales reales).
Para tiempo real puro habría que pagar (Polygon, Alpaca, IEX). yfinance es
el mejor compromiso para uso personal.

Optimizaciones:
- Cache SQLite para precios diarios (solo descarga días nuevos)
- ThreadPool para descargas paralelas (10× más rápido con 100 tickers)
- Cache en memoria con TTL para fundamentales y news
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable

import feedparser
import pandas as pd
import yfinance as yf

from . import db
from .config import FUNDAMENTALS_TTL, NEWS_TTL


MAX_WORKERS = 16  # paralelismo HTTP


# =============================================================================
# CACHE simple en memoria con TTL
# =============================================================================
_cache: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str, ttl: int) -> Any | None:
    if key not in _cache:
        return None
    ts, val = _cache[key]
    if ttl > 0 and (time.time() - ts) > ttl:
        return None
    return val


def _cache_set(key: str, val: Any) -> None:
    _cache[key] = (time.time(), val)


# =============================================================================
# PRECIOS (con cache SQLite incremental)
# =============================================================================
def _fetch_prices_yf(ticker: str, period: str, interval: str) -> pd.DataFrame:
    """Descarga directa de yfinance, sin cache."""
    try:
        df = yf.Ticker(ticker).history(period=period, interval=interval, auto_adjust=True)
        if df.empty:
            return pd.DataFrame()
        df.index = pd.to_datetime(df.index).tz_localize(None)
        return df[["Open", "High", "Low", "Close", "Volume"]]
    except Exception as exc:  # noqa: BLE001
        print(f"[scraper] precio {ticker} falló: {exc}")
        return pd.DataFrame()


def fetch_prices(ticker: str, period: str = "1y", interval: str = "1d") -> pd.DataFrame:
    """Histórico OHLCV. Para interval='1d' usa cache SQLite incremental.

    Para otros intervals (1m, 5m, etc.) va directo a yfinance (no cacheable).
    """
    if interval != "1d":
        return _fetch_prices_yf(ticker, period, interval)

    # Período → fecha mínima necesaria
    period_days = {
        "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365,
        "2y": 730, "5y": 1825, "10y": 3650, "max": 3650 * 2,
    }
    days = period_days.get(period, 365)
    needed_start = datetime.now() - timedelta(days=days)

    last_date = db.get_last_date(ticker)
    first_date = db.get_first_date(ticker)
    today = datetime.now().date()

    # Coverage insuficiente al inicio: el cache no llega tan atrás como pedimos
    # (ej: tenías 1y guardado pero ahora pides 10y). Damos margen de 30 días
    # para cubrir tickers jóvenes (IPOs recientes).
    coverage_short = (
        first_date is not None
        and first_date.date() > needed_start.date() + timedelta(days=30)
    )
    needs_fresh_download = last_date is None or coverage_short
    needs_incremental = (
        last_date is not None
        and last_date.date() < today - timedelta(days=1)
    )

    if needs_fresh_download:
        # Descarga completa del período pedido
        new_df = _fetch_prices_yf(ticker, period, "1d")
        if not new_df.empty:
            db.save_prices(ticker, new_df)
    elif needs_incremental:
        # Solo días nuevos
        since = last_date - timedelta(days=5)
        yf_period = f"{max(7, (datetime.now() - since).days + 5)}d"
        new_df = _fetch_prices_yf(ticker, yf_period, "1d")
        if not new_df.empty:
            db.save_prices(ticker, new_df)

    # Lee desde SQLite la ventana pedida
    df = db.load_prices(ticker, start=needed_start)
    return df


def fetch_prices_parallel(tickers: Iterable[str], period: str = "1y") -> dict[str, pd.DataFrame]:
    """Descarga precios de múltiples tickers en paralelo. Devuelve {ticker: df}."""
    out: dict[str, pd.DataFrame] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(fetch_prices, tk, period, "1d"): tk for tk in tickers}
        for fut in as_completed(futs):
            tk = futs[fut]
            try:
                out[tk] = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"[scraper] {tk} error: {exc}")
                out[tk] = pd.DataFrame()
    return out


def fetch_last_price(ticker: str) -> float | None:
    """Último precio (intradía si mercado abierto)."""
    df = _fetch_prices_yf(ticker, "5d", "1m")
    if df.empty:
        df = fetch_prices(ticker, period="1mo", interval="1d")
    if df.empty:
        return None
    return float(df["Close"].iloc[-1])


# =============================================================================
# FUNDAMENTALES (con cache 6h)
# =============================================================================
@dataclass
class Fundamentals:
    ticker: str
    revenue_growth: float | None = None
    eps_growth: float | None = None
    profit_margin: float | None = None
    roe: float | None = None
    debt_to_equity: float | None = None
    pe_ratio: float | None = None
    market_cap: float | None = None
    sector: str = ""


def fetch_fundamentals(ticker: str) -> Fundamentals:
    cached = _cache_get(f"fund:{ticker}", FUNDAMENTALS_TTL)
    if cached is not None:
        return cached
    f = Fundamentals(ticker=ticker)
    try:
        info = yf.Ticker(ticker).info or {}
        f.revenue_growth = info.get("revenueGrowth")
        f.eps_growth = info.get("earningsGrowth") or info.get("earningsQuarterlyGrowth")
        f.profit_margin = info.get("profitMargins")
        f.roe = info.get("returnOnEquity")
        de = info.get("debtToEquity")
        f.debt_to_equity = (de / 100.0) if de is not None else None
        f.pe_ratio = info.get("trailingPE")
        f.market_cap = info.get("marketCap")
        f.sector = info.get("sector", "")
    except Exception as exc:  # noqa: BLE001
        print(f"[scraper] fundamentales {ticker} falló: {exc}")
    _cache_set(f"fund:{ticker}", f)
    return f


def fetch_fundamentals_parallel(tickers: Iterable[str]) -> dict[str, Fundamentals]:
    """Descarga fundamentales en paralelo."""
    out: dict[str, Fundamentals] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(fetch_fundamentals, tk): tk for tk in tickers}
        for fut in as_completed(futs):
            tk = futs[fut]
            try:
                out[tk] = fut.result()
            except Exception:  # noqa: BLE001
                out[tk] = Fundamentals(ticker=tk)
    return out


# =============================================================================
# NOTICIAS / SENTIMIENTO (RSS Yahoo Finance)
# =============================================================================
_POSITIVE = {
    "beat", "beats", "surge", "surges", "soar", "rally", "upgrade", "outperform",
    "strong", "record", "growth", "gain", "gains", "bullish", "buy", "raises",
    "exceeds", "tops", "jumps", "wins", "approval",
}
_NEGATIVE = {
    "miss", "misses", "fall", "falls", "drop", "plunge", "downgrade", "underperform",
    "weak", "loss", "losses", "decline", "bearish", "sell", "cuts", "lawsuit",
    "probe", "investigation", "warning", "fraud", "recall", "layoff", "layoffs",
}


def fetch_news_sentiment(ticker: str, max_items: int = 20) -> tuple[float, int]:
    """Score de sentimiento ∈ [-1, 1] por keyword matching sobre titulares."""
    cached = _cache_get(f"news:{ticker}", NEWS_TTL)
    if cached is not None:
        return cached
    score, n = 0.0, 0
    try:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"
        feed = feedparser.parse(url)
        items = feed.entries[:max_items]
        n = len(items)
        if n == 0:
            _cache_set(f"news:{ticker}", (0.0, 0))
            return 0.0, 0
        total = 0.0
        for entry in items:
            text = (entry.get("title", "") + " " + entry.get("summary", "")).lower()
            words = set(text.split())
            pos = len(words & _POSITIVE)
            neg = len(words & _NEGATIVE)
            if pos + neg > 0:
                total += (pos - neg) / (pos + neg)
        score = total / n
    except Exception as exc:  # noqa: BLE001
        print(f"[scraper] noticias {ticker} falló: {exc}")
    _cache_set(f"news:{ticker}", (score, n))
    return score, n


def fetch_news_sentiment_parallel(tickers: Iterable[str]) -> dict[str, tuple[float, int]]:
    """Sentimiento en paralelo."""
    out: dict[str, tuple[float, int]] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(fetch_news_sentiment, tk): tk for tk in tickers}
        for fut in as_completed(futs):
            tk = futs[fut]
            try:
                out[tk] = fut.result()
            except Exception:  # noqa: BLE001
                out[tk] = (0.0, 0)
    return out


# =============================================================================
# MACRO
# =============================================================================
def fetch_macro() -> dict[str, float]:
    """Indicadores macro: tasa 10Y, VIX, retorno SPY 1m."""
    cached = _cache_get("macro", 60 * 15)
    if cached is not None:
        return cached
    out: dict[str, float] = {}
    for sym, key in [("^TNX", "tnx_10y"), ("^VIX", "vix"), ("SPY", "spy")]:
        df = fetch_prices(sym, period="2mo", interval="1d")
        if df.empty:
            continue
        out[key] = float(df["Close"].iloc[-1])
        if key == "spy" and len(df) >= 21:
            out["spy_ret_1m"] = float(df["Close"].iloc[-1] / df["Close"].iloc[-21] - 1)
    _cache_set("macro", out)
    return out
