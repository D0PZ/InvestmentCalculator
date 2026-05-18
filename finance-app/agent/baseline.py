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
    out[FEATURE_COLS] = out[FEATURE_COLS].replace([np.inf, -np.inf], np.nan)
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


def _load_or_build_cached_dataset() -> pd.DataFrame:
    cache = MODELS / "dataset_cache.parquet"
    if cache.exists():
        print(f"Reusing cached dataset: {cache}")
        return pd.read_parquet(cache)
    bars = load_bars()
    df = build_dataset(bars)
    df.to_parquet(cache, index=False)
    print(f"Cached dataset to {cache}")
    return df


def cmd_tune(n_trials: int = 40, timeout_sec: int | None = None):
    import optuna
    from optuna.samplers import TPESampler

    df = _load_or_build_cached_dataset()
    train, test = temporal_split(df, test_frac=0.2)
    X_train = train[FEATURE_COLS]
    y_train = (train["label"] == 1).astype(int)
    X_test = test[FEATURE_COLS]
    y_test = (test["label"] == 1).astype(int)
    pos_weight = (y_train == 0).sum() / max((y_train == 1).sum(), 1)

    def objective(trial: "optuna.Trial") -> float:
        params = dict(
            n_estimators=trial.suggest_int("n_estimators", 200, 800, step=100),
            max_depth=trial.suggest_int("max_depth", 3, 8),
            learning_rate=trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
            subsample=trial.suggest_float("subsample", 0.6, 1.0),
            colsample_bytree=trial.suggest_float("colsample_bytree", 0.6, 1.0),
            min_child_weight=trial.suggest_int("min_child_weight", 1, 20),
            reg_alpha=trial.suggest_float("reg_alpha", 0.0, 1.0),
            reg_lambda=trial.suggest_float("reg_lambda", 0.0, 3.0),
            scale_pos_weight=pos_weight,
            eval_metric="logloss",
            tree_method="hist",
            n_jobs=-1,
            random_state=42,
        )
        model = xgb.XGBClassifier(**params)
        model.fit(X_train, y_train)
        proba = model.predict_proba(X_test)[:, 1]
        auc = roc_auc_score(y_test, proba)
        trial.set_user_attr("auc", float(auc))
        return float(auc)

    study = optuna.create_study(
        direction="maximize",
        sampler=TPESampler(seed=42),
        study_name="baseline_xgb",
    )
    print(f"Optuna tune: n_trials={n_trials} timeout={timeout_sec}")
    study.optimize(objective, n_trials=n_trials, timeout=timeout_sec, show_progress_bar=False)

    best = study.best_trial
    print(f"\n=== Best trial #{best.number} ===")
    print(f"AUC: {best.value:.4f}")
    for k, v in best.params.items():
        print(f"  {k}: {v}")

    print("\nRe-training final model with best params on train+test (full data)...")
    full_X = pd.concat([X_train, X_test])
    full_y = pd.concat([y_train, y_test])
    final = xgb.XGBClassifier(
        **best.params,
        scale_pos_weight=pos_weight,
        eval_metric="logloss",
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )
    final.fit(full_X, full_y)
    joblib.dump({
        "model": final,
        "feature_cols": FEATURE_COLS,
        "target_pct": TARGET_PCT,
        "stop_pct": STOP_PCT,
        "horizon_min": HORIZON_MIN,
        "best_params": best.params,
        "best_auc": float(best.value),
    }, MODELS / "tuned_xgb.joblib")
    with open(MODELS / "tune_summary.json", "w") as f:
        json.dump({
            "best_auc": float(best.value),
            "best_params": best.params,
            "n_trials": len(study.trials),
            "all_trials": [
                {"number": t.number, "auc": t.value, "params": t.params}
                for t in study.trials
            ],
        }, f, indent=2)
    print(f"\nSaved: {MODELS / 'tuned_xgb.joblib'}")
    print(f"Saved: {MODELS / 'tune_summary.json'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["train", "eval", "tune"], help="qué hacer")
    parser.add_argument("--trials", type=int, default=40, help="optuna trials (default 40)")
    parser.add_argument("--timeout", type=int, default=None, help="optuna timeout seg")
    args = parser.parse_args()
    if args.cmd == "train":
        cmd_train()
    elif args.cmd == "eval":
        cmd_eval()
    elif args.cmd == "tune":
        cmd_tune(n_trials=args.trials, timeout_sec=args.timeout)
