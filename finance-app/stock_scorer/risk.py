"""Risk management: ATR-based stop-loss / take-profit + Kelly position sizing."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


def atr(df: pd.DataFrame, period: int = 14) -> float:
    """Average True Range — medida de volatilidad absoluta del precio.

    Útil para stops dinámicos: SL = entry - 2*ATR es estándar.
    """
    if df.empty or len(df) < period + 1:
        return float("nan")
    high = df["High"]
    low = df["Low"]
    close = df["Close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return float(tr.ewm(alpha=1 / period, adjust=False).mean().iloc[-1])


@dataclass
class TradePlan:
    """Plan de trade ejecutable con SL, TP y tamaño de posición."""
    entry: float
    stop_loss: float
    take_profit: float
    risk_pct: float            # % del capital arriesgado (entry → SL)
    reward_pct: float          # % ganancia objetivo (entry → TP)
    risk_reward: float         # ratio TP/SL (>=2 deseable)
    position_size_pct: float   # % del capital sugerido (Kelly fraccional)

    def as_text(self) -> str:
        """Línea legible para mostrar."""
        return (
            f"E ${self.entry:.2f} · "
            f"SL ${self.stop_loss:.2f} ({-self.risk_pct * 100:.1f}%) · "
            f"TP ${self.take_profit:.2f} (+{self.reward_pct * 100:.1f}%) · "
            f"R:R {self.risk_reward:.1f} · "
            f"size {self.position_size_pct * 100:.1f}%"
        )


def kelly_fraction(p_win: float, win_loss_ratio: float, fraction: float = 0.25) -> float:
    """Kelly criterion fraccional (1/4 de Kelly, estándar para reducir varianza).

    f* = p_win - p_loss / R, donde R = TP/SL.
    Devuelve % del capital a poner (clipeado a [0, 0.25]).

    `fraction` = qué porción del Kelly puro usar. 0.25 = "quarter Kelly",
    estándar en quant porque Kelly puro tiene drawdowns brutales.
    """
    if p_win != p_win or p_win <= 0 or win_loss_ratio <= 0:
        return 0.0
    p_loss = 1 - p_win
    full_kelly = p_win - (p_loss / win_loss_ratio)
    if full_kelly <= 0:
        return 0.0
    return float(min(full_kelly * fraction, 0.25))


def build_trade_plan(
    last_price: float,
    df_ohlcv: pd.DataFrame,
    p_up: float,
    atr_mult_sl: float = 2.0,
    atr_mult_tp: float = 4.0,
) -> TradePlan | None:
    """Genera SL/TP basados en ATR y position size con Kelly.

    Defaults: SL a 2 ATR, TP a 4 ATR → R:R = 2.0 (estándar swing trading).
    Si no hay datos suficientes, devuelve None.
    """
    if last_price != last_price or last_price <= 0:
        return None
    a = atr(df_ohlcv)
    if a != a or a <= 0:
        return None

    sl = last_price - atr_mult_sl * a
    tp = last_price + atr_mult_tp * a
    risk_pct = (last_price - sl) / last_price
    reward_pct = (tp - last_price) / last_price
    rr = reward_pct / risk_pct if risk_pct > 0 else 0.0

    # Kelly sizing: si no hay P(↑) entrenada, usa heurística conservadora 50%
    p = p_up if p_up == p_up else 0.50
    size = kelly_fraction(p, rr)

    return TradePlan(
        entry=last_price,
        stop_loss=sl,
        take_profit=tp,
        risk_pct=risk_pct,
        reward_pct=reward_pct,
        risk_reward=rr,
        position_size_pct=size,
    )
