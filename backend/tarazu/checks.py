"""Next-best verification (protocol section 4.3).

Each check has a cost (minutes plus friction) and a deterministic outcome
for every explanation. The selector picks

    c* = argmax_c  [H(h) - E_o H(h | o_c)] / cost(c)

and stops when one explanation passes the threshold, when the budget runs
out, or when the survivors cannot be separated (then it abstains).
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, Optional

from .explain import Edit, Explanation
from .ledger import EffectiveEvent

DEFAULT_COSTS = {
    # kind: (minutes, friction 0-5)
    "count_pieces": (3, 1),
    "weigh_scrap_bag": (5, 1),
    "weigh_bench": (10, 3),
    "assay": (45, 3),
    "reweigh": (4, 1),
    "photo": (2, 0),
    "dup_match": (2, 0),
    "weigh_stones": (15, 2),
}
FRICTION_MINUTES = 3.0  # one point of friction is worth three minutes

CHECK_TEXT = {
    "count_pieces": "Count finished pieces against the order sheet",
    "weigh_scrap_bag": "Weigh the scrap and sweepings bag",
    "weigh_bench": "Weigh any item still at the karigar's bench",
    "assay": "Assay the fineness of {ev}",
    "reweigh": "Reweigh {ev} on the second scale with a check weight",
    "photo": "Compare the slip photo of {ev} with the entry",
    "dup_match": "Match timestamps and photos of {ev} and the entry it repeats",
    "weigh_stones": "Weigh stones and findings in {ev}",
}

FIXED_ORDER = ["photo", "dup_match", "count_pieces", "weigh_scrap_bag", "reweigh",
               "weigh_stones", "weigh_bench", "assay"]


@dataclass(frozen=True)
class Check:
    check_id: str
    kind: str
    event_id: Optional[str]
    minutes: float
    friction: float

    @property
    def cost(self) -> float:
        return self.minutes + FRICTION_MINUTES * self.friction

    def text(self, labels: Optional[dict] = None) -> str:
        ev = (labels or {}).get(self.event_id, self.event_id or "")
        return CHECK_TEXT[self.kind].format(ev=ev)


# Outcome of a check, as a function of the set of edits that is true.
def outcome(check: Check, edits: tuple[Edit, ...]) -> str:
    k, eid = check.kind, check.event_id
    hyps = {(e.hyp, e.event_id, e.field) for e in edits}
    if k == "count_pieces":
        return "extra piece found" if any(h == "H1" for h, _, _ in hyps) else "count matches"
    if k == "weigh_scrap_bag":
        return "unlogged scrap found" if any(h == "H2" for h, _, _ in hyps) else "nothing extra"
    if k == "weigh_bench":
        return "item found at bench" if any(h == "H3" for h, _, _ in hyps) else "bench clear"
    if k == "assay":
        hit = any(e.event_id == eid and (e.hyp == "H4" or (e.hyp == "H6" and e.field == "fineness")) for e in edits)
        return "fineness differs from slip" if hit else "fineness as recorded"
    if k == "reweigh":
        hit = any(e.event_id == eid and (e.hyp == "H5" or (e.hyp == "H6" and e.field == "mass")) for e in edits)
        return "weight differs from entry" if hit else "weight matches entry"
    if k == "photo":
        if any(e.event_id == eid and e.hyp == "H6" for e in edits):
            return "slip differs from entry"
        if any(e.event_id == eid and e.hyp == "H7" for e in edits):
            return "same slip as another entry"
        return "slip matches entry"
    if k == "dup_match":
        return "same slip and time" if any(e.event_id == eid and e.hyp == "H7" for e in edits) else "distinct slips"
    if k == "weigh_stones":
        return "undeducted stones found" if any(e.event_id == eid and e.hyp == "H8" for e in edits) else "no stones"
    raise ValueError(k)


def possible_outcomes(check: Check) -> list[str]:
    probe = {
        "count_pieces": ["extra piece found", "count matches"],
        "weigh_scrap_bag": ["unlogged scrap found", "nothing extra"],
        "weigh_bench": ["item found at bench", "bench clear"],
        "assay": ["fineness differs from slip", "fineness as recorded"],
        "reweigh": ["weight differs from entry", "weight matches entry"],
        "photo": ["slip differs from entry", "same slip as another entry", "slip matches entry"],
        "dup_match": ["same slip and time", "distinct slips"],
        "weigh_stones": ["undeducted stones found", "no stones"],
    }
    return probe[check.kind]


def build_checks(explanations: list[Explanation], eff: list[EffectiveEvent],
                 costs: Optional[dict] = None) -> list[Check]:
    costs = {**DEFAULT_COSTS, **(costs or {})}
    kinds_by_type = {e.id: e.event.event_type for e in eff}
    out: dict[str, Check] = {}

    def add(kind, eid=None):
        cid = kind if eid is None else f"{kind}:{eid}"
        if cid not in out:
            m, f = costs[kind]
            out[cid] = Check(cid, kind, eid, float(m), float(f))

    for x in explanations:
        for e in x.edits:
            if e.hyp == "H1":
                add("count_pieces")
            elif e.hyp == "H2":
                add("weigh_scrap_bag")
            elif e.hyp == "H3":
                add("weigh_bench")
            elif e.hyp == "H4":
                add("assay", e.event_id)
            elif e.hyp == "H5":
                if kinds_by_type.get(e.event_id) in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD"):
                    add("reweigh", e.event_id)
                add("photo", e.event_id)
            elif e.hyp == "H6":
                add("photo", e.event_id)
                if e.field == "fineness":
                    add("assay", e.event_id)
                elif kinds_by_type.get(e.event_id) in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD"):
                    add("reweigh", e.event_id)
            elif e.hyp == "H7":
                add("dup_match", e.event_id)
                add("photo", e.event_id)
            elif e.hyp == "H8":
                add("weigh_stones", e.event_id)
    return list(out.values())


def entropy(ps) -> float:
    return -sum(p * math.log2(p) for p in ps if p > 0)


def info_gain(check: Check, survivors: list[Explanation]) -> float:
    tot = sum(x.prob for x in survivors)
    if tot <= 0:
        return 0.0
    ps = [x.prob / tot for x in survivors]
    h0 = entropy(ps)
    buckets: dict[str, list[float]] = {}
    for x, p in zip(survivors, ps):
        buckets.setdefault(outcome(check, x.edits), []).append(p)
    h1 = 0.0
    for b in buckets.values():
        pb = sum(b)
        h1 += pb * entropy([q / pb for q in b])
    return max(h0 - h1, 0.0)


def renormalise(xs: list[Explanation]) -> list[Explanation]:
    tot = sum(x.score for x in xs)
    for x in xs:
        x.prob = x.score / tot if tot > 0 else (1.0 / len(xs) if xs else 0.0)
    return xs


@dataclass
class StepAdvice:
    status: str  # "resolved" | "ask" | "abstain" | "unexplained"
    best: Optional[Explanation]
    check: Optional[Check]
    gain: float = 0.0
    ranked: list = field(default_factory=list)  # [(check, gain, gain/cost)]
    survivors: list = field(default_factory=list)


def advise(survivors: list[Explanation], checks: list[Check], asked: set[str],
           threshold: float = 0.9, budget_checks: int = 8, budget_minutes: float = 120,
           spent_minutes: float = 0.0) -> StepAdvice:
    survivors = [x for x in survivors if not x.last_resort]
    if not survivors:
        return StepAdvice("unexplained", None, None, survivors=[])
    renormalise(survivors)
    best = max(survivors, key=lambda x: x.prob)
    if best.prob >= threshold:
        # Confident, but still offer the cheapest check that would confirm it.
        conf = [c for c in checks if c.check_id not in asked
                and outcome(c, best.edits) != outcome(c, ())]
        conf.sort(key=lambda c: (c.cost, c.check_id))
        return StepAdvice("resolved", best, conf[0] if conf else None, survivors=survivors)
    if len(asked) >= budget_checks:
        return StepAdvice("abstain", best, None, survivors=survivors)
    ranked = []
    for c in checks:
        if c.check_id in asked or spent_minutes + c.minutes > budget_minutes:
            continue
        g = info_gain(c, survivors)
        if g > 1e-9:
            ranked.append((c, g, g / c.cost))
    ranked.sort(key=lambda t: (-t[2], t[0].cost, t[0].check_id))
    if not ranked:
        return StepAdvice("abstain", best, None, survivors=survivors)
    c, g, _ = ranked[0]
    return StepAdvice("ask", best, c, g, ranked, survivors)


def apply_outcome(survivors: list[Explanation], check: Check, observed: str) -> list[Explanation]:
    keep = [x for x in survivors if not x.last_resort and outcome(check, x.edits) == observed]
    return renormalise(keep)


# ------------------------------------------------------------------ simulator
def simulate(explanations: list[Explanation], checks: list[Check], truth: tuple[Edit, ...],
             policy: str = "best", threshold: float = 0.9, budget_checks: int = 8,
             rng: Optional[random.Random] = None) -> dict:
    """Replay a known fault: the 'world' answers each check from `truth`.

    policy: 'best' (information gain per cost), 'fixed' (checklist order),
    'random'. Baselines skip checks that cannot change anything, which is
    generous to them.
    """
    rng = rng or random.Random(0)
    survivors = renormalise([x for x in explanations if not x.last_resort])
    asked: set[str] = set()
    minutes = 0.0
    order = list(checks)
    if policy == "fixed":
        order.sort(key=lambda c: (FIXED_ORDER.index(c.kind), c.check_id))
    elif policy == "random":
        rng.shuffle(order)
    while True:
        if not survivors:
            return {"status": "unexplained", "checks": len(asked), "minutes": minutes, "best": None}
        best = max(survivors, key=lambda x: x.prob)
        if best.prob >= threshold:
            return {"status": "resolved", "checks": len(asked), "minutes": minutes, "best": best}
        if len(asked) >= budget_checks:
            return {"status": "abstain", "checks": len(asked), "minutes": minutes, "best": best}
        if policy == "best":
            adv = advise(survivors, checks, asked, threshold, budget_checks, 10 ** 9, minutes)
            c = adv.check
        else:
            c = next((c for c in order if c.check_id not in asked and info_gain(c, survivors) > 1e-9), None)
        if c is None:
            return {"status": "abstain", "checks": len(asked), "minutes": minutes, "best": best}
        asked.add(c.check_id)
        minutes += c.minutes
        survivors = apply_outcome(survivors, c, outcome(c, truth))
