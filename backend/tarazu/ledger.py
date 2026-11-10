"""Append-only event ledger and decimal-exact fine-metal arithmetic.

A correction is a new event that points at the event it corrects; nothing
is edited in place. The *effective* ledger is obtained by replaying
corrections, reweighs and assays over the source events in order.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Iterable, Optional

from .units import to_decimal

INPUT_TYPES = {"ISSUE", "ALLOY_ADD"}
OUTPUT_TYPES = {"RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "TRANSFER"}
DEDUCTION_TYPES = {"STONE_SET"}  # non-metal mass sitting inside a returned piece
OVERRIDE_TYPES = {"REWEIGH", "ASSAY", "CORRECTION"}
EVENT_TYPES = INPUT_TYPES | OUTPUT_TYPES | DEDUCTION_TYPES | OVERRIDE_TYPES

ZERO = Decimal(0)
ONE = Decimal(1)


@dataclass(frozen=True)
class Event:
    event_id: str
    job_id: str
    event_type: str
    mass_ug: int = 0
    fineness: Decimal = ZERO
    u_mass_ug: int = 0
    u_fineness: Decimal = ZERO
    party_id: str = ""
    value_original: str = ""
    unit_original: str = "g"
    assay_method: str = "declared"
    instrument_id: str = ""
    document_id: str = ""
    parent_event_id: str = ""
    timestamp: str = ""
    pieces: int = 0
    note: str = ""
    void: bool = False  # only meaningful on CORRECTION
    simulated: bool = False

    def __post_init__(self):
        if self.event_type not in EVENT_TYPES:
            raise ValueError(f"Unknown event type {self.event_type}")
        object.__setattr__(self, "fineness", to_decimal(self.fineness))
        object.__setattr__(self, "u_fineness", to_decimal(self.u_fineness))
        object.__setattr__(self, "mass_ug", int(self.mass_ug))
        object.__setattr__(self, "u_mass_ug", int(self.u_mass_ug))
        if self.mass_ug < 0:
            raise ValueError("Mass cannot be negative; record a CORRECTION instead")
        if self.u_mass_ug < 0 or self.u_fineness < 0:
            raise ValueError("Uncertainty half-widths cannot be negative")
        if not (ZERO <= self.fineness <= ONE):
            raise ValueError("Fineness must lie between 0 and 1 (e.g. 0.925)")


@dataclass(frozen=True)
class EffectiveEvent:
    """A source event after every correction that targets it has been applied."""

    event: Event
    history: tuple[str, ...] = ()
    voided: bool = False

    @property
    def id(self) -> str:
        return self.event.event_id

    @property
    def kind(self) -> str:
        t = self.event.event_type
        if t in INPUT_TYPES:
            return "in"
        if t in OUTPUT_TYPES:
            return "out"
        return "deduct"


@dataclass(frozen=True)
class Interval:
    lo: Decimal
    hi: Decimal

    def __post_init__(self):
        object.__setattr__(self, "lo", to_decimal(self.lo))
        object.__setattr__(self, "hi", to_decimal(self.hi))
        if self.lo > self.hi:
            raise ValueError(f"Empty interval [{self.lo}, {self.hi}]")

    def __add__(self, o: "Interval") -> "Interval":
        return Interval(self.lo + o.lo, self.hi + o.hi)

    def __sub__(self, o: "Interval") -> "Interval":
        return Interval(self.lo - o.hi, self.hi - o.lo)

    def shift(self, d) -> "Interval":
        d = to_decimal(d)
        return Interval(self.lo + d, self.hi + d)

    @property
    def mid(self) -> Decimal:
        return (self.lo + self.hi) / 2

    @property
    def width(self) -> Decimal:
        return self.hi - self.lo

    def contains(self, x) -> bool:
        x = to_decimal(x)
        return self.lo <= x <= self.hi


def _root(ev_by_id: dict[str, Event], eid: str) -> str:
    seen = set()
    while eid in ev_by_id and ev_by_id[eid].event_type in OVERRIDE_TYPES and ev_by_id[eid].parent_event_id:
        if eid in seen:
            raise ValueError("Correction cycle")
        seen.add(eid)
        eid = ev_by_id[eid].parent_event_id
    return eid


def effective_ledger(events: Iterable[Event]) -> list[EffectiveEvent]:
    """Replay overrides in append order. Source events keep their order."""
    events = list(events)
    by_id = {e.event_id: e for e in events}
    current: dict[str, Event] = {}
    history: dict[str, list[str]] = {}
    voided: dict[str, bool] = {}
    order: list[str] = []
    for e in events:
        if e.event_type not in OVERRIDE_TYPES:
            current[e.event_id] = e
            history[e.event_id] = []
            voided[e.event_id] = False
            order.append(e.event_id)
            continue
        target = _root(by_id, e.parent_event_id)
        if target not in current:
            raise ValueError(f"{e.event_type} {e.event_id} points at unknown event {e.parent_event_id}")
        base = current[target]
        if e.event_type == "REWEIGH":
            base = replace(base, mass_ug=e.mass_ug, u_mass_ug=e.u_mass_ug,
                           instrument_id=e.instrument_id or base.instrument_id)
        elif e.event_type == "ASSAY":
            base = replace(base, fineness=e.fineness, u_fineness=e.u_fineness,
                           assay_method=e.assay_method or base.assay_method)
        else:  # CORRECTION
            if e.void:
                voided[target] = True
            else:
                changes = {}
                if e.mass_ug:
                    changes.update(mass_ug=e.mass_ug, value_original=e.value_original,
                                   unit_original=e.unit_original)
                    if e.u_mass_ug:
                        changes["u_mass_ug"] = e.u_mass_ug
                if e.fineness:
                    changes["fineness"] = e.fineness
                    if e.u_fineness:
                        changes["u_fineness"] = e.u_fineness
                if e.pieces:
                    changes["pieces"] = e.pieces
                if changes:
                    base = replace(base, **changes)
                voided[target] = False
        current[target] = base
        history[target].append(e.event_id)
    return [EffectiveEvent(current[i], tuple(history[i]), voided[i]) for i in order]


def fine_point(e: Event) -> Decimal:
    """Fine metal in micrograms: mass x fineness."""
    return Decimal(e.mass_ug) * e.fineness


def fine_interval(e: Event) -> Interval:
    m_lo = max(Decimal(e.mass_ug - e.u_mass_ug), ZERO)
    m_hi = Decimal(e.mass_ug + e.u_mass_ug)
    f_lo = max(e.fineness - e.u_fineness, ZERO)
    f_hi = min(e.fineness + e.u_fineness, ONE)
    return Interval(m_lo * f_lo, m_hi * f_hi)


@dataclass
class Balance:
    fine_in: Decimal
    fine_out: Decimal
    fine_deduct: Decimal
    raw: Decimal  # in - out + deductions, before authorised loss
    loss_band: Interval  # authorised loss band [L_min, L_max] in fine ug
    residual: Interval  # R interval after the authorised loss band
    in_interval: Interval
    out_interval: Interval
    verdict: str  # "balanced" | "unaccounted" | "surplus"
    per_event: list[dict] = field(default_factory=list)

    @property
    def excess(self) -> Decimal:
        """Point amount beyond the authorised band (+ unaccounted, - surplus)."""
        if self.raw > self.loss_band.hi:
            return self.raw - self.loss_band.hi
        if self.raw < self.loss_band.lo:
            return self.raw - self.loss_band.lo
        return ZERO


def compute_balance(eff: list[EffectiveEvent], loss_min_pct=0, loss_max_pct=0,
                    loss_abs_ug: Optional[Interval] = None) -> Balance:
    """Interval residual R = F_in - F_out + F_deduct - L, with L in an authorised band.

    The band is a percentage of the issued fine metal (point value) unless an
    absolute band is given. Zero inside R means the gap can be noise or
    authorised loss.
    """
    fin = fout = fded = ZERO
    iin = Interval(ZERO, ZERO)
    iout = Interval(ZERO, ZERO)
    ided = Interval(ZERO, ZERO)
    per = []
    for ee in eff:
        if ee.voided:
            per.append({"event_id": ee.id, "kind": ee.kind, "fine_ug": "0", "voided": True})
            continue
        e = ee.event
        fp = fine_point(e)
        fi = fine_interval(e)
        if ee.kind == "in":
            fin += fp
            iin = iin + fi
        elif ee.kind == "out":
            fout += fp
            iout = iout + fi
        else:
            fded += fp
            ided = ided + fi
        per.append({"event_id": ee.id, "kind": ee.kind, "fine_ug": str(fp),
                    "fine_lo": str(fi.lo), "fine_hi": str(fi.hi), "voided": False})
    if loss_abs_ug is not None:
        band = loss_abs_ug
    else:
        band = Interval(fin * to_decimal(loss_min_pct) / 100, fin * to_decimal(loss_max_pct) / 100)
    raw = fin - fout + fded
    r = (iin + ided) - iout - band
    if r.contains(0):
        verdict = "balanced"
    elif r.lo > 0:
        verdict = "unaccounted"
    else:
        verdict = "surplus"
    return Balance(fin, fout, fded, raw, band, r, iin, iout, verdict, per)
