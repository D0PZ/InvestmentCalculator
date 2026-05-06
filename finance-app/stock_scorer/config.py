"""Configuración central del scorer."""
from __future__ import annotations
from dataclasses import dataclass, field

# Lista rápida (14 mega-caps tech) — buena para el dashboard live
QUICK_TICKERS: list[str] = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA",
    "AMD", "INTC", "NFLX", "AVGO", "CRM", "ORCL", "ADBE",
]

# S&P 100 — buena para entrenar modelos y minar patrones
# (cobertura sectorial real: tech, finance, energy, health, consumer, industrial)
SP100_TICKERS: list[str] = [
    # Tech
    "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "AVGO",
    "ORCL", "CRM", "ADBE", "AMD", "INTC", "CSCO", "QCOM", "TXN", "IBM",
    "ACN", "NOW", "INTU",
    # Finance
    "BRK-B", "JPM", "BAC", "WFC", "GS", "MS", "C", "AXP", "BLK", "SCHW",
    "USB", "PNC", "SPGI", "CB", "MMC", "ICE", "CME", "COF",
    # Health
    "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "DHR", "BMY",
    "AMGN", "CVS", "MDT", "GILD", "ELV", "ISRG", "SYK",
    # Consumer
    "WMT", "PG", "KO", "PEP", "COST", "MCD", "NKE", "SBUX", "TGT", "LOW",
    "HD", "DIS", "CMCSA", "VZ", "T", "TMUS", "NFLX",
    # Energy / industrial / materials
    "XOM", "CVX", "COP", "SLB", "CAT", "BA", "GE", "HON", "UNP", "UPS",
    "RTX", "LMT", "DE", "MMM", "EMR",
    # Otros
    "V", "MA", "PYPL", "BKNG", "ABNB", "UBER",
]

# Default usado por la CLI live (puedes cambiarlo a SP100_TICKERS si tu PC aguanta)
DEFAULT_TICKERS: list[str] = QUICK_TICKERS

# Universo extendido (~200 tickers) — usado para entrenar con más muestras.
# Más datos = modelo más preciso. Solo recomendado para train/patterns/backtest.
SP500_EXTENDED: list[str] = SP100_TICKERS + [
    # Tech adicional
    "PANW", "CRWD", "FTNT", "NET", "DDOG", "SNOW", "MDB", "ZS", "OKTA", "TEAM",
    "WDAY", "ADSK", "ANSS", "MRVL", "MU", "LRCX", "AMAT", "KLAC", "ASML", "TSM",
    # Finance adicional
    "MET", "PRU", "AIG", "AFL", "TRV", "ALL", "PGR", "HIG", "FITB", "RF",
    "KEY", "TFC", "MTB", "FRC", "CFG",
    # Health adicional
    "VRTX", "REGN", "BIIB", "MRNA", "BNTX", "ZTS", "EW", "BSX", "BAX", "BDX",
    "DXCM", "IDXX", "ALGN", "HCA", "HUM", "CI",
    # Consumer adicional
    "CL", "KMB", "GIS", "K", "HSY", "MDLZ", "STZ", "TAP", "MO", "PM",
    "EL", "ULTA", "LULU", "ROST", "TJX", "BBY", "DG", "DLTR", "KR", "WBA",
    "YUM", "CMG", "MAR", "HLT", "RCL", "CCL", "F", "GM", "RIVN", "LCID",
    # Energy / industrial adicional
    "EOG", "MPC", "PSX", "VLO", "OXY", "PXD", "HAL", "BKR", "KMI", "WMB",
    "MMC", "AON", "WM", "RSG", "ECL", "APD", "LIN", "SHW", "DOW", "DD",
    "NEM", "FCX", "VMC", "MLM", "NUE", "STLD",
    # REITs / utilities (diversificación)
    "AMT", "PLD", "CCI", "EQIX", "SPG", "O", "PSA", "WELL", "AVB", "EQR",
    "NEE", "DUK", "SO", "D", "AEP", "EXC", "SRE", "XEL", "PEG", "ED",
    # Autos / industrial pesado
    "TSLA", "F", "GM", "STLA", "TM", "HMC",
]
# Dedupe preservando orden
_seen: set[str] = set()
SP500_EXTENDED = [t for t in SP500_EXTENDED if not (t in _seen or _seen.add(t))]

# Benchmark para features relativas
BENCHMARK = "SPY"

# Intervalos de refresh permitidos (segundos)
REFRESH_OPTIONS = (15, 30, 60)
DEFAULT_REFRESH = 30

# Cache TTL (segundos)
FUNDAMENTALS_TTL = 60 * 60 * 6   # 6h: cambian trimestralmente
NEWS_TTL = 60 * 5                # 5min
PRICE_TTL = 0                    # siempre fresco

# Pesos del modelo heurístico (fallback cuando XGBoost no está entrenado)
# Suman ~1.0 — interpretables.
HEURISTIC_WEIGHTS: dict[str, float] = {
    "revenue_growth":   0.15,
    "eps_growth":       0.15,
    "profit_margin":    0.10,
    "roe":              0.08,
    "debt_to_equity":  -0.10,   # negativo: más deuda → peor
    "rsi_zone":         0.07,   # bonus si RSI 40-60 (no sobrecomprado)
    "trend_ma":         0.15,   # precio > MA50 > MA200
    "momentum_3m":      0.10,
    "rel_strength_spy": 0.07,
    "volume_surge":     0.03,
    "sentiment":        0.10,
}

# Modelo XGBoost
MODEL_PATH = "stock_scorer/model_xgb.json"
MODEL_CLF_UP_PATH = "stock_scorer/model_clf_up.json"     # P(retorno > +threshold) en 21d
MODEL_CLF_DOWN_PATH = "stock_scorer/model_clf_down.json" # P(retorno < -threshold) en 21d
# Horizonte corto (1 semana) para rentabilidad rápida
MODEL_SHORT_PATH = "stock_scorer/model_xgb_short.json"
MODEL_SHORT_UP_PATH = "stock_scorer/model_clf_up_short.json"
MODEL_SHORT_DOWN_PATH = "stock_scorer/model_clf_down_short.json"
TRAIN_LOOKBACK_YEARS = 10
FORWARD_RETURN_DAYS = 21          # ~1 mes hábil (swing trading)
FORWARD_RETURN_DAYS_SHORT = 5     # ~1 semana hábil (short-term)
WALK_FORWARD_FOLDS = 5            # validación out-of-sample
UP_THRESHOLD = 0.05               # retorno considerado 'subida fuerte' (+5%) a 21d
DOWN_THRESHOLD = -0.05            # 'bajada fuerte' (-5%) a 21d
UP_THRESHOLD_SHORT = 0.02         # +2% a 5d (más realista en horizonte corto)
DOWN_THRESHOLD_SHORT = -0.02
# Half-life del decay temporal en sample weights (días)
# 1 año = enfocado en dinámica reciente. 3 años = balance histórico/reciente.
WEIGHT_HALF_LIFE_DAYS = 365       # 1 año (era 3 años): más sensible al régimen actual
