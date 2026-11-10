"""Instrument uncertainty (protocol section 3 and Phase 0 of section 5).

One rule is used everywhere, in the app's calibration screen and in the trial
analysis, so the interval a karigar sees is the interval the paper reports:

    u = max(|bias| + 3 s, largest observed deviation, readability)

No Gaussian assumption is needed: the bound is the larger of a 3-sigma band
around the observed bias and the worst reading actually seen.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime
from typing import Iterable, Optional

# Half-width of the fineness interval by assay method (fraction, not per mil).
U_FINENESS = {"by construction": "0", "fire assay": "0.0005", "xrf": "0.002", "karat meter": "0.003",
              "declared": "0.003", "touchstone": "0.005"}


def bound(check_weight_ug: int, readings_ug: list[int], readability_ug: int = 1000) -> dict:
    """Empirical half-width from repeat readings of one certified check weight."""
    if len(readings_ug) < 2:
        raise ValueError("at least two readings are needed")
    devs = [r - check_weight_ug for r in readings_ug]
    bias = statistics.fmean(devs)
    sd = statistics.stdev(devs)
    max_dev = max(abs(d) for d in devs)
    u = int(max(abs(bias) + 3 * sd, max_dev, readability_ug))
    return {"n": len(devs), "bias_ug": round(bias, 1), "sd_ug": round(sd, 1), "max_dev_ug": max_dev, "u_mass_ug": u}


def _slope(xs: list[float], ys: list[float]) -> Optional[float]:
    """Least-squares slope, or None when x does not vary."""
    if len(xs) < 3:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx


def _hours(ts: str) -> Optional[float]:
    try:
        return datetime.fromisoformat(ts).timestamp() / 3600
    except (TypeError, ValueError):
        return None


def study(rows: Iterable[dict], readability_ug: int = 1000, min_n: int = 30, min_days: int = 3) -> dict:
    """Phase 0 instrument study.

    rows: dicts with scale_id, day, session, time (ISO), check_weight_ug, reading_ug and an
    optional tare ("yes"/"no"). Returns, per scale: the bound for every check weight, the
    scale's working half-width (the largest of them), drift within a session (ug per hour),
    linearity (bias change per gram of nominal mass), day-to-day spread of the mean
    deviation, the tare effect, and the protocol warnings that still apply.
    """
    by_scale: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_scale[r["scale_id"]].append(r)
    out = {}
    for sid, rs in sorted(by_scale.items()):
        weights = {}
        for w in sorted({r["check_weight_ug"] for r in rs}):
            reads = [r["reading_ug"] for r in rs if r["check_weight_ug"] == w]
            weights[str(w)] = bound(w, reads, readability_ug) if len(reads) >= 2 else {"n": len(reads)}
        drifts = []
        for (_day, _sess), grp in _groups(rs, ("day", "session")).items():
            pts = [(_hours(r.get("time")), r["reading_ug"] - r["check_weight_ug"]) for r in grp]
            pts = [(h, d) for h, d in pts if h is not None]
            s = _slope([h for h, _ in pts], [d for _, d in pts])
            if s is not None:
                drifts.append(s)
        means = {w: statistics.fmean(r["reading_ug"] - r["check_weight_ug"] for r in rs if r["check_weight_ug"] == int(w))
                 for w in weights}
        lin = _slope([int(w) / 1e6 for w in means], list(means.values())) if len(means) >= 3 else None
        day_means = [statistics.fmean(r["reading_ug"] - r["check_weight_ug"] for r in g)
                     for g in _groups(rs, ("day",)).values()]
        tare = {k: [r["reading_ug"] - r["check_weight_ug"] for r in rs if (r.get("tare") or "").lower() == k]
                for k in ("yes", "no")}
        tare_effect = (round(statistics.fmean(tare["yes"]) - statistics.fmean(tare["no"]), 1)
                       if tare["yes"] and tare["no"] else None)
        n_days = len({r["day"] for r in rs})
        warnings = [f"{w} ug check weight has {v['n']} readings (protocol: {min_n})"
                    for w, v in weights.items() if v["n"] < min_n]
        if n_days < min_days:
            warnings.append(f"readings span {n_days} day(s) (protocol: {min_days})")
        u = max((v.get("u_mass_ug", 0) for v in weights.values()), default=readability_ug)
        out[sid] = {
            "u_mass_ug": max(u, readability_ug), "weights": weights,
            "drift_ug_per_hour": round(max(drifts, key=abs), 1) if drifts else None,
            "linearity_ug_per_g": round(lin, 2) if lin is not None else None,
            "day_to_day_sd_ug": round(statistics.stdev(day_means), 1) if len(day_means) >= 2 else None,
            "tare_effect_ug": tare_effect, "days": n_days, "readings": len(rs), "warnings": warnings,
        }
    return out


def _groups(rows: list[dict], keys: tuple[str, ...]) -> dict:
    g: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        g[tuple(r.get(k) for k in keys)].append(r)
    return g
