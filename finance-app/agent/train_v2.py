"""Train v2: LightGBM con features_v2 + labels_v2 + walk-forward + isotonic calibration.

Métrica primaria: NET EXPECTANCY POR TRADE después de comisiones (0.6% round-trip Racional).
AUC se reporta pero NO se optimiza directamente — preferimos precision @ top quantile.

Uso:
    python train_v2.py train                        # walk-forward + final fit en full
    python train_v2.py train --horizon 30 --target-mult 2.0 --stop-mult 1.0
    python train_v2.py eval                         # evalúa modelo guardado

Output:
    models/standalone_lgbm.joblib   {model, calibrator, feature_cols, label_cfg, threshold}
    models/standalone_metrics.json
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import warnings
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score, precision_score, recall_score

from features_v2 import build_features_v2, FEATURE_COLS_V2
from labels_v2 import triple_barrier_atr, summarize_v2
from labels import triple_barrier as triple_barrier_fixed

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)

COMMISSION_PCT = 0.6  # round-trip ~0.6% en Racional
SLIPPAGE_PCT = 0.05   # 5 bp por lado, conservador


def load_all_bars(min_obs: int = 1000) -> tuple[pd.DataFrame, pd.DataFrame]:
    if not DB_PATH.exists():
        print(f"DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query(
        "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars ORDER BY ticker, ts",
        con,
    )
    con.close()
    counts = df.groupby("ticker").size()
    keep = counts[counts >= min_obs].index.tolist()
    df = df[df["ticker"].isin(keep)].copy()
    spy = df[df["ticker"] == "SPY"][["ts", "close", "volume"]].copy()
    others = df[df["ticker"] != "SPY"].copy()
    print(f"Loaded {len(df):,} bars · {len(keep)} tickers (SPY: {len(spy):,} bars)")
    return others, spy


def build_dataset_v2(
    bars: pd.DataFrame,
    spy: pd.DataFrame,
    horizon: int = 30,
    target_mult: float = 2.0,
    stop_mult: float = 1.0,
    label_mode: str = "atr",        # "atr" | "fixed"
    fixed_target_pct: float = 0.6,
    fixed_stop_pct: float = 0.3,
) -> pd.DataFrame:
    parts = []
    for ticker, grp in bars.groupby("ticker"):
        if len(grp) < 200:
            continue
        feats = build_features_v2(grp, spy_bars=spy)
        if label_mode == "atr":
            labeled = triple_barrier_atr(
                feats, atr_col="atr_14",
                target_mult=target_mult, stop_mult=stop_mult, horizon=horizon,
            )
        else:
            labeled = triple_barrier_fixed(
                feats, target_pct=fixed_target_pct, stop_pct=fixed_stop_pct, horizon_minutes=horizon,
            )
            # Add target_pct/stop_pct columns for the expectancy code (fixed)
            labeled["target_pct"] = fixed_target_pct
            labeled["stop_pct"] = fixed_stop_pct
            labeled["forward_return"] = np.log(labeled["close"]).shift(-horizon) - np.log(labeled["close"])
            labeled["max_runup_pct"] = labeled.get("future_max_pct", np.nan)
            labeled["max_drawdown_pct"] = labeled.get("future_min_pct", np.nan)
        labeled["ticker"] = ticker
        parts.append(labeled)
    out = pd.concat(parts, ignore_index=True)
    out[FEATURE_COLS_V2] = out[FEATURE_COLS_V2].replace([np.inf, -np.inf], np.nan)
    out = out.dropna(subset=FEATURE_COLS_V2 + ["label", "target_pct", "stop_pct"])
    out = out[out["label"] != 2]
    print(f"Dataset v2 ({label_mode}): {len(out):,} rows after dropna+neutral filter")
    print(json.dumps(summarize_v2(out), indent=2))
    return out


def walk_forward_splits(df: pd.DataFrame, n_splits: int = 5, min_train_frac: float = 0.4):
    df = df.sort_values("ts").reset_index(drop=True)
    n = len(df)
    min_train = int(n * min_train_frac)
    remaining = n - min_train
    fold_size = remaining // n_splits
    splits = []
    for i in range(n_splits):
        train_end = min_train + i * fold_size
        test_end = min_train + (i + 1) * fold_size if i < n_splits - 1 else n
        splits.append((slice(0, train_end), slice(train_end, test_end)))
    return splits


def _lgb_params():
    return dict(
        objective="binary",
        learning_rate=0.04,
        num_leaves=63,
        max_depth=-1,
        min_child_samples=50,
        feature_fraction=0.8,
        bagging_fraction=0.8,
        bagging_freq=5,
        reg_alpha=0.1,
        reg_lambda=0.5,
        n_estimators=600,
        n_jobs=-1,
        random_state=42,
        verbose=-1,
    )


def fit_one_fold(X_train, y_train, X_val, y_val, weights=None):
    import lightgbm as lgb
    model = lgb.LGBMClassifier(**_lgb_params())
    model.fit(
        X_train, y_train,
        sample_weight=weights,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(stopping_rounds=40, verbose=False),
                   lgb.log_evaluation(period=0)],
    )
    return model


def _expectancy(df_test: pd.DataFrame, prob: np.ndarray, threshold: float,
                commission_pct: float = COMMISSION_PCT,
                slippage_pct: float = SLIPPAGE_PCT) -> dict:
    """Calcula expectancy realista usando target_pct y stop_pct efectivos por trade,
    descontando comisiones (round-trip) y slippage por lado.
    """
    mask = prob >= threshold
    n = int(mask.sum())
    if n == 0:
        return {"threshold": threshold, "n": 0, "winrate": None, "gross_per_trade": 0, "net_per_trade": 0,
                "net_total_pct": 0}

    sub = df_test.loc[mask].reset_index(drop=True)
    y = (sub["label"] == 1).astype(int).to_numpy()
    tgt = sub["target_pct"].to_numpy()
    stp = sub["stop_pct"].to_numpy()

    gross = np.where(y == 1, tgt, -stp)  # % por trade
    total_cost = commission_pct + 2 * slippage_pct
    net = gross - total_cost
    return {
        "threshold": float(threshold),
        "n": n,
        "winrate": float(y.mean()),
        "avg_target_pct": float(tgt.mean()),
        "avg_stop_pct": float(stp.mean()),
        "gross_per_trade": float(gross.mean()),
        "net_per_trade": float(net.mean()),
        "net_total_pct": float(net.sum()),
        "auc": float(roc_auc_score(y, prob[mask])) if y.min() != y.max() else None,
    }


def evaluate(df_test: pd.DataFrame, prob: np.ndarray, label_cfg: dict, min_n: int = 200) -> dict:
    y = (df_test["label"] == 1).astype(int).to_numpy()
    auc = float(roc_auc_score(y, prob)) if y.min() != y.max() else float("nan")
    print(f"\nTest AUC: {auc:.4f}  (n={len(df_test):,}, win_rate base={y.mean()*100:.1f}%)")

    # Quantile-based threshold sweep (más útil cuando base rate es baja)
    print(f"\n=== Quantile sweep (commission={COMMISSION_PCT}% RT + slip 2*{SLIPPAGE_PCT}%) ===")
    print(f"{'top_pct':>8} {'thr_value':>10} {'n':>10} {'winrate':>9} {'gross/trade':>12} {'net/trade':>11}")
    rows = []
    for top_pct in [0.001, 0.005, 0.01, 0.02, 0.05, 0.10, 0.20, 0.30]:
        thr = float(np.quantile(prob, 1 - top_pct))
        m = _expectancy(df_test, prob, thr)
        m["top_pct"] = top_pct
        rows.append(m)
        if m["n"] == 0: continue
        print(f"{top_pct*100:>7.2f}% {thr:>10.4f} {m['n']:>10,} {m['winrate']*100:>8.1f}% "
              f"{m['gross_per_trade']:>11.4f}% {m['net_per_trade']:>10.4f}%")

    # Fixed thresholds (legacy, útil para comparar versiones)
    print(f"\n=== Fixed threshold sweep ===")
    print(f"{'thr':>6} {'n':>10} {'winrate':>9} {'gross/trade':>12} {'net/trade':>11}")
    fixed_rows = []
    for thr in [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70]:
        m = _expectancy(df_test, prob, thr)
        fixed_rows.append(m)
        if m["n"] == 0: continue
        print(f"{m['threshold']:>6.2f} {m['n']:>10,} {m['winrate']*100:>8.1f}% "
              f"{m['gross_per_trade']:>11.4f}% {m['net_per_trade']:>10.4f}%")

    # Best by net_per_trade with min volume
    candidates = [r for r in rows + fixed_rows if r["n"] >= min_n]
    best = max(candidates, key=lambda r: r["net_per_trade"]) if candidates else None
    if best:
        print(f"\n>>> BEST (n>={min_n}): thr={best['threshold']:.4f}  n={best['n']:,}  "
              f"winrate={best['winrate']*100:.1f}%  net={best['net_per_trade']:+.4f}%/trade  "
              f"total={best['net_total_pct']:+.2f}%")
    return {"auc": auc, "quantile_sweep": rows, "fixed_sweep": fixed_rows, "best": best,
            "label_cfg": label_cfg, "commission_pct": COMMISSION_PCT, "slippage_pct": SLIPPAGE_PCT}


def cmd_train(args):
    bars, spy = load_all_bars()
    if args.label_mode == "atr":
        cache_name = f"dataset_v2_atr_h{args.horizon}_t{args.target_mult}_s{args.stop_mult}.parquet"
    else:
        cache_name = f"dataset_v2_fix_h{args.horizon}_t{args.fixed_target}_s{args.fixed_stop}.parquet"
    cache = MODELS / cache_name
    if cache.exists() and not args.rebuild:
        print(f"Reusing cached dataset: {cache}")
        df = pd.read_parquet(cache)
    else:
        df = build_dataset_v2(bars, spy,
                              horizon=args.horizon,
                              target_mult=args.target_mult,
                              stop_mult=args.stop_mult,
                              label_mode=args.label_mode,
                              fixed_target_pct=args.fixed_target,
                              fixed_stop_pct=args.fixed_stop)
        df.to_parquet(cache, index=False)
        print(f"Cached dataset to {cache}")

    label_cfg = {
        "label_mode": args.label_mode,
        "horizon_min": args.horizon,
        "target_mult_atr": args.target_mult,
        "stop_mult_atr": args.stop_mult,
        "fixed_target_pct": args.fixed_target,
        "fixed_stop_pct": args.fixed_stop,
        "commission_pct": COMMISSION_PCT,
    }
    df = df.sort_values("ts").reset_index(drop=True)

    if args.no_cv:
        cutoff = int(len(df) * 0.8)
        train_df, test_df = df.iloc[:cutoff], df.iloc[cutoff:]
        X_tr, y_tr = train_df[FEATURE_COLS_V2], (train_df["label"] == 1).astype(int)
        X_te, y_te = test_df[FEATURE_COLS_V2], (test_df["label"] == 1).astype(int)
        val_cut = int(len(X_tr) * 0.9)
        model = fit_one_fold(X_tr.iloc[:val_cut], y_tr.iloc[:val_cut],
                             X_tr.iloc[val_cut:], y_tr.iloc[val_cut:])
        prob_te_raw = model.predict_proba(X_te)[:, 1]
        val_prob = model.predict_proba(X_tr.iloc[val_cut:])[:, 1]
        calibrator = IsotonicRegression(out_of_bounds="clip")
        calibrator.fit(val_prob, y_tr.iloc[val_cut:])
        # Evaluamos con RAW prob para ranking — el calibrator se guarda para interpretación posterior.
        print(f"\n[raw prob] threshold sweep")
        metrics = evaluate(test_df, prob_te_raw, label_cfg)
        # También reporta calibrado para referencia
        prob_te_cal = calibrator.transform(prob_te_raw)
        print(f"\n[calibrated prob] threshold sweep (para interpretación, no para ranking)")
        evaluate(test_df, prob_te_cal, label_cfg)
    else:
        splits = walk_forward_splits(df, n_splits=args.cv_folds)
        oof_prob_raw = np.full(len(df), np.nan)
        fold_metrics = []
        for k, (tr_slc, te_slc) in enumerate(splits):
            train_df = df.iloc[tr_slc]
            test_df = df.iloc[te_slc]
            X_tr, y_tr = train_df[FEATURE_COLS_V2], (train_df["label"] == 1).astype(int)
            X_te, y_te = test_df[FEATURE_COLS_V2], (test_df["label"] == 1).astype(int)
            val_cut = int(len(X_tr) * 0.9)
            model = fit_one_fold(X_tr.iloc[:val_cut], y_tr.iloc[:val_cut],
                                 X_tr.iloc[val_cut:], y_tr.iloc[val_cut:])
            prob_te_raw = model.predict_proba(X_te)[:, 1]
            oof_prob_raw[te_slc] = prob_te_raw
            auc = roc_auc_score(y_te, prob_te_raw) if y_te.nunique() > 1 else float("nan")
            print(f"\n[fold {k+1}/{len(splits)}] train={len(X_tr):,} test={len(X_te):,} AUC={auc:.4f}")
            fold_metrics.append({"fold": k+1, "auc": float(auc), "n_test": int(len(X_te))})

        valid = ~np.isnan(oof_prob_raw)
        df_eval = df.iloc[valid].copy()
        metrics = evaluate(df_eval, oof_prob_raw[valid], label_cfg)
        metrics["fold_aucs"] = fold_metrics

        # Final fit on all data
        print("\n=== Final fit en full data ===")
        X_full, y_full = df[FEATURE_COLS_V2], (df["label"] == 1).astype(int)
        val_cut = int(len(X_full) * 0.9)
        model = fit_one_fold(X_full.iloc[:val_cut], y_full.iloc[:val_cut],
                             X_full.iloc[val_cut:], y_full.iloc[val_cut:])
        val_prob = model.predict_proba(X_full.iloc[val_cut:])[:, 1]
        calibrator = IsotonicRegression(out_of_bounds="clip")
        calibrator.fit(val_prob, y_full.iloc[val_cut:])

    best_threshold = metrics["best"]["threshold"] if metrics.get("best") else 0.6
    payload = {
        "model": model,
        "calibrator": calibrator,
        "feature_cols": FEATURE_COLS_V2,
        "label_cfg": label_cfg,
        "threshold": float(best_threshold),
    }
    joblib.dump(payload, MODELS / "standalone_lgbm.joblib")
    with open(MODELS / "standalone_metrics.json", "w") as f:
        json.dump(metrics, f, indent=2, default=str)

    print(f"\nSaved: {MODELS / 'standalone_lgbm.joblib'}  threshold={best_threshold}")
    print(f"Saved: {MODELS / 'standalone_metrics.json'}")

    print("\n=== Top 20 features por importance ===")
    imp = pd.DataFrame({
        "feature": FEATURE_COLS_V2,
        "importance": model.feature_importances_,
    }).sort_values("importance", ascending=False)
    print(imp.head(20).to_string(index=False))


def cmd_eval(args):
    payload = joblib.load(MODELS / "standalone_lgbm.joblib")
    bars, spy = load_all_bars()
    df = build_dataset_v2(bars, spy,
                          horizon=payload["label_cfg"]["horizon_min"],
                          target_mult=payload["label_cfg"]["target_mult_atr"],
                          stop_mult=payload["label_cfg"]["stop_mult_atr"])
    df = df.sort_values("ts").reset_index(drop=True)
    cutoff = int(len(df) * 0.8)
    test_df = df.iloc[cutoff:]
    X = test_df[FEATURE_COLS_V2]
    prob_raw = payload["model"].predict_proba(X)[:, 1]
    prob = payload["calibrator"].transform(prob_raw)
    evaluate(test_df, prob, payload["label_cfg"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_train = sub.add_parser("train")
    p_train.add_argument("--horizon", type=int, default=10, help="horizonte forward en min (default 10)")
    p_train.add_argument("--label-mode", choices=["atr", "fixed"], default="fixed")
    p_train.add_argument("--target-mult", type=float, default=2.0, help="solo si --label-mode atr")
    p_train.add_argument("--stop-mult", type=float, default=1.0, help="solo si --label-mode atr")
    p_train.add_argument("--fixed-target", type=float, default=0.6, help="solo si --label-mode fixed (pct del precio)")
    p_train.add_argument("--fixed-stop", type=float, default=0.3)
    p_train.add_argument("--cv-folds", type=int, default=5)
    p_train.add_argument("--no-cv", action="store_true", help="single split, faster")
    p_train.add_argument("--rebuild", action="store_true", help="rebuild dataset cache")
    p_eval = sub.add_parser("eval")
    args = parser.parse_args()
    if args.cmd == "train":
        cmd_train(args)
    elif args.cmd == "eval":
        cmd_eval(args)
