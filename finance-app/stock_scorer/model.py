"""Modelo de scoring: XGBoost (si está entrenado) + fallback heurístico.

Estrategia anti-overfitting:
- Walk-forward CV (no shuffled): respeta orden temporal.
- Label = retorno forward 21 días, NO clasificación binaria (más señal).
- Early stopping con validación temporal.
- Features normalizadas a percentiles cross-sectional (robusto a outliers).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import (
    HEURISTIC_WEIGHTS, MODEL_PATH, MODEL_CLF_UP_PATH, MODEL_CLF_DOWN_PATH,
    FORWARD_RETURN_DAYS, WALK_FORWARD_FOLDS, TRAIN_LOOKBACK_YEARS,
    UP_THRESHOLD, DOWN_THRESHOLD,
)
from .features import FeatureSet

# Features usadas por el modelo (orden estable)
FEATURE_COLS = [
    # fundamentales (NaN durante entrenamiento histórico, XGBoost los maneja)
    "revenue_growth", "eps_growth", "profit_margin", "roe", "debt_to_equity",
    "pe_ratio",
    # técnicos básicos
    "rsi_14", "trend_ma", "momentum_3m", "volume_surge", "rel_strength_spy",
    # técnicos avanzados (nuevos: factores con edge probado)
    "macd_hist", "bb_pct", "adx_14", "dist_52w_high", "realized_vol",
    "momentum_10d", "gap_freq", "price_efficiency",
    # sentimiento
    "sentiment",
]


# =============================================================================
# NORMALIZACIÓN HEURÍSTICA → score 0-100
# =============================================================================
def _clip01(x: float) -> float:
    if x != x:  # NaN
        return 0.5
    return max(0.0, min(1.0, x))


def _normalize_feature(name: str, val: float) -> float:
    """Mapea cada feature a [0,1] según su semántica financiera."""
    if val != val:  # NaN
        return 0.5  # neutral
    if name == "revenue_growth":
        # 0% → 0.4 ; 20% → 0.9 ; >40% → 1
        return _clip01(0.4 + val * 2.5)
    if name == "eps_growth":
        return _clip01(0.4 + val * 2.0)
    if name == "profit_margin":
        return _clip01(0.3 + val * 3.0)   # 10% → 0.6, 20% → 0.9
    if name == "roe":
        return _clip01(0.3 + val * 2.5)
    if name == "debt_to_equity":
        # menos deuda mejor: 0 → 1.0, 1 → 0.5, 2+ → 0
        return _clip01(1.0 - val / 2.0)
    if name == "rsi_zone":
        # bonus si RSI 40-60, penaliza extremos
        rsi = val
        if 40 <= rsi <= 60:
            return 1.0
        if 30 <= rsi < 40 or 60 < rsi <= 70:
            return 0.7
        if rsi < 30:
            return 0.4    # sobrevendido (puede rebotar pero arriesgado)
        return 0.2        # >70 sobrecomprado
    if name == "trend_ma":
        # ya está en [-1, 1] → mapeo a [0, 1]
        return _clip01((val + 1) / 2)
    if name == "momentum_3m":
        # -20% → 0, 0% → 0.5, +20% → 1
        return _clip01(0.5 + val * 2.5)
    if name == "rel_strength_spy":
        return _clip01(0.5 + val * 3.0)
    if name == "volume_surge":
        # 1.0 = normal → 0.5 ; 2.0 → 0.8
        return _clip01(0.3 + val * 0.25)
    if name == "sentiment":
        return _clip01((val + 1) / 2)
    return 0.5


def heuristic_score(fs: FeatureSet) -> tuple[float, dict[str, float]]:
    """Score 0-100 + breakdown por feature (para explicabilidad)."""
    contributions: dict[str, float] = {}
    raw = 0.0
    weight_sum = 0.0
    for feat, w in HEURISTIC_WEIGHTS.items():
        if feat == "rsi_zone":
            v = fs.rsi_14
        else:
            v = getattr(fs, feat, float("nan"))
        norm = _normalize_feature(feat, v)
        # peso negativo (D/E) ya se manejó con normalización invertida → usamos abs
        contrib = norm * abs(w)
        contributions[feat] = contrib
        raw += contrib
        weight_sum += abs(w)
    score = (raw / weight_sum) * 100 if weight_sum > 0 else 50.0
    return score, contributions


# =============================================================================
# XGBOOST
# =============================================================================
@dataclass
class ScoringModel:
    """Wrapper sobre XGBoost con fallback heurístico.

    Soporta 3 modelos opcionales:
      - booster (regresión): predice retorno forward (score 0-100)
      - clf_up: P(retorno > +UP_THRESHOLD) — probabilidad de subida fuerte
      - clf_down: P(retorno < DOWN_THRESHOLD) — probabilidad de bajada fuerte
    """
    booster: object | None = None
    clf_up: object | None = None
    clf_down: object | None = None
    feature_cols: list[str] = None    # type: ignore

    def __post_init__(self):
        if self.feature_cols is None:
            self.feature_cols = FEATURE_COLS

    @classmethod
    def load(
        cls,
        path: str = MODEL_PATH,
        clf_up_path: str = MODEL_CLF_UP_PATH,
        clf_down_path: str = MODEL_CLF_DOWN_PATH,
    ) -> "ScoringModel":
        m = cls()
        try:
            import xgboost as xgb
        except ImportError:
            print("[modelo] xgboost no instalado → heurístico.")
            return m

        for attr, p, label in [
            ("booster", path, "regresión"),
            ("clf_up", clf_up_path, "clasificador P(↑)"),
            ("clf_down", clf_down_path, "clasificador P(↓)"),
        ]:
            if os.path.exists(p):
                try:
                    b = xgb.Booster()
                    b.load_model(p)
                    setattr(m, attr, b)
                    print(f"[modelo] {label} cargado desde {p}")
                except Exception as exc:  # noqa: BLE001
                    print(f"[modelo] no se pudo cargar {label} ({exc}).")
        if m.booster is None and m.clf_up is None:
            print("[modelo] sin XGBoost entrenado → usando heurístico. "
                  "Ejecuta `py -m stock_scorer.train` para entrenar.")
        return m

    def is_trained(self) -> bool:
        return self.booster is not None

    def _to_dmatrix(self, fs: FeatureSet):
        import xgboost as xgb
        row = {c: getattr(fs, c, np.nan) for c in self.feature_cols}
        return xgb.DMatrix(pd.DataFrame([row]))

    def predict(self, fs: FeatureSet) -> tuple[float, dict[str, float]]:
        """Retorna (score 0-100, breakdown)."""
        if not self.is_trained():
            return heuristic_score(fs)
        try:
            dmat = self._to_dmatrix(fs)
            pred = float(self.booster.predict(dmat)[0])  # type: ignore
            score = 50 + 50 * np.tanh(pred * 5)
            shap = self.booster.predict(dmat, pred_contribs=True)[0]  # type: ignore
            breakdown = {c: float(shap[i]) for i, c in enumerate(self.feature_cols)}
            return float(score), breakdown
        except Exception as exc:  # noqa: BLE001
            print(f"[modelo] predicción XGBoost falló ({exc}) → heurístico.")
            return heuristic_score(fs)

    def predict_probs(self, fs: FeatureSet) -> tuple[float, float]:
        """Retorna (P_up, P_down) ∈ [0,1] o (NaN,NaN) si no hay clasificadores."""
        if self.clf_up is None and self.clf_down is None:
            return float("nan"), float("nan")
        try:
            dmat = self._to_dmatrix(fs)
            p_up = float(self.clf_up.predict(dmat)[0]) if self.clf_up else float("nan")  # type: ignore
            p_down = float(self.clf_down.predict(dmat)[0]) if self.clf_down else float("nan")  # type: ignore
            return p_up, p_down
        except Exception as exc:  # noqa: BLE001
            print(f"[modelo] predict_probs falló ({exc})")
            return float("nan"), float("nan")
