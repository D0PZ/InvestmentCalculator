"""Monitor en vivo de posiciones abiertas.

Cada N segundos:
1. Descarga precio actual + features intradía
2. Compara contra SL/TP de cada posición
3. Alerta visual + sonora si:
   - Precio cruzó SL (¡VENDÉ YA!)
   - Precio cruzó TP (¡TOMAR GANANCIA!)
   - Precio se acerca peligrosamente (<1% de SL)
   - Señal intradía cambia drásticamente

Uso:
    py -m stock_scorer.live_monitor --refresh 30
    py -m stock_scorer.live_monitor --add NVDA --entry 890 --sl 850 --tp 970 --shares 1
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from . import scrapers
from .intraday import build_intraday_features_parallel
from .positions import Position, load_positions, save_positions, add_position, remove_position

console = Console()


def beep():
    """Beep del sistema (Windows). Para alertas críticas."""
    try:
        sys.stdout.write("\a")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass


def render_monitor(positions: list[Position], prices: dict, intra_map: dict) -> Group:
    """Renderiza el monitor live. Devuelve un Group de panels."""
    if not positions:
        return Group(Panel(
            "[dim]No hay posiciones abiertas.[/]\n"
            "Agregar: [bold]py -m stock_scorer.live_monitor --add TICKER "
            "--entry X --sl Y --tp Z --shares N[/]",
            title="📡 MONITOR EN VIVO",
            border_style="dim",
        ))

    table = Table(
        title=f"📡 MONITOR · {datetime.now().strftime('%H:%M:%S')}",
        expand=True, header_style="bold cyan",
    )
    table.add_column("Ticker", style="bold")
    table.add_column("Entry", justify="right")
    table.add_column("Precio", justify="right")
    table.add_column("PnL", justify="right")
    table.add_column("→ SL", justify="right")
    table.add_column("→ TP", justify="right")
    table.add_column("Intra", justify="center")
    table.add_column("Señal", justify="center", style="bold")
    table.add_column("Días", justify="right")

    alerts: list[str] = []

    for p in positions:
        current = prices.get(p.ticker)
        if current is None or current != current:
            table.add_row(p.ticker, f"${p.entry_price:.2f}",
                          "[red]?[/]", "—", "—", "—", "—", "—", str(p.days_open))
            continue

        pnl = p.pnl_pct(current) * 100
        d_sl = p.distance_to_sl(current) * 100   # % por encima del SL
        d_tp = p.distance_to_tp(current) * 100   # % que falta al TP

        intra = intra_map.get(p.ticker)
        intra_signal = intra.signal if intra else "—"
        intra_color = {"ALCISTA": "green", "BAJISTA": "red", "NEUTRO": "yellow"}.get(intra_signal, "white")

        # Decisión / alerta
        if current <= p.stop_loss:
            decision = "🚨 VENDER YA (SL)"
            decision_color = "bright_red"
            alerts.append(f"🚨 [bold red]{p.ticker}[/]: precio ${current:.2f} cruzó SL ${p.stop_loss:.2f} — VENDER YA")
            beep()
        elif current >= p.take_profit:
            decision = "💰 TOMAR GANANCIA (TP)"
            decision_color = "bright_green"
            alerts.append(f"💰 [bold green]{p.ticker}[/]: precio ${current:.2f} alcanzó TP ${p.take_profit:.2f} — TOMAR GANANCIA")
            beep()
        elif d_sl < 1.0:
            decision = "⚠️ CERCA DEL SL"
            decision_color = "orange3"
            alerts.append(f"⚠️ [yellow]{p.ticker}[/]: a {d_sl:.1f}% del SL")
        elif d_tp < 1.0:
            decision = "🎯 CERCA DEL TP"
            decision_color = "cyan"
        elif intra_signal == "BAJISTA" and pnl > 3:
            decision = "📉 CONSIDERA SALIR"
            decision_color = "yellow"
        elif p.days_open >= p.horizon_days:
            decision = "⏰ HORIZONTE EXPIRADO"
            decision_color = "magenta"
            alerts.append(f"⏰ [magenta]{p.ticker}[/]: {p.days_open} días abierta — revisá tesis")
        else:
            decision = "✓ HOLD"
            decision_color = "green"

        pnl_color = "green" if pnl >= 0 else "red"
        table.add_row(
            p.ticker,
            f"${p.entry_price:.2f}",
            f"${current:.2f}",
            Text(f"{pnl:+.2f}%", style=pnl_color),
            Text(f"{d_sl:+.1f}%", style="red" if d_sl < 2 else "white"),
            Text(f"{d_tp:+.1f}%", style="green" if d_tp < 2 else "white"),
            Text(intra_signal, style=intra_color),
            Text(decision, style=decision_color),
            str(p.days_open),
        )

    panels = [table]
    if alerts:
        panels.append(Panel(
            "\n".join(alerts),
            title=f"🚨 ALERTAS ACTIVAS ({len(alerts)})",
            border_style="bright_red",
        ))
    return Group(*panels)


def fetch_current_prices(tickers: list[str]) -> dict:
    """Última cotización en vivo usando barras 1-min de yfinance.

    Importante: NO usa el cache diario (que solo se actualiza al cierre).
    Hace fetch directo cada llamada → durante mercado abierto refresca cada
    minuto (delay ~15min en yfinance free, pero al menos avanza).

    Fuera de horario, fallback al último close diario.
    """
    import yfinance as yf
    from concurrent.futures import ThreadPoolExecutor

    def _last_price(tk: str) -> tuple[str, float | None]:
        try:
            # Intradía 1-min (último día de trading) — bypass cache
            df = yf.download(tk, period="1d", interval="1m",
                             progress=False, auto_adjust=False, threads=False)
            if not df.empty:
                return tk, float(df["Close"].iloc[-1].item() if hasattr(df["Close"].iloc[-1], "item") else df["Close"].iloc[-1])
        except Exception:
            pass
        # Fallback: cache diario
        try:
            df = scrapers.fetch_prices(tk, period="5d")
            if not df.empty:
                return tk, float(df["Close"].iloc[-1])
        except Exception:
            pass
        return tk, None

    out = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for tk, price in ex.map(_last_price, tickers):
            if price is not None:
                out[tk] = price
    return out


def cmd_add(args) -> None:
    pos = Position(
        ticker=args.add.upper(),
        entry_price=args.entry,
        stop_loss=args.sl,
        take_profit=args.tp,
        shares=args.shares,
        entry_date=datetime.now().isoformat(timespec="minutes"),
        horizon_days=args.horizon,
        notes=args.notes or "",
    )
    add_position(pos)
    console.print(f"[green]✓ Posición agregada:[/] {pos.ticker} @ ${pos.entry_price} "
                  f"SL ${pos.stop_loss} TP ${pos.take_profit}")


def cmd_remove(args) -> None:
    n = remove_position(args.remove.upper())
    console.print(f"[yellow]✓ {n} posición(es) eliminadas de {args.remove.upper()}[/]")


def cmd_list(_args) -> None:
    positions = load_positions()
    if not positions:
        console.print("[dim]No hay posiciones abiertas.[/]")
        return
    for p in positions:
        console.print(f"  • {p.ticker:6s} entry ${p.entry_price:.2f}  "
                      f"SL ${p.stop_loss:.2f}  TP ${p.take_profit:.2f}  "
                      f"shares {p.shares}  ({p.days_open}d)")


def cmd_monitor(args) -> None:
    positions = load_positions()
    if not positions:
        console.print("[yellow]No hay posiciones para monitorear. Agregá una con --add.[/]")
        return
    tickers = [p.ticker for p in positions]
    console.print(f"[dim]Monitoreando {len(tickers)} posición(es) cada {args.refresh}s. Ctrl+C para salir.[/]")
    try:
        cycle = 0
        while True:
            cycle += 1
            positions = load_positions()  # reload cada ciclo
            tickers = [p.ticker for p in positions]
            if not tickers:
                console.print("[yellow]No quedan posiciones.[/]")
                break
            prices = fetch_current_prices(tickers)
            intra_map = build_intraday_features_parallel(tickers, days=2)
            console.rule(f"[bold cyan]Ciclo #{cycle}[/]")
            console.print(render_monitor(positions, prices, intra_map))
            time.sleep(args.refresh)
    except KeyboardInterrupt:
        console.print("\n[yellow]✋ Monitor detenido.[/]")


def main() -> None:
    parser = argparse.ArgumentParser(description="Monitor en vivo de posiciones")
    parser.add_argument("--refresh", type=int, default=30, help="Segundos entre refreshes (default 30)")
    parser.add_argument("--add", help="Ticker a agregar")
    parser.add_argument("--entry", type=float, help="Precio de entrada")
    parser.add_argument("--sl", type=float, help="Stop loss")
    parser.add_argument("--tp", type=float, help="Take profit")
    parser.add_argument("--shares", type=float, default=1.0, help="Cantidad")
    parser.add_argument("--horizon", type=int, default=21, help="Días esperados de holding")
    parser.add_argument("--notes", help="Notas libres")
    parser.add_argument("--remove", help="Ticker a eliminar")
    parser.add_argument("--list", action="store_true", help="Listar posiciones")
    args = parser.parse_args()

    if args.add:
        if args.entry is None or args.sl is None or args.tp is None:
            parser.error("--add requiere --entry, --sl y --tp")
        cmd_add(args)
    elif args.remove:
        cmd_remove(args)
    elif args.list:
        cmd_list(args)
    else:
        cmd_monitor(args)


if __name__ == "__main__":
    main()
