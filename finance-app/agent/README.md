# Trading Agent — Pipeline ML

Objetivo: entrenar un agente que supere la heurística estadística del bot (VWAP-Reclaim-Scalp) usando los datos persistidos en SQLite.

## Arquitectura

```
finance-app/                       ← Node app (server + DB + live feed)
  data/finance.db                  ← SQLite (compartida)
  agent/                           ← Python sidecar
    baseline.py                    ← XGBoost classifier (entry quality)
    features.py                    ← feature engineering (RSI, VWAP, etc)
    labels.py                      ← genera labels (WIN/LOSS oraculares)
    backtest.py                    ← walk-forward backtester
    serve.py                       ← FastAPI: POST /predict
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

# Entrenar baseline contra tus datos en data/finance.db
python baseline.py train

# Backtest walk-forward (cuando lo implementes)
python backtest.py --window 14d --tickers MSFT,NVDA

# Servir inferencia (cuando lo implementes)
uvicorn serve:app --port 8001
```

Después en Node, llamás:
```js
const { agentScore } = await fetch('http://localhost:8001/predict', { method: 'POST', body: JSON.stringify(snapshot) });
if (agentScore > 0.6) executeEntry();
```

## Datos disponibles en `data/finance.db`

| Tabla | Filas (esperado) | Uso |
|-------|------------------|-----|
| `minute_bars` | ~150K+ después del backfill | velas 1m OHLCV (`finnhub` live + `yahoo` backfill) |
| `signals` | crece con cada trade | labels reales del bot (WIN/LOSS/BE) |
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
