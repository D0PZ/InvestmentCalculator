"""Entrenamiento de XGBoost con walk-forward validation.

Uso:
    python -m stock_scorer.train
    python -m stock_scorer.train --tickers AAPL MSFT NVDA --years 5
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime

import numpy as np
import pandas as pd

from . import scrapers
from .config import (
    DEFAULT_TICKERS, QUICK_TICKERS, SP100_TICKERS, SP500_EXTENDED,
    MODEL_PATH, MODEL_CLF_UP_PATH, MODEL_CLF_DOWN_PATH,
    MODEL_SHORT_PATH, MODEL_SHORT_UP_PATH, MODEL_SHORT_DOWN_PATH,
    FORWARD_RETURN_DAYS, FORWARD_RETURN_DAYS_SHORT, TRAIN_LOOKBACK_YEARS,
    WALK_FORWARD_FOLDS, WEIGHT_HALF_LIFE_DAYS,
    UP_THRESHOLD, DOWN_THRESHOLD, UP_THRESHOLD_SHORT, DOWN_THRESHOLD_SHORT,
)
from .features import (
    rsi, trend_score, momentum, volume_surge, relative_strength,
    macd_signal, bollinger_pct, adx, dist_52w_high, realized_vol,
    momentum_short, gap_freq, price_efficiency,
)
from .model import FEATURE_COLS


def build_training_dataset(
    tickers: list[str],
    years: int = TRAIN_LOOKBACK_YEARS,
    stride: int = 5,
) -> pd.DataFrame:
    """Para cada ticker y cada `stride` días hábiles, calcula features históricas
    y los retornos forward de 5d (corto) y 21d (medio). Sin look-ahead bias.

    stride=5 (default) = sample semanal → 5× más muestras que stride=21.
    Más muestras = modelo más preciso, especialmente para horizonte corto.
    """
    period = f"{years}y"
    bench = scrapers.fetch_prices("SPY", period=period, interval="1d")["Close"]

    # Descarga TODOS los precios en paralelo (mucho más rápido)
    print(f"  descargando {len(tickers)} tickers en paralelo...")
    prices_map = scrapers.fetch_prices_parallel(tickers, period=period)

    rows: list[dict] = []
    skipped = []
    max_horizon = max(FORWARD_RETURN_DAYS, FORWARD_RETURN_DAYS_SHORT)
    for tk in tickers:
        df = prices_map.get(tk, pd.DataFrame())
        if df.empty or len(df) < 250:
            skipped.append((tk, len(df)))
            continue
        close = df["Close"]
        vol = df["Volume"]
        # Sample cada `stride` días hábiles (default semanal)
        for i in range(220, len(df) - max_horizon, stride):
            window = df.iloc[: i + 1]
            window_close = close.iloc[: i + 1]
            window_vol = vol.iloc[: i + 1]
            bench_window = bench.loc[: window_close.index[-1]]
            fwd_ret_long = float(close.iloc[i + FORWARD_RETURN_DAYS] / close.iloc[i] - 1)
            fwd_ret_short = float(close.iloc[i + FORWARD_RETURN_DAYS_SHORT] / close.iloc[i] - 1)
            row = {
                "date": close.index[i],
                "ticker": tk,
                # Fundamentales NO disponibles históricamente vía yfinance gratis.
                # Las dejamos como NaN; XGBoost maneja NaN nativamente.
                "revenue_growth": np.nan,
                "eps_growth": np.nan,
                "profit_margin": np.nan,
                "roe": np.nan,
                "debt_to_equity": np.nan,
                "pe_ratio": np.nan,
                # Técnicas básicas
                "rsi_14": rsi(window_close),
                "trend_ma": trend_score(window_close),
                "momentum_3m": momentum(window_close),
                "volume_surge": volume_surge(window_vol),
                "rel_strength_spy": relative_strength(window_close, bench_window),
                # Técnicas avanzadas (nuevas)
                "macd_hist": macd_signal(window_close),
                "bb_pct": bollinger_pct(window_close),
                "adx_14": adx(window),
                "dist_52w_high": dist_52w_high(window_close),
                "realized_vol": realized_vol(window_close),
                "momentum_10d": momentum_short(window_close),
                "gap_freq": gap_freq(window),
                "price_efficiency": price_efficiency(window_close),
                "sentiment": 0.0,  # no hay histórico de noticias gratis
                "fwd_return": fwd_ret_long,
                "fwd_return_short": fwd_ret_short,
            }
            rows.append(row)

    if skipped:
        print(f"  ⚠️  {len(skipped)} tickers descartados (sin datos suficientes):")
        for tk, n in skipped[:20]:
            print(f"      {tk}: {n} filas")
        if len(skipped) > 20:
            print(f"      ... y {len(skipped) - 20} más")

    df_out = pd.DataFrame(rows).sort_values("date").reset_index(drop=True)
    return df_out


def walk_forward_train(
    df: pd.DataFrame,
    n_folds: int = WALK_FORWARD_FOLDS,
    objective: str = "reg:squarederror",
    label_col: str = "fwd_return",
    eval_metric: str = "rmse",
) -> object:
    """Entrena XGBoost con walk-forward CV. Devuelve el booster final
    entrenado con todos los datos.

    Mejoras de precisión:
    - Sample weights con decay temporal (datos recientes pesan más, half-life ~3 años)
    - Más rounds + early stopping más paciente
    - Regularización L1+L2 para reducir overfitting
    - max_depth=5 (más capacidad para capturar interacciones de features)

    objective: 'reg:squarederror' (regresión) o 'binary:logistic' (clasificación).
    """
    import xgboost as xgb

    X = df[FEATURE_COLS]
    y = df[label_col]

    # Sample weights con decay exponencial: half-life = 3 años (≈756 días)
    # → datos de hace 3 años pesan 0.5; de hace 6 años pesan 0.25.
    # Esto le da más voz a la dinámica reciente del mercado sin descartar histórico.
    if "date" in df.columns:
        days_ago = (df["date"].max() - df["date"]).dt.days
        half_life = 365 * 3
        sample_weights = np.power(0.5, days_ago / half_life).values
    else:
        sample_weights = np.ones(len(df))

    fold_size = len(df) // (n_folds + 1)
    metrics = []
    params = {
        "objective": objective,
        "eta": 0.03,                  # learning rate más bajo + más rounds
        "max_depth": 5,               # más capacidad (era 4)
        "subsample": 0.8,
        "colsample_bytree": 0.7,      # más diversidad entre árboles
        "min_child_weight": 5,
        "reg_alpha": 0.1,             # L1: feature selection automática
        "reg_lambda": 1.0,            # L2: anti-overfitting
        "eval_metric": eval_metric,
        "verbosity": 0,
    }
    is_clf = objective.startswith("binary")

    for fold in range(n_folds):
        train_end = fold_size * (fold + 1)
        val_end = fold_size * (fold + 2)
        X_tr, y_tr = X.iloc[:train_end], y.iloc[:train_end]
        X_val, y_val = X.iloc[train_end:val_end], y.iloc[train_end:val_end]
        w_tr = sample_weights[:train_end]
        if len(X_val) < 10:
            continue
        dtr = xgb.DMatrix(X_tr, label=y_tr, weight=w_tr)
        dval = xgb.DMatrix(X_val, label=y_val)
        booster = xgb.train(
            params, dtr, num_boost_round=1000,            # más rounds
            evals=[(dval, "val")],
            early_stopping_rounds=50,                     # más paciencia
            verbose_eval=False,
        )
        pred = booster.predict(dval)
        if is_clf:
            from sklearn.metrics import roc_auc_score
            try:
                m = float(roc_auc_score(y_val.values, pred))
            except ValueError:
                m = float("nan")
            print(f"  fold {fold + 1}: AUC={m:.3f}  best_iter={booster.best_iteration}")
        else:
            m = float(pd.Series(pred).corr(pd.Series(y_val.values), method="spearman"))
            print(f"  fold {fold + 1}: IC={m:.3f}  best_iter={booster.best_iteration}")
        metrics.append(m)

    avg = float(np.nanmean(metrics)) if metrics else 0.0
    metric_name = "AUC" if is_clf else "IC"
    print(f"\n  {metric_name} promedio walk-forward: {avg:.3f}")
    if is_clf and avg < 0.55:
        print("  ⚠️  AUC ~0.5 = el modelo no distingue mejor que azar.")
    if not is_clf and avg < 0.02:
        print("  ⚠️  IC muy bajo: el modelo no tiene edge real.")

    # Modelo final entrenado con TODOS los datos (con weights)
    dall = xgb.DMatrix(X, label=y, weight=sample_weights)
    final_booster = xgb.train({**params, "verbosity": 0}, dall, num_boost_round=400)

    # Mostrar top features por importancia (gain)
    try:
        importance = final_booster.get_score(importance_type="gain")
        top = sorted(importance.items(), key=lambda x: x[1], reverse=True)[:10]
        print("\n  📊 Top 10 features por importancia (gain):")
        for feat, score in top:
            print(f"      {feat:25s} {score:>10.2f}")
    except Exception:  # noqa: BLE001
        pass

    return final_booster


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tickers", nargs="+", default=None)
    parser.add_argument("--universe", choices=["quick", "sp100", "sp500"], default="sp100",
                        help="sp100 (default) entrena con 100 tickers; "
                             "sp500 con ~200 (mejor precisión, más lento); quick con 14")
    parser.add_argument("--years", type=int, default=TRAIN_LOOKBACK_YEARS)
    parser.add_argument("--out", default=MODEL_PATH)
    parser.add_argument("--up", default=MODEL_CLF_UP_PATH)
    parser.add_argument("--down", default=MODEL_CLF_DOWN_PATH)
    parser.add_argument("--skip-clf", action="store_true",
                        help="Solo regresión, sin clasificadores P(↑)/P(↓)")
    args = parser.parse_args()

    if args.tickers is None:
        if args.universe == "sp500":
            args.tickers = SP500_EXTENDED
        elif args.universe == "sp100":
            args.tickers = SP100_TICKERS
        else:
            args.tickers = QUICK_TICKERS

    print(f"📊 Construyendo dataset ({len(args.tickers)} tickers, {args.years} años)...")
    df = build_training_dataset(args.tickers, args.years)
    print(f"  filas: {len(df)}\n")

    if len(df) < 100:
        print("❌ Muy pocas filas para entrenar. Aumenta tickers o años.")
        return

    # 1) Regresor (score base)
    print("🧠 [1/3] Walk-forward training (regresión, retorno forward)...")
    reg = walk_forward_train(df)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    reg.save_model(args.out)
    print(f"  ✅ guardado en {args.out}")

    if args.skip_clf:
        return

    # 2) Clasificador "subida fuerte"
    print(f"\n🧠 [2/3] Clasificador P(retorno > +{UP_THRESHOLD * 100:.0f}%)...")
    df_up = df.copy()
    df_up["label_up"] = (df_up["fwd_return"] > UP_THRESHOLD).astype(int)
    pos_rate = df_up["label_up"].mean()
    print(f"  positive rate: {pos_rate * 100:.1f}%")
    clf_up = walk_forward_train(
        df_up, objective="binary:logistic",
        label_col="label_up", eval_metric="auc",
    )
    clf_up.save_model(args.up)
    print(f"  ✅ guardado en {args.up}")

    # 3) Clasificador "bajada fuerte"
    print(f"\n🧠 [3/3] Clasificador P(retorno < {DOWN_THRESHOLD * 100:.0f}%)...")
    df_dn = df.copy()
    df_dn["label_down"] = (df_dn["fwd_return"] < DOWN_THRESHOLD).astype(int)
    pos_rate = df_dn["label_down"].mean()
    print(f"  positive rate: {pos_rate * 100:.1f}%")
    clf_dn = walk_forward_train(
        df_dn, objective="binary:logistic",
        label_col="label_down", eval_metric="auc",
    )
    clf_dn.save_model(args.down)
    print(f"  ✅ guardado en {args.down}")

    print("\n🎉 Entrenamiento completo.")


if __name__ == "__main__":
    main()
