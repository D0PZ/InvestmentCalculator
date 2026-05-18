# Finance App

Personal finance dashboard en CLP — Express + SQLite + EJS.

## Setup

```bash
cd finance-app
npm install
cp .env.example .env
npm run seed   # carga cuentas y suscripciones iniciales
npm start
```

Abre http://localhost:3000

## Deploy

- Stateless excepto por `data/finance.db`. Monta volumen persistente en el server.
- Variables: `PORT`, `DB_PATH`, `NODE_ENV=production`.
- Detrás de Nginx/Caddy con HTTPS. La app no tiene auth aún — agregar antes de exponer públicamente.

## Estructura

- `server.js` — entry point Express
- `lib/db.js` — SQLite schema (`node:sqlite`, sincrónico)
- `lib/health.js` — score de salud financiera + tips
- `lib/format.js` — helpers CLP / fechas
- `routes/` — dashboard, transactions, accounts, subscriptions, positions, live
- `views/` — EJS con layout compartido
- `public/css/style.css` — tema dark
- `agent/` — agente ML (Python) para predicciones intradía sobre minute_bars

## Auth

Primer arranque → `/setup` para definir contraseña (mín 8 chars, hasheada con `crypto.scryptSync`).
Sesión vía cookie firmada (`cookie-session`, 7 días). Botón **Salir** en la nav.

En producción **siempre** setear `SESSION_SECRET` largo en `.env` y `NODE_ENV=production` (cookie pasa a `secure`).

## Stock prices

En `/positions`:
- **↻ Refresh precios** — actualiza precios de las posiciones existentes desde Yahoo Finance.

Datos de mercado vienen de Yahoo Finance v7 (sin API key). FX USD/CLP via `USDCLP=X`. Minute bars
live vienen de Alpaca paper (IEX feed) — ver `agent/README.md`.

## Próximos pasos sugeridos

- Recordatorios mensuales por email para registrar pago CMR y aporte Racional.
- Categorización automática de gastos.
- Cron diario para refresh automático de precios.
