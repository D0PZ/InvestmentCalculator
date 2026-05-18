"""Walk-forward backtester realista para el modelo standalone.

Simula trading minuto-a-minuto con:
- Comisión 0.6% round-trip (Racional)
- Slippage 5 bp por lado
- Concurrency limit (max_open_positions)
- Targets/stops escalados a ATR (mismas reglas que las labels)
- Time stop al final del horizonte
- Cierre forzado antes de cierre de mercado

Uso:
    python backtest.py                              # usa standalone_lgbm.joblib
    python backtest.py --threshold 0.55 --max-open 3 --capital 100
    python backtest.py --start 2024-01-01 --end 2024-12-31
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd

from features_v2 import build_features_v2, FEATURE_COLS_V2

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"

COMMISSION_PCT = 0.6
SLIPPAGE_PCT = 0.05


def load_bars(ts_min: int | None, ts_max: int | None, min_obs: int = 1000):
    con = sqlite3.connect(DB_PATH)
    q = "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars"
    args = []
    where = []
    if ts_min is not None: where.append("ts >= ?"); args.append(ts_min)
    if ts_max is not None: where.append("ts <= ?"); args.append(ts_max)
    if where: q += " WHERE " + " AND ".join(where)
    q += " ORDER BY ticker, ts"
    df = pd.read_sql_query(q, con, params=args)
    con.close()
    counts = df.groupby("ticker").size()
    keep = counts[counts >= min_obs].index.tolist()
    df = df[df["ticker"].isin(keep)].copy()
    spy = df[df["ticker"] == "SPY"][["ts", "close", "volume"]].copy()
    return df, spy


def build_features_all(bars: pd.DataFrame, spy: pd.DataFrame) -> pd.DataFrame:
    parts = []
    for ticker, grp in bars.groupby("ticker"):
        if ticker == "SPY":
            continue
        if len(grp) < 200: continue
        f = build_features_v2(grp, spy_bars=spy)
        f["ticker"] = ticker
        parts.append(f)
    out = pd.concat(parts, ignore_index=True)
    out[FEATURE_COLS_V2] = out[FEATURE_COLS_V2].replace([np.inf, -np.inf], np.nan)
    return out


def ny_minute_of_day(ts_ms: int) -> int:
    dt = pd.Timestamp(ts_ms, unit="ms", tz="UTC").tz_convert("America/New_York")
    return dt.hour * 60 + dt.minute


def simulate(feats_per_ticker: dict[str, pd.DataFrame],
             model, calibrator,
             threshold: float,
             label_cfg: dict,
             max_open: int = 3,
             capital_per_trade: float = 100.0,
             min_minute_from_open: int = 30,
             flat_before_close_min: int = 5) -> dict:
    """Itera bar-a-bar (todos los tickers simultáneos) y simula trades.
    Devuelve dict con equity curve y trades.
    """
    horizon = int(label_cfg["horizon_min"])
    target_mult_atr = float(label_cfg["target_mult_atr"])
    stop_mult_atr = float(label_cfg["stop_mult_atr"])

    # Para cada ticker, score todas las barras y guardar arrays
    per_ticker = {}
    all_ts = set()
    for ticker, feats in feats_per_ticker.items():
        f = feats.dropna(subset=FEATURE_COLS_V2 + ["atr_14"]).reset_index(drop=True)
        if len(f) == 0: continue
        prob_raw = model.predict_proba(f[FEATURE_COLS_V2])[:, 1]
        prob = calibrator.transform(prob_raw)
        per_ticker[ticker] = {
            "ts": f["ts"].to_numpy(),
            "open": f["open"].to_numpy(),
            "high": f["high"].to_numpy(),
            "low": f["low"].to_numpy(),
            "close": f["close"].to_numpy(),
            "atr": f["atr_14"].to_numpy(),
            "prob": prob,
            "idx_by_ts": {int(t): i for i, t in enumerate(f["ts"].to_numpy())},
        }
        all_ts.update(int(t) for t in f["ts"].to_numpy())

    timeline = sorted(all_ts)
    print(f"Simulando {len(timeline):,} timestamps únicos × {len(per_ticker)} tickers...")

    open_pos = {}  # symbol -> {entry, target, stop, entry_ts, expire_ts, ...}
    trades = []
    skipped_concurrency = 0

    for ts in timeline:
        # 1. Check exits for all open positions
        to_close = []
        for symbol, pos in open_pos.items():
            d = per_ticker[symbol]
            idx = d["idx_by_ts"].get(ts)
            if idx is None:
                # No bar this minute for this ticker — wait
                continue
            high = d["high"][idx]; low = d["low"][idx]; close = d["close"][idx]
            outcome = None; exit_price = None
            if high >= pos["target"]:
                outcome = "WIN"; exit_price = pos["target"]
            elif low <= pos["stop"]:
                outcome = "LOSS"; exit_price = pos["stop"]
            elif ts >= pos["expire_ts"]:
                outcome = "TIMEOUT"; exit_price = close
            else:
                ny = ny_minute_of_day(ts)
                if ny >= 960 - flat_before_close_min:
                    outcome = "EOD_CLOSE"; exit_price = close
            if outcome is not None:
                gross_pct = (exit_price - pos["entry"]) / pos["entry"] * 100
                net_pct = gross_pct - COMMISSION_PCT - 2 * SLIPPAGE_PCT
                trades.append({
                    "symbol": symbol,
                    "entry_ts": pos["entry_ts"],
                    "entry": pos["entry"],
                    "exit_ts": ts,
                    "exit": exit_price,
                    "target_pct": pos["target_pct"],
                    "stop_pct": pos["stop_pct"],
                    "prob": pos["prob"],
                    "outcome": outcome,
                    "gross_pct": gross_pct,
                    "net_pct": net_pct,
                })
                to_close.append(symbol)
        for s in to_close:
            del open_pos[s]

        # 2. Check entries for tickers not already open
        if len(open_pos) >= max_open:
            continue
        ny = ny_minute_of_day(ts)
        if ny < 570 + min_minute_from_open or ny >= 960 - flat_before_close_min - horizon:
            continue
        candidates = []
        for symbol, d in per_ticker.items():
            if symbol in open_pos: continue
            idx = d["idx_by_ts"].get(ts)
            if idx is None: continue
            p = d["prob"][idx]
            if p >= threshold and np.isfinite(d["atr"][idx]):
                candidates.append((p, symbol, idx))
        candidates.sort(reverse=True)
        slots = max_open - len(open_pos)
        for p, symbol, idx in candidates[:slots]:
            d = per_ticker[symbol]
            entry = float(d["close"][idx])
            a = float(d["atr"][idx])
            target_dollars = target_mult_atr * a
            stop_dollars = stop_mult_atr * a
            target = entry + target_dollars
            stop = entry - stop_dollars
            open_pos[symbol] = {
                "entry": entry,
                "target": target,
                "stop": stop,
                "target_pct": target_dollars / entry * 100,
                "stop_pct": stop_dollars / entry * 100,
                "entry_ts": ts,
                "expire_ts": ts + horizon * 60 * 1000,
                "prob": float(p),
            }
        if len(candidates) > slots:
            skipped_concurrency += len(candidates) - slots

    # Close any still-open at end (mark to last price)
    final_ts = timeline[-1] if timeline else 0
    for symbol, pos in list(open_pos.items()):
        d = per_ticker[symbol]
        last_idx = len(d["close"]) - 1
        exit_price = float(d["close"][last_idx])
        gross_pct = (exit_price - pos["entry"]) / pos["entry"] * 100
        net_pct = gross_pct - COMMISSION_PCT - 2 * SLIPPAGE_PCT
        trades.append({
            "symbol": symbol, "entry_ts": pos["entry_ts"], "entry": pos["entry"],
            "exit_ts": final_ts, "exit": exit_price,
            "target_pct": pos["target_pct"], "stop_pct": pos["stop_pct"],
            "prob": pos["prob"], "outcome": "MARKED",
            "gross_pct": gross_pct, "net_pct": net_pct,
        })

    return {"trades": trades, "skipped_concurrency": skipped_concurrency,
            "timeline_len": len(timeline)}


def report(trades_df: pd.DataFrame, capital_per_trade: float):
    if trades_df.empty:
        print("⚠️  No se generaron trades en el período. Bajá threshold o ajustá filtros.")
        return
    trades_df = trades_df.sort_values("entry_ts").reset_index(drop=True)
    trades_df["pnl_usd"] = trades_df["net_pct"] / 100 * capital_per_trade
    trades_df["cum_pnl"] = trades_df["pnl_usd"].cumsum()
    n = len(trades_df)
    wins = (trades_df["net_pct"] > 0).sum()
    losses = (trades_df["net_pct"] <= 0).sum()
    avg_pct = trades_df["net_pct"].mean()
    median_pct = trades_df["net_pct"].median()
    total_pct = trades_df["net_pct"].sum()
    total_usd = trades_df["pnl_usd"].sum()
    sharpe = trades_df["net_pct"].mean() / trades_df["net_pct"].std() * np.sqrt(252) if trades_df["net_pct"].std() > 0 else 0
    peak = trades_df["cum_pnl"].cummax()
    drawdown = trades_df["cum_pnl"] - peak
    mdd_usd = drawdown.min()

    print("\n=== Backtest result ===")
    print(f"Trades: {n:,}  Wins: {wins:,}  Losses: {losses:,}  Winrate: {wins/n*100:.1f}%")
    print(f"Avg net per trade: {avg_pct:+.4f}%  (median {median_pct:+.4f}%)")
    print(f"Total net return: {total_pct:+.2f}%  ≈ ${total_usd:+.2f} con ${capital_per_trade}/trade")
    print(f"Sharpe (~daily-equiv): {sharpe:.2f}")
    print(f"Max drawdown: ${mdd_usd:+.2f}")
    print(f"\n=== Per ticker ===")
    per_t = trades_df.groupby("symbol").agg(
        n=("net_pct", "size"),
        winrate=("net_pct", lambda s: (s > 0).mean() * 100),
        avg_net_pct=("net_pct", "mean"),
        total_pct=("net_pct", "sum"),
    ).sort_values("total_pct", ascending=False)
    print(per_t.round(4).to_string())
    print(f"\n=== Outcome breakdown ===")
    print(trades_df["outcome"].value_counts().to_string())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, default=str(MODELS / "standalone_lgbm.joblib"))
    parser.add_argument("--threshold", type=float, default=None, help="override threshold guardado")
    parser.add_argument("--max-open", type=int, default=3)
    parser.add_argument("--capital", type=float, default=100.0, help="USD por trade")
    parser.add_argument("--start", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--end", type=str, default=None, help="YYYY-MM-DD")
    parser.add_argument("--last-frac", type=float, default=0.2, help="usar solo el último N%% del dataset si no se da start/end (default 0.2)")
    parser.add_argument("--out", type=str, default=str(MODELS / "backtest_trades.csv"))
    args = parser.parse_args()

    payload = joblib.load(args.model)
    model = payload["model"]; calibrator = payload["calibrator"]
    label_cfg = payload["label_cfg"]
    threshold = args.threshold if args.threshold is not None else payload["threshold"]
    print(f"Model: {args.model}\nThreshold: {threshold}\nLabel cfg: {label_cfg}")

    ts_min = ts_max = None
    if args.start:
        ts_min = int(pd.Timestamp(args.start, tz="UTC").timestamp() * 1000)
    if args.end:
        ts_max = int(pd.Timestamp(args.end, tz="UTC").timestamp() * 1000)
    bars, spy = load_bars(ts_min, ts_max)
    print(f"Bars: {len(bars):,}")
    feats = build_features_all(bars, spy)
    if ts_min is None and ts_max is None and args.last_frac < 1.0:
        # Use last N% by ts globally
        cutoff_ts = feats["ts"].quantile(1.0 - args.last_frac)
        feats = feats[feats["ts"] >= cutoff_ts].copy()
        print(f"Trimmed to last {args.last_frac*100:.0f}%: {len(feats):,} bars, ts>={pd.Timestamp(cutoff_ts, unit='ms', tz='UTC')}")

    feats_per_ticker = {t: g.reset_index(drop=True) for t, g in feats.groupby("ticker")}
    result = simulate(feats_per_ticker, model, calibrator,
                      threshold=threshold, label_cfg=label_cfg,
                      max_open=args.max_open,
                      capital_per_trade=args.capital)
    trades_df = pd.DataFrame(result["trades"])
    if not trades_df.empty:
        trades_df.to_csv(args.out, index=False)
        print(f"Saved trades: {args.out}")
    report(trades_df, args.capital)
    print(f"\nSkipped concurrency: {result['skipped_concurrency']:,}")


if __name__ == "__main__":
    main()
