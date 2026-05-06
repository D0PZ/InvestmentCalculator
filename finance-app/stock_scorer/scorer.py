"""Scorer principal: combina features + modelo y rankea tickers."""
from __future__ import annotations

from dataclasses import dataclass, field

from . import scrapers
from .features import FeatureSet, build_features, get_benchmark_close
from .model import ScoringModel, heuristic_score
from .patterns import Pattern, load_patterns, find_matching_patterns
from .risk import TradePlan, build_trade_plan


@dataclass
class ScoreResult:
    ticker: str
    score: float
    features: FeatureSet
    breakdown: dict[str, float] = field(default_factory=dict)
    p_up: float = float("nan")
    p_down: float = float("nan")
    matched_patterns: list[Pattern] = field(default_factory=list)
    trade_plan: TradePlan | None = None

    @property
    def label(self) -> str:
        if self.score >= 70:
            return "FUERTE"
        if self.score >= 55:
            return "BUENO"
        if self.score >= 45:
            return "NEUTRO"
        if self.score >= 30:
            return "DÉBIL"
        return "EVITAR"

    @property
    def action(self) -> str:
        """Acción concreta: COMPRAR / COMPRAR DÉBIL / MANTENER / ESPERAR / VENDER.

        Combina score + probabilidades + RSI. Tres tiers de compra:
        - COMPRAR FUERTE: alta convicción (p_up≥0.55, p_down<0.35, RSI<72)
        - COMPRAR DÉBIL: setup decente (p_up≥0.45 OR score≥55, RSI<75)
        - MANTENER / ESPERAR / VENDER: igual que antes
        """
        rsi_val = self.features.rsi_14
        has_probs = self.p_up == self.p_up  # not NaN
        rsi_ok_strong = (rsi_val != rsi_val) or rsi_val < 72
        rsi_ok_weak = (rsi_val != rsi_val) or rsi_val < 75

        # COMPRAR FUERTE
        if has_probs and self.p_up >= 0.55 and self.p_down < 0.35 and rsi_ok_strong:
            return "COMPRAR"
        if not has_probs and self.score >= 60 and rsi_ok_strong:
            return "COMPRAR"

        # COMPRAR DÉBIL: edge positivo pero menos contundente
        if has_probs and self.p_up >= 0.45 and self.p_up > self.p_down and rsi_ok_weak:
            return "COMPRAR DÉBIL"
        if not has_probs and self.score >= 50 and rsi_ok_weak:
            return "COMPRAR DÉBIL"

        # VENDER
        if has_probs and self.p_down >= 0.50 and self.p_up < 0.30:
            return "VENDER"
        if not has_probs and self.score <= 30:
            return "VENDER"
        if rsi_val == rsi_val and rsi_val > 80:
            return "VENDER"

        # ESPERAR: sobrevendido + score decente
        if rsi_val == rsi_val and rsi_val < 30 and self.score >= 45:
            return "ESPERAR"

        return "MANTENER"

    @property
    def action_color(self) -> str:
        return {
            "COMPRAR": "bright_green",
            "COMPRAR DÉBIL": "green",
            "MANTENER": "yellow",
            "ESPERAR": "cyan",
            "VENDER": "bright_red",
        }.get(self.action, "white")

    @property
    def action_icon(self) -> str:
        return {
            "COMPRAR": "▲ COMPRAR",
            "COMPRAR DÉBIL": "△ COMP.DÉB",
            "MANTENER": "● MANTENER",
            "ESPERAR": "◆ ESPERAR",
            "VENDER": "▼ VENDER",
        }.get(self.action, self.action)

    @property
    def color(self) -> str:
        if self.score >= 70:
            return "bright_green"
        if self.score >= 55:
            return "green"
        if self.score >= 45:
            return "yellow"
        if self.score >= 30:
            return "orange3"
        return "red"

    def top_reasons(self, n: int = 3) -> list[str]:
        items = sorted(self.breakdown.items(), key=lambda x: x[1], reverse=True)
        return [k for k, _ in items[:n]]

    @property
    def best_pattern_strength(self) -> float:
        """0..1: qué tan fuerte es el patrón histórico mejor que matchea ahora.
        Combina hit_rate y muestra. 0 = ninguno, 1 = patrón muy sólido."""
        if not self.matched_patterns:
            return 0.0
        best = max(self.matched_patterns, key=lambda p: p.hit_rate)
        # Penaliza muestras chicas
        sample_factor = min(best.n / 100, 1.0)
        # Normaliza hit_rate desde 0.5 (azar) hasta 0.75 (excelente)
        hit_norm = max(0.0, min(1.0, (best.hit_rate - 0.5) / 0.25))
        return hit_norm * sample_factor

    @property
    def verdict(self) -> tuple[str, list[str]]:
        """Recomendación FINAL unificada combinando TODO.

        Returns: (decision, reasons) donde decision es uno de:
        - "COMPRAR YA"           → triple confirmación, alta convicción
        - "COMPRAR (parcial)"     → señal positiva pero con cautela
        - "WATCHLIST"             → cerca de calificar, vigilar
        - "NO HACER NADA"         → sin edge claro
        - "EVITAR / NO ENTRAR"    → señales mixtas o sobrecomprado
        - "VENDER SI TIENES"      → señal negativa clara
        """
        action = self.action
        rsi_val = self.features.rsi_14
        sent = self.features.sentiment
        pattern_str = self.best_pattern_strength
        has_strong_pattern = pattern_str >= 0.3  # hit≥58% con n≥100

        reasons: list[str] = []

        # ═══════════ VENDER ═══════════
        if action == "VENDER":
            reasons.append(f"Modelo señala VENDER (P↓={self.p_down:.0%})")
            if rsi_val == rsi_val and rsi_val > 75:
                reasons.append(f"RSI {rsi_val:.0f} = sobrecomprado")
            if sent == sent and sent < -0.2:
                reasons.append(f"Sentimiento negativo ({sent:+.2f})")
            return "VENDER SI TIENES", reasons

        # ═══════════ COMPRAR YA (triple confirmación) ═══════════
        if action == "COMPRAR" and has_strong_pattern:
            reasons.append(f"✓ Modelo: COMPRAR (P↑={self.p_up:.0%})")
            best = max(self.matched_patterns, key=lambda p: p.hit_rate)
            reasons.append(f"✓ Patrón histórico: {best.hit_rate:.0%} hit (n={best.n}, μ={best.mean_return:+.1%})")
            if sent == sent and sent > 0.1:
                reasons.append(f"✓ Sentimiento positivo ({sent:+.2f})")
            else:
                reasons.append(f"✓ Score alto ({self.score:.0f}) + RSI sano ({rsi_val:.0f})")
            return "COMPRAR YA", reasons

        # ═══════════ COMPRAR YA (modelo fuerte sin patrón) ═══════════
        if action == "COMPRAR":
            reasons.append(f"✓ Modelo: COMPRAR (P↑={self.p_up:.0%}, P↓={self.p_down:.0%})")
            reasons.append(f"✓ Score {self.score:.0f}, RSI {rsi_val:.0f}")
            if not self.matched_patterns:
                reasons.append("⚠ Sin patrón histórico que confirme — convicción media")
            return "COMPRAR YA", reasons

        # ═══════════ COMPRAR PARCIAL (débil + patrón fuerte) ═══════════
        if action == "COMPRAR DÉBIL" and has_strong_pattern:
            best = max(self.matched_patterns, key=lambda p: p.hit_rate)
            reasons.append(f"○ Modelo: compra débil (P↑={self.p_up:.0%})")
            reasons.append(f"✓ Patrón histórico: {best.hit_rate:.0%} hit (n={best.n})")
            reasons.append("→ Entra con MITAD del size sugerido")
            return "COMPRAR (parcial)", reasons

        # ═══════════ COMPRAR PARCIAL (débil sólo) ═══════════
        if action == "COMPRAR DÉBIL":
            reasons.append(f"○ Edge positivo pero débil (P↑={self.p_up:.0%})")
            reasons.append("→ Watchlist o entra con 1/3 del size")
            return "COMPRAR (parcial)", reasons

        # ═══════════ WATCHLIST (mantener pero patrón interesante) ═══════════
        if action == "MANTENER" and has_strong_pattern:
            best = max(self.matched_patterns, key=lambda p: p.hit_rate)
            reasons.append(f"Patrón histórico interesante: {best.hit_rate:.0%} hit")
            reasons.append(f"Pero modelo neutro (P↑={self.p_up:.0%})")
            reasons.append("→ Vigila; espera confirmación del modelo")
            return "WATCHLIST", reasons

        # ═══════════ ESPERAR (sobrevendido) ═══════════
        if action == "ESPERAR":
            reasons.append(f"RSI {rsi_val:.0f} = sobrevendido (puede rebotar)")
            reasons.append("Pero también puede seguir cayendo — esperá confirmación")
            return "WATCHLIST", reasons

        # ═══════════ NO HACER NADA ═══════════
        reasons.append(f"Score {self.score:.0f} sin edge claro (P↑={self.p_up:.0%})")
        if rsi_val == rsi_val and rsi_val > 70:
            reasons.append(f"RSI {rsi_val:.0f} alto — riesgoso entrar acá")
        return "NO HACER NADA", reasons

    @property
    def verdict_color(self) -> str:
        decision = self.verdict[0]
        return {
            "COMPRAR YA": "bright_green",
            "COMPRAR (parcial)": "green",
            "WATCHLIST": "cyan",
            "NO HACER NADA": "dim",
            "EVITAR / NO ENTRAR": "orange3",
            "VENDER SI TIENES": "bright_red",
        }.get(decision, "white")


def score_tickers(
    tickers: list[str],
    model: ScoringModel | None = None,
    patterns: list[Pattern] | None = None,
) -> list[ScoreResult]:
    """Calcula scores para una lista de tickers, ordenados desc.

    Optimizado: descarga precios + fundamentales + news en PARALELO antes
    de armar features (10× más rápido con 100 tickers).
    """
    if model is None:
        model = ScoringModel.load()
    if patterns is None:
        patterns = load_patterns()
    bench_close = get_benchmark_close()

    # Descarga paralela de los 3 tipos de datos
    prices_map = scrapers.fetch_prices_parallel(tickers, period="1y")
    fund_map = scrapers.fetch_fundamentals_parallel(tickers)
    news_map = scrapers.fetch_news_sentiment_parallel(tickers)

    results: list[ScoreResult] = []
    for tk in tickers:
        fs = build_features(
            tk,
            bench_close=bench_close,
            ohlcv=prices_map.get(tk),
            fund=fund_map.get(tk),
            news=news_map.get(tk),
        )
        score, breakdown = model.predict(fs)
        p_up, p_down = model.predict_probs(fs)

        matched: list[Pattern] = []
        if patterns:
            matched = find_matching_patterns(fs.as_dict(), patterns)

        plan = build_trade_plan(fs.last_price, fs.ohlcv, p_up) if fs.ohlcv is not None else None

        results.append(ScoreResult(
            ticker=tk, score=score, features=fs, breakdown=breakdown,
            p_up=p_up, p_down=p_down, matched_patterns=matched,
            trade_plan=plan,
        ))
    results.sort(key=lambda r: r.score, reverse=True)
    return results