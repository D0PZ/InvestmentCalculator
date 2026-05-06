"""Backtest del scorer: ¿realmente funcionan las señales COMPRAR?

Estrategia simulada (walk-forward, sin look-ahead bias):
  - Cada N días hábiles, ejecuta el scorer con datos disponibles hasta T
  - Compra equal-weight las top-K acciones con score >= umbral
  - Mantiene HOLD_DAYS días, luego vende
  - Compara con benchmark SPY

Métricas: retorno total, CAGR, Sharpe, max drawdown, hit-rate, vs SPY.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import scrapers
from .config import QUICK_TICKERS, SP100_TICKERS
from .features import rsi, trend_score, momentum, volume_surge, relative_strength
from .model import FEATURE_COLS, ScoringModel, heuristic_score
from .features import FeatureSet


REBALANCE_DAYS = 21        # cada cuánto rebalancear (1 mes hábil)
HOLD_DAYS = 21             # cuánto mantener cada posición
TOP_K = 5                  # compra top-K por score
SCORE_THRESHOLD = 60       # solo compra si score >= esto
INITIAL_CAPITAL = 10_000   # USD


@dataclass
class BacktestResult:
    equity_curve: pd.Series       # capital del portfolio día a día
    trades: pd.DataFrame
    benchmark: pd.Series          # SPY equity curve normalizado al mismo capital inicial
    metrics: dict


def _build_features_at(
    ticker: str,
    full_df: pd.DataFrame,
    bench_full: pd.Series,
    t_idx: int,
) -> FeatureSet:
    """Construye features usando solo datos hasta el día t_idx (no leakage)."""
    fs = FeatureSet(ticker=ticker)
    if t_idx < 220 or t_idx >= len(full_df):
        return fs
    window = full_df.iloc[: t_idx + 1]
    bench_w = bench_full.loc[: window.index[-1]]
    close = window["Close"]
    fs.last_price = float(close.iloc[-1])
    fs.rsi_14 = rsi(close)
    fs.trend_ma = trend_score(close)
    fs.momentum_3m = momentum(close)
    fs.volume_surge = volume_surge(window["Volume"])
    fs.rel_strength_spy = relative_strength(close, bench_w)
    return fs


def run_backtest(
    tickers: list[str],
    years: int = 5,
    rebalance_days: int = REBALANCE_DAYS,
    hold_days: int = HOLD_DAYS,
    top_k: int = TOP_K,
    score_threshold: float = SCORE_THRESHOLD,
    initial_capital: float = INITIAL_CAPITAL,
    use_model: bool = True,
) -> BacktestResult:
    """Ejecuta backtest walk-forward."""
    print(f"📊 Descargando histórico para {len(tickers)} tickers ({years} años)...")
    period = f"{years}y"
    prices_map = scrapers.fetch_prices_parallel(tickers, period=period)
    bench_full = scrapers.fetch_prices("SPY", period=period, interval="1d")["Close"]

    # Sólo tickers con suficiente histórico
    valid = {tk: df for tk, df in prices_map.items() if not df.empty and len(df) > 250}
    print(f"  tickers válidos: {len(valid)}/{len(tickers)}")
    if len(valid) < 2:
        raise ValueError("Pocos tickers con histórico suficiente.")

    # Eje temporal común: usamos el calendario del benchmark
    all_dates = bench_full.index
    if len(all_dates) < 250:
        raise ValueError("Histórico del benchmark muy corto.")

    model = ScoringModel.load() if use_model else None

    # Estado del portfolio
    cash = initial_capital
    positions: dict[str, dict] = {}    # ticker → {shares, entry_price, exit_idx}
    equity_records: list[tuple] = []
    trades: list[dict] = []

    for t_idx in range(220, len(all_dates)):
        today = all_dates[t_idx]

        # 1) Cerrar posiciones que vencen hoy
        to_close = [tk for tk, pos in positions.items() if pos["exit_idx"] <= t_idx]
        for tk in to_close:
            pos = positions.pop(tk)
            df = valid.get(tk)
            if df is None:
                continue
            # precio de salida: close del día actual si existe
            try:
                exit_price = float(df.loc[df.index <= today, "Close"].iloc[-1])
            except IndexError:
                continue
            proceeds = pos["shares"] * exit_price
            cash += proceeds
            ret = (exit_price / pos["entry_price"]) - 1
            trades.append({
                "ticker": tk,
                "entry_date": pos["entry_date"],
                "exit_date": today,
                "entry": pos["entry_price"],
                "exit": exit_price,
                "return": ret,
            })

        # 2) Rebalancear cada N días: scoring + compra top-K
        if (t_idx - 220) % rebalance_days == 0:
            scores: list[tuple[str, float, float]] = []   # (ticker, score, price)
            for tk, df in valid.items():
                if tk in positions:
                    continue
                # Buscar el índice de today en este df
                local_idx = df.index.get_indexer([today], method="ffill")[0]
                if local_idx < 220:
                    continue
                fs = _build_features_at(tk, df, bench_full, local_idx)
                if fs.last_price != fs.last_price:
                    continue
                if model is not None and model.is_trained():
                    score, _ = model.predict(fs)
                else:
                    score, _ = heuristic_score(fs)
                scores.append((tk, score, fs.last_price))

            # Top-K filtrado
            scores.sort(key=lambda x: x[1], reverse=True)
            picks = [s for s in scores if s[1] >= score_threshold][:top_k]

            if picks and cash > 0:
                allocation = cash / len(picks)
                for tk, score, price in picks:
                    if price <= 0:
                        continue
                    shares = allocation / price
                    cost = shares * price
                    cash -= cost
                    positions[tk] = {
                        "shares": shares,
                        "entry_price": price,
                        "entry_date": today,
                        "exit_idx": t_idx + hold_days,
                    }

        # 3) Mark-to-market del portfolio
        portfolio_value = cash
        for tk, pos in positions.items():
            df = valid.get(tk)
            if df is None:
                continue
            try:
                last_close = float(df.loc[df.index <= today, "Close"].iloc[-1])
                portfolio_value += pos["shares"] * last_close
            except IndexError:
                pass
        equity_records.append((today, portfolio_value))

    equity_curve = pd.Series(
        [v for _, v in equity_records],
        index=[d for d, _ in equity_records],
        name="equity",
    )
    trades_df = pd.DataFrame(trades)

    # Benchmark normalizado al mismo capital inicial
    bench_aligned = bench_full.loc[equity_curve.index[0]:equity_curve.index[-1]]
    bench_norm = bench_aligned / bench_aligned.iloc[0] * initial_capital

    metrics = compute_metrics(equity_curve, bench_norm, trades_df, initial_capital)
    return BacktestResult(
        equity_curve=equity_curve,
        trades=trades_df,
        benchmark=bench_norm,
        metrics=metrics,
    )


def compute_metrics(
    equity: pd.Series,
    benchmark: pd.Series,
    trades: pd.DataFrame,
    initial_capital: float,
) -> dict:
    if equity.empty:
        return {}
    final = float(equity.iloc[-1])
    total_ret = final / initial_capital - 1
    days = (equity.index[-1] - equity.index[0]).days
    years = max(days / 365.25, 0.01)
    cagr = (final / initial_capital) ** (1 / years) - 1

    daily_ret = equity.pct_change().dropna()
    sharpe = (daily_ret.mean() / daily_ret.std() * np.sqrt(252)) if daily_ret.std() > 0 else 0.0

    peak = equity.cummax()
    dd = (equity - peak) / peak
    max_dd = float(dd.min())

    bench_total = float(benchmark.iloc[-1] / benchmark.iloc[0] - 1)
    bench_cagr = (benchmark.iloc[-1] / benchmark.iloc[0]) ** (1 / years) - 1

    if not trades.empty:
        hit_rate = float((trades["return"] > 0).mean())
        avg_win = float(trades.loc[trades["return"] > 0, "return"].mean() or 0)
        avg_loss = float(trades.loc[trades["return"] <= 0, "return"].mean() or 0)
        n_trades = len(trades)
    else:
        hit_rate = avg_win = avg_loss = 0.0
        n_trades = 0

    return {
        "initial_capital": initial_capital,
        "final_value": final,
        "total_return": total_ret,
        "cagr": cagr,
        "sharpe": float(sharpe),
        "max_drawdown": max_dd,
        "n_trades": n_trades,
        "hit_rate": hit_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "spy_total_return": bench_total,
        "spy_cagr": float(bench_cagr),
        "alpha_vs_spy": cagr - float(bench_cagr),
        "years": years,
    }


def print_report(result: BacktestResult) -> None:
    m = result.metrics
    print("\n" + "=" * 64)
    print("📈 BACKTEST RESULTS")
    print("=" * 64)
    print(f"Periodo:           {m['years']:.1f} años")
    print(f"Capital inicial:   ${m['initial_capital']:,.0f}")
    print(f"Capital final:     ${m['final_value']:,.0f}")
    print(f"Retorno total:     {m['total_return'] * 100:+.1f}%")
    print(f"CAGR:              {m['cagr'] * 100:+.2f}%")
    print(f"Sharpe ratio:      {m['sharpe']:.2f}")
    print(f"Max drawdown:      {m['max_drawdown'] * 100:.1f}%")
    print("-" * 64)
    print(f"Trades:            {m['n_trades']}")
    print(f"Hit rate:          {m['hit_rate'] * 100:.1f}%")
    print(f"Avg win:           {m['avg_win'] * 100:+.2f}%")
    print(f"Avg loss:          {m['avg_loss'] * 100:+.2f}%")
    print("-" * 64)
    print(f"SPY total:         {m['spy_total_return'] * 100:+.1f}%")
    print(f"SPY CAGR:          {m['spy_cagr'] * 100:+.2f}%")
    print(f"Alpha vs SPY:      {m['alpha_vs_spy'] * 100:+.2f}%")
    print("=" * 64)
    if m['alpha_vs_spy'] > 0:
        print("✅ El scorer batió al SPY.")
    else:
        print("❌ El scorer perdió contra SPY (buy-and-hold sería mejor).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest del scorer")
    parser.add_argument("--tickers", nargs="+", default=None)
    parser.add_argument("--universe", choices=["quick", "sp100"], default="sp100")
    parser.add_argument("--years", type=int, default=5)
    parser.add_argument("--top-k", type=int, default=TOP_K)
    parser.add_argument("--threshold", type=float, default=SCORE_THRESHOLD)
    parser.add_argument("--hold", type=int, default=HOLD_DAYS)
    parser.add_argument("--rebalance", type=int, default=REBALANCE_DAYS)
    parser.add_argument("--capital", type=float, default=INITIAL_CAPITAL)
    parser.add_argument("--no-model", action="store_true", help="Forzar heurístico")
    args = parser.parse_args()

    if args.tickers is None:
        args.tickers = SP100_TICKERS if args.universe == "sp100" else QUICK_TICKERS

    result = run_backtest(
        tickers=args.tickers,
        years=args.years,
        rebalance_days=args.rebalance,
        hold_days=args.hold,
        top_k=args.top_k,
        score_threshold=args.threshold,
        initial_capital=args.capital,
        use_model=not args.no_model,
    )
    print_report(result)


if __name__ == "__main__":
    main()
