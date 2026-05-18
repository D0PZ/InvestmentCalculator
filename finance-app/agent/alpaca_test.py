"""Verificación rápida: ¿las API keys de Alpaca funcionan?

Uso:
    python alpaca_test.py
"""
import os
import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env")
load_dotenv(ROOT / ".env", override=True)

API_KEY = os.getenv("ALPACA_API_KEY", "").strip()
API_SECRET = os.getenv("ALPACA_SECRET", "").strip()

if not API_KEY or not API_SECRET:
    print("❌ Faltan ALPACA_API_KEY o ALPACA_SECRET en .env")
    sys.exit(1)

print(f"✓ Keys encontradas (KEY empieza con: {API_KEY[:4]}...)")

try:
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame

    client = StockHistoricalDataClient(API_KEY, API_SECRET)
    end = datetime.now(timezone.utc) - timedelta(minutes=16)
    start = end - timedelta(days=1)

    req = StockBarsRequest(
        symbol_or_symbols="MSFT",
        timeframe=TimeFrame.Minute,
        start=start,
        end=end,
        feed="iex",
    )
    resp = client.get_stock_bars(req)
    bars = resp.data.get("MSFT", [])
    print(f"✓ Conexión OK — {len(bars)} bars de MSFT recibidos")
    if bars:
        first = bars[0]
        last = bars[-1]
        print(f"  Primera: {first.timestamp} → close ${first.close}")
        print(f"  Última : {last.timestamp} → close ${last.close}")
    print()
    print("🎉 Listo para correr: python alpaca_backfill.py --years 5")
except Exception as e:
    print(f"❌ Error: {e}")
    print()
    print("Causas comunes:")
    print("  - Key/secret mal pegados (espacios, comillas extra)")
    print("  - Cuenta sin activar (revisa email de confirmación)")
    print("  - Usaste live keys en vez de paper")
    sys.exit(1)
