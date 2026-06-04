"""Per-ticker LightGBM — entrena un modelo por ticker, reporta cuáles son rentables.

La idea: maybe el modelo universal se queda en mediocre porque promedia patrones de
22 tickers muy distintos. Per-ticker permite que cada uno encuentre su propio edge.

Uso:
    python train_per_ticker.py --label-mode fixed --fixed-target 2.0 --fixed-stop 0.5 --horizon 60
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
from sklearn.metrics import roc_auc_score

from features_v2 import build_features_v2, FEATURE_COLS_V2
from labels_v2 import triple_barrier_atr
from labels import triple_barrier as triple_barrier_fixed

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=RuntimeWarning)

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT.parent / "data" / "finance.db"
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)
PER_TICKER_DIR = MODELS / "per_ticker"
PER_TICKER_DIR.mkdir(exist_ok=True)

COMMISSION_PCT = 0.6
SLIPPAGE_PCT = 0.05
TOTAL_COST = COMMISSION_PCT + 2 * SLIPPAGE_PCT


def _lgb_params():
    return dict(
        objective="binary",
        learning_rate=0.04,
        num_leaves=63,
        min_child_samples=30,
        feature_fraction=0.85,
        bagging_fraction=0.85,
        bagging_freq=5,
        reg_alpha=0.05,
        reg_lambda=0.3,
        n_estimators=500,
        n_jobs=-1,
        random_state=42,
        verbose=-1,
    )


def load_data(ts_min=None):
    con = sqlite3.connect(DB_PATH)
    q = "SELECT ticker, ts, open, high, low, close, volume FROM minute_bars"
    args = []
    if ts_min is not None: q += " WHERE ts>=?"; args.append(ts_min)
    q += " ORDER BY ticker, ts"
    df = pd.read_sql_query(q, con, params=args)
    con.close()
    spy = df[df["ticker"] == "SPY"][["ts", "close", "volume"]].copy()
    others = df[df["ticker"] != "SPY"].copy()
    return others, spy


def load_events_map(tickers) -> dict:
    """{ticker: {earnings_days, rating_days, rating_sent}} desde catalysts (features de evento)."""
    con = sqlite3.connect(DB_PATH)
    try:
        er = pd.read_sql_query("SELECT ticker, event_date FROM catalysts WHERE type='earnings'", con)
        rr = pd.read_sql_query("SELECT ticker, event_date, sentiment FROM catalysts WHERE type='rating'", con)
    finally:
        con.close()
    sent_map = {"bullish": 1.0, "bearish": -1.0, "neutral": 0.0}

    def to_ms(d):
        try:
            return int(pd.Timestamp(d).normalize().tz_localize("UTC").timestamp() * 1000)
        except Exception:
            return None

    out = {t: {"earnings_days": [], "rating_days": [], "rating_sent": []} for t in tickers}
    for t, d in zip(er["ticker"], er["event_date"]):
        ms = to_ms(d)
        if t in out and ms is not None:
            out[t]["earnings_days"].append(ms)
    for t, d, s in zip(rr["ticker"], rr["event_date"], rr["sentiment"]):
        ms = to_ms(d)
        if t in out and ms is not None:
            out[t]["rating_days"].append(ms)
            out[t]["rating_sent"].append(sent_map.get(s, 0.0))
    return out


def build_ticker_dataset(grp: pd.DataFrame, spy: pd.DataFrame, args, events=None) -> pd.DataFrame:
    feats = build_features_v2(grp, spy_bars=spy, events=events)
    if args.label_mode == "atr":
        labeled = triple_barrier_atr(feats, atr_col="atr_14",
                                     target_mult=args.target_mult, stop_mult=args.stop_mult,
                                     horizon=args.horizon)
    else:
        labeled = triple_barrier_fixed(feats, target_pct=args.fixed_target,
                                       stop_pct=args.fixed_stop, horizon_minutes=args.horizon)
        labeled["target_pct"] = args.fixed_target
        labeled["stop_pct"] = args.fixed_stop
    labeled[FEATURE_COLS_V2] = labeled[FEATURE_COLS_V2].replace([np.inf, -np.inf], np.nan)
    labeled = labeled.dropna(subset=FEATURE_COLS_V2 + ["label", "target_pct", "stop_pct"])
    labeled = labeled[labeled["label"] != 2]
    return labeled


def evaluate_one(test_df: pd.DataFrame, prob: np.ndarray):
    y = (test_df["label"] == 1).astype(int).to_numpy()
    tgt = test_df["target_pct"].to_numpy()
    stp = test_df["stop_pct"].to_numpy()
    auc = float(roc_auc_score(y, prob)) if y.min() != y.max() else float("nan")
    best = {"net_per_trade": -1e9}
    for top_pct in [0.005, 0.01, 0.02, 0.05, 0.10]:
        thr = float(np.quantile(prob, 1 - top_pct))
        mask = prob >= thr
        n = int(mask.sum())
        if n < 50: continue
        wr = y[mask].mean()
        gross = (y[mask] * tgt[mask] - (1 - y[mask]) * stp[mask]).mean()
        net = gross - TOTAL_COST
        if net > best["net_per_trade"]:
            best = {"top_pct": top_pct, "threshold": thr, "n": n, "winrate": float(wr),
                    "gross_per_trade": float(gross), "net_per_trade": float(net)}
    if best.get("net_per_trade") == -1e9: best = None
    return {"auc": auc, "base_rate": float(y.mean()), "best": best, "n_test": len(test_df)}


def train_ticker(ticker: str, df: pd.DataFrame, args) -> dict:
    import lightgbm as lgb
    df = df.sort_values("ts").reset_index(drop=True)
    cutoff = int(len(df) * 0.8)
    train, test = df.iloc[:cutoff], df.iloc[cutoff:]
    val_cut = int(len(train) * 0.9)
    X_tr, y_tr = train[FEATURE_COLS_V2], (train["label"] == 1).astype(int)
    X_te, y_te = test[FEATURE_COLS_V2], (test["label"] == 1).astype(int)
    if y_tr.sum() < 50 or y_te.sum() < 20:
        return {"ticker": ticker, "error": "not enough positive labels",
                "train_pos": int(y_tr.sum()), "test_pos": int(y_te.sum())}
    model = lgb.LGBMClassifier(**_lgb_params())
    model.fit(X_tr.iloc[:val_cut], y_tr.iloc[:val_cut],
              eval_set=[(X_tr.iloc[val_cut:], y_tr.iloc[val_cut:])],
              callbacks=[lgb.early_stopping(stopping_rounds=40, verbose=False),
                         lgb.log_evaluation(period=0)])
    prob = model.predict_proba(X_te)[:, 1]
    res = evaluate_one(test, prob)
    res["ticker"] = ticker
    res["n_train"] = len(train)
    res["n_test"] = len(test)
    res["train_pos_rate"] = float(y_tr.mean())
    if not res.get("error"):
        joblib.dump({"model": model, "feature_cols": FEATURE_COLS_V2,
                     "label_cfg": {
                         "label_mode": args.label_mode,
                         "horizon_min": args.horizon,
                         "fixed_target_pct": args.fixed_target,
                         "fixed_stop_pct": args.fixed_stop,
                     }, "threshold": res["best"]["threshold"] if res["best"] else 0.5,
                     "metrics": res},
                    PER_TICKER_DIR / f"{ticker}.joblib")
    return res


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label-mode", choices=["fixed", "atr"], default="fixed")
    parser.add_argument("--fixed-target", type=float, default=2.0)
    parser.add_argument("--fixed-stop", type=float, default=0.5)
    parser.add_argument("--target-mult", type=float, default=2.0)
    parser.add_argument("--stop-mult", type=float, default=1.0)
    parser.add_argument("--horizon", type=int, default=60)
    parser.add_argument("--tickers", type=str, default=None, help="comma-separated; default all")
    args = parser.parse_args()

    bars, spy = load_data()
    tickers = (args.tickers.split(",") if args.tickers
               else sorted(bars["ticker"].unique().tolist()))
    events_map = load_events_map(tickers)
    n_ev = sum(1 for t in tickers if events_map.get(t, {}).get("earnings_days"))
    print(f"Per-ticker training: {len(tickers)} tickers, mode={args.label_mode}, "
          f"target/stop={args.fixed_target}/{args.fixed_stop}, horizon={args.horizon}m · "
          f"event-features para {n_ev}/{len(tickers)} con earnings")

    results = []
    profitable = []
    for i, t in enumerate(tickers, 1):
        grp = bars[bars["ticker"] == t]
        if len(grp) < 5000:
            print(f"  [{i}/{len(tickers)}] {t}: insufficient bars ({len(grp)}) — skip")
            continue
        df = build_ticker_dataset(grp, spy, args, events=events_map.get(t))
        if len(df) < 500:
            print(f"  [{i}/{len(tickers)}] {t}: insufficient labels ({len(df)}) — skip")
            continue
        try:
            res = train_ticker(t, df, args)
        except Exception as e:
            print(f"  [{i}/{len(tickers)}] {t}: ERROR {e}")
            continue
        results.append(res)
        if res.get("error"):
            print(f"  [{i}/{len(tickers)}] {t}: ERROR {res['error']}")
            continue
        b = res.get("best")
        if b:
            badge = "✓" if b["net_per_trade"] > 0 else "✗"
            print(f"  [{i}/{len(tickers)}] {t} {badge} AUC={res['auc']:.4f} "
                  f"top{b['top_pct']*100:.1f}% n={b['n']} wr={b['winrate']*100:.1f}% "
                  f"net={b['net_per_trade']:+.4f}%/trade")
            if b["net_per_trade"] > 0:
                profitable.append((t, b["net_per_trade"], b["winrate"], b["n"]))
        else:
            print(f"  [{i}/{len(tickers)}] {t}: AUC={res['auc']:.4f} (no profitable thr)")

    print(f"\n=== Summary: {len(profitable)}/{len(results)} tickers con net positivo después de comisiones ===")
    if profitable:
        profitable.sort(key=lambda x: x[1], reverse=True)
        print(f"{'ticker':<8} {'net%/trade':>11} {'winrate':>8} {'n_test':>7}")
        for t, net, wr, n in profitable:
            print(f"{t:<8} {net:>+10.4f}% {wr*100:>7.1f}% {n:>7,}")

    with open(MODELS / "per_ticker_summary.json", "w") as f:
        json.dump({"results": results, "profitable": [
            {"ticker": t, "net_per_trade": n, "winrate": wr, "n": cn}
            for t, n, wr, cn in profitable
        ]}, f, indent=2, default=str)


if __name__ == "__main__":
    main()
