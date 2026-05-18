# Trading Agent — Pipeline ML

Objetivo: entrenar un agente que supere la heurística estadística del bot (VWAP-Reclaim-Scalp) usando los datos persistidos en SQLite.

## Estado actual (v2 — modelo standalone)

- **Datos**: 8.6M minute bars (5y Alpaca IEX) × 22 tickers
- **Modelo universal** (LightGBM, features v2, labels target 2% / stop 0.5% / horizon 60m): AUC test = **0.79** pero **net per-trade negativo** después de comisiones (0.6% RT Racional)
- **Modelos per-ticker** (uno por símbolo): solo 2/21 cruzan rentabilidad
  - **TSM ✓** — AUC 0.83, winrate 67%, **net +0.48% por trade**
  - **LLY ✓** — AUC 0.77, winrate 53%, **net +0.13% por trade** (borderline)
  - 19 tickers no superan comisiones aunque varios tienen AUC > 0.78 — la barrera estructural es que la comisión 0.6% es alta vs el target predecible
- **Sistema standalone** (`mlStandaloneEngine.js`): activo por defecto solo sobre tickers marcados profitable, evalúa cada minuto, persiste `ml_signals`/`ml_positions`/`ml_trades`

### Para hacerlo MÁS rentable

1. Reducir comisiones (broker con < 0.2% RT) — la matemática cambia totalmente
2. Re-entrenar mensualmente con datos nuevos
3. Agregar más tickers high-vol al watchlist y dejar que los per-ticker decidan

## Arquitectura

```
finance-app/                       ← Node app (server + DB + live feed)
  data/finance.db                  ← SQLite (compartida)
  lib/mlClient.js                  ← HTTP client al predict service
  lib/strategyEngine.js            ← persiste shadow_predictions en entry/exit
  agent/                           ← Python sidecar
    baseline.py                    ← XGBoost: train | eval | tune (optuna)
    predict_service.py             ← FastAPI: GET /health, POST /predict
    features.py                    ← feature engineering
    labels.py                      ← triple-barrier labeling
    alpaca_backfill.py             ← backfill histórico Alpaca
    alpaca_test.py                 ← smoke test keys
    requirements.txt
```

El agente vive en Python (mejor ecosistema ML), Node lo consume vía HTTP a `localhost:8001/predict`.

## Setup (gratis, en tu máquina)

```bash
cd finance-app/agent
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt

# (one-time) Backfill histórico Alpaca: 5y × 22 tickers ~ 8.6M bars
python alpaca_test.py                          # verifica keys
python alpaca_backfill.py --years 5

# Entrenar modelos (v2 con features cross-asset/multi-TF + labels target 2%/stop 0.5%)
python train_v2.py train --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60 --no-cv
python train_per_ticker.py --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60

# Backtest realista (comisiones + slippage)
python backtest.py --threshold 0.50 --max-open 3

# Servir inferencia (Node lo consume vía mlClient.js)
uvicorn predict_service:app --host 127.0.0.1 --port 8001
```

En Node hay DOS sistemas:

**Shadow mode** — `strategyEngine.js` (heurístico) llama a `/predict` después de cada ENTRY suya y persiste a `shadow_predictions` para auditar.

**Standalone mode** — `mlStandaloneEngine.js` corre independiente: cada `ML_STANDALONE_INTERVAL_MS` evalúa el watchlist, abre trades cuando prob > threshold (per-ticker), persiste a `ml_signals`/`ml_positions`/`ml_trades`. Por defecto opera **solo en tickers marcados profitable**.

Vars de entorno:
```
ML_PREDICT_URL=http://127.0.0.1:8001
ML_PREDICT_ENABLED=true
ML_PREDICT_TIMEOUT_MS=2500

ML_STANDALONE_ENABLED=true
ML_STANDALONE_INTERVAL_MS=60000
ML_STANDALONE_THRESHOLD=                  # vacío = usar el per-ticker guardado
ML_STANDALONE_CAPITAL_USD=100
ML_STANDALONE_MAX_OPEN=3
ML_STANDALONE_COMMISSION_PCT=0.6
ML_STANDALONE_SLIPPAGE_PCT=0.05
ML_STANDALONE_WHITELIST=                  # ej "TSM,LLY" — si vacío usa onlyProfitable
ML_STANDALONE_ONLY_PROFITABLE=true        # solo tickers con per-ticker model rentable
```

Rutas Node:
- `GET /live/ml/state` — config + posiciones abiertas + stats
- `GET /live/ml/trades?limit=N` — historial de trades cerrados
- `GET /live/ml/signals?limit=N` — historial de signals ENTRY/EXIT

## Datos disponibles en `data/finance.db`

| Tabla | Filas (esperado) | Uso |
|-------|------------------|-----|
| `minute_bars` | ~8.6M con Alpaca 5y | velas 1m OHLCV (`alpaca` > `yahoo` > `finnhub`) |
| `signals` | crece con cada trade | labels reales del bot (WIN/LOSS/BE) |
| `shadow_predictions` | 1 row por ENTRY del bot | prob ML + outcome real para tracking |
| `alerts` | eventos discretos | features de evento (rvolSpike, gap, etc) |
| `trades` | tus compras reales | benchmark personal |
| `price_history` | cierre diario | contexto multi-día |
| `fx_rates` | USD/CLP histórico | conversión |

## Roadmap (de menos a más ambicioso)

### Fase 1 — Optimización paramétrica (~días)
- Backtest la estrategia actual con `stopPct ∈ [0.2, 0.5]`, `targetPct ∈ [0.4, 1.0]`, etc.
- `optuna` busca el mejor set vía Bayesian optimization.
- **Casi seguro le gana al default arbitrario.**

### Fase 2 — Filtro ML de calidad de entrada (~semanas)
- Para cada momento donde el modelo estadístico DARÍA entrada, computar features y predecir prob(WIN).
- Solo entrar si prob(WIN) > 0.6.
- Modelo: `xgboost` o `lightgbm`. Features: snapshot técnico + hora + régimen SPY.
- **Mejora típica: 20-40% en expectancy.**

### Fase 3 — Modelo de secuencia (~meses)
- LSTM/Transformer sobre ventana de N minutos de OHLCV.
- Predice dirección + magnitud del próximo movimiento.
- Necesita 6+ meses de datos para no overfit.

### Fase 4 — Reinforcement Learning (~6+ meses de datos)
- Entorno gym: estado = ventana técnica, acción ∈ {BUY, SELL, HOLD}, reward = P&L.
- `stable-baselines3` con PPO o DQN.
- Backtests son traicioneros — validar walk-forward, paper-trade primero.

## Datos faltantes (cuándo escrapear más)

| Fuente | Costo | Cobertura | Cómo |
|--------|-------|-----------|------|
| **Yahoo** (actual) | gratis, sin auth | ~28 días back, 1m | `scripts/backfill_minute_bars.js` |
| **Alpaca** | gratis con cuenta | 6+ años, 1m (IEX feed) | `agent/alpaca_backfill.py` (TODO) |
| **Polygon free** | gratis 5 req/min | 2 años, 1m | requiere paciencia |
| **AlphaVantage** | gratis 25 req/día | 2 años, 1m | demasiado limitado |
| **Sentiment**: Reddit, Twitter scrape | gratis | tiempo real | `scripts/sentiment_*.py` (TODO) |

**Recomendación:** crear cuenta Alpaca (gratis, sin tarjeta) en https://alpaca.markets → genera API key → script de backfill puede traer 6+ años de bars 1m para los 22 tickers.

## ⚠️ Advertencias honestas

- **Backtests engañan.** Survivorship bias, look-ahead bias, slippage subestimado. Cualquier resultado < 10% drawdown / > 60% winrate **probablemente está sobreajustado**.
- **Tick data de Finnhub free** tiene gaps. El feed envía solo agregados; no hay garantía de cada trade individual. Alpaca IEX es similar (solo trades IEX).
- **Régimen de mercado importa.** Modelo entrenado en bull no funciona en bear. Reentrenar trimestralmente.
- **No usar plata real hasta validar 3+ meses de paper trading.**
