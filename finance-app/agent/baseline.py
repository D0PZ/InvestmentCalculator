"""Baseline XGBoost: clasifica si un setup ENTRY tiene probabilidad alta de WIN.

Pipeline:
1. Carga minute_bars desde data/finance.db
2. Calcula features (features.py)
3. Genera labels triple-barrier (labels.py) con los mismos stops/targets de la estrategia
4. Train/test split temporal (walk-forward, no random)
5. XGBoost classifier binario (WIN vs no-WIN)
6. Evalúa: AUC, precision en quantiles, expectativa de retorno si filtramos por prob > threshold

Uso:
    python baseline.py train       # entrena y guarda modelo + métricas
    python baseline.py eval        # solo evalúa modelo existente
    python baseline.py tune        # optuna hyperparam search

Output:
    models/baseline_xgb.joblib
    models/metrics.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, precision_score, recall_score, classification_report
from sklearn.model_selection import TimeSeriesSplit
import xgboost as xgb
import joblib

from features import build_features, FEATURE_COLS
from labels import triple_barrier, summarize

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)

# Strategy params — match strategyEngine.js DEFAULTS
TARGET_PCT = 0.6
STOP_PCT = 0.3
HORIZON_MIN = 10


def load_bars(min_obs_per_ticker: int = 500) -> pd.DataFrame:
    if not DB_PATH.exists():
        print(f"ERROR: DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query(
        "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars ORDER BY ticker, ts",
        con,
    )
    con.close()
    counts = df.groupby("ticker").size()
    keep = counts[counts >= min_obs_per_ticker].index
    df = df[df["ticker"].isin(keep)].copy()
    print(f"Loaded {len(df):,} bars across {df['ticker'].nunique()} tickers "
          f"({df['ticker'].nunique()} kept after min_obs filter)")
    return df


def build_dataset(bars: pd.DataFrame) -> pd.DataFrame:
    parts = []
    for ticker, grp in bars.groupby("ticker"):
        if len(grp) < 100:
            continue
        feats = build_features(grp)
        labeled = triple_barrier(feats, target_pct=TARGET_PCT, stop_pct=STOP_PCT, horizon_minutes=HORIZON_MIN)
        labeled["ticker"] = ticker
        parts.append(labeled)
    out = pd.concat(parts, ignore_index=True)
    out = out.dropna(subset=FEATURE_COLS + ["label"])
    out = out[out["label"] != 2]  # drop NEUTRAL (no clear outcome)
    print(f"\nDataset: {len(out):,} rows after dropna + neutral filter")
    print(summarize(out))
    return out


def temporal_split(df: pd.DataFrame, test_frac: float = 0.2):
    df = df.sort_values("ts").reset_index(drop=True)
    cutoff = int(len(df) * (1 - test_frac))
    train = df.iloc[:cutoff]
    test = df.iloc[cutoff:]
    print(f"Split: train={len(train):,}  test={len(test):,}  cutoff_ts={df.loc[cutoff,'ts']}")
    return train, test


def train_model(train_df: pd.DataFrame) -> xgb.XGBClassifier:
    X = train_df[FEATURE_COLS]
    y = (train_df["label"] == 1).astype(int)
    pos_weight = (y == 0).sum() / max((y == 1).sum(), 1)
    print(f"Class balance — pos: {y.sum():,}  neg: {(y == 0).sum():,}  scale_pos_weight: {pos_weight:.2f}")

    model = xgb.XGBClassifier(
        n_estimators=400,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=pos_weight,
        eval_metric="logloss",
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )
    model.fit(X, y)
    return model


def evaluate(model, test_df: pd.DataFrame):
    X = test_df[FEATURE_COLS]
    y = (test_df["label"] == 1).astype(int)
    proba = model.predict_proba(X)[:, 1]

    auc = roc_auc_score(y, proba) if y.nunique() > 1 else float("nan")
    print(f"\nTest AUC: {auc:.4f}")

    print("\n=== Precision en quantiles superiores ===")
    print(f"{'threshold':>10} {'n_signals':>10} {'precision':>10} {'recall':>10} {'pct of total':>14}")
    for thr in [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]:
        mask = proba >= thr
        n = mask.sum()
        if n == 0:
            continue
        prec = precision_score(y, mask, zero_division=0)
        rec = recall_score(y, mask, zero_division=0)
        print(f"{thr:>10.2f} {n:>10,} {prec:>10.4f} {rec:>10.4f} {100*n/len(y):>13.1f}%")

    print("\n=== Expectativa simulada ===")
    print("Si filtramos entries por prob >= threshold, qué P&L esperado:")
    for thr in [0.5, 0.6, 0.7]:
        mask = proba >= thr
        n = mask.sum()
        if n == 0:
            continue
        wins = ((y == 1) & mask).sum()
        losses = ((y == 0) & mask).sum()
        wr = wins / n if n else 0
        # Expected $ per trade with $100 capital, target 0.6%, stop 0.3%
        expected_per_trade = wr * (TARGET_PCT / 100 * 100) - (1 - wr) * (STOP_PCT / 100 * 100)
        print(f"  thr {thr}: {n:,} trades, winrate {wr*100:.1f}%, exp ${expected_per_trade:.3f}/trade")

    return {"auc": float(auc), "n_test": int(len(test_df))}


def cmd_train():
    bars = load_bars()
    df = build_dataset(bars)
    train, test = temporal_split(df, test_frac=0.2)
    model = train_model(train)
    metrics = evaluate(model, test)

    joblib.dump({
        "model": model,
        "feature_cols": FEATURE_COLS,
        "target_pct": TARGET_PCT,
        "stop_pct": STOP_PCT,
        "horizon_min": HORIZON_MIN,
    }, MODELS / "baseline_xgb.joblib")
    with open(MODELS / "metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"\nSaved: {MODELS / 'baseline_xgb.joblib'}")

    print("\n=== Top 10 features por importance ===")
    importances = pd.DataFrame({
        "feature": FEATURE_COLS,
        "importance": model.feature_importances_,
    }).sort_values("importance", ascending=False)
    print(importances.head(10).to_string(index=False))


def cmd_eval():
    payload = joblib.load(MODELS / "baseline_xgb.joblib")
    bars = load_bars()
    df = build_dataset(bars)
    _, test = temporal_split(df)
    evaluate(payload["model"], test)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["train", "eval"], help="qué hacer")
    args = parser.parse_args()
    if args.cmd == "train":
        cmd_train()
    elif args.cmd == "eval":
        cmd_eval()
