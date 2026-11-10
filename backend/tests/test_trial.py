"""Trial toolkit: blinding, pre-registration, integrity checks and the full dry run."""
import csv
import itertools
import random
from decimal import Decimal

import pytest

from tarazu import trial
from tarazu.explain import Edit, Interval, feasible, minimal_sets_bruteforce
from tarazu.instrument import bound, study


@pytest.fixture(scope="module")
def ws(tmp_path_factory):
    w = tmp_path_factory.mktemp("trial")
    trial.simulate(w, seed=11, n_clean=36)
    trial.prereg(w, ["S01", "S02", "S03"])
    trial.blind(w)
    trial.phase3(w, per_class=4, n_pairs=3, cancelling=2, malformed=3, seed=11)
    trial.freeze(w)
    return w


def test_bound_rule_matches_protocol():
    r = bound(10_000_000, [10_000_400, 10_000_600, 9_999_800, 10_000_200, 10_000_500], readability_ug=1000)
    assert r["u_mass_ug"] == max(int(abs(r["bias_ug"]) + 3 * r["sd_ug"]), r["max_dev_ug"], 1000)


def test_instrument_study_flags_thin_data():
    rows = [{"scale_id": "A", "day": 1, "session": 1, "time": f"2026-11-01T10:0{i}:00",
             "check_weight_ug": 50_000_000, "reading_ug": 50_000_000 + 100 * i} for i in range(6)]
    rep = study(rows)["A"]
    assert rep["drift_ug_per_hour"] > 0
    assert any("readings" in w for w in rep["warnings"]) and any("day" in w for w in rep["warnings"])


def test_schedule_key_is_committed_and_hidden(ws):
    public = list(csv.DictReader(open(ws / "schedule.csv", encoding="utf-8")))
    assert "fault" not in public[0]
    assert trial._sha(ws / "sealed/fault_key.csv") == trial._load(ws / "schedule_commitment.json")["fault_key_sha256"]


def test_prereg_detects_changed_config(ws, monkeypatch):
    assert trial.verify(ws) == []
    monkeypatch.setattr(trial, "THRESHOLD", 0.8)
    assert any("threshold" in d for d in trial.verify(ws))


def test_evaluate_refuses_tampered_key(ws, tmp_path):
    import shutil
    w2 = tmp_path / "copy"
    shutil.copytree(ws, w2)
    with open(w2 / "sealed/fault_key.csv", "a", encoding="utf-8") as f:
        f.write("R999,F1,,,edited after the fact\n")
    with pytest.raises(SystemExit, match="commitment"):
        trial.evaluate(w2, sensitivity=False)


def test_evaluate_refuses_without_prereg(tmp_path):
    trial.init(tmp_path)
    with pytest.raises(SystemExit, match="pre-registered"):
        trial.evaluate(tmp_path, sensitivity=False)


def test_dry_run_scores_every_criterion(ws):
    res = trial.evaluate(ws, sensitivity=False)
    assert res["label"] == "SIMULATED"
    assert res["false_alerts"]["tarazu"]["n"] > 0 and res["coverage"]["n"] > 0
    assert res["malformed_rejected"]["k"] == res["malformed_rejected"]["n"] == 3
    assert set(res["pass_fail"]) >= {"false_alert_rate", "coverage", "localisation", "checks_reduction"}
    assert (ws / "RESULTS.md").read_text(encoding="utf-8").startswith("# Results · SIMULATED")


def test_blind_outputs_carry_code_version(ws):
    out = trial._load(next((ws / "outputs").glob("*.json")))
    assert out["code"] == trial.fingerprint()["combined"] and "report" in out


def test_exhaustive_enumeration_is_minimal_and_complete():
    rng = random.Random(3)
    for _ in range(25):
        cands = []
        for i in range(9):
            lo = Decimal(rng.randint(-50, 50))
            cands.append(Edit(f"k{i}", f"H{1 + i % 8}", f"e{i % 6}", lo, lo + rng.randint(0, 20), False))
        target = Interval(Decimal(rng.randint(30, 60)), Decimal(rng.randint(61, 90)))
        got = {frozenset(e.key for e in s) for s in minimal_sets_bruteforce(cands, target, 3)}
        want = set()
        for k in (1, 2, 3):
            for s in itertools.combinations(cands, k):
                ids = [e.event_id or e.hyp for e in s]
                if len(set(ids)) < k or not feasible(s, target):
                    continue
                keys = frozenset(e.key for e in s)
                if not any(w < keys for w in want):
                    want.add(keys)
        assert got == want
