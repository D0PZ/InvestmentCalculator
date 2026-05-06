"""Entry point: py -m stock_scorer.web [opciones]"""
import argparse
import asyncio

import uvicorn

from .app import app, scoring_loop, _state
from ..config import SP100_TICKERS, QUICK_TICKERS, SP500_EXTENDED


def main():
    parser = argparse.ArgumentParser(description="Stock Scorer — Dashboard Web")
    parser.add_argument("--universe", choices=["quick", "sp100", "sp500"],
                        default="sp100",
                        help="quick=14 tickers | sp100=100 | sp500=200")
    parser.add_argument("--tickers", nargs="+", default=None,
                        help="Lista explícita de tickers (override universe)")
    parser.add_argument("--refresh", type=int, default=30,
                        help="Segundos entre actualizaciones (default 30)")
    parser.add_argument("--port", type=int, default=8080,
                        help="Puerto HTTP (default 8080)")
    parser.add_argument("--no-intraday", action="store_true",
                        help="Saltar features intradía (más rápido)")
    args = parser.parse_args()

    if args.tickers:
        tickers = [t.upper() for t in args.tickers]
    elif args.universe == "sp500":
        tickers = SP500_EXTENDED
    elif args.universe == "sp100":
        tickers = SP100_TICKERS
    else:
        tickers = QUICK_TICKERS

    _state["tickers"] = tickers

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=args.port,
        log_level="warning",
        loop="asyncio",
    )
    server = uvicorn.Server(config)

    async def run():
        asyncio.create_task(scoring_loop(args.refresh, args.no_intraday))
        await server.serve()

    print(f"")
    print(f"  🚀  http://localhost:{args.port}")
    print(f"  📊  {len(tickers)} tickers · refresh {args.refresh}s")
    print(f"  Ctrl+C para salir\n")
    asyncio.run(run())


if __name__ == "__main__":
    main()
