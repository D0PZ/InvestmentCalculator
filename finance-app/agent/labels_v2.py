"""Labels v2: ATR-relative + multi-horizon + continuous forward returns.

Mejoras vs labels.py:
- target/stop escalados a ATR del momento → adaptativo por ticker y régimen
- horizonte por defecto 30min (más espacio para grandes movimientos)
- forward_return continuo: log(close[t+H]) - log(close[t])
- max_runup / max_drawdown sobre la ventana
- label triple-barrier con triple {target=k*ATR, stop=k*ATR, horizon=H}

Para entrenamiento standalone usamos `target_mult=2.0, stop_mult=1.0, horizon=30`
(R:R 2:1, breakeven a ~33.7% winrate después de comisiones 0.6% round-trip).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def triple_barrier_atr(
    bars: pd.DataFrame,
    atr_col: str = "atr_14",
    target_mult: float = 2.0,
    stop_mult: float = 1.0,
    horizon: int = 30,
    min_target_pct: float = 0.4,
    max_target_pct: float = 3.0,
) -> pd.DataFrame:
    """ATR-relative triple barrier.

    Para cada fila i:
      target_level = close[i] + target_mult * atr[i]   (clamped a [min_target, max_target] % de close)
      stop_level   = close[i] - stop_mult * atr[i]
    Se etiqueta WIN si high futuro >= target antes de que low < stop, LOSS al revés.

    Args:
        bars: DataFrame con columnas ts, open, high, low, close + atr_col precomputado
        target_mult/stop_mult: múltiplo de ATR para target/stop
        horizon: barras hacia adelante
        min/max_target_pct: clamp el target en estos rangos (% de precio entrada)

    Devuelve copia con:
        label: 0=LOSS, 1=WIN, 2=NEUTRAL
        forward_return: log return a t+horizon
        max_runup_pct: máx high futuro vs entrada (%)
        max_drawdown_pct: mín low futuro vs entrada (%)
        target_pct, stop_pct (los efectivos usados)
        bars_to_outcome
    """
    out = bars.copy().reset_index(drop=True)
    if atr_col not in out.columns:
        raise ValueError(f"need column {atr_col} (run features pipeline first)")

    closes = out["close"].to_numpy()
    highs = out["high"].to_numpy()
    lows = out["low"].to_numpy()
    atr = out[atr_col].to_numpy()

    n = len(out)
    label = np.full(n, 2, dtype=np.int8)
    bars_to = np.full(n, np.nan)
    forward_ret = np.full(n, np.nan)
    runup = np.full(n, np.nan)
    drawdown = np.full(n, np.nan)
    tgt_pct = np.full(n, np.nan)
    stp_pct = np.full(n, np.nan)

    for i in range(n):
        entry = closes[i]
        a = atr[i]
        if not (np.isfinite(entry) and entry > 0 and np.isfinite(a) and a > 0):
            continue

        # ATR-relative dollar amount, clamped to [min,max] % of entry
        target_dollars = target_mult * a
        stop_dollars = stop_mult * a
        min_target = entry * min_target_pct / 100
        max_target = entry * max_target_pct / 100
        target_dollars = max(min_target, min(target_dollars, max_target))
        stop_dollars = max(min_target * (stop_mult / target_mult), min(stop_dollars, max_target))

        up_lvl = entry + target_dollars
        dn_lvl = entry - stop_dollars
        tgt_pct[i] = target_dollars / entry * 100
        stp_pct[i] = stop_dollars / entry * 100

        end = min(n, i + 1 + horizon)
        seg_high = highs[i + 1:end]
        seg_low = lows[i + 1:end]
        seg_close_last = closes[end - 1] if end > i + 1 else closes[i]

        if len(seg_high) == 0:
            continue

        max_high = np.nanmax(seg_high)
        min_low = np.nanmin(seg_low)
        runup[i] = (max_high - entry) / entry * 100
        drawdown[i] = (min_low - entry) / entry * 100
        forward_ret[i] = np.log(seg_close_last / entry) if seg_close_last > 0 else 0.0

        won_at = None
        lost_at = None
        for j in range(len(seg_high)):
            if won_at is None and seg_high[j] >= up_lvl:
                won_at = j
            if lost_at is None and seg_low[j] <= dn_lvl:
                lost_at = j
            if won_at is not None or lost_at is not None:
                break

        if won_at is not None and (lost_at is None or won_at < lost_at):
            label[i] = 1
            bars_to[i] = won_at + 1
        elif lost_at is not None:
            label[i] = 0
            bars_to[i] = lost_at + 1
        else:
            label[i] = 2

    out["label"] = label
    out["bars_to_outcome"] = bars_to
    out["forward_return"] = forward_ret
    out["max_runup_pct"] = runup
    out["max_drawdown_pct"] = drawdown
    out["target_pct"] = tgt_pct
    out["stop_pct"] = stp_pct
    return out


def summarize_v2(df: pd.DataFrame) -> dict:
    counts = df["label"].value_counts().to_dict()
    total = len(df)
    return {
        "total": int(total),
        "win": int(counts.get(1, 0)),
        "loss": int(counts.get(0, 0)),
        "neutral": int(counts.get(2, 0)),
        "win_pct": float(counts.get(1, 0) / total * 100) if total else 0,
        "avg_target_pct": float(df["target_pct"].mean()) if "target_pct" in df else None,
        "avg_stop_pct": float(df["stop_pct"].mean()) if "stop_pct" in df else None,
        "median_target_pct": float(df["target_pct"].median()) if "target_pct" in df else None,
        "avg_forward_return": float(df["forward_return"].mean()) if "forward_return" in df else None,
    }
