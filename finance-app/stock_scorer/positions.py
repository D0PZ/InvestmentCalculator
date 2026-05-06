"""Registro de posiciones abiertas (JSON local).

Permite al monitor en vivo saber qué tickers vigilar y con qué SL/TP.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime

POSITIONS_PATH = "stock_scorer/positions.json"


@dataclass
class Position:
    ticker: str
    entry_price: float
    stop_loss: float
    take_profit: float
    shares: float
    entry_date: str          # ISO
    horizon_days: int = 21   # cuándo expira
    notes: str = ""

    @property
    def days_open(self) -> int:
        try:
            d0 = datetime.fromisoformat(self.entry_date)
        except ValueError:
            return 0
        return (datetime.now() - d0).days

    def pnl_pct(self, current: float) -> float:
        if self.entry_price <= 0:
            return 0.0
        return (current / self.entry_price - 1)

    def distance_to_sl(self, current: float) -> float:
        """% que falta para tocar SL. Negativo = ya cruzó."""
        if self.entry_price <= 0:
            return 0.0
        return (current / self.stop_loss - 1)

    def distance_to_tp(self, current: float) -> float:
        """% que falta para tocar TP. Negativo = ya superó."""
        if self.entry_price <= 0:
            return 0.0
        return (self.take_profit / current - 1)


def load_positions() -> list[Position]:
    if not os.path.exists(POSITIONS_PATH):
        return []
    try:
        with open(POSITIONS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return [Position(**d) for d in data]
    except Exception as exc:  # noqa: BLE001
        print(f"[positions] error leyendo {POSITIONS_PATH}: {exc}")
        return []


def save_positions(positions: list[Position]) -> None:
    os.makedirs(os.path.dirname(POSITIONS_PATH) or ".", exist_ok=True)
    with open(POSITIONS_PATH, "w", encoding="utf-8") as f:
        json.dump([asdict(p) for p in positions], f, indent=2, ensure_ascii=False)


def add_position(pos: Position) -> None:
    positions = load_positions()
    # Evita duplicados (mismo ticker + entry_date)
    positions = [p for p in positions if not (p.ticker == pos.ticker and p.entry_date == pos.entry_date)]
    positions.append(pos)
    save_positions(positions)


def remove_position(ticker: str, entry_date: str | None = None) -> int:
    """Elimina posición(es). Si entry_date es None, elimina todas las del ticker."""
    positions = load_positions()
    before = len(positions)
    if entry_date:
        positions = [p for p in positions if not (p.ticker == ticker and p.entry_date == entry_date)]
    else:
        positions = [p for p in positions if p.ticker != ticker]
    save_positions(positions)
    return before - len(positions)
