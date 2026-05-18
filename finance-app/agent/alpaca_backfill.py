"""Backfill histórico desde Alpaca Markets (free tier).

Alpaca da acceso GRATIS a 1m bars desde ~2016 vía IEX feed (subset del consolidated tape,
pero suficiente para entrenar). Necesitas cuenta gratis en https://alpaca.markets (sin tarjeta).

Setup (una sola vez):
1. Crear cuenta en https://alpaca.markets/ (paper trading, gratis, sin tarjeta)
2. Generar API key en Dashboard → API Keys (modo paper)
3. Copiar .env.example → .env y completar ALPACA_API_KEY y ALPACA_SECRET

Uso:
    python alpaca_backfill.py                              # 22 tickers, ~2 años
    python alpaca_backfill.py --years 5                    # 5 años
    python alpaca_backfill.py --tickers MSFT,NVDA,TSLA     # solo algunos

El script:
- Pull 1m bars en chunks (Alpaca tiene paginación)
- Upsert idempotente a minute_bars con source='alpaca'
- Respeta el rate limit (200 req/min en free tier)
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
ENV_PATH = ROOT.parent / ".env"
load_dotenv(ENV_PATH)
load_dotenv(ROOT / ".env", override=True)

API_KEY = os.getenv("ALPACA_API_KEY", "").strip()
API_SECRET = os.getenv("ALPACA_SECRET", "").strip()

DEFAULT_TICKERS = [
    "MSFT", "TTWO", "NOW", "ACN", "GOOGL", "AMZN", "META", "NVDA",
    "AMD", "MU", "INTC", "TSM", "PLTR", "TSLA", "CRWD", "SHOP",
    "LLY", "UNH", "V", "COST", "SPY", "QQQ",
]


def require_keys():
    if not API_KEY or not API_SECRET:
        print("❌ No hay ALPACA_API_KEY / ALPACA_SECRET en .env", file=sys.stderr)
        print(f"   Crea cuenta gratis en https://alpaca.markets y copia las keys a {ENV_PATH}", file=sys.stderr)
        sys.exit(1)


def upsert_bars(con: sqlite3.Connection, ticker: str, bars):
    cur = con.cursor()
    count = 0
    for bar in bars:
        ts_ms = int(bar.timestamp.timestamp() * 1000)
        cur.execute(
            """INSERT INTO minute_bars (ticker, ts, open, high, low, close, volume, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'alpaca')
               ON CONFLICT(ticker, ts) DO UPDATE SET
                 open=excluded.open, high=excluded.high, low=excluded.low,
                 close=excluded.close, volume=excluded.volume,
                 source=CASE WHEN minute_bars.source='finnhub' THEN minute_bars.source ELSE excluded.source END""",
            (ticker, ts_ms, float(bar.open), float(bar.high), float(bar.low),
             float(bar.close), int(bar.volume or 0)),
        )
        count += 1
    con.commit()
    return count


def fetch_ticker(client, ticker: str, start: datetime, end: datetime, con: sqlite3.Connection) -> int:
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame

    req = StockBarsRequest(
        symbol_or_symbols=ticker,
        timeframe=TimeFrame.Minute,
        start=start,
        end=end,
        adjustment="raw",
        feed="iex",
    )
    resp = client.get_stock_bars(req)
    bars = resp.data.get(ticker, [])
    if not bars:
        return 0
    return upsert_bars(con, ticker, bars)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--years", type=float, default=2.0, help="años hacia atrás (default 2)")
    parser.add_argument("--tickers", type=str, default=None, help="comma-separated tickers")
    parser.add_argument("--db", type=str, default=str(DB_PATH))
    args = parser.parse_args()

    require_keys()
    from alpaca.data.historical import StockHistoricalDataClient

    tickers = (
        [s.strip().upper() for s in args.tickers.split(",")]
        if args.tickers else DEFAULT_TICKERS
    )
    print(f"Alpaca backfill: {len(tickers)} tickers × {args.years} años")
    print(f"DB: {args.db}")

    client = StockHistoricalDataClient(API_KEY, API_SECRET)
    end = datetime.now(timezone.utc) - timedelta(minutes=16)  # delayed ≥15min for free tier
    start = end - timedelta(days=int(args.years * 365))

    con = sqlite3.connect(args.db)
    try:
        grand_total = 0
        for i, t in enumerate(tickers, 1):
            t0 = time.time()
            try:
                n = fetch_ticker(client, t, start, end, con)
                elapsed = time.time() - t0
                print(f"  [{i:>2}/{len(tickers)}] {t:<6} {n:>7,} bars  ({elapsed:.1f}s)")
                grand_total += n
            except Exception as exc:
                print(f"  [{i:>2}/{len(tickers)}] {t:<6} ERROR: {exc}")
            time.sleep(0.4)  # ~150 req/min, well under 200/min limit

        print(f"\n✅ Total insertados/actualizados: {grand_total:,} bars")

        cur = con.execute("""
            SELECT ticker, COUNT(*) AS n,
                   datetime(MIN(ts)/1000, 'unixepoch') AS first,
                   datetime(MAX(ts)/1000, 'unixepoch') AS last,
                   SUM(CASE WHEN source='alpaca' THEN 1 ELSE 0 END) AS alpaca,
                   SUM(CASE WHEN source='yahoo' THEN 1 ELSE 0 END) AS yahoo,
                   SUM(CASE WHEN source='finnhub' THEN 1 ELSE 0 END) AS finnhub
            FROM minute_bars GROUP BY ticker ORDER BY ticker
        """)
        print("\n📊 Resumen:")
        print(f"{'ticker':<8} {'total':>10} {'first':<11} {'last':<11} {'alpaca':>8} {'yahoo':>8} {'finnhub':>8}")
        for row in cur:
            print(f"{row[0]:<8} {row[1]:>10,} {row[2][:10]:<11} {row[3][:10]:<11} {row[4]:>8} {row[5]:>8} {row[6]:>8}")
    finally:
        con.close()


if __name__ == "__main__":
    main()
