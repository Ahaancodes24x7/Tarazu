"""Physical-trial toolkit (protocol sections 5 to 8).

Everything the trial needs that software can do, in one place, with plain CSV
files a non-programmer can fill in:

    init        create a trial workspace with every sheet
    instrument  Phase 0: scale uncertainty, drift, linearity, tare, day effect
    costs       check costs elicited from the jeweller and the karigar
    schedule    blind, randomised fault schedule; the key is sealed and committed
    prereg      pre-registration: metrics, thresholds, frozen config, code fingerprint
    verify      confirm the code and config still match the pre-registration
    blind       run Tarazu on the visible records only and store every output
    phase3      record-level faults (F7, F8, F9, pairs) on copies of clean runs
    freeze      freeze the test set: hash the records and the injection log
    evaluate    open the key and score everything against the pre-registered criteria
    review      Phase 4 joint sessions: comprehension of both parties
    simulate    fill a workspace with SIMULATED data to dry-run the whole pipeline
    baselines   case sheets for the chatbot (B3) and the human expert (B4)
    score-baselines   score their answers against the key, next to Tarazu
    figures     the paper's charts as SVG, from results.json
    card        the dataset card
    release     the redacted public dataset, with checksums

Run: python -m tarazu.trial <command> <workspace> [options]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import secrets
import statistics
import sys
from dataclasses import asdict
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Optional

from . import __version__
from . import checks as checks_mod
from . import explain as explain_mod
from .explain import Config
from .harness import (FAULTS, GEN_VERSION, MULTIPLES, PHI, TRUTH_HYP, Run, clean_run, cp_upper, evaluate_run,
                      fault_run)
from .instrument import U_FINENESS, study
from .ledger import Event
from .units import UG_PER_UNIT, to_ug

ENGINE = Path(__file__).resolve().parent
ENGINE_FILES = ["units.py", "ledger.py", "explain.py", "checks.py", "analysis.py", "wording.py", "instrument.py",
                "harness.py", "trial.py"]
DEFAULT_U_MASS_UG = 2000
THRESHOLD, BUDGET_CHECKS = 0.9, 8
PHYSICAL = ["F1", "F2", "F3", "F4", "F5", "F6"]  # Phase 2 classes (H1 to H5 and H8)
SWEEP = ["F1", "F2", "F3", "F5"]
RECORD = ["F7", "F8", "F9"]
PAIRS = [("F7", "F8"), ("F7", "F9"), ("F8", "F9")]
FIELD = {"H4": "fineness", "H5": "mass", "H6": "mass", "H8": "mass", "H7": ""}
NEEDS_TARGET = {"F4", "F5", "F6"}

SHEETS = {
    "runs.csv": ["run_id", "session", "date", "operator", "phase", "task", "metal", "wastage_min_pct",
                 "wastage_max_pct", "pieces_expected", "note"],
    "records.csv": ["run_id", "event_no", "event_type", "value", "unit", "fineness", "scale_id", "assay_method",
                    "pieces", "document", "timestamp"],
    "ground_truth.csv": ["run_id", "true_unrecovered_fine_g", "closed_within_g", "filled_by", "note"],
    "instrument_readings.csv": ["scale_id", "day", "session", "time", "check_weight_g", "reading_g", "tare", "note"],
    "costs.csv": ["check_kind", "rater_role", "rater_id", "minutes", "friction_0_to_5", "note"],
    "joint_review.csv": ["session_id", "case_id", "role", "stated_unaccounted_g", "stated_next_check", "trust_1_to_5",
                         "note"],
    "consent_log.csv": ["participant_code", "role", "language", "date", "method", "reference", "withdrawn_on"],
    "payment_log.csv": ["participant_code", "date", "hours", "amount_inr", "note"],
    "data_ledger.csv": ["source", "consent_reference", "collected_on", "allowed_use", "geography", "units",
                        "known_problems", "transformations", "split"],
    "sealed/injection_log.csv": ["run_id", "target_event_no", "actual_size_g", "injected_by", "note"],
}

INSTRUCTIONS = {
    "F1": "Hide one finished piece: it goes back in a sealed bag but is left off the return slip.",
    "F2": "Leave the scrap and sweepings bag off the return slip.",
    "F3": "Keep a part-finished item at the bench; it is not on any slip.",
    "F4": "Return one piece made with extra copper (900 instead of 925) against a 925 slip.",
    "F5": "Weigh one return on the second scale set to a known added offset.",
    "F6": "Leave a stone or finding in one weighed piece and do not deduct it.",
    "control": "No fault. Run exactly as a clean run.",
}


# ------------------------------------------------------------------ files
def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8-sig") as f:
        return [{k: (v or "").strip() for k, v in r.items()} for r in csv.DictReader(f) if any((v or "").strip() for v in r.values())]


def _write(path: Path, rows: list[dict], header: Optional[list[str]] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = header or (list(rows[0]) if rows else [])
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def _sha(path: Path) -> Optional[str]:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, default=str, ensure_ascii=False), encoding="utf-8")


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init(ws: Path) -> list[str]:
    made = []
    for name, header in SHEETS.items():
        p = ws / name
        if not p.exists():
            _write(p, [], header)
            made.append(name)
    return made


# ------------------------------------------------------------- Phase 0
def instrument(ws: Path, readability_g: str = "0.001") -> dict:
    rows = [{**r, "check_weight_ug": to_ug(r["check_weight_g"], "g"), "reading_ug": to_ug(r["reading_g"], "g")}
            for r in _read(ws / "instrument_readings.csv")]
    if not rows:
        raise SystemExit("instrument_readings.csv is empty")
    rep = {"created": _now(), "rule": "u = max(|bias| + 3s, largest deviation, readability)",
           "scales": study(rows, to_ug(readability_g, "g"))}
    _json(ws / "instrument_report.json", rep)
    return rep


def u_by_scale(ws: Path) -> dict[str, int]:
    return {k: v["u_mass_ug"] for k, v in _load(ws / "instrument_report.json").get("scales", {}).items()}


# ----------------------------------------------------------------- costs
def costs(ws: Path) -> dict:
    rows = _read(ws / "costs.csv")
    prof: dict[str, dict] = {}
    for kind in sorted({r["check_kind"] for r in rows}):
        rs = [r for r in rows if r["check_kind"] == kind]
        m = [float(r["minutes"]) for r in rs]
        fr = [float(r["friction_0_to_5"]) for r in rs]
        prof[kind] = {"median": [statistics.median(m), statistics.median(fr)], "low": [min(m), min(fr)],
                      "high": [max(m), max(fr)], "n": len(rs), "roles": sorted({r["rater_role"] for r in rs})}
    unknown = sorted(set(prof) - set(checks_mod.DEFAULT_COSTS))
    missing = sorted(set(checks_mod.DEFAULT_COSTS) - set(prof))
    one_sided = sorted(k for k, v in prof.items() if not {"jeweller", "karigar"} <= set(v["roles"]))
    out = {"created": _now(), "profile": prof, "unknown_kinds": unknown, "not_rated": missing,
           "rated_by_one_side_only": one_sided}
    _json(ws / "cost_profile.json", out)
    return out


def cost_table(ws: Path, which: str = "median") -> dict:
    prof = _load(ws / "cost_profile.json").get("profile", {})
    return {k: tuple(v[which]) for k, v in prof.items() if k in checks_mod.DEFAULT_COSTS}


# -------------------------------------------------------------- schedule
def schedule(ws: Path, per_class: int = 10, sweep_per_cell: int = 2, controls: int = 6,
             indistinguishable: int = 4, seed: Optional[int] = None) -> dict:
    """Randomised blind schedule. The analyst sees only schedule.csv; the key is sealed."""
    rng = random.Random(seed) if seed is not None else secrets.SystemRandom()
    u = u_by_scale(ws)
    if not u:
        raise SystemExit("Run the instrument study first: the sweep sizes come from it")
    # A typical balance has three weighings (issue, finished, scrap): its half-width is about 3u.
    unit_g = Decimal(3 * max(u.values())) / UG_PER_UNIT["g"]
    plan = [(f, None, None) for f in PHYSICAL for _ in range(per_class)]
    plan += [(f, m, (unit_g * Decimal(str(m))).quantize(Decimal("0.001"))) for f in SWEEP for m in MULTIPLES
             for _ in range(sweep_per_cell)]
    plan += [(f, None, Decimal("1.000")) for f in ("F2", "F3") for _ in range(indistinguishable)]
    plan += [("control", None, None)] * controls
    rng.shuffle(plan)
    tasks = ["cut_file", "solder", "polish"]
    public, key = [], []
    for i, (f, m, size) in enumerate(plan, 1):
        rid = f"R{i:03d}"
        public.append({"run_id": rid, "order": i, "task": rng.choice(tasks), "phase": "fault-or-control"})
        key.append({"run_id": rid, "fault": f, "multiple": m or "", "size_g": size or "",
                    "instruction": INSTRUCTIONS[f] + (f" Size: {size} g." if size else "")})
    nonce = secrets.token_hex(16) if seed is None else f"seed-{seed}"
    key.append({"run_id": "NONCE", "fault": nonce, "multiple": "", "size_g": "", "instruction": "do not remove"})
    _write(ws / "schedule.csv", public)
    _write(ws / "sealed/fault_key.csv", key)
    lines = ["# Injector sheet (sealed: never show this to the analyst)", "",
             "Apply each fault exactly as written. After the run, write the record number you changed",
             "(for F4, F5 and F6) and the actual size in sealed/injection_log.csv.", ""]
    lines += [f"- {k['run_id']}: {k['instruction']}" for k in key if k["run_id"] != "NONCE"]
    (ws / "sealed/injector_sheet.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    commit = {"created": _now(), "n_runs": len(public), "sweep_unit_g": str(unit_g),
              "fault_key_sha256": _sha(ws / "sealed/fault_key.csv")}
    _json(ws / "schedule_commitment.json", commit)
    return commit


# ------------------------------------------------------- pre-registration
CRITERIA = [
    ("false_alert_rate", "Clean runs flagged / clean runs", "observed <= 3%, exact 95% upper bound reported"),
    ("detection_2x", "Faults detected at >= 2x the scale uncertainty", ">= 90%, and silent below 1x"),
    ("coverage", "True fault is in the returned set (single faults)", ">= 85%"),
    ("localisation", "Correct record identified (single faults)", ">= 80%"),
    ("checks_reduction", "Mean checks to resolution vs the fixed checklist (B5)", ">= 25% fewer"),
    ("abstention", "Indistinguishable cases: abstains or asks a separating check", ">= 90%"),
    ("confident_wrong", "Confidently wrong answers on single faults", "<= 5%"),
    ("interval_coverage", "Ground-truth residual inside the interval (clean runs)", ">= 95%"),
    ("latency", "Input to output on a laptop CPU, up to 30 records", "< 2 s"),
    ("comprehension", "Jeweller and karigar each state the quantity and the next step", ">= 8 of 10 each"),
]


def fingerprint() -> dict:
    files = {f: hashlib.sha256((ENGINE / f).read_bytes()).hexdigest() for f in ENGINE_FILES}
    return {"files": files, "combined": hashlib.sha256("".join(files[f] for f in ENGINE_FILES).encode()).hexdigest()}


def frozen_config(ws: Path) -> dict:
    cfg = asdict(Config())
    return {"engine_config": {k: str(v) if isinstance(v, Decimal) else v for k, v in cfg.items()},
            "enum_budget": explain_mod.ENUM_BUDGET, "threshold": THRESHOLD, "budget_checks": BUDGET_CHECKS,
            "friction_minutes": checks_mod.FRICTION_MINUTES,
            "costs": {k: list(v) for k, v in {**checks_mod.DEFAULT_COSTS, **cost_table(ws)}.items()},
            "u_mass_ug": u_by_scale(ws), "u_fineness": U_FINENESS}


def prereg(ws: Path, dev_sessions: list[str]) -> dict:
    if not dev_sessions:
        raise SystemExit("Name the development sessions (--dev S01 S02 ...): the split is by session, not by run")
    doc = {"created": _now(), "tarazu_version": __version__, "split": {"dev_sessions": sorted(dev_sessions),
           "rule": "every other session is test; tuning uses dev only"},
           "criteria": [{"id": i, "metric": m, "pass": p} for i, m, p in CRITERIA],
           "frozen": frozen_config(ws), "code": fingerprint(),
           "schedule_commitment": _load(ws / "schedule_commitment.json").get("fault_key_sha256"),
           "instrument_report_sha256": _sha(ws / "instrument_report.json"),
           "stop_conditions": ["Abandon the dispute claim if added checks cost more time than current verification",
                               "Report a negative result if the human expert (B4) matches coverage and check count",
                               "No single headline accuracy: per-class counts, denominators and exact intervals"]}
    body = json.dumps(doc, sort_keys=True, default=str)
    doc["sha256"] = hashlib.sha256(body.encode()).hexdigest()
    _json(ws / "prereg.json", doc)
    md = [f"# Pre-registration · {date.today().isoformat()}", "",
          f"Fingerprint: `{doc['sha256']}`", f"Engine code: `{doc['code']['combined']}`",
          f"Fault key commitment: `{doc['schedule_commitment']}`", "",
          f"Development sessions: {', '.join(doc['split']['dev_sessions'])}. All other sessions are test.", "",
          "| Metric | Definition | Pass criterion |", "|---|---|---|"]
    md += [f"| {i} | {m} | {p} |" for i, m, p in CRITERIA]
    md += ["", f"Decision rule: stop at posterior {THRESHOLD}, at most {BUDGET_CHECKS} checks, abstain otherwise.",
           "", "Commit this file and prereg.json before opening any fault-run result."]
    (ws / "PREREGISTRATION.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    return doc


def verify(ws: Path) -> list[str]:
    pre = _load(ws / "prereg.json")
    if not pre:
        return ["no prereg.json"]
    diffs = [f"code changed: {f}" for f, h in fingerprint()["files"].items() if pre["code"]["files"].get(f) != h]
    now = json.loads(json.dumps(frozen_config(ws), default=str))
    diffs += [f"config changed: {k}" for k in now if now[k] != pre["frozen"].get(k)]
    return diffs


# -------------------------------------------------------------- loading
def _u_fin(method: str) -> Decimal:
    return Decimal(U_FINENESS.get((method or "declared").lower(), U_FINENESS["declared"]))


def load_runs(ws: Path) -> dict[str, Run]:
    """Visible records only, as engine events. Malformed runs carry the reason instead."""
    u = u_by_scale(ws)
    gt = {r["run_id"]: Decimal(r["true_unrecovered_fine_g"]) * UG_PER_UNIT["g"]
          for r in _read(ws / "ground_truth.csv") if r.get("true_unrecovered_fine_g")}
    meta = {r["run_id"]: r for r in _read(ws / "runs.csv") + _read(ws / "runs_phase3.csv")}
    recs: dict[str, list[dict]] = {}
    for r in _read(ws / "records.csv") + _read(ws / "records_phase3.csv"):
        recs.setdefault(r["run_id"], []).append(r)
    out = {}
    for rid, m in meta.items():
        evs, err = [], None
        for r in sorted(recs.get(rid, []), key=lambda r: int(r["event_no"])):
            try:
                if not r["unit"]:
                    raise ValueError("unit missing")
                if not r["fineness"]:
                    raise ValueError("fineness missing")
                mass = to_ug(r["value"], r["unit"])
                if mass <= 0:
                    raise ValueError("weight must be positive")
                evs.append(Event(f"{rid}-e{r['event_no']}", rid, r["event_type"], mass, Decimal(r["fineness"]),
                                 u.get(r["scale_id"], DEFAULT_U_MASS_UG), _u_fin(r["assay_method"]),
                                 value_original=r["value"], unit_original=r["unit"],
                                 assay_method=r["assay_method"] or "declared", instrument_id=r["scale_id"],
                                 document_id=r["document"], timestamp=r["timestamp"], pieces=int(r["pieces"] or 0),
                                 simulated="SIMULATED" in m.get("note", "")))
            except Exception as e:  # noqa: BLE001 - malformed input is reported, never guessed
                err = f"record {r['event_no']}: {e}"
                break
        job = {"metal": m.get("metal") or "silver", "wastage_min_pct": m.get("wastage_min_pct") or "0",
               "wastage_max_pct": m.get("wastage_max_pct") or "0", "pieces_expected": int(m.get("pieces_expected") or 0)}
        run = Run(rid, evs, job, gt.get(rid), task=m.get("task", ""))
        run.malformed = err  # type: ignore[attr-defined]
        run.session = m.get("session", "")  # type: ignore[attr-defined]
        run.phase = m.get("phase", "")  # type: ignore[attr-defined]
        out[rid] = run
    return out


# ------------------------------------------------------------ blind run
def blind(ws: Path) -> dict:
    """Protocol 5.3 step 6: run Tarazu on the visible records and store each output with the code version."""
    from .analysis import analyse
    fp = fingerprint()["combined"]
    n = bad = 0
    for rid, run in load_runs(ws).items():
        out = {"run_id": rid, "at": _now(), "tarazu_version": __version__, "code": fp}
        if run.malformed:  # type: ignore[attr-defined]
            out["rejected"] = run.malformed  # type: ignore[attr-defined]
            bad += 1
        else:
            out["report"] = analyse(run.events, run.job)
        _json(ws / "outputs" / f"{rid}.json", out)
        n += 1
    return {"runs": n, "rejected": bad, "code": fp}


# ----------------------------------------------------- Phase 3 (records)
def _swap_digits(v: str, rng) -> Optional[str]:
    dot = v.index(".") if "." in v else len(v)
    idx = [i for i in range(len(v) - 1) if v[i].isdigit() and v[i + 1].isdigit() and v[i] != v[i + 1]]
    idx = [i for i in idx if i < dot + 2] or idx
    if not idx:
        return None
    i = rng.choice(idx)
    c = list(v)
    c[i], c[i + 1] = c[i + 1], c[i]
    return "".join(c)


def _apply_record_fault(f: str, recs: list[dict], rng, used: set) -> Optional[tuple[str, str]]:
    """Mutate copies of clean records in place. Returns (hyp, event_no) or None."""
    if f == "F7":
        for r in rng.sample(recs, len(recs)):
            if r["event_no"] in used or r["unit"] != "g":
                continue
            nv = _swap_digits(r["value"], rng)
            if nv:
                r["value"] = nv
                return "H6", r["event_no"]
    elif f == "F8":
        cands = [r for r in recs if r["event_type"].startswith("RETURN") and r["event_no"] not in used]
        if cands:
            src = rng.choice(cands)
            dup = {**src, "event_no": str(max(int(r["event_no"]) for r in recs) + 1)}
            recs.append(dup)
            return "H7", dup["event_no"]
    elif f == "F9":
        tola = [r for r in recs if r["unit"] == "tola" and r["event_no"] not in used]
        if tola:
            r = tola[0]
            r["value"], r["unit"] = str(Decimal(r["value"]) * 10), "g"  # a tola entered as 10 g
            return "H6", r["event_no"]
        rets = [r for r in recs if r["event_type"].startswith("RETURN") and r["unit"] == "g" and r["event_no"] not in used]
        if rets:
            r = max(rets, key=lambda r: Decimal(r["value"]))  # written in masha on the slip, typed in as grams
            masha = (to_ug(r["value"], "g") / UG_PER_UNIT["masha"]).quantize(Decimal("0.01"))
            r["value"] = format(masha, "f")
            return "H6", r["event_no"]
    return None


def phase3(ws: Path, per_class: int = 10, n_pairs: int = 10, cancelling: int = 5, malformed: int = 5,
           seed: Optional[int] = None) -> dict:
    rng = random.Random(seed) if seed is not None else secrets.SystemRandom()
    dev = set(_load(ws / "prereg.json").get("split", {}).get("dev_sessions", []))
    runs = {r["run_id"]: r for r in _read(ws / "runs.csv") if r["phase"] == "clean" and r["session"] not in dev}
    if not runs:
        raise SystemExit("No clean test-session runs in runs.csv to copy")
    recs: dict[str, list[dict]] = {}
    for r in _read(ws / "records.csv"):
        recs.setdefault(r["run_id"], []).append(r)
    plan = [(f,) for f in RECORD for _ in range(per_class)] + [PAIRS[i % len(PAIRS)] for i in range(n_pairs)]
    plan += [("cancel",)] * cancelling + [("malformed",)] * malformed
    rng.shuffle(plan)
    new_runs, new_recs, key = [], [], []
    for i, faults in enumerate(plan, 1):
        src = rng.choice(sorted(runs))
        rid = f"P{i:03d}"
        rs = [{**r, "run_id": rid} for r in recs[src]]
        truth, used = [], set()
        if faults == ("cancel",):
            rets = [r for r in rs if r["event_type"].startswith("RETURN") and r["unit"] == "g"]
            if len(rets) >= 2:
                d = Decimal("0.150")
                rets[0]["value"] = format(Decimal(rets[0]["value"]) + d, "f")
                rets[1]["value"] = format(Decimal(rets[1]["value"]) - d, "f")
                truth = [("H5", rets[0]["event_no"]), ("H5", rets[1]["event_no"])]
        elif faults == ("malformed",):
            r = rng.choice(rs)
            kind = rng.choice(["fineness", "zero", "negative", "unit"])
            r.update({"fineness": ""} if kind == "fineness" else {"value": "0"} if kind == "zero"
                     else {"value": "-" + r["value"]} if kind == "negative" else {"unit": ""})
            truth = [("reject", kind)]
        else:
            for f in faults:
                t = _apply_record_fault(f, rs, rng, used)
                if t:
                    truth.append(t)
                    used.add(t[1])
        label = faults[0] if len(faults) == 1 else "F10"
        new_runs.append({**runs[src], "run_id": rid, "phase": "record", "session": runs[src]["session"],
                         "note": runs[src].get("note", "")})
        new_recs += rs
        key.append({"run_id": rid, "source_run": src, "fault": label, "parts": "+".join(faults),
                    "truth": json.dumps(truth)})
    key.append({"run_id": "NONCE", "source_run": "", "fault": secrets.token_hex(16) if seed is None else f"seed-{seed}",
                "parts": "", "truth": ""})
    _write(ws / "runs_phase3.csv", new_runs, SHEETS["runs.csv"])
    _write(ws / "records_phase3.csv", new_recs, SHEETS["records.csv"])
    _write(ws / "sealed/fault_key_phase3.csv", key)
    commit = _load(ws / "schedule_commitment.json")
    commit["fault_key_phase3_sha256"] = _sha(ws / "sealed/fault_key_phase3.csv")
    _json(ws / "schedule_commitment.json", commit)
    return {"runs": len(new_runs), "commitment": commit["fault_key_phase3_sha256"]}


# --------------------------------------------------------------- freeze
FROZEN = ["runs.csv", "records.csv", "runs_phase3.csv", "records_phase3.csv", "ground_truth.csv",
          "sealed/injection_log.csv"]


def freeze(ws: Path) -> dict:
    doc = {"created": _now(), "files": {f: _sha(ws / f) for f in FROZEN}}
    _json(ws / "frozen.json", doc)
    return doc


# -------------------------------------------------------------- evaluate
def _truth_for(rid: str, key: dict, inj: dict, run: Run) -> list[tuple]:
    k = key.get(rid)
    if not k:
        return []
    if "truth" in k:  # phase 3
        return [(h, f"{rid}-e{n}", FIELD.get(h, "")) for h, n in json.loads(k["truth"]) if h != "reject"]
    f = k["fault"]
    if f == "control":
        return []
    hyp = TRUTH_HYP[f]
    if f in NEEDS_TARGET:
        n = inj.get(rid, {}).get("target_event_no")
        return [(hyp, f"{rid}-e{n}" if n else None, FIELD.get(hyp, ""))]
    return [(hyp, None, "")]


def _localised(r: dict) -> bool:
    return bool(r.get("covered"))


def integrity(ws: Path, allow_changed: bool = False) -> tuple[dict, list[str], list[str]]:
    """Every condition that must hold before a sealed key may be opened."""
    pre = _load(ws / "prereg.json")
    frozen = _load(ws / "frozen.json")
    commit = _load(ws / "schedule_commitment.json")
    problems = []
    if not pre:
        problems.append("not pre-registered")
    if not frozen:
        problems.append("test set not frozen")
    for f, h in (frozen.get("files") or {}).items():
        if _sha(ws / f) != h:
            problems.append(f"{f} changed after freezing")
    for name, field_ in (("sealed/fault_key.csv", "fault_key_sha256"), ("sealed/fault_key_phase3.csv",
                                                                         "fault_key_phase3_sha256")):
        if commit.get(field_) and _sha(ws / name) != commit[field_]:
            problems.append(f"{name} does not match its commitment")
    changed = verify(ws) if pre else []
    if changed and not allow_changed:
        problems += changed
    if problems and not allow_changed:
        raise SystemExit("Refusing to open the key: " + "; ".join(problems))
    return pre, problems, changed


def evaluate(ws: Path, allow_changed: bool = False, sensitivity: bool = True) -> dict:
    pre, problems, changed = integrity(ws, allow_changed)
    key = {r["run_id"]: r for r in _read(ws / "sealed/fault_key.csv") + _read(ws / "sealed/fault_key_phase3.csv")
           if r["run_id"] != "NONCE"}
    inj = {r["run_id"]: r for r in _read(ws / "sealed/injection_log.csv")}
    dev = set(pre.get("split", {}).get("dev_sessions", []))
    fz = pre.get("frozen", {})
    threshold, budget = fz.get("threshold", THRESHOLD), fz.get("budget_checks", BUDGET_CHECKS)
    runs = load_runs(ws)
    simulated = any(e.simulated for r in runs.values() for e in r.events)
    cfg = Config(use_cpsat=False)

    def score(run, costs=None, cfg_=cfg, policies=("best", "fixed", "random")):
        return evaluate_run(run, cfg_, policies, seed=0, costs=costs, threshold=threshold, budget_checks=budget)

    malformed = {rid: r for rid, r in runs.items() if r.malformed}  # type: ignore[attr-defined]
    good = {rid: r for rid, r in runs.items() if not r.malformed}  # type: ignore[attr-defined]
    for rid, r in good.items():
        k = key.get(rid, {})
        r.fault = (None if not k or k["fault"] in ("control", "cancel", "malformed") else k["fault"])
        r.truth = _truth_for(rid, key, inj, r)
        r.magnitude = float(k["multiple"]) if k.get("multiple") else None
    test = {rid: r for rid, r in good.items() if r.session not in dev}  # type: ignore[attr-defined]
    dev_clean = [score(r, policies=()) for r in good.values() if r.session in dev and r.phase == "clean"]  # type: ignore[attr-defined]
    excess = sorted(x["dev_from_agreed_ug"] for x in dev_clean)
    tol = excess[max(0, -(-97 * len(excess) // 100) - 1)] if excess else 0.0
    costs_med = {k: tuple(v) for k, v in fz.get("costs", {}).items()} or None
    ev = {rid: score(r, costs_med) for rid, r in test.items()}

    def rate(k, n):
        return {"k": k, "n": n, "rate": round(k / n, 4) if n else None, "upper95": round(cp_upper(k, n), 4)}

    clean_ids = [rid for rid, r in test.items() if r.phase == "clean" or key.get(rid, {}).get("fault") == "control"]  # type: ignore[attr-defined]
    fa = {"tarazu": rate(sum(ev[i]["detected"] for i in clean_ids), len(clean_ids)),
          "B0_plain_ledger": rate(sum(ev[i]["point_flag"] for i in clean_ids), len(clean_ids)),
          "B1_fixed_tolerance": rate(sum(ev[i]["dev_from_agreed_ug"] > tol for i in clean_ids), len(clean_ids))}
    single = [i for i in ev if test[i].fault in FAULTS and test[i].magnitude is None]
    det = [i for i in single if ev[i]["detected"]]
    classes = {}
    for f in FAULTS + ["F10"]:
        ids = [i for i in ev if test[i].fault == f and test[i].magnitude is None]
        d = [i for i in ids if ev[i]["detected"]]
        classes[f] = {"n": len(ids), "detected": len(d), "covered": sum(bool(ev[i].get("covered")) for i in d),
                      "single_best_guess": sum(bool(ev[i].get("top1")) for i in d),
                      "resolved_correct": sum(bool(ev[i].get("sim_best", {}).get("correct")) for i in d),
                      "confident_wrong": sum(bool(ev[i].get("sim_best", {}).get("confident_wrong")) for i in d)}
    sweep = []
    for f in SWEEP:
        for m in MULTIPLES:
            ids = [i for i in ev if test[i].fault == f and test[i].magnitude == m]
            if ids:
                sweep.append({"fault": f, "multiple": m, "n": len(ids), "tarazu": sum(ev[i]["detected"] for i in ids),
                              "B0": sum(ev[i]["point_flag"] for i in ids),
                              "B1": sum(ev[i]["dev_from_agreed_ug"] > tol for i in ids)})
    pool = [i for i in det if ev[i].get("covered")]

    def mean_of(evs, pol, key_):
        v = [evs[i][f"sim_{pol}"][key_] for i in pool if f"sim_{pol}" in evs[i]]
        return round(statistics.fmean(v), 3) if v else None
    checks_ = {pol: {"mean_checks": mean_of(ev, pol, "checks"), "mean_minutes": mean_of(ev, pol, "minutes")}
               for pol in ("best", "fixed", "random")}
    b, fx = checks_["best"]["mean_checks"], checks_["fixed"]["mean_checks"]
    reduction = round(1 - b / fx, 3) if b and fx else None
    amb = [i for i in det if test[i].fault in ("F2", "F3") and key.get(i, {}).get("size_g") == "1.000"]
    abst = sum(1 for i in amb if ev[i].get("first_check") in ("weigh_scrap_bag", "weigh_bench")
               or ev[i].get("first_status") == "abstain")
    cov_ids = [i for i in clean_ids if ev[i]["interval_covers_truth"] is not None]
    cancel = [i for i in ev if key.get(i, {}).get("fault") == "cancel"]
    mal_key = [i for i, k in key.items() if k.get("fault") == "malformed"]
    res = {
        "label": "SIMULATED" if simulated else "PHYSICAL TRIAL", "created": _now(), "tarazu_version": __version__,
        "preregistration": pre.get("sha256"), "integrity_problems": problems, "code_changed_since_prereg": changed,
        "split": {"dev_sessions": sorted(dev), "test_runs": len(test), "b1_tolerance_ug": round(tol, 1)},
        "false_alerts": fa,
        "interval_coverage": rate(sum(bool(ev[i]["interval_covers_truth"]) for i in cov_ids), len(cov_ids)),
        "per_class": classes, "sweep": sweep,
        "coverage": rate(sum(bool(ev[i].get("covered")) for i in det), len(det)),
        "localisation": rate(sum(_localised(ev[i]) for i in det if any(t[1] for t in test[i].truth)),
                             sum(1 for i in det if any(t[1] for t in test[i].truth))),
        "single_best_guess": rate(sum(bool(ev[i].get("top1")) for i in det), len(det)),
        "checks": checks_, "checks_reduction_vs_fixed": reduction,
        "confident_wrong": rate(sum(bool(ev[i].get("sim_best", {}).get("confident_wrong")) for i in det), len(det)),
        "abstention": rate(abst, len(amb)),
        "cancelling_flagged": rate(sum(ev[i]["detected"] for i in cancel), len(cancel)),
        "malformed_rejected": rate(sum(1 for i in mal_key if i in malformed), len(mal_key)),
        "not_run": ["B3 chatbot-only and B4 human-expert baselines: score them with `baselines` and `score-baselines`"],
    }
    # Ablations (protocol 7.1): remove one component at a time.
    res["ablations"] = {
        "full Tarazu": {"false_alerts": fa["tarazu"], "coverage": res["coverage"], "mean_checks": checks_["best"]["mean_checks"]},
        "no interval (point residual)": {"false_alerts": fa["B0_plain_ledger"], "coverage": res["coverage"],
                                         "mean_checks": checks_["best"]["mean_checks"]},
        "no competing explanations (single best guess)": {"false_alerts": fa["tarazu"], "coverage": res["single_best_guess"],
                                                          "mean_checks": None},
        "no next-check selection (fixed order)": {"false_alerts": fa["tarazu"], "coverage": res["coverage"],
                                                  "mean_checks": checks_["fixed"]["mean_checks"]},
    }
    if sensitivity and pool:
        res["sensitivity"] = _sensitivity(test, pool, score, fz)
    res["pass_fail"] = _pass_fail(res)
    # Tarazu's own answer per test run, for comparison with the chatbot and expert baselines.
    _json(ws / "eval_runs.json", {i: {"fault": test[i].fault, "detected": e["detected"], "top1": e.get("top1"),
                                      "covered": e.get("covered"), "first_check": e.get("first_check"),
                                      "truth": test[i].truth} for i, e in ev.items()})
    _json(ws / "results.json", res)
    (ws / "RESULTS.md").write_text(_results_md(res), encoding="utf-8")
    return res


def _sensitivity(test: dict, pool: list[str], score, fz: dict) -> dict:
    """Check counts under the low and high elicited costs, and coverage under one-at-a-time prior changes."""
    out: dict = {"costs": {}, "priors": {}}
    prof = fz.get("costs", {})
    for which, scale in (("low", 0.5), ("high", 2.0)):
        table = {k: (v[0] * scale, v[1]) for k, v in prof.items()}
        evs = {i: score(test[i], table, policies=("best", "fixed")) for i in pool}
        out["costs"][which] = {pol: round(statistics.fmean(evs[i][f"sim_{pol}"]["checks"] for i in pool), 3)
                               for pol in ("best", "fixed")}
    for h in [h for h in explain_mod.HYPOTHESES if h != "H9"]:
        cfg = Config(use_cpsat=False)
        cfg.priors = {**cfg.priors, h: 3.0}
        evs = {i: score(test[i], cfg_=cfg, policies=("best",)) for i in pool}
        out["priors"][f"{h} x3"] = {"top1": sum(bool(evs[i].get("top1")) for i in pool), "n": len(pool),
                                    "mean_checks": round(statistics.fmean(evs[i]["sim_best"]["checks"] for i in pool), 3)}
    return out


def _pass_fail(r: dict) -> dict:
    def ok(cond):
        return None if cond is None else bool(cond)
    fa, cov, loc = r["false_alerts"]["tarazu"], r["coverage"], r["localisation"]
    sw2 = [s for s in r["sweep"] if s["multiple"] >= 2]
    sw_lo = [s for s in r["sweep"] if s["multiple"] < 1]
    det2 = sum(s["tarazu"] for s in sw2) / sum(s["n"] for s in sw2) if sw2 else None
    silent = sum(s["tarazu"] for s in sw_lo) == 0 if sw_lo else None
    return {
        "false_alert_rate": ok(fa["rate"] is not None and fa["rate"] <= 0.03) if fa["n"] else None,
        "detection_2x": ok(det2 is not None and det2 >= 0.9 and silent) if sw2 else None,
        "coverage": ok(cov["rate"] >= 0.85) if cov["n"] else None,
        "localisation": ok(loc["rate"] >= 0.80) if loc["n"] else None,
        "checks_reduction": ok(r["checks_reduction_vs_fixed"] >= 0.25) if r["checks_reduction_vs_fixed"] is not None else None,
        "abstention": ok(r["abstention"]["rate"] >= 0.9) if r["abstention"]["n"] else None,
        "confident_wrong": ok(r["confident_wrong"]["rate"] <= 0.05) if r["confident_wrong"]["n"] else None,
        "interval_coverage": ok(r["interval_coverage"]["rate"] >= 0.95) if r["interval_coverage"]["n"] else None,
    }


def _pct(x: dict) -> str:
    if not x or not x.get("n"):
        return "no cases"
    return f"{x['k']} / {x['n']} ({100 * x['rate']:.1f}%, 95% upper {100 * x['upper95']:.1f}%)"


def _results_md(r: dict) -> str:
    L = [f"# Results · {r['label']}", "", f"Pre-registration: `{r['preregistration']}`",
         f"Test runs: {r['split']['test_runs']} · B1 tolerance tuned on dev: {r['split']['b1_tolerance_ug']} µg", ""]
    if r["integrity_problems"] or r["code_changed_since_prereg"]:
        L += ["**Integrity warnings:** " + "; ".join(r["integrity_problems"] + r["code_changed_since_prereg"]), ""]
    L += ["## False alerts on clean runs", "", "| Method | False alerts |", "|---|---|"]
    L += [f"| {k} | {_pct(v)} |" for k, v in r["false_alerts"].items()]
    L += ["", "## Single faults", "", f"- Coverage: {_pct(r['coverage'])}", f"- Localisation: {_pct(r['localisation'])}",
          f"- Single best guess (ablation): {_pct(r['single_best_guess'])}",
          f"- Confidently wrong: {_pct(r['confident_wrong'])}", f"- Abstention on indistinguishable pairs: {_pct(r['abstention'])}",
          f"- Interval coverage (clean, ground truth): {_pct(r['interval_coverage'])}", "",
          "| Class | n | detected | covered | best guess | resolved | confident wrong |", "|---|---|---|---|---|---|---|"]
    L += [f"| {f} | {c['n']} | {c['detected']} | {c['covered']} | {c['single_best_guess']} | {c['resolved_correct']} | "
          f"{c['confident_wrong']} |" for f, c in r["per_class"].items() if c["n"]]
    L += ["", "## Detection by size", "", "| Fault | × uncertainty | n | Tarazu | B0 | B1 |", "|---|---|---|---|---|---|"]
    L += [f"| {s['fault']} | {s['multiple']} | {s['n']} | {s['tarazu']} | {s['B0']} | {s['B1']} |" for s in r["sweep"]]
    L += ["", "## Checks to resolution", "", "| Policy | Mean checks | Mean minutes |", "|---|---|---|"]
    L += [f"| {p} | {v['mean_checks']} | {v['mean_minutes']} |" for p, v in r["checks"].items()]
    L += [f"", f"Reduction against the fixed checklist: {r['checks_reduction_vs_fixed']}", "",
          f"Cancelling faults flagged (a known limit): {_pct(r['cancelling_flagged'])}",
          f"Malformed runs rejected: {_pct(r['malformed_rejected'])}", "", "## Pre-registered criteria", "",
          "| Criterion | Result |", "|---|---|"]
    L += [f"| {k} | {'pass' if v else 'MISS' if v is False else 'not measured'} |" for k, v in r["pass_fail"].items()]
    L += ["", "## Ablations", "", "| Variant | False alerts | Coverage | Mean checks |", "|---|---|---|---|"]
    L += [f"| {k} | {_pct(v['false_alerts'])} | {_pct(v['coverage'])} | {v['mean_checks'] if v['mean_checks'] is not None else 'n/a'} |"
          for k, v in r.get("ablations", {}).items()]
    L += ["", "Not run here: " + "; ".join(r["not_run"]) + "."]
    return "\n".join(L) + "\n"


# --------------------------------------------------------------- Phase 4
def review(ws: Path, tol_g: str = "0.010") -> dict:
    rows = _read(ws / "joint_review.csv")
    tol = Decimal(tol_g)
    out = {}
    for role in ("jeweller", "karigar"):
        rs = [r for r in rows if r["role"] == role]
        ok = 0
        for r in rs:
            o = _load(ws / "outputs" / f"{r['case_id']}.json").get("report", {})
            bal = o.get("balance", {})
            try:
                stated = Decimal(r["stated_unaccounted_g"])
                lo, hi = Decimal(str(bal["residual_lo_g"])), Decimal(str(bal["residual_hi_g"]))
                # accept the gap as a range, the raw gap, or the excess over the agreed wastage
                qty_ok = (lo - tol <= stated <= hi + tol or abs(stated - Decimal(str(bal["raw_g"]))) <= tol
                          or abs(stated - Decimal(str(bal["excess_g"]))) <= tol)
            except Exception:  # noqa: BLE001 - an unreadable answer counts as wrong
                qty_ok = False
            nxt = ((o.get("investigation") or {}).get("next_check") or {}).get("kind")
            ok += bool(qty_ok and nxt and r["stated_next_check"] == nxt)
        trust = sorted(int(r["trust_1_to_5"]) for r in rs if r.get("trust_1_to_5"))
        out[role] = {"correct": ok, "n": len(rs), "pass": len(rs) >= 10 and ok >= 0.8 * len(rs),
                     "trust_median": statistics.median(trust) if trust else None,
                     "trust_range": [trust[0], trust[-1]] if trust else None}
    out["note"] = "Trust ratings are descriptive only (protocol 7.2)."
    _json(ws / "review_results.json", out)
    return out


# ------------------------------------------------------------- simulate
def simulate(ws: Path, seed: int = 2026, n_clean: int = 60) -> dict:
    """Fill every sheet with SIMULATED data in the real formats, then build the schedule from it."""
    init(ws)
    rng = random.Random(seed)
    reads = []
    for sid, bias in (("A", 300), ("B", -500)):
        for w in (10, 50, 100):
            for day in (1, 2, 3):
                for k in range(10):
                    v = Decimal(w) + (Decimal(bias) + Decimal(int(rng.gauss(0, 600)))) / UG_PER_UNIT["g"]
                    reads.append({"scale_id": sid, "day": day, "session": 1,
                                  "time": f"2026-11-0{day}T10:{k * 3:02d}:00", "check_weight_g": w,
                                  "reading_g": format(v.quantize(Decimal("0.001")), "f"),
                                  "tare": "yes" if k % 2 else "no", "note": f"SIMULATED {GEN_VERSION}"})
    _write(ws / "instrument_readings.csv", reads, SHEETS["instrument_readings.csv"])
    instrument(ws)
    sched = schedule(ws, seed=seed)
    key = [r for r in _read(ws / "sealed/fault_key.csv") if r["run_id"] != "NONCE"]
    runs, recs, gt, log = [], [], [], []

    def emit(run: Run, rid: str, session: str, phase: str):
        runs.append({"run_id": rid, "session": session, "date": "2026-11-20", "operator": "sim", "phase": phase,
                     "task": run.task, "metal": "silver", "wastage_min_pct": run.job["wastage_min_pct"],
                     "wastage_max_pct": run.job["wastage_max_pct"], "pieces_expected": run.job["pieces_expected"],
                     "note": f"SIMULATED {GEN_VERSION}"})
        for n, e in enumerate(run.events, 1):
            recs.append({"run_id": rid, "event_no": n, "event_type": e.event_type, "value": e.value_original,
                         "unit": e.unit_original, "fineness": str(e.fineness), "scale_id": "A",
                         "assay_method": e.assay_method, "pieces": e.pieces, "document": "", "timestamp": e.timestamp})
        gt.append({"run_id": rid, "true_unrecovered_fine_g": format(run.true_unrecovered_fine / UG_PER_UNIT["g"], "f"),
                   "closed_within_g": "0.002", "filled_by": "simulator", "note": "SIMULATED"})
        return {e.event_id: n for n, e in enumerate(run.events, 1)}

    for i in range(n_clean):
        emit(clean_run(seed, i), f"C{i + 1:03d}", f"S{i // 6 + 1:02d}", "clean")
    for i, k in enumerate(key):
        f = k["fault"]
        session = f"T{i // 6 + 1:02d}"
        if f == "control":
            emit(clean_run(seed + 5, i), k["run_id"], session, "fault-or-control")
            continue
        run = fault_run(seed, i, f, float(k["multiple"]) if k["multiple"] else None)
        pos = emit(run, k["run_id"], session, "fault-or-control")
        tgt = next((pos.get(t[1]) for t in run.truth if t[1]), "")
        log.append({"run_id": k["run_id"], "target_event_no": tgt, "actual_size_g": k["size_g"],
                    "injected_by": "simulator", "note": "SIMULATED"})
    _write(ws / "runs.csv", runs, SHEETS["runs.csv"])
    _write(ws / "records.csv", recs, SHEETS["records.csv"])
    _write(ws / "ground_truth.csv", gt, SHEETS["ground_truth.csv"])
    _write(ws / "sealed/injection_log.csv", log, SHEETS["sealed/injection_log.csv"])
    crs = [{"check_kind": kind, "rater_role": role, "rater_id": role[0] + "1",
            "minutes": max(1, m + rng.choice([-1, 0, 1])), "friction_0_to_5": fr, "note": "SIMULATED"}
           for kind, (m, fr) in checks_mod.DEFAULT_COSTS.items() for role in ("jeweller", "karigar")]
    _write(ws / "costs.csv", crs, SHEETS["costs.csv"])
    costs(ws)
    return {"clean": n_clean, "scheduled": sched["n_runs"], "dev_sessions": [f"S{i:02d}" for i in range(1, 6)]}


# ------------------------------------------------------------------ CLI
def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m tarazu.trial", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["init", "instrument", "costs", "schedule", "prereg", "verify", "blind",
                                        "phase3", "freeze", "evaluate", "review", "simulate", "baselines",
                                        "score-baselines", "figures", "card", "release"])
    ap.add_argument("--out", type=Path, default=None, help="release folder (release)")
    ap.add_argument("workspace", type=Path)
    ap.add_argument("--dev", nargs="*", default=[], help="development sessions (prereg)")
    ap.add_argument("--seed", type=int, default=None, help="only for dry runs; real schedules use system randomness")
    ap.add_argument("--allow-changed", action="store_true", help="evaluate even if integrity checks fail (reported)")
    a = ap.parse_args(argv)
    ws = a.workspace
    cmd = a.command
    if cmd == "init":
        r = {"created": init(ws)}
    elif cmd == "instrument":
        r = {k: {"u_mass_ug": v["u_mass_ug"], "warnings": v["warnings"]} for k, v in instrument(ws)["scales"].items()}
    elif cmd == "costs":
        r = costs(ws)
    elif cmd == "schedule":
        r = schedule(ws, seed=a.seed)
    elif cmd == "prereg":
        d = prereg(ws, a.dev)
        r = {"sha256": d["sha256"], "next": "commit PREREGISTRATION.md and prereg.json now"}
    elif cmd == "verify":
        diffs = verify(ws)
        print(json.dumps({"matches_preregistration": not diffs, "differences": diffs}, indent=2))
        return 1 if diffs else 0
    elif cmd == "blind":
        r = blind(ws)
    elif cmd == "phase3":
        r = phase3(ws, seed=a.seed)
    elif cmd == "freeze":
        r = freeze(ws)
    elif cmd == "evaluate":
        res = evaluate(ws, a.allow_changed)
        r = {"label": res["label"], "pass_fail": res["pass_fail"], "report": str(ws / "RESULTS.md")}
    elif cmd == "review":
        r = review(ws)
    elif cmd in ("baselines", "score-baselines", "figures", "card", "release"):
        from . import paper
        r = {"baselines": lambda: paper.baseline_sheets(ws, seed=a.seed),
             "score-baselines": lambda: paper.score_baselines(ws, a.allow_changed),
             "figures": lambda: paper.figures(ws), "card": lambda: paper.card(ws),
             "release": lambda: paper.release(ws, a.out or ws / "release")}[cmd]()
    else:
        r = simulate(ws, a.seed if a.seed is not None else 2026)
    print(json.dumps(r, indent=2, default=str, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
