"""Generación de labels oraculares (look-ahead labeling).

Para cada bar t, mira ADELANTE hasta N minutos y etiqueta:
- WIN  → high alcanzó +target_pct antes que low alcanzara -stop_pct
- LOSS → low alcanzó -stop_pct primero
- NEUTRAL → ninguno se alcanzó en la ventana

Esto es el "triple barrier method" (López de Prado).

⚠️ Estas labels son LOOK-AHEAD: usar SOLO para entrenamiento, NUNCA en inferencia.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def triple_barrier(
    bars: pd.DataFrame,
    target_pct: float = 0.6,
    stop_pct: float = 0.3,
    horizon_minutes: int = 10,
) -> pd.DataFrame:
    """Para cada fila, calcula label en {WIN, LOSS, NEUTRAL}.

    Parámetros:
        target_pct: % al alza para WIN (ej 0.6 = +0.6%)
        stop_pct:   % a la baja para LOSS (ej 0.3 = -0.3%)
        horizon_minutes: ventana máxima de espera (minutos)

    Devuelve copia con columnas:
        label: 0=LOSS, 1=WIN, 2=NEUTRAL
        bars_to_outcome: cuántas barras tardó el resultado (NaN si NEUTRAL)
        future_max_pct: máximo alza en ventana
        future_min_pct: máxima caída en ventana
    """
    out = bars.copy().reset_index(drop=True)
    closes = out["close"].to_numpy()
    highs = out["high"].to_numpy()
    lows = out["low"].to_numpy()

    n = len(out)
    label = np.full(n, 2, dtype=np.int8)  # NEUTRAL default
    bars_to = np.full(n, np.nan)
    fut_max = np.full(n, np.nan)
    fut_min = np.full(n, np.nan)

    target_mult = 1 + target_pct / 100
    stop_mult = 1 - stop_pct / 100

    for i in range(n):
        entry = closes[i]
        if not np.isfinite(entry) or entry <= 0:
            continue
        up_lvl = entry * target_mult
        dn_lvl = entry * stop_mult
        end = min(n, i + 1 + horizon_minutes)
        seg_high = highs[i + 1:end]
        seg_low = lows[i + 1:end]
        if len(seg_high) == 0:
            continue

        # Track first touch
        won_at = None
        lost_at = None
        for j in range(len(seg_high)):
            if not won_at and seg_high[j] >= up_lvl:
                won_at = j
            if not lost_at and seg_low[j] <= dn_lvl:
                lost_at = j
            if won_at is not None or lost_at is not None:
                break

        max_high = np.nanmax(seg_high)
        min_low = np.nanmin(seg_low)
        fut_max[i] = (max_high - entry) / entry * 100
        fut_min[i] = (min_low - entry) / entry * 100

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
    out["future_max_pct"] = fut_max
    out["future_min_pct"] = fut_min
    return out


def summarize(df: pd.DataFrame) -> dict:
    counts = df["label"].value_counts().to_dict()
    total = len(df)
    return {
        "total": total,
        "win": int(counts.get(1, 0)),
        "loss": int(counts.get(0, 0)),
        "neutral": int(counts.get(2, 0)),
        "win_pct": counts.get(1, 0) / total * 100 if total else 0,
        "loss_pct": counts.get(0, 0) / total * 100 if total else 0,
        "neutral_pct": counts.get(2, 0) / total * 100 if total else 0,
    }
