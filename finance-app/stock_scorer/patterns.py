"""Pattern mining: descubre reglas históricas tipo
"si RSI ∈ [40,60] Y momentum>10% Y trend up → P(subida >5%) = 68% (n=412)".

Estrategia:
1. Construye dataset histórico (features técnicos + fwd_return).
2. Discretiza cada feature en bins (low/mid/high).
3. Genera todas las combinaciones de 2-3 features y calcula:
     - n: ocurrencias del patrón
     - hit_rate: % de veces que fwd_return > umbral
     - mean_return / median_return / worst_drawdown
4. Filtra patrones con n >= MIN_SAMPLES y ordena por hit_rate.
5. Aplica los patrones a los tickers actuales para alertas.
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
from dataclasses import dataclass, asdict
from typing import Iterable

import numpy as np
import pandas as pd

from . import scrapers
from .config import DEFAULT_TICKERS, QUICK_TICKERS, SP100_TICKERS, FORWARD_RETURN_DAYS
from .features import rsi, trend_score, momentum, volume_surge, relative_strength
from .train import build_training_dataset


PATTERNS_PATH = "stock_scorer/patterns.json"
MIN_SAMPLES = 30          # mínimo histórico para que un patrón sea estadísticamente válido
DEFAULT_THRESHOLD = 0.05  # subida considerada "ganadora" (>+5% en 21d)
TOP_N_PATTERNS = 30


# Bins discretización: nombre → (test_fn, label)
# Cada feature se mapea a una "zona" categórica
FEATURE_BINS = {
    "rsi_14": [
        ("rsi_oversold",   lambda x: x < 30),
        ("rsi_neutral_lo", lambda x: 30 <= x < 45),
        ("rsi_sweet",      lambda x: 45 <= x <= 60),
        ("rsi_neutral_hi", lambda x: 60 < x <= 70),
        ("rsi_overbought", lambda x: x > 70),
    ],
    "momentum_3m": [
        ("mom_strong_neg", lambda x: x < -0.15),
        ("mom_neg",        lambda x: -0.15 <= x < -0.03),
        ("mom_flat",       lambda x: -0.03 <= x <= 0.03),
        ("mom_pos",        lambda x: 0.03 < x <= 0.15),
        ("mom_strong_pos", lambda x: x > 0.15),
    ],
    "trend_ma": [
        ("trend_down",     lambda x: x <= -0.5),
        ("trend_mixed",    lambda x: -0.5 < x < 0.5),
        ("trend_up",       lambda x: x >= 0.5),
    ],
    "rel_strength_spy": [
        ("rs_loser",       lambda x: x < -0.05),
        ("rs_neutral",     lambda x: -0.05 <= x <= 0.05),
        ("rs_winner",      lambda x: x > 0.05),
    ],
    "volume_surge": [
        ("vol_low",        lambda x: x < 0.8),
        ("vol_normal",     lambda x: 0.8 <= x <= 1.3),
        ("vol_surge",      lambda x: x > 1.3),
    ],
}


@dataclass
class Pattern:
    """Una regla descubierta del histórico."""
    conditions: list[str]              # ej. ["rsi_sweet", "mom_pos", "trend_up"]
    n: int                             # ocurrencias en el histórico
    hit_rate: float                    # P(fwd_return > threshold)
    mean_return: float
    median_return: float
    worst_return: float                # peor caso (para riesgo)
    threshold: float                   # umbral usado

    def matches(self, feat_values: dict[str, float]) -> bool:
        """¿La acción actual cumple este patrón?"""
        return all(_eval_condition(c, feat_values) for c in self.conditions)

    def to_dict(self) -> dict:
        return asdict(self)


def _eval_condition(cond: str, feat_values: dict[str, float]) -> bool:
    """Evalúa una etiqueta tipo 'rsi_sweet' contra los valores actuales."""
    for feat, bins in FEATURE_BINS.items():
        for label, test in bins:
            if label == cond:
                v = feat_values.get(feat, float("nan"))
                if v != v:  # NaN → no matchea
                    return False
                return test(v)
    return False


def _label_row(row: pd.Series) -> dict[str, str]:
    """Discretiza una fila histórica → {feature: zona}."""
    out: dict[str, str] = {}
    for feat, bins in FEATURE_BINS.items():
        v = row.get(feat)
        if v is None or v != v:
            continue
        for label, test in bins:
            if test(v):
                out[feat] = label
                break
    return out


def mine_patterns(
    df: pd.DataFrame,
    threshold: float = DEFAULT_THRESHOLD,
    min_samples: int = MIN_SAMPLES,
    max_combo_size: int = 3,
) -> list[Pattern]:
    """Genera todas las combinaciones de 2..max features, calcula stats."""
    # Pre-discretizar todo el dataset
    labeled = df.apply(_label_row, axis=1)
    labels_df = pd.DataFrame(list(labeled))
    labels_df["fwd_return"] = df["fwd_return"].values

    patterns: list[Pattern] = []
    feats = list(FEATURE_BINS.keys())

    for combo_size in range(2, max_combo_size + 1):
        for combo in itertools.combinations(feats, combo_size):
            # Posibles valores de cada feature en este combo
            options = [
                [lbl for lbl, _ in FEATURE_BINS[f]] for f in combo
            ]
            for value_combo in itertools.product(*options):
                mask = np.ones(len(labels_df), dtype=bool)
                for f, val in zip(combo, value_combo):
                    mask &= (labels_df[f] == val).fillna(False).values
                n = int(mask.sum())
                if n < min_samples:
                    continue
                rets = labels_df.loc[mask, "fwd_return"].values
                hit_rate = float((rets > threshold).mean())
                patterns.append(Pattern(
                    conditions=list(value_combo),
                    n=n,
                    hit_rate=hit_rate,
                    mean_return=float(rets.mean()),
                    median_return=float(np.median(rets)),
                    worst_return=float(rets.min()),
                    threshold=threshold,
                ))

    # Ranking: hit_rate alta + suficiente n
    patterns.sort(key=lambda p: (p.hit_rate, p.n), reverse=True)
    return patterns


def save_patterns(patterns: list[Pattern], path: str = PATTERNS_PATH) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([p.to_dict() for p in patterns], fh, indent=2)


def load_patterns(path: str = PATTERNS_PATH) -> list[Pattern]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return [Pattern(**d) for d in data]


def find_matching_patterns(
    feat_values: dict[str, float],
    patterns: list[Pattern],
    top_n: int = 5,
    min_hit_rate: float = 0.55,
) -> list[Pattern]:
    """Devuelve los patrones que la acción cumple AHORA, ordenados."""
    matched = [p for p in patterns if p.hit_rate >= min_hit_rate and p.matches(feat_values)]
    matched.sort(key=lambda p: (p.hit_rate, p.n), reverse=True)
    return matched[:top_n]


# =============================================================================
# CLI
# =============================================================================
def main() -> None:
    parser = argparse.ArgumentParser(description="Pattern mining histórico")
    parser.add_argument("--tickers", nargs="+", default=None)
    parser.add_argument("--universe", choices=["quick", "sp100"], default="sp100",
                        help="sp100 (default) usa 100 tickers; quick usa 14")
    parser.add_argument("--years", type=int, default=10)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help="Umbral de retorno para 'ganador' (0.05 = +5%%)")
    parser.add_argument("--min-samples", type=int, default=MIN_SAMPLES)
    parser.add_argument("--top", type=int, default=TOP_N_PATTERNS)
    parser.add_argument("--out", default=PATTERNS_PATH)
    args = parser.parse_args()

    if args.tickers is None:
        args.tickers = SP100_TICKERS if args.universe == "sp100" else QUICK_TICKERS

    print(f"📊 Construyendo dataset histórico ({len(args.tickers)} tickers × {args.years} años)...")
    df = build_training_dataset(args.tickers, args.years)
    print(f"  filas: {len(df)}")

    if len(df) < 200:
        print("⚠️  Dataset muy pequeño. Aumenta tickers o años.")
        return

    print(f"\n🔍 Minando patrones (umbral=+{args.threshold * 100:.0f}%, min n={args.min_samples})...")
    patterns = mine_patterns(df, args.threshold, args.min_samples)
    print(f"  patrones válidos: {len(patterns)}")

    save_patterns(patterns, args.out)
    print(f"✅ Guardados en {args.out}\n")

    # Top-N en consola
    print(f"🏆 TOP {args.top} PATRONES por hit-rate:")
    print(f"{'Hit%':>6} {'n':>5} {'μ ret':>8} {'mediana':>8} {'peor':>8}  Patrón")
    print("-" * 90)
    for p in patterns[:args.top]:
        cond = " + ".join(p.conditions)
        print(f"{p.hit_rate * 100:>5.1f}% {p.n:>5} "
              f"{p.mean_return * 100:>+7.2f}% {p.median_return * 100:>+7.2f}% "
              f"{p.worst_return * 100:>+7.2f}%  {cond}")


if __name__ == "__main__":
    main()
