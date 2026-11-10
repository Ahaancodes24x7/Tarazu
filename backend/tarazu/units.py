"""Unit conversion at the edge. Masses are stored as integer micrograms.

1 tola  = 11.6638 g
1 masha = tola / 12
1 ratti = masha / 8
"""
from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, getcontext

getcontext().prec = 40

UG_PER_UNIT: dict[str, Decimal] = {
    "ug": Decimal(1),
    "mg": Decimal(1_000),
    "g": Decimal(1_000_000),
    "kg": Decimal(1_000_000_000),
    "tola": Decimal("11663800"),
    "masha": Decimal("11663800") / Decimal(12),
    "ratti": Decimal("11663800") / Decimal(96),
}

UNIT_LABELS = {
    "g": "gram",
    "mg": "milligram",
    "tola": "tola",
    "masha": "masha",
    "ratti": "ratti",
    "kg": "kilogram",
    "ug": "microgram",
}


def to_decimal(x) -> Decimal:
    if isinstance(x, Decimal):
        return x
    if isinstance(x, float):
        # Floats arrive only from JSON; go through repr to avoid binary noise.
        return Decimal(repr(x))
    return Decimal(str(x))


def to_ug(value, unit: str) -> int:
    """Convert a value in `unit` to integer micrograms (banker's rounding)."""
    unit = unit.lower().strip()
    if unit not in UG_PER_UNIT:
        raise ValueError(f"Unknown unit '{unit}'. Use one of {sorted(UG_PER_UNIT)}")
    v = to_decimal(value) * UG_PER_UNIT[unit]
    return int(v.quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def from_ug(ug, unit: str = "g") -> Decimal:
    return to_decimal(ug) / UG_PER_UNIT[unit]


def fmt_g(ug, places: int = 3) -> str:
    q = Decimal(1).scaleb(-places)
    return str((to_decimal(ug) / UG_PER_UNIT["g"]).quantize(q, rounding=ROUND_HALF_EVEN))
