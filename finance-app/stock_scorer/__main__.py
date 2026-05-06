"""CLI con refresh en vivo del scoring.

Uso:
    py -m stock_scorer                              # default tickers, 30s
    py -m stock_scorer --tickers AAPL TSLA NVDA
    py -m stock_scorer --refresh 15                 # cada 15s
    py -m stock_scorer --once                       # una sola pasada
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime

# Forzar UTF-8 en Windows (evita UnicodeEncodeError con flechas/emojis)
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from .config import DEFAULT_TICKERS, QUICK_TICKERS, SP100_TICKERS, REFRESH_OPTIONS, DEFAULT_REFRESH
from .model import ScoringModel
from .patterns import load_patterns
from .scorer import score_tickers, ScoreResult
from .intraday import build_intraday_features_parallel, IntradayFeatures


console = Console()


def _fmt_pct(v: float | None) -> str:
    if v is None or v != v:
        return "—"
    return f"{v * 100:+.1f}%"


def _fmt_prob(v: float | None) -> str:
    if v is None or v != v:
        return "—"
    return f"{v * 100:.0f}%"


def _fmt_num(v: float | None, dec: int = 2) -> str:
    if v is None or v != v:
        return "—"
    return f"{v:.{dec}f}"


def _prob_color(p_up: float, p_down: float) -> str:
    if p_up != p_up:
        return "white"
    if p_up - p_down > 0.20:
        return "bright_green"
    if p_up - p_down > 0.05:
        return "green"
    if p_down - p_up > 0.20:
        return "red"
    if p_down - p_up > 0.05:
        return "orange3"
    return "yellow"


def render_table(results: list[ScoreResult], refresh: int, model_kind: str,
                 intra_map: dict[str, IntradayFeatures] | None = None) -> Table:
    now = datetime.now().strftime("%H:%M:%S")
    title = (
        f"📊 Stock Scoring  ·  {now}  ·  refresh {refresh}s  ·  modelo: {model_kind}"
    )
    table = Table(title=title, expand=True, header_style="bold cyan")
    table.add_column("Ticker", style="bold")
    table.add_column("ACCIÓN", justify="center", style="bold")
    table.add_column("Intra", justify="center")           # NUEVO: confirma o contradice
    table.add_column("Score", justify="right")
    table.add_column("P(↑5%)", justify="right")
    table.add_column("P(↓5%)", justify="right")
    table.add_column("Precio", justify="right")
    table.add_column("vs VWAP", justify="right")          # NUEVO
    table.add_column("Trade Plan (SL/TP/Size)")
    table.add_column("RSI", justify="right")
    table.add_column("Mom 3m", justify="right")
    table.add_column("vs SPY", justify="right")
    table.add_column("Sent", justify="right")
    table.add_column("Pat", justify="right")

    for r in results:
        f = r.features
        score_txt = Text(f"{r.score:5.1f}", style=f"bold {r.color}")
        action_txt = Text(r.action_icon, style=f"bold {r.action_color}")
        prob_color = _prob_color(r.p_up, r.p_down)
        p_up_txt = Text(_fmt_prob(r.p_up), style=prob_color)
        p_dn_txt = Text(_fmt_prob(r.p_down), style="red" if (r.p_down == r.p_down and r.p_down > 0.4) else "white")
        n_pat = len(r.matched_patterns)
        pat_txt = Text(str(n_pat), style="bright_cyan" if n_pat > 0 else "dim")

        # Señal intradía
        intra = (intra_map or {}).get(r.ticker)
        if intra and intra.n_bars > 0:
            sig = intra.signal
            sig_color = {"ALCISTA": "green", "BAJISTA": "red", "NEUTRO": "yellow"}.get(sig, "dim")
            intra_txt = Text(sig[:4], style=sig_color)
            vwap_txt = _fmt_pct(intra.vwap_dist) if intra.vwap_dist == intra.vwap_dist else Text("—", style="dim")
        else:
            intra_txt = Text("—", style="dim")
            vwap_txt = Text("—", style="dim")

        # Trade plan: solo mostrar para COMPRAR/COMPRAR DÉBIL/MANTENER
        if r.trade_plan and r.action in ("COMPRAR", "COMPRAR DÉBIL", "MANTENER"):
            plan_color = (
                "bright_green" if r.action == "COMPRAR"
                else "green" if r.action == "COMPRAR DÉBIL"
                else "dim"
            )
            plan_txt = Text(r.trade_plan.as_text(), style=plan_color)
        else:
            plan_txt = Text("—", style="dim")

        table.add_row(
            r.ticker,
            action_txt,
            intra_txt,
            score_txt,
            p_up_txt,
            p_dn_txt,
            _fmt_num(f.last_price),
            vwap_txt,
            plan_txt,
            _fmt_num(f.rsi_14, 1),
            _fmt_pct(f.momentum_3m),
            _fmt_pct(f.rel_strength_spy),
            _fmt_num(f.sentiment, 2),
            pat_txt,
        )
    return table


def render_patterns_panel(results: list[ScoreResult], top_n: int = 5) -> Panel | None:
    """Panel con las mejores oportunidades detectadas por patrones."""
    rows: list[str] = []
    for r in results:
        if not r.matched_patterns:
            continue
        for p in r.matched_patterns[:2]:
            cond = " + ".join(p.conditions)
            rows.append(
                f"[bold cyan]{r.ticker}[/]  "
                f"[bright_green]{p.hit_rate * 100:.0f}% hit[/] "
                f"(n={p.n}, μ={p.mean_return * 100:+.1f}%, "
                f"peor={p.worst_return * 100:+.1f}%)  "
                f"[dim]{cond}[/]"
            )
        if len(rows) >= top_n:
            break
    if not rows:
        return Panel(
            "[dim]Sin patrones históricos coincidentes. "
            "Ejecuta `py -m stock_scorer.patterns` primero.[/dim]",
            title="🎯 Oportunidades por patrón histórico",
            border_style="dim",
        )
    return Panel(
        "\n".join(rows[:top_n]),
        title="🎯 Oportunidades por patrón histórico (10 años)",
        border_style="cyan",
    )


def render_orders_panel(results: list[ScoreResult],
                        intra_map: dict[str, IntradayFeatures] | None = None) -> Panel:
    """Panel de ÓRDENES PARA HOY: solo muestra acciones con veredicto claro
    (COMPRAR YA, COMPRAR parcial, VENDER). Es la sección más importante.

    Si hay datos intradía, AGREGA confirmación o WARNING:
    - Intra ALCISTA + COMPRAR → "✓ Confirmado intradía"
    - Intra BAJISTA + COMPRAR → "⚠ Intradía contradice — espera o reduce size"
    - Intra ALCISTA + VENDER → "⚠ Intradía rebota — quizá esperar"
    """
    actionable = [
        r for r in results
        if r.verdict[0] in ("COMPRAR YA", "COMPRAR (parcial)", "VENDER SI TIENES")
    ]
    if not actionable:
        return Panel(
            "[dim]Hoy no hay setups con edge claro.[/dim]\n"
            "[dim]→ Lo más sano es no operar. Espera mejor oportunidad.[/dim]",
            title="📋 ÓRDENES PARA HOY",
            border_style="dim",
        )

    priority = {"COMPRAR YA": 0, "COMPRAR (parcial)": 1, "VENDER SI TIENES": 2}
    actionable.sort(key=lambda r: (priority[r.verdict[0]], -r.score))

    blocks: list[str] = []
    for r in actionable[:10]:
        decision, reasons = r.verdict
        color = r.verdict_color
        header = f"[bold {color}]► {r.ticker} — {decision}[/]"
        reason_lines = "\n".join(f"   {reason}" for reason in reasons)

        # Confirmación intradía
        intra = (intra_map or {}).get(r.ticker)
        intra_line = ""
        if intra and intra.n_bars > 0:
            sig = intra.signal
            vwap_d = intra.vwap_dist if intra.vwap_dist == intra.vwap_dist else 0.0
            mom_1h = intra.momentum_1h if intra.momentum_1h == intra.momentum_1h else 0.0
            stats = f"VWAP {vwap_d * 100:+.2f}%  ·  1h {mom_1h * 100:+.2f}%"
            if decision.startswith("COMPRAR"):
                if sig == "ALCISTA":
                    intra_line = f"   [bold green]✓ Intradía CONFIRMA[/] ({stats})"
                elif sig == "BAJISTA":
                    intra_line = f"   [bold yellow]⚠ Intradía CONTRADICE[/] ({stats}) → espera mejor entry o reduce size 50%"
                else:
                    intra_line = f"   [dim]Intradía neutro ({stats})[/]"
            elif decision == "VENDER SI TIENES":
                if sig == "ALCISTA":
                    intra_line = f"   [yellow]⚠ Intradía rebotando[/] ({stats}) → si no es urgente, espera"
                elif sig == "BAJISTA":
                    intra_line = f"   [bold red]✓ Intradía CONFIRMA caída[/] ({stats})"

        if r.trade_plan and decision != "VENDER SI TIENES":
            plan_line = f"   [bold]PLAN:[/] {r.trade_plan.as_text()}"
            block = f"{header}\n{reason_lines}\n{plan_line}"
        else:
            block = f"{header}\n{reason_lines}"
        if intra_line:
            block += f"\n{intra_line}"
        blocks.append(block)

    n_buy = sum(1 for r in actionable if r.verdict[0].startswith("COMPRAR"))
    n_sell = sum(1 for r in actionable if r.verdict[0] == "VENDER SI TIENES")
    title = f"📋 ÓRDENES PARA HOY  —  {n_buy} compra(s) · {n_sell} venta(s)"

    return Panel(
        "\n\n".join(blocks),
        title=title,
        border_style="bright_green" if n_buy > 0 else "bright_red",
    )


def render_dashboard(results, refresh, model_kind, intra_map=None):
    return Group(
        render_table(results, refresh, model_kind, intra_map),
        render_orders_panel(results, intra_map),
        render_patterns_panel(results),
    )


def main():
    parser = argparse.ArgumentParser(description="Stock Scoring en vivo")
    parser.add_argument("--tickers", nargs="+", default=None,
                        help="Tickers a analizar")
    parser.add_argument("--universe", choices=["quick", "sp100"], default="quick",
                        help="quick=14 mega-caps tech | sp100=100 acciones top US")
    parser.add_argument("--refresh", type=int, default=DEFAULT_REFRESH,
                        choices=REFRESH_OPTIONS,
                        help="Segundos entre refrescos (15/30/60)")
    parser.add_argument("--once", action="store_true",
                        help="Ejecutar una sola pasada (sin loop)")
    parser.add_argument("--no-intraday", action="store_true",
                        help="Saltar features intradía (más rápido pero menos preciso)")
    args = parser.parse_args()

    if args.tickers is None:
        args.tickers = SP100_TICKERS if args.universe == "sp100" else QUICK_TICKERS

    model = ScoringModel.load()
    patterns = load_patterns()
    if model.is_trained() and model.clf_up is not None:
        model_kind = "XGBoost + P(↑↓)"
    elif model.is_trained():
        model_kind = "XGBoost"
    else:
        model_kind = "Heurístico"
    if patterns:
        model_kind += f" · {len(patterns)} patrones"

    if args.once:
        results = score_tickers(args.tickers, model=model, patterns=patterns)
        intra_map = None if args.no_intraday else build_intraday_features_parallel(args.tickers, days=2)
        console.print(render_dashboard(results, args.refresh, model_kind, intra_map))
        return

    console.print(
        f"[dim]Ctrl+C para salir · refresh={args.refresh}s · "
        f"{len(args.tickers)} tickers[/dim]"
    )
    try:
        # Sin Live → imprimimos un dashboard nuevo cada ciclo.
        # Permite scroll hacia arriba para revisar refreshes anteriores.
        # Trade-off: la pantalla "crece" hacia abajo en vez de actualizarse en sitio.
        cycle = 0
        while True:
            cycle += 1
            results = score_tickers(args.tickers, model=model, patterns=patterns)
            intra_map = None if args.no_intraday else build_intraday_features_parallel(args.tickers, days=2)
            console.rule(f"[bold cyan]Refresh #{cycle} · {time.strftime('%H:%M:%S')}[/]")
            console.print(render_dashboard(results, args.refresh, model_kind, intra_map))
            time.sleep(args.refresh)
    except KeyboardInterrupt:
        console.print("\n[yellow]✋ Detenido por el usuario.[/yellow]")


if __name__ == "__main__":
    main()
