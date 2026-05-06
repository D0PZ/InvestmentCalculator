# InvestmentCalculator

Plataforma personal de finanzas + recomendación de acciones. Todo el código vive bajo [`finance-app/`](finance-app/).

```
finance-app/
├── server.js              # Express + SQLite + EJS (dashboard web, auth, gastos/ingresos/patrimonio)
├── lib/                   # db, auth, market data (Yahoo), salud financiera
├── routes/                # dashboard, transactions, accounts, subscriptions, positions
├── views/                 # EJS dark UI
├── stock_scorer/          # Recomendador de acciones (Python, ML + scoring 0-100)
├── scripts/
│   ├── investment_calculator.py    # Monte Carlo de capital + aportes
│   └── register_positions.py       # Registra posiciones con SL/TP por ATR
└── requirements.txt       # Deps Python para stock_scorer
```

## Web app (Node.js)

```bash
cd finance-app
npm install
cp .env.example .env
npm run seed   # carga inicial de cuentas y suscripciones
npm start      # http://localhost:3000
```

Primer acceso → `/setup` para definir contraseña. Después login con cookie firmada.

Features:
- Dashboard de salud financiera (score 0-100, ingresos, gastos, suscripciones, flujo neto)
- Cuentas (débito, crédito, digital, beneficio) con alertas de uso de crédito
- Movimientos (gastos/ingresos) con categorización
- Suscripciones recurrentes (mensual / anual / cuotas)
- Posiciones de acciones con sync desde `stock_scorer/positions.json` y precios live de Yahoo Finance
- Patrimonio total = cash + inversiones − deuda
- Aporte sugerido a Plan Racional (rango 500k–1M CLP)
- Tips contextuales (CMR alto, mes ajustado, suscripciones excesivas)

Más detalles en [finance-app/README.md](finance-app/README.md).

## Stock scorer (Python, ML)

Sistema de scoring 0-100 por acción: fundamentales (yfinance) + técnicos (RSI/MA/momentum) + sentimiento (RSS) + XGBoost con walk-forward CV.

```bash
cd finance-app
pip install -r requirements.txt

# Live dashboard con refresh 30s
py -m stock_scorer

# Una pasada
py -m stock_scorer --once

# Entrenar modelos
py -m stock_scorer.train --years 10

# Backtest
py -m stock_scorer.backtest --years 5 --top-k 5 --threshold 60
```

Arquitectura:

```
stock_scorer/
  config.py      tickers, universos, umbrales
  db.py          SQLite cache OHLCV
  scrapers.py    yfinance + RSS + paralelización
  features.py    RSI, MA, momentum, fundamentales
  risk.py        ATR + Kelly + TradePlan
  model.py       XGBoost regresión + clasificadores P(↑)/P(↓)
  patterns.py    pattern mining histórico
  scorer.py      ranking + trade plans
  train.py       walk-forward training
  backtest.py    backtest walk-forward
```

## Calculadora Monte Carlo

```bash
cd finance-app
python scripts/investment_calculator.py
```

## Registrar posiciones rápido

```bash
cd finance-app
py scripts/register_positions.py
```

Genera `stock_scorer/positions.json` con SL/TP calculados por ATR — luego desde la web app sincronizas con un click.
