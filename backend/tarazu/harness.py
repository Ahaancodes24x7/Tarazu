"""Evaluation harness on a SIMULATED workshop (protocol sections 5-7).

Every record produced here is simulated, carries `simulated=True` and the
generator version, and every result table is labelled SIMULATED. The real
benchmark is the physical trial; this harness exists so every code change is
scored on the same frozen, seeded runs before any real run (build step 6).
"""
from __future__ import annotations

import math
import random
import statistics
import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

from .analysis import analyse
from .checks import build_checks, simulate
from .explain import Config, Edit, explain
from .ledger import Event, compute_balance, effective_ledger
from .units import UG_PER_UNIT, to_ug

GEN_VERSION = "sim-v1"
SIGMA_UG = 600  # scale repeatability (1 s.d.), from a typical Phase 0 study
U_MASS_UG = 2000  # interval half-width used by Tarazu (about 3.3 sigma)
PHI = Decimal("0.925")
SOLDER_PHI = Decimal("0.650")
BAND_MAX_PCT = Decimal("0.05")  # agreed wastage band: 0 to 0.05% of fine issued
MULTIPLES = [0.5, 1, 2, 5, 10]
FAULTS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"]
TRUTH_HYP = {"F1": "H1", "F2": "H2", "F3": "H3", "F4": "H4", "F5": "H5", "F6": "H8",
             "F7": "H6", "F8": "H7", "F9": "H6"}
FAST = Config(max_set_size=2, use_cpsat=False)


@dataclass
class Piece:
    kind: str  # ISSUE, ALLOY_ADD, RETURN_FINISHED, RETURN_SCRAP
    mass_ug: int  # physical truth
    phi: Decimal
    recorded_ug: Optional[int] = None
    value: str = ""
    unit: str = "g"
    doc: str = ""
    pieces: int = 0
    logged: bool = True


@dataclass
class Run:
    run_id: str
    events: list[Event]
    job: dict
    true_unrecovered_fine: Optional[Decimal]
    fault: Optional[str] = None
    truth: list[tuple] = field(default_factory=list)  # [(hyp, event_id|None, field)]
    magnitude: Optional[float] = None
    task: str = ""


def _read(rng: random.Random, true_ug: int, offset_ug: int = 0) -> int:
    return int(round(true_ug + rng.gauss(0, SIGMA_UG) + offset_ug))


def _gval(ug: int) -> str:
    return format((Decimal(ug) / UG_PER_UNIT["g"]).quantize(Decimal("0.001")), "f")


def gen_physical(rng: random.Random, idx: int, tola_issue: bool = False) -> tuple[list[Piece], dict, Decimal, str]:
    task = rng.choice(["cut_file", "solder", "polish"])
    if tola_issue:
        t = rng.randint(4, 10)
        issue = Piece("ISSUE", to_ug(t, "tola"), PHI, value=str(t), unit="tola")
    else:
        issue = Piece("ISSUE", rng.randint(40_000_000, 120_000_000), PHI)
    parts = [issue]
    total = issue.mass_ug
    fine_total = Decimal(issue.mass_ug) * PHI
    if task == "solder":
        s = Piece("ALLOY_ADD", rng.randint(200_000, 800_000), SOLDER_PHI)
        parts.append(s)
        total += s.mass_ug
        fine_total += Decimal(s.mass_ug) * SOLDER_PHI
    mix_phi = (fine_total / total).quantize(Decimal("0.0001"))
    loss = {"cut_file": (0.004, 0.012), "solder": (0.002, 0.008), "polish": (0.001, 0.006)}[task]
    lf = rng.uniform(*loss)
    rec = rng.uniform(0.97, 0.995)
    lost_ug = int(total * lf)
    scrap_ug = int(lost_ug * rec)
    unrec_ug = lost_ug - scrap_ug
    finished_ug = total - lost_ug
    n = rng.randint(1, 4)
    cuts = sorted(rng.uniform(0.15, 0.85) for _ in range(n - 1))
    bounds = [0.0] + cuts + [1.0]
    for i in range(n):
        m = int(finished_ug * (bounds[i + 1] - bounds[i])) if i < n - 1 else 0
        parts.append(Piece("RETURN_FINISHED", m, mix_phi, pieces=1))
    used = sum(p.mass_ug for p in parts if p.kind == "RETURN_FINISHED")
    parts[-1].mass_ug = finished_ug - used
    parts.append(Piece("RETURN_SCRAP", scrap_ug, mix_phi))
    job = {"metal": "silver", "wastage_min_pct": "0", "wastage_max_pct": str(BAND_MAX_PCT),
           "pieces_expected": n, "simulated": True, "task": task}
    return parts, job, Decimal(unrec_ug) * mix_phi, task


def to_events(rng: random.Random, run_id: str, parts: list[Piece]) -> list[Event]:
    evs = []
    k = 0
    for p in parts:
        if not p.logged:
            continue
        k += 1
        rec = p.recorded_ug if p.recorded_ug is not None else _read(rng, p.mass_ug)
        if p.unit == "g" and not p.value:
            p.value = _gval(rec)
        ug = to_ug(p.value, p.unit)
        evs.append(Event(
            event_id=f"{run_id}-e{k}", job_id=run_id, event_type=p.kind, mass_ug=ug, fineness=p.phi,
            u_mass_ug=U_MASS_UG, u_fineness=Decimal("0.0005") if p.kind != "ISSUE" else Decimal(0),
            value_original=p.value, unit_original=p.unit, assay_method="by construction",
            instrument_id="sim-scale-A", document_id=p.doc or f"{run_id}-slip{k}",
            timestamp=f"2026-11-{10 + k:02d}T10:00:00", pieces=p.pieces, simulated=True,
            note=f"SIMULATED {GEN_VERSION}"))
    return evs


def clean_run(seed: int, idx: int, prefix: str = "clean") -> Run:
    rng = random.Random(seed * 100003 + idx)
    parts, job, unrec, task = gen_physical(rng, idx)
    rid = f"{prefix}-{GEN_VERSION}-{seed}-{idx}"
    return Run(rid, to_events(rng, rid, parts), job, unrec, task=task)


def noise_halfwidth(run: Run) -> Decimal:
    eff = effective_ledger(run.events)
    b = compute_balance(eff, run.job["wastage_min_pct"], run.job["wastage_max_pct"])
    return b.residual.width / 2


def fault_run(seed: int, idx: int, fault: str, multiple: Optional[float] = None) -> Run:
    """Build the physical truth, apply one fault blind, return only visible records + key."""
    rng = random.Random(seed * 7919 + idx * 31 + FAULTS.index(fault))
    parts, job, unrec, task = gen_physical(rng, idx, tola_issue=(fault == "F9" and rng.random() < 0.5))
    rid = f"{fault}-{GEN_VERSION}-{seed}-{idx}" + (f"-x{multiple}" if multiple else "")
    # size unit for the magnitude sweep: the clean run's residual half-width
    probe = Run(rid, to_events(random.Random(1), rid, [Piece(**vars(p)) for p in parts]), job, unrec)
    U = int(noise_halfwidth(probe) / PHI)  # in mass units
    size = int(U * multiple) if multiple else None
    finished = [p for p in parts if p.kind == "RETURN_FINISHED"]
    scrap = next(p for p in parts if p.kind == "RETURN_SCRAP")
    truth_kind = TRUTH_HYP[fault]
    target_part = None
    extra: list[Piece] = []

    if fault == "F1":
        if size:
            donor = max(finished, key=lambda p: p.mass_ug)
            donor.mass_ug -= size
            hidden = Piece("RETURN_FINISHED", size, donor.phi, pieces=1, logged=False)
            parts.insert(parts.index(donor) + 1, hidden)
            job["pieces_expected"] += 1
        else:
            if len(finished) == 1:  # split so a piece can be hidden
                f0 = finished[0]
                half = f0.mass_ug // 3
                f0.mass_ug -= half
                parts.insert(parts.index(f0) + 1, Piece("RETURN_FINISHED", half, f0.phi, pieces=1))
                job["pieces_expected"] += 1
                finished = [p for p in parts if p.kind == "RETURN_FINISHED"]
            rng.choice(finished).logged = False
    elif fault == "F2":
        if size:
            # an extra bag of filings of the chosen size, never logged
            donor = max(finished, key=lambda p: p.mass_ug)
            donor.mass_ug -= size
            parts.append(Piece("RETURN_SCRAP", size, scrap.phi, logged=False))
        else:
            scrap.logged = False
    elif fault == "F3":
        m = size or rng.randint(500_000, 4_000_000)
        donor = max(finished, key=lambda p: p.mass_ug)
        donor.mass_ug -= m  # metal stays at the bench, never logged
    elif fault == "F4":
        target_part = rng.choice(finished)
        cu = rng.randint(200_000, 1_000_000)  # copper added without telling the analyst
        fine = Decimal(target_part.mass_ug) * target_part.phi
        target_part.mass_ug += cu
        target_part.recorded_ug = _read(rng, target_part.mass_ug)
        # slip still says the mix fineness; the true fineness is lower
        _ = fine
    elif fault == "F5":
        target_part = rng.choice(finished + [scrap])
        off = size or rng.randint(50_000, 300_000)
        target_part.recorded_ug = _read(rng, target_part.mass_ug, off * rng.choice([-1, 1]) if not size else off)
    elif fault == "F6":
        target_part = rng.choice(finished)
        stone = rng.randint(50_000, 500_000)
        target_part.recorded_ug = _read(rng, target_part.mass_ug + stone)
    elif fault == "F7":
        cands = [p for p in parts if p.kind in ("ISSUE", "RETURN_FINISHED", "RETURN_SCRAP")]
        rng.shuffle(cands)
        for p in cands:
            rec = _read(rng, p.mass_ug)
            v = _gval(rec)
            dot = v.index(".")
            digits = [i for i in range(len(v) - 1) if v[i].isdigit() and v[i + 1].isdigit() and v[i] != v[i + 1]]
            # prefer swaps in the whole-gram part or the first two decimals (bigger than noise)
            digits = [i for i in digits if i < dot + 2] or digits
            if not digits:
                continue
            i = rng.choice(digits)
            c = list(v)
            c[i], c[i + 1] = c[i + 1], c[i]
            p.recorded_ug = rec
            p.value = "".join(c)
            target_part = p
            break
    elif fault == "F8":
        target_part = rng.choice(finished + [scrap])
        extra.append(target_part)
    elif fault == "F9":
        issue = parts[0]
        if issue.unit == "tola":
            target_part = issue
            issue.value = str(int(Decimal(issue.value) * 10))  # "t tola" entered as 10t g
            issue.unit = "g"
        else:
            target_part = scrap
            v = (Decimal(scrap.mass_ug) / UG_PER_UNIT["masha"]).quantize(Decimal("0.01"))
            scrap.mass_ug = to_ug(v, "masha")  # the karigar wrote it in masha
            scrap.value, scrap.unit = format(v, "f"), "g"  # entered as grams
            job["_note"] = "masha read as gram"

    evs = to_events(rng, rid, parts)
    if fault == "F8":
        src = next(e for e in evs if e.value_original == extra[0].value and e.event_type == extra[0].kind)
        dup = Event(**{**vars(src), "event_id": f"{rid}-dup", "timestamp": src.timestamp})
        evs.append(dup)
        truth = [("H7", dup.event_id, "")]
    elif truth_kind in ("H1", "H2", "H3"):
        truth = [(truth_kind, None, "")]
    else:
        # map the physical target to its visible event
        k = [p for p in parts if p.logged].index(target_part)
        eid = evs[k].event_id
        truth = [(truth_kind, eid, "mass" if truth_kind in ("H5", "H6", "H8") else "fineness")]
    return Run(rid, evs, job, unrec, fault, truth, multiple, task)


# ---------------------------------------------------------------- scoring
def _matches(edits, truth) -> bool:
    for hyp, eid, _f in truth:
        if not any(e.hyp == hyp and (eid is None or e.event_id == eid) for e in edits):
            return False
    return True


def _truth_edits(truth) -> tuple[Edit, ...]:
    return tuple(Edit(f"T{h}:{eid}", h, eid, Decimal(0), Decimal(0), True, f) for h, eid, f in truth)


def cp_upper(k: int, n: int, conf: float = 0.95) -> float:
    """Exact one-sided Clopper-Pearson upper bound (rule of three when k=0)."""
    if n == 0:
        return 1.0
    if k >= n:
        return 1.0
    alpha = 1 - conf

    def cdf(p):
        return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))

    lo, hi = k / n, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid) > alpha:
            lo = mid
        else:
            hi = mid
    return hi


def evaluate_run(run: Run, cfg: Config = FAST, policies=("best", "fixed", "random"), seed: int = 0,
                 costs: Optional[dict] = None, threshold: float = 0.9, budget_checks: int = 8) -> dict:
    eff = effective_ledger(run.events)
    bal = compute_balance(eff, run.job["wastage_min_pct"], run.job["wastage_max_pct"])
    res = explain(eff, bal, cfg, int(run.job.get("pieces_expected") or 0))
    scored = [x for x in res.explanations if not x.last_resort]
    raw_lo = bal.residual.lo + bal.loss_band.hi
    raw_hi = bal.residual.hi + bal.loss_band.lo
    out = {
        "run_id": run.run_id, "fault": run.fault, "magnitude": run.magnitude, "task": run.task,
        "detected": bal.verdict != "balanced", "verdict": bal.verdict,
        "raw_ug": float(bal.raw), "band_hi_ug": float(bal.loss_band.hi),
        # B0: a plain ledger treats the agreed wastage as one fixed number and flags
        # any deviation larger than the scale's readability (1 mg of metal).
        "point_flag": abs(bal.raw - bal.loss_band.hi) > Decimal(1000) * PHI,
        "dev_from_agreed_ug": float(abs(bal.raw - bal.loss_band.hi)),
        "halfwidth_ug": float(bal.residual.width / 2),
        "interval_covers_truth": (None if run.true_unrecovered_fine is None
                                  else raw_lo <= run.true_unrecovered_fine <= raw_hi),
        "n_expl": len(scored),
    }
    if run.fault and scored:
        out["covered"] = any(_matches(x.edits, run.truth) for x in scored)
        top = max(scored, key=lambda x: x.prob)
        out["top1"] = _matches(top.edits, run.truth)
        truth_edits = _truth_edits(run.truth)
        checks = build_checks(scored, eff, costs)
        first = None
        for pol in policies:
            sim = simulate(scored, checks, truth_edits, pol, threshold, budget_checks, rng=random.Random(seed))
            out[f"sim_{pol}"] = {
                "status": sim["status"], "checks": sim["checks"], "minutes": sim["minutes"],
                "correct": bool(sim["best"] is not None and sim["status"] == "resolved"
                                and _matches(sim["best"].edits, run.truth)),
                "confident_wrong": bool(sim["best"] is not None and sim["status"] == "resolved"
                                        and not _matches(sim["best"].edits, run.truth)),
            }
        from .checks import advise
        adv = advise(scored, checks, set(), threshold, budget_checks)
        first = adv.check.kind if adv.check else None
        out["first_check"] = first
        out["first_status"] = adv.status
    elif run.fault:
        out["covered"] = False
        out["top1"] = False
    return out


def _rate(xs, key) -> dict:
    n = len(xs)
    k = sum(1 for x in xs if x.get(key))
    return {"k": k, "n": n, "rate": (k / n) if n else None}


def run_suite(seed: int = 2026, n_clean: int = 60, n_dev: int = 40, n_per_fault: int = 10,
              n_sweep: int = 8, n_pairs: int = 10) -> dict:
    t0 = time.perf_counter()
    dev = [clean_run(seed + 1, i, "dev") for i in range(n_dev)]
    clean = [clean_run(seed, i) for i in range(n_clean)]
    dev_eval = [evaluate_run(r) for r in dev]
    clean_eval = [evaluate_run(r) for r in clean]

    # B1: a fixed tolerance tuned on the dev split (<=3% false alerts on dev)
    excess = sorted(r["dev_from_agreed_ug"] for r in dev_eval)
    q = max(0, math.ceil(0.97 * len(excess)) - 1)
    tol = excess[q] if excess else 0.0

    def b1_flag(r):
        return r["dev_from_agreed_ug"] > tol

    fa = {
        "tarazu": _rate(clean_eval, "detected"),
        "B0_point": _rate(clean_eval, "point_flag"),
        "B1_fixed_tol": {"k": sum(b1_flag(r) for r in clean_eval), "n": len(clean_eval)},
    }
    for v in fa.values():
        v["rate"] = v["k"] / v["n"] if v["n"] else None
        v["upper95"] = cp_upper(v["k"], v["n"])
    interval_cov = _rate(clean_eval, "interval_covers_truth")

    faults_eval = []
    for f in FAULTS:
        for i in range(n_per_fault):
            faults_eval.append(evaluate_run(fault_run(seed, i, f), seed=i))
    per_class = {}
    for f in FAULTS:
        rs = [r for r in faults_eval if r["fault"] == f]
        det = [r for r in rs if r["detected"]]
        per_class[f] = {
            "hyp": TRUTH_HYP[f], "n": len(rs),
            "detected": sum(r["detected"] for r in rs),
            "b1_detected": sum(b1_flag(r) for r in rs),
            "covered": sum(bool(r.get("covered")) for r in det),
            "top1": sum(bool(r.get("top1")) for r in det),
            "resolved_correct": sum(bool(r.get("sim_best", {}).get("correct")) for r in det),
        }

    sweep = []
    for f in ("F1", "F2", "F3", "F5"):
        for m in MULTIPLES:
            rs = [evaluate_run(fault_run(seed + 17, i, f, m), policies=()) for i in range(n_sweep)]
            sweep.append({"fault": f, "multiple": m, "n": len(rs),
                          "tarazu": sum(r["detected"] for r in rs),
                          "b0": sum(r["point_flag"] for r in rs),
                          "b1": sum(b1_flag(r) for r in rs)})

    # F10: two faults on different events
    pair_eval = []
    rng = random.Random(seed)
    combos = [("F2", "F7"), ("F8", "F5"), ("F3", "F6"), ("F1", "F7"), ("F2", "F4"), ("F8", "F7")]
    for i in range(n_pairs):
        a, b = combos[i % len(combos)]
        ra = fault_run(seed + 99, i, a)
        rb_proto = fault_run(seed + 99, i, b)
        pair_eval.append(_combine_pair(ra, rb_proto, rng, i, seed))

    # checks to resolution: best vs fixed vs random on detected & covered single faults
    pool = [r for r in faults_eval if r["detected"] and r.get("covered")]
    def mean(key, pol):
        v = [r[f"sim_{pol}"][key] for r in pool if f"sim_{pol}" in r]
        return round(statistics.mean(v), 3) if v else None
    checks_cmp = {pol: {"mean_checks": mean("checks", pol), "mean_minutes": mean("minutes", pol),
                        "resolved_correct": sum(r[f"sim_{pol}"]["correct"] for r in pool if f"sim_{pol}" in r),
                        "confident_wrong": sum(r[f"sim_{pol}"]["confident_wrong"] for r in pool if f"sim_{pol}" in r),
                        "n": len(pool)} for pol in ("best", "fixed", "random")}

    # indistinguishable pair behaviour (unlogged scrap vs unlogged WIP of equal size)
    amb = [r for r in faults_eval if r["fault"] in ("F2", "F3") and r["detected"]]
    abst_ok = sum(1 for r in amb if r.get("first_check") in ("weigh_scrap_bag", "weigh_bench")
                  or r.get("first_status") == "abstain")
    det_all = [r for r in faults_eval if r["detected"]]
    single = [r for r in det_all]
    coverage = {"k": sum(bool(r.get("covered")) for r in single), "n": len(single)}
    top1 = {"k": sum(bool(r.get("top1")) for r in single), "n": len(single)}

    # latency on a 30-event job with the full solver (CP-SAT combinations)
    lat = latency_probe()

    return {
        "label": "SIMULATED", "generator": GEN_VERSION, "seed": seed,
        "config": {"sigma_ug": SIGMA_UG, "u_mass_ug": U_MASS_UG, "band_max_pct": str(BAND_MAX_PCT),
                   "b1_tolerance_ug": round(tol, 1), "n_clean": n_clean, "n_dev": n_dev,
                   "n_per_fault": n_per_fault, "n_sweep": n_sweep, "n_pairs": n_pairs},
        "false_alerts": fa,
        "interval_coverage": interval_cov,
        "per_class": per_class,
        "sweep": sweep,
        "coverage": coverage,
        "single_best_guess": top1,
        "checks": checks_cmp,
        "abstention": {"k": abst_ok, "n": len(amb)},
        "pairs": {
            "n": len(pair_eval),
            "both_listed": sum(p["both"] for p in pair_eval),
            "one_listed": sum(p["one"] for p in pair_eval),
            "abstained_or_asked": sum(p["safe"] for p in pair_eval),
            "confident_wrong": sum(p["wrong"] for p in pair_eval),
        },
        "latency": lat,
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "not_run": {"B3": "LLM-only baseline needs a logged model and prompt; run separately",
                    "B4": "Human expert baseline needs a jeweller or accountant on 15-20 cases"},
    }


def _combine_pair(ra: Run, rb: Run, rng, i, seed) -> dict:
    """Apply fault B's record-level effect on top of run A when the events line up, else score A+B jointly."""
    # Rebuild: take A's events and, for record faults, inject B's style directly.
    evs = list(ra.events)
    truth = list(ra.truth)
    bfault = rb.fault
    if bfault in ("F7",):
        cand = [e for e in evs if e.event_type in ("RETURN_FINISHED", "RETURN_SCRAP", "ISSUE")
                and not any(t[1] == e.event_id for t in truth)]
        for e in cand:
            v = e.value_original
            idx = [j for j in range(len(v) - 1) if v[j].isdigit() and v[j + 1].isdigit() and v[j] != v[j + 1]
                   and j < (v.index(".") if "." in v else len(v)) - 1]
            if idx:
                j = idx[0]
                c = list(v)
                c[j], c[j + 1] = c[j + 1], c[j]
                nv = "".join(c)
                k = evs.index(e)
                evs[k] = Event(**{**vars(e), "value_original": nv, "mass_ug": to_ug(nv, e.unit_original)})
                truth.append(("H6", e.event_id, "mass"))
                break
    elif bfault == "F5":
        cand = [e for e in evs if e.event_type == "RETURN_FINISHED" and not any(t[1] == e.event_id for t in truth)]
        if cand:
            e = cand[0]
            k = evs.index(e)
            nm = e.mass_ug + 150_000
            evs[k] = Event(**{**vars(e), "mass_ug": nm, "value_original": _gval(nm)})
            truth.append(("H5", e.event_id, "mass"))
    elif bfault == "F6":
        cand = [e for e in evs if e.event_type == "RETURN_FINISHED" and not any(t[1] == e.event_id for t in truth)]
        if cand:
            e = cand[0]
            k = evs.index(e)
            nm = e.mass_ug + 300_000
            evs[k] = Event(**{**vars(e), "mass_ug": nm, "value_original": _gval(nm)})
            truth.append(("H8", e.event_id, "mass"))
    elif bfault == "F4":
        cand = [e for e in evs if e.event_type == "RETURN_FINISHED" and not any(t[1] == e.event_id for t in truth)]
        if cand:
            e = cand[0]
            k = evs.index(e)
            nm = e.mass_ug + 600_000  # copper added, slip fineness unchanged
            evs[k] = Event(**{**vars(e), "mass_ug": nm, "value_original": _gval(nm)})
            truth.append(("H4", e.event_id, "fineness"))
    run = Run(ra.run_id + "+" + str(bfault), evs, ra.job, ra.true_unrecovered_fine, "F10", truth)
    eff = effective_ledger(run.events)
    bal = compute_balance(eff, run.job["wastage_min_pct"], run.job["wastage_max_pct"])
    res = explain(eff, bal, FAST, int(run.job.get("pieces_expected") or 0))
    scored = [x for x in res.explanations if not x.last_resort]
    both = any(_matches(x.edits, truth) for x in scored)
    one = any(any(_matches(x.edits, [t]) for t in truth) for x in scored)
    safe = wrong = False
    if scored:
        checks = build_checks(scored, eff)
        sim = simulate(scored, checks, _truth_edits(truth), "best", rng=random.Random(i))
        if sim["status"] in ("abstain", "unexplained"):
            safe = True
        elif sim["best"] is not None:
            if any(_matches(sim["best"].edits, [t]) for t in truth):
                safe = True  # resolves one real fault; re-running after the correction finds the other
            else:
                wrong = True
    return {"both": both, "one": one, "safe": safe, "wrong": wrong}


def latency_probe() -> dict:
    rng = random.Random(5)
    evs = []
    total = 0
    jid = "lat"
    for k in range(10):
        m = rng.randint(20_000_000, 60_000_000)
        total += m
        evs.append(Event(f"lat-i{k}", jid, "ISSUE", m, PHI, U_MASS_UG, 0, value_original=_gval(m), simulated=True))
    for k in range(19):
        m = int(total * 0.05)
        evs.append(Event(f"lat-r{k}", jid, "RETURN_FINISHED", m, PHI, U_MASS_UG, 0, value_original=_gval(m),
                         pieces=1, simulated=True))
    evs.append(Event("lat-s", jid, "RETURN_SCRAP", 900_000, PHI, U_MASS_UG, 0, value_original="0.900",
                     simulated=True))
    t0 = time.perf_counter()
    rep = analyse(evs, {"metal": "silver", "wastage_min_pct": "0", "wastage_max_pct": "0.05"})
    ms = (time.perf_counter() - t0) * 1000
    return {"events": len(evs), "ms": round(ms, 1), "solver": rep["explain"]["solver"],
            "explanations": rep["explain"]["n_found"], "under_2s": ms < 2000}
