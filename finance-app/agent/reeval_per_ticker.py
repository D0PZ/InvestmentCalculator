"""Re-evalúa los modelos per-ticker existentes con quantile sweep más estricto.
No re-entrena — solo carga modelos y aplica thresholds más altos al test set.

Uso:
    python reeval_per_ticker.py
"""
from __future__ import annotations

import json
import sqlite3
import sys
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from features_v2 import build_features_v2, FEATURE_COLS_V2
from labels import triple_barrier as triple_barrier_fixed

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"
PER_TICKER_DIR = MODELS / "per_ticker"

COMMISSION_PCT = 0.6
SLIPPAGE_PCT = 0.05
TOTAL_COST = COMMISSION_PCT + 2 * SLIPPAGE_PCT


def load_data():
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query(
        "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars ORDER BY ticker, ts", con)
    con.close()
    spy = df[df["ticker"] == "SPY"][["ts", "close", "volume"]].copy()
    others = df[df["ticker"] != "SPY"].copy()
    return others, spy


def build_ticker(grp, spy, cfg):
    feats = build_features_v2(grp, spy_bars=spy)
    labeled = triple_barrier_fixed(feats, target_pct=cfg["fixed_target_pct"],
                                   stop_pct=cfg["fixed_stop_pct"],
                                   horizon_minutes=cfg["horizon_min"])
    labeled["target_pct"] = cfg["fixed_target_pct"]
    labeled["stop_pct"] = cfg["fixed_stop_pct"]
    labeled[FEATURE_COLS_V2] = labeled[FEATURE_COLS_V2].replace([np.inf, -np.inf], np.nan)
    labeled = labeled.dropna(subset=FEATURE_COLS_V2 + ["label"])
    labeled = labeled[labeled["label"] != 2]
    return labeled


def main():
    bars, spy = load_data()
    print(f"{'ticker':<6} {'AUC':>6} {'base%':>6}  ", end="")
    quantiles = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.10]
    for q in quantiles:
        print(f" top{q*100:>5.2f}%(n,wr,net)", end="")
    print()
    print("-" * 130)

    summary_60 = []   # tickers with winrate >= 60% at any quantile (with n>=50)
    summary_50 = []
    summary_profit = []

    for joblib_path in sorted(PER_TICKER_DIR.glob("*.joblib")):
        ticker = joblib_path.stem
        pt = joblib.load(joblib_path)
        cfg = pt["label_cfg"]
        grp = bars[bars["ticker"] == ticker]
        if len(grp) < 5000: continue
        df = build_ticker(grp, spy, cfg).sort_values("ts").reset_index(drop=True)
        if len(df) < 500: continue
        cutoff = int(len(df) * 0.8)
        test = df.iloc[cutoff:]
        if len(test) < 100: continue
        X_te = test[FEATURE_COLS_V2]
        y_te = (test["label"] == 1).astype(int).to_numpy()
        prob = pt["model"].predict_proba(X_te)[:, 1]
        auc = roc_auc_score(y_te, prob) if y_te.min() != y_te.max() else float("nan")

        line = f"{ticker:<6} {auc:>6.3f} {y_te.mean()*100:>5.1f}%  "
        best_wr_60 = None
        best_profitable = None
        best_wr_50 = None
        for q in quantiles:
            thr = float(np.quantile(prob, 1 - q))
            mask = prob >= thr
            n = int(mask.sum())
            if n < 10:
                line += f"   --       --     "
                continue
            wr = float(y_te[mask].mean())
            tgt = cfg["fixed_target_pct"]; stp = cfg["fixed_stop_pct"]
            gross = wr * tgt - (1 - wr) * stp
            net = gross - TOTAL_COST
            badge = "P" if net > 0 else " "
            if wr >= 0.60 and n >= 30 and (best_wr_60 is None or wr > best_wr_60[2]):
                best_wr_60 = (ticker, q, wr, n, net)
            if wr >= 0.50 and n >= 30 and (best_wr_50 is None or wr > best_wr_50[2]):
                best_wr_50 = (ticker, q, wr, n, net)
            if net > 0 and n >= 30 and (best_profitable is None or net > best_profitable[4]):
                best_profitable = (ticker, q, wr, n, net)
            line += f"{badge}{n:>4}|{wr*100:>4.0f}%|{net:>+5.2f}%"
        print(line)
        if best_wr_60: summary_60.append(best_wr_60)
        if best_wr_50: summary_50.append(best_wr_50)
        if best_profitable: summary_profit.append(best_profitable)

    print(f"\n=== Tickers que alcanzan winrate >= 60% (n>=30) ===")
    summary_60.sort(key=lambda x: -x[2])
    for t, q, wr, n, net in summary_60:
        print(f"  {t}: top{q*100:.2f}%  n={n}  wr={wr*100:.1f}%  net={net:+.3f}%/trade")

    print(f"\n=== Tickers que alcanzan winrate >= 50% (n>=30) ===")
    summary_50.sort(key=lambda x: -x[2])
    for t, q, wr, n, net in summary_50:
        print(f"  {t}: top{q*100:.2f}%  n={n}  wr={wr*100:.1f}%  net={net:+.3f}%/trade")

    print(f"\n=== Tickers con net positivo en algún quantile (n>=30) ===")
    summary_profit.sort(key=lambda x: -x[4])
    for t, q, wr, n, net in summary_profit:
        print(f"  {t}: top{q*100:.2f}%  n={n}  wr={wr*100:.1f}%  net={net:+.3f}%/trade")


if __name__ == "__main__":
    main()
