"""Actualiza los thresholds y marca como profitable a los modelos per-ticker
que ahora alcanzan rentabilidad en quantiles más estrictos (top 0.1-0.2%).

Lee el resultado del reeval mental y aplica los thresholds óptimos detectados.
"""
from __future__ import annotations

import sqlite3
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
PER_TICKER_DIR = ROOT / "models" / "per_ticker"
COMMISSION_PCT = 0.6
SLIPPAGE_PCT = 0.05
TOTAL_COST = COMMISSION_PCT + 2 * SLIPPAGE_PCT

# Best quantile per ticker (basado en reeval — winrate alto + n>=30)
BEST_QUANTILE = {
    "TSM": 0.005,    # 0.5%  → wr 67% n=143
    "LLY": 0.002,    # 0.2%  → wr 66% n=32
    "AMD": 0.001,    # 0.1%  → wr 57% n=51
    "NVDA": 0.001,   # 0.1%  → wr 56% n=48
}


def load_data():
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query(
        "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars ORDER BY ticker, ts", con)
    con.close()
    spy = df[df["ticker"] == "SPY"][["ts", "close", "volume"]].copy()
    return df, spy


def main():
    bars, spy = load_data()
    for ticker, q in BEST_QUANTILE.items():
        path = PER_TICKER_DIR / f"{ticker}.joblib"
        if not path.exists():
            print(f"{ticker}: SKIP — no model")
            continue
        pt = joblib.load(path)
        cfg = pt["label_cfg"]
        grp = bars[bars["ticker"] == ticker]
        feats = build_features_v2(grp, spy_bars=spy)
        labeled = triple_barrier_fixed(feats, target_pct=cfg["fixed_target_pct"],
                                       stop_pct=cfg["fixed_stop_pct"],
                                       horizon_minutes=cfg["horizon_min"])
        labeled[FEATURE_COLS_V2] = labeled[FEATURE_COLS_V2].replace([np.inf, -np.inf], np.nan)
        labeled = labeled.dropna(subset=FEATURE_COLS_V2 + ["label"])
        labeled = labeled[labeled["label"] != 2].sort_values("ts").reset_index(drop=True)
        cutoff = int(len(labeled) * 0.8)
        test = labeled.iloc[cutoff:]
        X_te = test[FEATURE_COLS_V2]
        y_te = (test["label"] == 1).astype(int).to_numpy()
        prob = pt["model"].predict_proba(X_te)[:, 1]
        new_thr = float(np.quantile(prob, 1 - q))
        mask = prob >= new_thr
        n = int(mask.sum())
        wr = float(y_te[mask].mean()) if n > 0 else 0
        tgt = cfg["fixed_target_pct"]; stp = cfg["fixed_stop_pct"]
        gross = wr * tgt - (1 - wr) * stp
        net = gross - TOTAL_COST
        auc = float(roc_auc_score(y_te, prob)) if y_te.min() != y_te.max() else float("nan")

        pt["threshold"] = new_thr
        pt["metrics"] = {
            "auc": auc,
            "base_rate": float(y_te.mean()),
            "best": {
                "top_pct": q,
                "threshold": new_thr,
                "n": n,
                "winrate": wr,
                "gross_per_trade": float(gross),
                "net_per_trade": float(net),
            },
            "n_test": int(len(test)),
        }
        joblib.dump(pt, path)
        badge = "PROFITABLE" if net > 0 else "loss"
        print(f"{ticker:<6} top {q*100:.2f}%  thr={new_thr:.4f}  n={n}  "
              f"wr={wr*100:.1f}%  net={net:+.3f}%/trade  [{badge}]")


if __name__ == "__main__":
    main()
