"""Explanation engine (protocol section 4.1).

Each hypothesis is a small, typed edit to the ledger. An edit moves the
residual interval by an *effect* (fine micrograms). Discrete edits (H6
transcription/unit, H7 duplicate) have a single effect; continuous edits
(H1-H5, H8) carry a physically bounded effect range.

A set of edits explains the residual when some choice of effects inside
their ranges brings zero into the residual interval. The solver keeps only
subset-minimal sets of at most three edits, singles by plain enumeration
and combinations with OR-Tools CP-SAT (brute force if CP-SAT is missing).
"""
from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from typing import Optional

from .ledger import ZERO, Balance, EffectiveEvent, Interval, fine_interval
from .units import UG_PER_UNIT, to_decimal, to_ug

try:  # optional, used for the combination step
    from ortools.sat.python import cp_model  # type: ignore

    HAVE_CPSAT = True
except Exception:  # pragma: no cover
    HAVE_CPSAT = False

HYPOTHESES = {
    "H1": "A finished piece came back but was not logged",
    "H2": "Scrap or sweepings were not logged",
    "H3": "Metal is still in work-in-progress",
    "H4": "A return has a different fineness than written",
    "H5": "A weight was misread or a scale drifted",
    "H6": "A unit or transcription error on a slip",
    "H7": "A slip was entered twice",
    "H8": "Stones or fixtures were not deducted",
    "H9": "Process loss exceeded the agreed wastage",
}
GLOBAL_HYPS = {"H1", "H2", "H3"}


@dataclass
class Config:
    priors: dict = field(default_factory=lambda: {h: 1.0 for h in HYPOTHESES if h != "H9"})
    scrap_max_pct: Decimal = Decimal("15")  # unlogged scrap at most 15% of issued fine
    fineness_max_shift: Decimal = Decimal("0.08")
    misread_pct: Decimal = Decimal("1.0")  # H5 bound: 1% of the mass ...
    misread_u_multiple: int = 25  # ... or 25x the scale half-width, whichever is larger
    stone_max_pct: Decimal = Decimal("30")
    max_set_size: int = 3
    max_explanations: int = 40
    use_cpsat: bool = True


@dataclass(frozen=True)
class Edit:
    key: str
    hyp: str
    event_id: Optional[str]
    lo: Decimal  # effect range on R, fine ug
    hi: Decimal
    discrete: bool
    field: str = ""  # "mass" | "fineness" | ""
    detail: tuple = ()  # sorted (name, value) pairs for display

    @property
    def info(self) -> dict:
        return dict(self.detail)


@dataclass
class Explanation:
    edits: tuple[Edit, ...]
    score: float
    effect: Decimal  # chosen point effect (closest to centring R at zero)
    prob: float = 0.0
    last_resort: bool = False

    @property
    def key(self) -> str:
        return "+".join(sorted(e.key for e in self.edits)) if self.edits else "H9"

    @property
    def hyps(self) -> list[str]:
        return [e.hyp for e in self.edits] if self.edits else ["H9"]


def _det(**kw) -> tuple:
    return tuple(sorted((k, str(v)) for k, v in kw.items()))


def _sign(ee: EffectiveEvent) -> int:
    """How a +1 change in this event's fine metal moves R."""
    return 1 if ee.kind in ("in", "deduct") else -1


# ---------------------------------------------------------------- H6 candidates
def _transpositions(s: str) -> set[str]:
    out = set()
    chars = list(s)
    for i in range(len(chars) - 1):
        if chars[i].isdigit() and chars[i + 1].isdigit() and chars[i] != chars[i + 1]:
            c = chars[:]
            c[i], c[i + 1] = c[i + 1], c[i]
            out.add("".join(c))
    return out


def transcription_candidates(value_original: str, unit: str) -> list[tuple[str, str, int, str]]:
    """Alternative readings of a slip value: (value, unit, mass_ug, reason)."""
    v = (value_original or "").strip()
    unit = (unit or "g").lower()
    if not v:
        return []
    try:
        dv = Decimal(v)
    except Exception:
        return []
    cands: dict[tuple[str, str], str] = {}
    for t in _transpositions(v):
        cands[(t, unit)] = f"digits swapped: {v} → {t}"
    for factor, why in ((Decimal(10), "decimal point shifted"), (Decimal("0.1"), "decimal point shifted")):
        nv = (dv * factor).normalize()
        cands.setdefault((format(nv, "f"), unit), f"{why}: {v} → {format(nv, 'f')}")
    for u2 in ("g", "masha", "tola", "ratti"):
        if u2 != unit:
            cands.setdefault((v, u2), f"unit: {v} {unit} is really {v} {u2}")
    if unit == "g" and dv > 0 and (dv % 10 == 0):
        tv = format((dv / 10).normalize(), "f")
        cands.setdefault((tv, "tola"), f"unit: {v} g was written as {tv} tola (1 tola = 11.6638 g, not 10 g)")
    out = []
    for (nv, nu), why in cands.items():
        try:
            ug = to_ug(nv, nu)
        except Exception:
            continue
        if ug > 0:
            out.append((nv, nu, ug, why))
    return out


def fineness_candidates(phi: Decimal) -> list[tuple[Decimal, str]]:
    s = format(phi.normalize(), "f")
    out = []
    for t in _transpositions(s):
        d = Decimal(t)
        if Decimal("0.5") <= d <= 1 and d != phi:
            out.append((d, f"fineness digits swapped: {s} → {t}"))
    return out


# ------------------------------------------------------------ candidate edits
def candidate_edits(eff: list[EffectiveEvent], bal: Balance, cfg: Config,
                    pieces_expected: int = 0) -> list[Edit]:
    live = [ee for ee in eff if not ee.voided]
    fin = bal.fine_in
    raw_hi =bal.in_interval.hi - bal.out_interval.lo + max(bal.fine_deduct, ZERO)
    room = max(raw_hi, ZERO)  # physical cap: outputs can't exceed inputs
    edits: list[Edit] = []

    # H1 unlogged finished piece
    finished = [ee for ee in live if ee.event.event_type == "RETURN_FINISHED"]
    returned_pieces = sum(max(ee.event.pieces, 1 if ee.event.mass_ug else 0) for ee in finished)
    h1_allowed = not (pieces_expected and returned_pieces >= pieces_expected)
    if h1_allowed and room > 0:
        pieces_fine = sum((Decimal(ee.event.mass_ug) * ee.event.fineness for ee in finished), ZERO)
        n = sum(max(ee.event.pieces, 1) for ee in finished)
        if n >= 3 and pieces_fine > 0:
            # enough returned pieces to know what a typical piece weighs
            avg = pieces_fine / n
            k = max(pieces_expected - returned_pieces, 1) if pieces_expected else 1
            lo_f, hi_f = avg * Decimal("0.5"), min(avg * Decimal("1.5") * k, room)
        else:
            lo_f, hi_f = ZERO, room
        if hi_f > lo_f:
            edits.append(Edit("H1", "H1", None, -hi_f, -lo_f, False,
                              detail=_det(piece_fine_lo=lo_f, piece_fine_hi=hi_f)))
    # H2 unlogged scrap
    smax = min(fin * cfg.scrap_max_pct / 100, room)
    if smax > 0:
        edits.append(Edit("H2", "H2", None, -smax, ZERO, False, detail=_det(scrap_fine_max=smax)))
    # H3 work in progress
    if room > 0:
        edits.append(Edit("H3", "H3", None, -room, ZERO, False, detail=_det(wip_fine_max=room)))

    by_type_mass: dict[tuple, list[EffectiveEvent]] = {}
    for ee in live:
        e = ee.event
        s = _sign(ee)
        m = Decimal(e.mass_ug)
        phi = e.fineness
        if m <= 0:
            continue
        # H4 fineness differs (precious events only, not stone deductions)
        if ee.kind != "deduct" and phi >= Decimal("0.5"):
            d_lo = max(-cfg.fineness_max_shift, Decimal("0.5") - phi)
            d_hi = min(cfg.fineness_max_shift, Decimal(1) - phi)
            if d_hi > d_lo:
                a, b = s * m * d_lo, s * m * d_hi
                edits.append(Edit(f"H4:{e.event_id}", "H4", e.event_id, min(a, b), max(a, b), False,
                                  "fineness", _det(fineness=phi)))
        # H5 misread / drift
        bound = max(m * cfg.misread_pct / 100, Decimal(e.u_mass_ug * cfg.misread_u_multiple))
        bound = min(bound, m)
        if bound > 0 and phi > 0:
            eff_b = bound * phi
            edits.append(Edit(f"H5:{e.event_id}", "H5", e.event_id, -eff_b, eff_b, False, "mass",
                              _det(max_shift_ug=bound)))
        # H6 transcription / unit on mass
        for nv, nu, ug, why in transcription_candidates(e.value_original, e.unit_original):
            if ug == e.mass_ug:
                continue
            d = s * (Decimal(ug) - m) * phi
            if d != 0:
                edits.append(Edit(f"H6:{e.event_id}:m:{nv}{nu}", "H6", e.event_id, d, d, True, "mass",
                                  _det(new_value=nv, new_unit=nu, new_mass_ug=ug, reason=why)))
        # H6 transcription on fineness
        if ee.kind != "deduct":
            for nphi, why in fineness_candidates(phi):
                d = s * m * (nphi - phi)
                edits.append(Edit(f"H6:{e.event_id}:f:{nphi}", "H6", e.event_id, d, d, True, "fineness",
                                  _det(new_fineness=nphi, reason=why)))
        # H8 stones not deducted (finished returns only)
        if e.event_type == "RETURN_FINISHED" and phi > 0:
            smax_e = m * cfg.stone_max_pct / 100 * phi
            edits.append(Edit(f"H8:{e.event_id}", "H8", e.event_id, ZERO, smax_e, False, "mass",
                              _det(stone_fine_max=smax_e)))
        by_type_mass.setdefault((e.event_type, phi), []).append(ee)

    # H7 duplicate entries: a later event matching an earlier one of the same type
    for (etype, _phi), group in by_type_mass.items():
        if etype not in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "ISSUE", "TRANSFER"):
            continue
        for i, later in enumerate(group):
            for earlier in group[:i]:
                a, b = later.event, earlier.event
                if abs(a.mass_ug - b.mass_ug) > a.u_mass_ug + b.u_mass_ug:
                    continue
                if a.document_id and b.document_id and a.document_id != b.document_id:
                    continue  # two distinct slip photos: genuine, never a duplicate
                fi = fine_interval(a)
                d = -_sign(later) * fi.mid
                evidence = "same slip photo" if a.document_id and a.document_id == b.document_id else "no photos to tell them apart"
                edits.append(Edit(f"H7:{a.event_id}", "H7", a.event_id, d, d, True, "",
                                  _det(duplicate_of=b.event_id, evidence=evidence)))
                break
    return edits


# ------------------------------------------------------------------ feasibility
def _sum_range(es) -> tuple[Decimal, Decimal]:
    return sum((e.lo for e in es), ZERO), sum((e.hi for e in es), ZERO)


def feasible(es, target: Interval) -> bool:
    lo, hi = _sum_range(es)
    return lo <= target.hi and hi >= target.lo


def _conflict(es) -> bool:
    seen = set()
    for e in es:
        k = e.event_id or e.hyp
        if k in seen:
            return True
        seen.add(k)
    return False


def _fit(es, target: Interval) -> float:
    lo, hi = _sum_range(es)
    w = hi - lo
    if w == 0:
        return 1.0
    ov = min(hi, target.hi) - max(lo, target.lo)
    if ov < 0:
        return 0.0
    # uniform prior on the effect over its range: chance it lands in the window
    return float(max(ov, Decimal("1e-9")) / w)


def _point_effect(es, target: Interval) -> Decimal:
    lo, hi = _sum_range(es)
    want = target.mid
    return min(max(want, lo), hi)


def _exact_ints(values) -> tuple[list[int], int]:
    """Scale Decimals to exact integers with one common power of ten (no rounding)."""
    exp = min((v.as_tuple().exponent for v in values if v.is_finite()), default=0)
    d = max(0, -int(exp))
    return [int(v.scaleb(d)) for v in values], d


def minimal_sets_bruteforce(cands: list[Edit], target: Interval, max_size: int = 3,
                            limit_n_for_triples: Optional[int] = None) -> list[tuple[Edit, ...]]:
    """Every subset-minimal, conflict-free set of up to three edits whose effect range meets the target.

    Exhaustive and exact. Effect bounds are scaled to integers once, so the inner
    loops add machine integers instead of Decimals; a pair that already fits is
    never extended, which is what makes every returned set minimal.
    """
    singles = [(e,) for e in cands if e.lo <= target.hi and e.hi >= target.lo]
    single_keys = {s[0].key for s in singles}
    rest = [e for e in cands if e.key not in single_keys]
    out: list[tuple[Edit, ...]] = list(singles)
    n = len(rest)
    if max_size < 2 or n < 2:
        return out
    ints, _ = _exact_ints([target.lo, target.hi] + [e.lo for e in rest] + [e.hi for e in rest])
    t_lo, t_hi = ints[0], ints[1]
    lo, hi = ints[2:2 + n], ints[2 + n:]
    ident = [e.event_id or e.hyp for e in rest]
    fits = [[False] * n for _ in range(n)]
    for i in range(n):
        li, hi_i, di, row = lo[i], hi[i], ident[i], fits[i]
        for j in range(i + 1, n):
            if ident[j] != di and li + lo[j] <= t_hi and hi_i + hi[j] >= t_lo:
                row[j] = True
                out.append((rest[i], rest[j]))
    if max_size >= 3 and (limit_n_for_triples is None or n <= limit_n_for_triples):
        for i in range(n - 2):
            di, fi = ident[i], fits[i]
            for j in range(i + 1, n - 1):
                if ident[j] == di or fi[j]:
                    continue
                a, b, dj, fj = lo[i] + lo[j], hi[i] + hi[j], ident[j], fits[j]
                need_hi, need_lo = t_hi - a, t_lo - b
                for k in range(j + 1, n):
                    if (lo[k] <= need_hi and hi[k] >= need_lo and not fi[k] and not fj[k]
                            and ident[k] != di and ident[k] != dj):
                        out.append((rest[i], rest[j], rest[k]))
    return out


ENUM_BUDGET = 12_000_000  # combinations the exhaustive search visits (about 0.5 s) before CP-SAT takes over


def _search_size(cands: list[Edit], target: Interval, max_size: int) -> int:
    n = sum(1 for e in cands if not (e.lo <= target.hi and e.hi >= target.lo))
    return math.comb(n, 2) + (math.comb(n, 3) if max_size >= 3 else 0)


def minimal_sets_cpsat(cands: list[Edit], target: Interval, cfg: Config,
                       limit: int = 40, time_limit_s: float = 0.7) -> list[tuple[Edit, ...]]:
    """Singles by enumeration; pairs and triples by CP-SAT with no-good cuts.

    Minimising the set size first, then cutting every found set (which also
    forbids its supersets), returns subset-minimal explanations only.
    """
    singles = [(e,) for e in cands if feasible((e,), target)]
    single_keys = {s[0].key for s in singles}
    rest = [e for e in cands if e.key not in single_keys]
    out = list(singles)
    if cfg.max_set_size < 2 or len(rest) < 2:
        return out

    def floor_(x: Decimal) -> int:
        return int(x.to_integral_value(rounding=ROUND_FLOOR))

    def ceil_(x: Decimal) -> int:
        return int(x.to_integral_value(rounding=ROUND_CEILING))

    model = cp_model.CpModel()
    x = [model.NewBoolVar(f"x{i}") for i in range(len(rest))]
    ef = []
    for i, e in enumerate(rest):
        lo, hi = floor_(e.lo), ceil_(e.hi)
        v = model.NewIntVar(min(lo, 0), max(hi, 0), f"e{i}")
        model.Add(v >= lo * x[i])
        model.Add(v <= hi * x[i])
        ef.append(v)
    t_lo, t_hi = floor_(target.lo), ceil_(target.hi)
    model.Add(sum(ef) >= t_lo)
    model.Add(sum(ef) <= t_hi)
    groups: dict[str, list[int]] = {}
    for i, e in enumerate(rest):
        groups.setdefault(e.event_id or e.hyp, []).append(i)
    for idx in groups.values():
        if len(idx) > 1:
            model.Add(sum(x[i] for i in idx) <= 1)
    size = sum(x)
    model.Add(size >= 2)
    model.Add(size <= cfg.max_set_size)
    # Within a size, prefer edits with higher prior mass.
    n_slots: dict[str, int] = {}
    for e in cands:
        n_slots[e.hyp] = n_slots.get(e.hyp, 0) + 1
    w = []
    for e in rest:
        p = max(cfg.priors.get(e.hyp, 1.0), 1e-9) / n_slots[e.hyp]
        w.append(int(round(-math.log(p) * 100)))
    model.Minimize(100000 * size + sum(wi * xi for wi, xi in zip(w, x)))
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 4
    budget = time_limit_s
    found = 0
    while found < limit and budget > 0.02:
        solver.parameters.max_time_in_seconds = budget
        st = solver.Solve(model)
        budget -= solver.WallTime()
        if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        chosen = [i for i in range(len(rest)) if solver.Value(x[i])]
        tup = tuple(rest[i] for i in chosen)
        # verify exactly with Decimals (integer rounding is outward)
        if feasible(tup, target):
            out.append(tup)
            found += 1
        model.Add(sum(x[i] for i in chosen) <= len(chosen) - 1)
    return out


# ------------------------------------------------------------------- explain
@dataclass
class ExplainResult:
    status: str  # "balanced" | "explained" | "unresolved"
    target: Interval
    explanations: list[Explanation]
    n_candidates: int
    n_found: int
    solver: str


def explain(eff: list[EffectiveEvent], bal: Balance, cfg: Optional[Config] = None,
            pieces_expected: int = 0) -> ExplainResult:
    cfg = cfg or Config()
    target = Interval(-bal.residual.hi, -bal.residual.lo)  # effect needed so 0 ∈ R'
    if bal.verdict == "balanced":
        return ExplainResult("balanced", target, [], 0, 0, "none")
    cands = candidate_edits(eff, bal, cfg, pieces_expected)
    # Exhaustive enumeration is exact and complete, and faster than CP-SAT until the search
    # space is very large; it is also the only option where OR-Tools is absent (the app).
    if cfg.use_cpsat and HAVE_CPSAT and _search_size(cands, target, cfg.max_set_size) > ENUM_BUDGET:
        sets = minimal_sets_cpsat(cands, target, cfg)
        solver = "enumeration + CP-SAT"
    else:
        sets = minimal_sets_bruteforce(cands, target, cfg.max_set_size)
        solver = "exhaustive enumeration"
    n_slots: dict[str, int] = {}
    for e in cands:
        n_slots[e.hyp] = n_slots.get(e.hyp, 0) + 1
    weight = {h: max(cfg.priors.get(h, 1.0), 0.0) / k for h, k in n_slots.items()}
    n_found = len(sets)
    # Score every set, but build and sort only the ones that will be shown.
    def score(s_):
        sc = _fit(s_, target)
        for e in s_:
            sc *= weight[e.hyp]
        return sc
    ranked = heapq.nsmallest(cfg.max_explanations, ((-score(s_), len(s_), "+".join(sorted(e.key for e in s_)), s_)
                                                    for s_ in sets))
    exps = [Explanation(tuple(sorted(s_, key=lambda e: e.key)), -neg, _point_effect(s_, target))
            for neg, _n, _k, s_ in ranked]
    total = sum(x.score for x in exps)
    for x in exps:
        x.prob = (x.score / total) if total > 0 else 0.0
    status = "explained" if exps else "unresolved"
    if bal.verdict == "unaccounted":
        # H9 is offered only as a last resort, never as a scored explanation.
        exps.append(Explanation((), 0.0, ZERO, 0.0, last_resort=True))
    return ExplainResult(status, target, exps, len(cands), n_found, solver)


def apply_edit_preview(edit: Edit, effect: Decimal, eff: list[EffectiveEvent]) -> dict:
    """Describe the concrete ledger edit an explanation implies (for display and 'apply')."""
    info = edit.info
    ev = next((ee.event for ee in eff if ee.id == edit.event_id), None)
    out = {"hyp": edit.hyp, "event_id": edit.event_id, "effect_fine_ug": str(effect)}
    if edit.hyp in GLOBAL_HYPS:
        out["add_fine_ug"] = str(-effect)
    elif edit.hyp == "H4" and ev is not None and ev.mass_ug:
        s = -1 if ev.event_type in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "TRANSFER") else 1
        out["new_fineness"] = str((ev.fineness + effect / (s * Decimal(ev.mass_ug))).quantize(Decimal("0.0001")))
    elif edit.hyp == "H5" and ev is not None and ev.fineness:
        s = -1 if ev.event_type in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "TRANSFER") else 1
        out["new_mass_ug"] = int(ev.mass_ug + effect / (s * ev.fineness))
    elif edit.hyp == "H8" and ev is not None and ev.fineness:
        out["stone_mass_ug"] = int(effect / ev.fineness)
    out.update(info)
    return out
