"""SQLite cache para precios OHLCV histórico.

Solo descarga los días nuevos desde la última fecha guardada.
Esto reduce el tiempo de refresh con 100 tickers de ~60s a ~2s.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta
from threading import Lock

import pandas as pd

DB_PATH = "stock_scorer/cache.db"
_db_lock = Lock()


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prices (
            ticker   TEXT NOT NULL,
            date     TEXT NOT NULL,
            open     REAL,
            high     REAL,
            low      REAL,
            close    REAL,
            volume   REAL,
            PRIMARY KEY (ticker, date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_prices_ticker ON prices(ticker)")
    return conn


def get_last_date(ticker: str) -> datetime | None:
    """Última fecha guardada para un ticker, o None si no hay datos."""
    with _db_lock, _connect() as conn:
        row = conn.execute(
            "SELECT MAX(date) FROM prices WHERE ticker = ?", (ticker,)
        ).fetchone()
    if row and row[0]:
        return datetime.fromisoformat(row[0])
    return None


def get_first_date(ticker: str) -> datetime | None:
    """Primera fecha guardada para un ticker (para coverage check)."""
    with _db_lock, _connect() as conn:
        row = conn.execute(
            "SELECT MIN(date) FROM prices WHERE ticker = ?", (ticker,)
        ).fetchone()
    if row and row[0]:
        return datetime.fromisoformat(row[0])
    return None


def load_prices(ticker: str, start: datetime | None = None) -> pd.DataFrame:
    """Carga histórico desde la DB. Si start es None, devuelve todo."""
    query = "SELECT date, open, high, low, close, volume FROM prices WHERE ticker = ?"
    params: list = [ticker]
    if start is not None:
        query += " AND date >= ?"
        params.append(start.strftime("%Y-%m-%d"))
    query += " ORDER BY date ASC"
    with _db_lock, _connect() as conn:
        df = pd.read_sql_query(query, conn, params=params)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date")
    df.columns = ["Open", "High", "Low", "Close", "Volume"]
    return df


def save_prices(ticker: str, df: pd.DataFrame) -> int:
    """Guarda OHLCV (upsert). df debe tener columnas Open/High/Low/Close/Volume y DatetimeIndex."""
    if df.empty:
        return 0
    rows = []
    for ts, r in df.iterrows():
        rows.append((
            ticker,
            ts.strftime("%Y-%m-%d"),
            float(r["Open"]) if pd.notna(r["Open"]) else None,
            float(r["High"]) if pd.notna(r["High"]) else None,
            float(r["Low"]) if pd.notna(r["Low"]) else None,
            float(r["Close"]) if pd.notna(r["Close"]) else None,
            float(r["Volume"]) if pd.notna(r["Volume"]) else None,
        ))
    with _db_lock, _connect() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO prices (ticker, date, open, high, low, close, volume) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    return len(rows)


def clear_ticker(ticker: str) -> None:
    with _db_lock, _connect() as conn:
        conn.execute("DELETE FROM prices WHERE ticker = ?", (ticker,))
        conn.commit()


def db_stats() -> dict:
    with _db_lock, _connect() as conn:
        n_tickers = conn.execute("SELECT COUNT(DISTINCT ticker) FROM prices").fetchone()[0]
        n_rows = conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
        size_mb = os.path.getsize(DB_PATH) / 1024 / 1024 if os.path.exists(DB_PATH) else 0
    return {"tickers": n_tickers, "rows": n_rows, "size_mb": round(size_mb, 2)}
