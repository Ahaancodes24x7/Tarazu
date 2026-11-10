"""The Tarazu pipeline: ledger -> interval balance -> explanations -> next check -> words."""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Optional

from .checks import (DEFAULT_COSTS, Check, advise, apply_outcome, build_checks, possible_outcomes,
                     renormalise)
from .explain import Config, Explanation, apply_edit_preview, explain
from .ledger import Event, compute_balance, effective_ledger
from .units import fmt_g
from .wording import TYPE_LABEL, check_text, hyp_text, narrate

G = Decimal(1_000_000)


def g(ug) -> str:
    return fmt_g(ug, 4)


def event_labels(events: list[Event], lang: str = "en") -> dict[str, str]:
    counts: dict[str, int] = {}
    labels = {}
    names = TYPE_LABEL.get(lang, TYPE_LABEL["en"])
    for e in events:
        counts[e.event_type] = counts.get(e.event_type, 0) + 1
        labels[e.event_id] = f"{names[e.event_type]} {counts[e.event_type]}"
    return labels


def split_effect(x: Explanation) -> list[Decimal]:
    """Share an explanation's total effect across its edits, inside each edit's range."""
    fixed = sum((e.lo for e in x.edits if e.discrete), Decimal(0))
    cont = [e for e in x.edits if not e.discrete]
    need = x.effect - fixed - sum((e.lo for e in cont), Decimal(0))
    shares = {}
    for e in cont:
        add = min(max(need, Decimal(0)), e.hi - e.lo)
        shares[e.key] = e.lo + add
        need -= add
    return [e.lo if e.discrete else shares[e.key] for e in x.edits]


def _detail(x: Explanation, eff, labels) -> list[dict]:
    out = []
    for ed, eff_amt in zip(x.edits, split_effect(x)):
        prev = apply_edit_preview(ed, eff_amt, eff)
        h = ed.hyp
        ev = labels.get(ed.event_id, "")
        if h == "H1":
            s = f"An unlogged finished piece holding about {g(Decimal(prev['add_fine_ug']))} g fine"
        elif h == "H2":
            s = f"Unlogged scrap or sweepings holding about {g(Decimal(prev['add_fine_ug']))} g fine"
        elif h == "H3":
            s = f"About {g(Decimal(prev['add_fine_ug']))} g fine still at the bench"
        elif h == "H4":
            s = f"{ev}: fineness {prev.get('fineness')} on the slip, about {prev.get('new_fineness')} in fact"
        elif h == "H5":
            nm = prev.get("new_mass_ug")
            s = f"{ev}: weight is closer to {g(nm)} g than the entry" if nm is not None else f"{ev}: weight shifted"
        elif h == "H6":
            s = f"{ev}: {prev.get('reason')}"
        elif h == "H7":
            s = f"{ev} repeats {labels.get(prev.get('duplicate_of'), prev.get('duplicate_of'))} ({prev.get('evidence')})"
        elif h == "H8":
            s = f"{ev}: about {g(prev.get('stone_mass_ug', 0))} g of stones or findings not deducted"
        else:
            s = ""
        out.append({"hyp": h, "event_id": ed.event_id, "event_label": ev, "text": s, "discrete": ed.discrete,
                    "effect_lo_g": g(ed.lo), "effect_hi_g": g(ed.hi), "preview": {k: str(v) for k, v in prev.items()}})
    return out


def parse_check(check_id: str, costs: Optional[dict] = None) -> Check:
    costs = {**DEFAULT_COSTS, **(costs or {})}
    kind, _, eid = check_id.partition(":")
    m, f = costs[kind]
    return Check(check_id, kind, eid or None, float(m), float(f))


def analyse(events: list[Event], job: dict, check_log: Optional[list[dict]] = None, lang: str = "en",
            cfg: Optional[Config] = None, costs: Optional[dict] = None, threshold: float = 0.9,
            budget_checks: int = 8, budget_minutes: float = 120) -> dict:
    t0 = time.perf_counter()
    eff = effective_ledger(events)
    bal = compute_balance(eff, job.get("wastage_min_pct", 0), job.get("wastage_max_pct", 0))
    res = explain(eff, bal, cfg, int(job.get("pieces_expected") or 0))
    labels = event_labels(events, lang)
    labels_en = event_labels(events, "en") if lang != "en" else labels
    scored = [x for x in res.explanations if not x.last_resort]
    checks = build_checks(scored, eff, costs)
    by_id = {c.check_id: c for c in checks}

    survivors = renormalise(list(scored))
    log_out = []
    asked = set()
    spent = 0.0
    for entry in (check_log or []):
        c = by_id.get(entry["check_id"]) or parse_check(entry["check_id"], costs)
        before = len(survivors)
        survivors = apply_outcome(survivors, c, entry["outcome"])
        asked.add(c.check_id)
        spent += c.minutes
        log_out.append({"check_id": c.check_id, "text": check_text(c.kind, labels.get(c.event_id, ""), lang),
                        "outcome": entry["outcome"], "eliminated": before - len(survivors),
                        "remaining": len(survivors), "at": entry.get("at")})

    inv = {"status": "none", "log": log_out, "spent_minutes": spent, "threshold": threshold}
    if bal.verdict != "balanced":
        if not scored:
            inv["status"] = "unexplained"
        else:
            adv = advise(survivors, checks, asked, threshold, budget_checks, budget_minutes, spent)
            inv["status"] = adv.status
            inv["best"] = adv.best.key if adv.best else None
            if adv.check:
                c = adv.check
                inv["next_check"] = {
                    "check_id": c.check_id, "kind": c.kind, "event_id": c.event_id,
                    "text": check_text(c.kind, labels.get(c.event_id, ""), lang),
                    "minutes": c.minutes, "friction": c.friction, "cost": c.cost,
                    "gain_bits": round(adv.gain, 4), "outcomes": possible_outcomes(c),
                    "confirm": adv.status == "resolved"}
                inv["ranked"] = [{"check_id": rc.check_id,
                                  "text": check_text(rc.kind, labels.get(rc.event_id, ""), lang),
                                  "minutes": rc.minutes, "cost": rc.cost, "gain_bits": round(gb, 4),
                                  "gain_per_cost": round(gpc, 5)} for rc, gb, gpc in adv.ranked[:6]]
    surv_keys = {x.key for x in survivors}
    exps_out = []
    for x in res.explanations:
        exps_out.append({
            "key": x.key, "hyps": x.hyps, "titles": [hyp_text(h, lang) for h in x.hyps],
            "prior_prob": round(x.prob, 6) if not x.last_resort else 0,
            "prob": round(next((s.prob for s in survivors if s.key == x.key), 0.0), 6),
            "alive": x.key in surv_keys or x.last_resort,
            "size": len(x.edits), "last_resort": x.last_resort,
            "edits": _detail(x, eff, labels_en) if not x.last_resort else [],
        })
    exps_out.sort(key=lambda d: (d["last_resort"], not d["alive"], -d["prob"], -d["prior_prob"]))

    best = next((d for d in exps_out if d["key"] == inv.get("best")), None)
    top = None
    if best:
        top = (" + ".join(best["titles"]), round(best["prob"] * 100))
    alive_titles = [" + ".join(d["titles"]) for d in exps_out if d["alive"] and not d["last_resort"]]
    narration = narrate(bal.verdict, bal.excess, bal.residual.lo, bal.residual.hi, job.get("metal", "silver"),
                        lang, len(scored), top, inv.get("next_check", {}).get("text"), inv["status"],
                        alive_titles[:4])

    events_out = []
    eff_by = {ee.id: ee for ee in eff}
    per_by = {p["event_id"]: p for p in bal.per_event}
    for e in events:
        ee = eff_by.get(e.event_id)
        d = {"event_id": e.event_id, "label": labels.get(e.event_id, e.event_type), "event_type": e.event_type,
             "mass_g": g(e.mass_ug), "u_mass_g": g(e.u_mass_ug), "fineness": str(e.fineness),
             "u_fineness": str(e.u_fineness), "value_original": e.value_original, "unit": e.unit_original,
             "parent_event_id": e.parent_event_id,
             "parent_label": labels.get(e.parent_event_id, "") if e.parent_event_id else "",
             "document_id": e.document_id, "timestamp": e.timestamp, "pieces": e.pieces, "note": e.note,
             "void": e.void, "simulated": e.simulated, "instrument_id": e.instrument_id,
             "assay_method": e.assay_method}
        if ee is not None:
            d["effective"] = {"mass_g": g(ee.event.mass_ug), "fineness": str(ee.event.fineness),
                              "voided": ee.voided, "history": list(ee.history),
                              "fine_g": g(Decimal(per_by[e.event_id]["fine_ug"]))}
        events_out.append(d)

    return {
        "balance": {
            "verdict": bal.verdict, "fine_in_g": g(bal.fine_in), "fine_out_g": g(bal.fine_out),
            "fine_deduct_g": g(bal.fine_deduct), "raw_g": g(bal.raw),
            "band_lo_g": g(bal.loss_band.lo), "band_hi_g": g(bal.loss_band.hi),
            "residual_lo_g": g(bal.residual.lo), "residual_hi_g": g(bal.residual.hi),
            "excess_g": g(bal.excess), "in_lo_g": g(bal.in_interval.lo), "in_hi_g": g(bal.in_interval.hi),
            "out_lo_g": g(bal.out_interval.lo), "out_hi_g": g(bal.out_interval.hi),
        },
        "events": events_out,
        "explain": {"status": res.status, "solver": res.solver, "n_candidates": res.n_candidates,
                    "n_found": res.n_found, "target_lo_g": g(res.target.lo), "target_hi_g": g(res.target.hi)},
        "explanations": exps_out,
        "investigation": inv,
        "narration": narration,
        "lang": lang,
        "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
