"""Paper and release tooling for the physical trial (protocol sections 7.1, 8.4 and 11).

    baseline_sheets   identical case sheets for the chatbot (B3) and the human expert (B4)
    score_baselines   their answers scored against the sealed key, next to Tarazu on the same cases
    figures           the paper's charts as SVG, straight from results.json
    card              the dataset card
    release           the redacted public dataset with checksums

All of them read the same trial workspace as tarazu.trial.
"""
from __future__ import annotations

import hashlib
import random
import secrets
import shutil
from collections import Counter
from pathlib import Path
from typing import Optional

from . import __version__
from .harness import MULTIPLES, cp_upper
from .instrument import U_FINENESS
from .trial import SHEETS, _json, _load, _now, _read, _write, integrity

HYP_CHECK = {"H1": "count_pieces", "H2": "weigh_scrap_bag", "H3": "weigh_bench", "H4": "assay", "H5": "reweigh",
             "H6": "photo", "H7": "dup_match", "H8": "weigh_stones"}
CAUSES = {
    "H1": "A finished piece came back but was not logged", "H2": "Scrap or sweepings were not logged",
    "H3": "Metal is still at the bench", "H4": "A return's purity differs from what was written",
    "H5": "A weight was misread or a scale drifted", "H6": "A unit or typing slip on a slip",
    "H7": "A slip was entered twice", "H8": "Stones or fixtures were not deducted",
    "H9": "Process loss beyond the agreed wastage",
}
CHECKS = {
    "count_pieces": "Count finished pieces against the order sheet", "weigh_scrap_bag": "Weigh the scrap bag",
    "weigh_bench": "Weigh any item still at the bench", "assay": "Assay a return's purity",
    "reweigh": "Reweigh a return on a second scale", "photo": "Compare a slip photo with its entry",
    "dup_match": "Match timestamps and photos of two entries", "weigh_stones": "Weigh stones and findings",
}
# Colours for light-background figures (same hues as the pitch deck): Tarazu, fixed rule, plain ledger.
INK, MUTED, GRID = "#17231F", "#4F5A54", "#DCDDD4"
C_TARAZU, C_FIXED, C_PLAIN = "#A0741A", "#2C6FB0", "#C2456E"


# ------------------------------------------------------------ baselines
def _case_text(rid: str, run: dict, recs: list[dict]) -> str:
    rows = ["| # | Record | Value | Unit | Purity | Scale | Pieces |", "|---|---|---|---|---|---|---|"]
    rows += [f"| {r['event_no']} | {r['event_type']} | {r['value']} | {r['unit']} | {r['fineness']} | {r['scale_id']} | "
             f"{r['pieces'] or ''} |" for r in sorted(recs, key=lambda r: int(r["event_no"]))]
    return "\n".join([
        f"# Case {rid}", "",
        f"Metal: {run.get('metal') or 'silver'}. Agreed wastage: {run.get('wastage_min_pct') or 0}% to "
        f"{run.get('wastage_max_pct') or 0}% of the fine metal issued. Pieces ordered: {run.get('pieces_expected') or 'not given'}.",
        "Every scale reads to 0.001 g. Purity is written as a fraction (0.925 is sterling silver).", "",
        *rows, "",
        "The fine (pure) metal returned does not match the fine metal issued. Using only these records, answer:", "",
        "1. Which single cause best explains the difference? Give one code:",
        *[f"   - {k}: {v}" for k, v in CAUSES.items()],
        "2. If the cause is tied to one record, which record number?",
        "3. Which check should be done first? Give one code:",
        *[f"   - {k}: {v}" for k, v in CHECKS.items()],
        "", "Answer on one line as: cause, record number or blank, check.", ""])


def baseline_sheets(ws: Path, n: int = 18, seed: Optional[int] = None) -> dict:
    """The same blind cases for B3 and B4: single-fault test runs that Tarazu flagged, spread across classes.

    Case selection reads only eval_runs.json (written by evaluate), so it needs the key to have been opened
    already; the sheets themselves contain only the visible records.
    """
    ev = _load(ws / "eval_runs.json")
    if not ev:
        raise SystemExit("Run evaluate first: cases are drawn from the scored test runs")
    rng = random.Random(seed) if seed is not None else secrets.SystemRandom()
    by_class: dict[str, list[str]] = {}
    for rid, e in sorted(ev.items()):
        if e["fault"] and e["fault"] != "F10" and e["detected"]:
            by_class.setdefault(e["fault"], []).append(rid)
    picked, classes = [], sorted(by_class)
    while len(picked) < n and any(by_class.values()):
        for c in classes:
            if by_class[c] and len(picked) < n:
                picked.append(by_class[c].pop(rng.randrange(len(by_class[c]))))
    rng.shuffle(picked)
    runs = {r["run_id"]: r for r in _read(ws / "runs.csv") + _read(ws / "runs_phase3.csv")}
    recs: dict[str, list[dict]] = {}
    for r in _read(ws / "records.csv") + _read(ws / "records_phase3.csv"):
        recs.setdefault(r["run_id"], []).append(r)
    out = ws / "baselines"
    (out / "cases").mkdir(parents=True, exist_ok=True)
    for rid in picked:
        text = _case_text(rid, runs[rid], recs[rid])
        (out / "cases" / f"{rid}.md").write_text(text, encoding="utf-8")
    _write(out / "answers.csv", [], ["who", "answered_by", "case_id", "cause", "record_no", "first_check", "minutes", "note"])
    (out / "README.md").write_text("\n".join([
        "# Baseline sheets", "",
        "B3 (chatbot): paste each file in `cases/` into the model as it is, one case per fresh conversation.",
        "Log the model name and version in `answered_by`, and keep the full transcript.", "",
        "B4 (human expert): print the same files for a jeweller or accountant. Note the minutes taken.", "",
        "Write one row per case in `answers.csv`: who (B3 or B4), answered_by, case_id, cause (H1 to H9),",
        "record_no (blank if none), first_check (a check code), minutes, note.",
        "Then run: python -m tarazu.trial score-baselines <workspace>", ""]), encoding="utf-8")
    return {"cases": len(picked), "folder": str(out)}


def score_baselines(ws: Path, allow_changed: bool = False) -> dict:
    integrity(ws, allow_changed)
    ev = _load(ws / "eval_runs.json")
    answers = _read(ws / "baselines" / "answers.csv")
    if not answers:
        raise SystemExit("baselines/answers.csv has no answers yet")
    out: dict = {"created": _now()}
    for who in sorted({a["who"] for a in answers}):
        rows = [a for a in answers if a["who"] == who and a["case_id"] in ev]
        cause = loc = check = 0
        t_cause = t_check = 0
        for a in rows:
            e = ev[a["case_id"]]
            truth = e["truth"]
            hyps = {t[0] for t in truth}
            events = {t[1].rsplit("-e", 1)[-1] for t in truth if t[1]}
            cause += a["cause"].strip().upper() in hyps
            loc += bool(events) and a["record_no"].strip() in events
            check += a["first_check"].strip() in {HYP_CHECK.get(h) for h in hyps}
            t_cause += bool(e["top1"])
            t_check += e["first_check"] in {HYP_CHECK.get(h) for h in hyps}
        n = len(rows)
        mins = [float(a["minutes"]) for a in rows if a.get("minutes")]

        def rate(k):
            return {"k": k, "n": n, "rate": round(k / n, 4) if n else None, "upper95": round(cp_upper(k, n), 4)}
        out[who] = {"answered_by": sorted({a["answered_by"] for a in rows}), "cause": rate(cause), "record": rate(loc),
                    "first_check_separates": rate(check), "mean_minutes": round(sum(mins) / len(mins), 1) if mins else None,
                    "tarazu_same_cases": {"cause": rate(t_cause), "first_check_separates": rate(t_check)}}
    _json(ws / "baselines" / "baseline_results.json", out)
    L = ["# Baselines against Tarazu, same cases", "", "| Method | Cause right | Record right | First check separates | Minutes |",
         "|---|---|---|---|---|"]
    for who, v in out.items():
        if who == "created":
            continue
        f = lambda x: f"{x['k']} / {x['n']}"  # noqa: E731
        L.append(f"| {who} ({', '.join(v['answered_by'])}) | {f(v['cause'])} | {f(v['record'])} | "
                 f"{f(v['first_check_separates'])} | {v['mean_minutes']} |")
        t = v["tarazu_same_cases"]
        L.append(f"| Tarazu on the same cases | {f(t['cause'])} | n/a | {f(t['first_check_separates'])} | under 1 s |")
    L += ["", "If the expert (B4) matches Tarazu on cause and check count, report it as a negative result (protocol 7.3)."]
    (ws / "baselines" / "BASELINES.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    return out


# --------------------------------------------------------------- figures
def _svg(w: int, h: int, body: list[str], title: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'font-family="IBM Plex Sans, Arial, sans-serif" role="img" aria-label="{title}">'
            f'<rect width="{w}" height="{h}" fill="#FFFFFF"/>'
            f'<text x="24" y="34" font-size="18" font-weight="600" fill="{INK}">{title}</text>' + "".join(body) + "</svg>")


def _bars(items: list[tuple[str, float, str, str]], title: str, vmax: float, unit: str = "") -> str:
    """Horizontal bars: (label, value, colour, value text). Values are labelled; the axis is implicit."""
    w, row, x0, bw = 720, 46, 210, 420
    body = []
    for i, (label, v, col, txt) in enumerate(items):
        y = 64 + i * row
        width = 0 if vmax <= 0 else max(2, bw * v / vmax)
        body.append(f'<text x="{x0 - 12}" y="{y + 20}" font-size="14" text-anchor="end" fill="{INK}">{label}</text>')
        body.append(f'<rect x="{x0}" y="{y + 6}" width="{width:.1f}" height="22" rx="4" fill="{col}"/>')
        body.append(f'<text x="{x0 + width + 8:.1f}" y="{y + 22}" font-size="14" fill="{INK}">{txt}{unit}</text>')
    return _svg(w, 64 + row * len(items) + 24, body, title)


def _detection_curve(sweep: list[dict], label: str = "") -> str:
    w, h, x0, y0, pw, ph = 720, 430, 70, 92, 600, 270
    # Tarazu is drawn last so it stays visible where the lines overlap.
    series = [("Plain ledger (B0)", "B0", C_PLAIN), ("Fixed tolerance (B1)", "B1", C_FIXED), ("Tarazu", "tarazu", C_TARAZU)]
    xs = {m: x0 + pw * i / (len(MULTIPLES) - 1) for i, m in enumerate(MULTIPLES)}
    body = [f'<line x1="{x0}" y1="{y0 + ph}" x2="{x0 + pw}" y2="{y0 + ph}" stroke="{GRID}"/>']
    for f in (0, 0.5, 1):
        y = y0 + ph * (1 - f)
        body.append(f'<line x1="{x0}" y1="{y}" x2="{x0 + pw}" y2="{y}" stroke="{GRID}" stroke-dasharray="3 4"/>')
        body.append(f'<text x="{x0 - 10}" y="{y + 5}" font-size="13" text-anchor="end" fill="{MUTED}">{int(f * 100)}%</text>')
    for m, x in xs.items():
        body.append(f'<text x="{x}" y="{y0 + ph + 22}" font-size="13" text-anchor="middle" fill="{MUTED}">{m}×</text>')
    body.append(f'<text x="{x0 + pw / 2}" y="{h - 14}" font-size="13" text-anchor="middle" fill="{MUTED}">'
                "Fault size, in multiples of the measured scale uncertainty</text>")
    for k, (name, key, col) in enumerate(series):
        pts = []
        for m in MULTIPLES:
            cells = [s for s in sweep if s["multiple"] == m]
            n = sum(s["n"] for s in cells)
            if n:
                pts.append((xs[m], y0 + ph * (1 - sum(s[key] for s in cells) / n)))
        if pts:
            body.append(f'<polyline points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in pts)}" fill="none" stroke="{col}" stroke-width="2"/>')
            body += [f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4.5" fill="{col}" stroke="#FFFFFF" stroke-width="2"/>' for x, y in pts]
        lx = 24 + k * 190
        body.append(f'<rect x="{lx}" y="52" width="12" height="12" rx="2" fill="{col}"/>')
        body.append(f'<text x="{lx + 18}" y="62" font-size="13" fill="{INK}">{name}</text>')
    return _svg(w, h, body, "Share of faults detected, by size" + label)


def figures(ws: Path) -> dict:
    r = _load(ws / "results.json")
    if not r:
        raise SystemExit("Run evaluate first")
    out = ws / "figures"
    out.mkdir(exist_ok=True)
    label = " (SIMULATED)" if r["label"] == "SIMULATED" else ""
    fa = r["false_alerts"]
    made = {}

    def pct(x):
        return 100 * (x["rate"] or 0)
    made["false_alerts.svg"] = _bars(
        [("Plain ledger (B0)", pct(fa["B0_plain_ledger"]), C_PLAIN, f"{fa['B0_plain_ledger']['k']} of {fa['B0_plain_ledger']['n']}"),
         ("Fixed tolerance (B1)", pct(fa["B1_fixed_tolerance"]), C_FIXED, f"{fa['B1_fixed_tolerance']['k']} of {fa['B1_fixed_tolerance']['n']}"),
         ("Tarazu", pct(fa["tarazu"]), C_TARAZU, f"{fa['tarazu']['k']} of {fa['tarazu']['n']}, 95% upper bound "
                                                  f"{100 * fa['tarazu']['upper95']:.1f}%")],
        "False alerts on clean runs" + label, 100)
    if r["sweep"]:
        made["detection_by_size.svg"] = _detection_curve(r["sweep"], label)
    classes = [(f, c) for f, c in r["per_class"].items() if c["detected"]]
    made["coverage_by_class.svg"] = _bars(
        [(f, 100 * c["covered"] / c["detected"], C_TARAZU, f"{c['covered']} of {c['detected']}") for f, c in classes],
        "True cause among the explanations, by fault class" + label, 100)
    ch = r["checks"]
    made["checks_to_resolution.svg"] = _bars(
        [("Random order", ch["random"]["mean_checks"] or 0, C_PLAIN, f"{ch['random']['mean_checks']}"),
         ("Fixed checklist", ch["fixed"]["mean_checks"] or 0, C_FIXED, f"{ch['fixed']['mean_checks']}"),
         ("Tarazu", ch["best"]["mean_checks"] or 0, C_TARAZU, f"{ch['best']['mean_checks']}")],
        "Mean checks until one explanation remains" + label, max(v["mean_checks"] or 0 for v in ch.values()) * 1.15)
    for name, svg in made.items():
        (out / name).write_text(svg, encoding="utf-8")
    return {"figures": sorted(made), "folder": str(out)}


# ------------------------------------------------------- card and release
def card(ws: Path) -> dict:
    runs = _read(ws / "runs.csv") + _read(ws / "runs_phase3.csv")
    recs = _read(ws / "records.csv") + _read(ws / "records_phase3.csv")
    inst = _load(ws / "instrument_report.json").get("scales", {})
    res = _load(ws / "results.json")
    consent = _read(ws / "consent_log.csv")
    simulated = any("SIMULATED" in r.get("note", "") for r in runs)
    phases = Counter(r["phase"] for r in runs)
    tasks = Counter(r["task"] for r in runs if r.get("task"))
    units = Counter(r["unit"] for r in recs)
    L = [f"# Dataset card: Tarazu weighed job-work runs{' (SIMULATED)' if simulated else ''}", "",
         f"Created {_now()} with Tarazu {__version__}.", "",
         "## What it is", "",
         "Weighed silver job-work runs with blind, known faults, for testing tools that explain why the fine metal "
         "returned does not match the fine metal issued. Each run has the records as written on the slips, a sealed "
         "ground-truth balance, and, for fault runs, the fault label.", "",
         "## Contents", "",
         f"- Runs: {len(runs)} ({', '.join(f'{v} {k}' for k, v in sorted(phases.items()))})",
         f"- Records (slip lines): {len(recs)}; units as written: {', '.join(f'{k} {v}' for k, v in sorted(units.items()))}",
         f"- Task types: {', '.join(f'{k} {v}' for k, v in sorted(tasks.items())) or 'not recorded'}",
         f"- Sessions: {len({r['session'] for r in runs})}; operators: {len({r['operator'] for r in runs})}", "",
         "## Instruments", "", "| Scale | Half-width (µg) | Readings | Days | Drift (µg/h) | Linearity (µg/g) |",
         "|---|---|---|---|---|---|"]
    L += [f"| {k} | {v['u_mass_ug']} | {v['readings']} | {v['days']} | {v['drift_ug_per_hour']} | {v['linearity_ug_per_g']} |"
          for k, v in inst.items()]
    L += ["", "Rule: half-width = max(|bias| + 3 s, largest deviation, readability), from repeat readings of certified "
          "check weights.", "", "Purity half-widths by method: " + ", ".join(f"{k} {v}" for k, v in U_FINENESS.items()) + ".", "",
          "## Ground truth and faults", "",
          "Ground truth is the fine-metal balance closed to within scale uncertainty, written by a third person and sealed "
          "from the analyst. Faults were applied blind from a randomised schedule whose key was committed by SHA-256 "
          "before any run; record-level faults were applied to copies of clean test runs.", "",
          "## Consent and privacy", "",
          f"- Participants with recorded consent: {len(consent)}; withdrawn: {sum(1 for c in consent if c.get('withdrawn_on'))}",
          "- Names are replaced by codes before data leaves the workshop. Slip photos are not released.", "",
          "## Licence", "", "Data: Creative Commons Attribution 4.0 (CC BY 4.0). Code: MIT. Check both against any agreement "
          "with the participants before release.", "",
          "## Known limits", "",
          "- One site and one metal (silver) unless stated otherwise.",
          "- Two errors that cancel out are invisible by construction.",
          "- Check costs were estimated by the participants, not measured.", ""]
    if res:
        L += [f"Results file: results.json ({res['label']}), pre-registration `{res.get('preregistration')}`.", ""]
    (ws / "DATASET_CARD.md").write_text("\n".join(L), encoding="utf-8")
    return {"card": str(ws / "DATASET_CARD.md"), "runs": len(runs), "simulated": simulated}


def release(ws: Path, out: Path) -> dict:
    """Redacted public files: operator names to codes, slip photo paths removed, withdrawn people dropped."""
    integrity(ws)  # only after the key has legitimately been opened
    withdrawn = {c["participant_code"] for c in _read(ws / "consent_log.csv") if c.get("withdrawn_on")}
    runs = [r for r in _read(ws / "runs.csv") + _read(ws / "runs_phase3.csv") if r["operator"] not in withdrawn]
    keep = {r["run_id"] for r in runs}
    codes: dict[str, str] = {}
    for r in runs:
        r["operator"] = codes.setdefault(r["operator"], f"OP{len(codes) + 1:02d}")
    recs = [{**r, "document": "photo kept by the study" if r.get("document") else ""}
            for r in _read(ws / "records.csv") + _read(ws / "records_phase3.csv") if r["run_id"] in keep]
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    _write(out / "runs.csv", runs, SHEETS["runs.csv"])
    _write(out / "records.csv", recs, SHEETS["records.csv"])
    _write(out / "ground_truth.csv", [r for r in _read(ws / "ground_truth.csv") if r["run_id"] in keep],
           SHEETS["ground_truth.csv"])
    key = [r for r in _read(ws / "sealed/fault_key.csv") + _read(ws / "sealed/fault_key_phase3.csv")
           if r["run_id"] in keep]
    _write(out / "fault_labels.csv", key)
    _write(out / "instrument_readings.csv", _read(ws / "instrument_readings.csv"), SHEETS["instrument_readings.csv"])
    for f in ("results.json", "RESULTS.md", "PREREGISTRATION.md", "prereg.json", "schedule_commitment.json"):
        if (ws / f).exists():
            shutil.copy(ws / f, out / f)
    card(ws)
    shutil.copy(ws / "DATASET_CARD.md", out / "DATASET_CARD.md")
    sums = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()}
    (out / "SHA256SUMS").write_text("".join(f"{h}  {n}\n" for n, h in sums.items()), encoding="utf-8")
    return {"folder": str(out), "files": len(sums) + 1, "runs": len(runs), "dropped_withdrawn": len(withdrawn)}
