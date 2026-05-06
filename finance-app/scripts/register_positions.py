"""Registra rápidamente tus posiciones actuales con SL/TP calculados por ATR.

Uso: py register_positions.py
"""
from datetime import datetime

from stock_scorer import scrapers
from stock_scorer.risk import build_trade_plan
from stock_scorer.positions import Position, add_position, load_positions, save_positions


# Tus posiciones (ticker, shares, entry_price, entry_datetime_iso)
POSITIONS = [
    ("TTWO", 0.50578576, 223.93, "2026-05-06T10:43"),
    ("MSFT", 0.04902936, 407.92, "2026-05-06T09:45"),
    ("ACN",  0.11320618, 176.67, "2026-05-06T11:57"),
    ("MDB",  0.16337817, 267.54, "2026-05-04T10:47"),
    ("NOW",  0.42070366,  95.08, "2026-05-04T10:46"),
]

# Limpiar posiciones previas si querés empezar fresco — descomentar:
# save_positions([])

print("📊 Calculando SL/TP por ATR para cada posición...\n")

for ticker, shares, entry, when in POSITIONS:
    df = scrapers.fetch_prices(ticker, period="6mo", interval="1d")
    if df.empty:
        print(f"❌ {ticker}: sin datos, salto")
        continue
    plan = build_trade_plan(entry, df, p_up=0.55)  # asume P↑=0.55 si no hay modelo
    if plan is None:
        print(f"❌ {ticker}: no se pudo calcular plan")
        continue

    pos = Position(
        ticker=ticker,
        entry_price=entry,
        stop_loss=plan.stop_loss,
        take_profit=plan.take_profit,
        shares=shares,
        entry_date=when,
        horizon_days=21,
        notes=f"Auto-registrado. Inversión inicial ${shares * entry:.2f}",
    )
    add_position(pos)
    pnl_to_sl = (plan.stop_loss / entry - 1) * 100
    pnl_to_tp = (plan.take_profit / entry - 1) * 100
    print(f"✓ {ticker:6s}  entry ${entry:>7.2f}  "
          f"SL ${plan.stop_loss:>7.2f} ({pnl_to_sl:+.1f}%)  "
          f"TP ${plan.take_profit:>7.2f} ({pnl_to_tp:+.1f}%)  "
          f"shares {shares:.6f}  inv ${shares * entry:.2f}")

print(f"\n📋 Total posiciones registradas: {len(load_positions())}")
print("\n💡 DHR es una orden MIT pendiente @ $165.58 — registrala cuando se ejecute con:")
print("   py -m stock_scorer.live_monitor --add DHR --entry 165.58 --sl <valor> --tp <valor> --shares 0.13")
print("\n▶️  Para empezar a monitorear:")
print("   py -m stock_scorer.live_monitor --refresh 30")
