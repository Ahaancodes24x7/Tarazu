from decimal import Decimal

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from tarazu.analysis import analyse
from tarazu.checks import advise, apply_outcome, build_checks, info_gain, simulate
from tarazu.explain import HAVE_CPSAT, Config, Edit, explain, minimal_sets_bruteforce, minimal_sets_cpsat
from tarazu.ledger import Event, Interval, compute_balance, effective_ledger, fine_interval
from tarazu.units import to_ug
from tarazu.wording import FORBIDDEN, LANGS, narrate


def E(i, t, v, unit="g", phi="0.925", u="0.002", **k):
    return Event(i, "j", t, to_ug(v, unit), Decimal(phi), to_ug(u, "g"), Decimal(0),
                 value_original=str(v), unit_original=unit, **k)


def bal(evs, wmin=0, wmax=0):
    eff = effective_ledger(evs)
    return eff, compute_balance(eff, wmin, wmax)


# ------------------------------------------------------------------- units
def test_units():
    assert to_ug("1", "tola") == 11_663_800
    assert to_ug("12", "masha") == 11_663_800
    assert to_ug("96", "ratti") == 11_663_800
    assert to_ug("1.5", "g") == 1_500_000
    assert to_ug(0.1, "g") == 100_000  # floats go through repr, not binary noise
    with pytest.raises(ValueError):
        to_ug("1", "seer")


# ---------------------------------------------------------- worked example
def test_worked_example_section_3():
    evs = [E("i", "ISSUE", "100", phi="0.916", u="0"), E("r", "RETURN_FINISHED", "95", phi="0.916", u="0"),
           E("s", "RETURN_SCRAP", "4", phi="0.916", u="0")]
    _, b = bal(evs)
    assert b.fine_in == Decimal("91600000.000")
    assert b.raw == Decimal("916000.000")  # 0.916 g fine
    assert b.verdict == "unaccounted"
    _, b2 = bal(evs + [E("w", "WIP_HOLD", "1", phi="0.916", u="0")])
    assert b2.raw == 0 and b2.verdict == "balanced"


def test_worked_example_lists_alternatives():
    evs = [E("i", "ISSUE", "100", phi="0.916"), E("r", "RETURN_FINISHED", "95", phi="0.916", pieces=1),
           E("s", "RETURN_SCRAP", "4", phi="0.916")]
    eff, b = bal(evs)
    res = explain(eff, b)
    hyps = {h for x in res.explanations for h in x.hyps}
    assert {"H2", "H3", "H5"} <= hyps  # unlogged scrap, WIP, misread weight are all shown


# ------------------------------------------------ property-based conservation
masses = st.integers(min_value=1, max_value=200_000_000)
phis = st.sampled_from(["0.916", "0.925", "0.999", "0.750", "0.650"])


@settings(max_examples=200, deadline=None)
@given(st.lists(st.tuples(masses, phis), min_size=1, max_size=6), st.data())
def test_fine_metal_conserved(issues, data):
    """If every microgram of fine metal issued comes back, the residual is exactly zero."""
    evs = []
    total_fine = Decimal(0)
    for k, (m, p) in enumerate(issues):
        evs.append(Event(f"i{k}", "j", "ISSUE", m, Decimal(p)))
        total_fine += Decimal(m) * Decimal(p)
    # copper alloy adds weight but no fine metal
    cu = data.draw(st.integers(min_value=0, max_value=5_000_000))
    evs.append(Event("cu", "j", "ALLOY_ADD", cu, Decimal(0)))
    # every issued lot comes back, split between finished work and scrap in any proportion
    fine_ret = Decimal(0)
    for k, (m, p) in enumerate(issues):
        cut = data.draw(st.integers(min_value=0, max_value=m))
        for kind, mm in (("RETURN_FINISHED", cut), ("RETURN_SCRAP", m - cut)):
            evs.append(Event(f"r{k}{kind}", "j", kind, mm, Decimal(p)))
            fine_ret += Decimal(mm) * Decimal(p)
    _, b = bal(evs)
    assert b.raw == total_fine - fine_ret == 0
    assert b.residual.contains(0)
    assert b.verdict == "balanced"


@settings(max_examples=200, deadline=None)
@given(masses, phis, st.integers(min_value=0, max_value=50_000), st.integers(min_value=0, max_value=20))
def test_interval_contains_point(m, p, u, uf):
    e = Event("x", "j", "ISSUE", m, Decimal(p), u, Decimal(uf) / 1000)
    fi = fine_interval(e)
    assert fi.lo <= Decimal(m) * Decimal(p) <= fi.hi


@settings(max_examples=150, deadline=None)
@given(st.integers(min_value=10_000_000, max_value=100_000_000), st.integers(min_value=-3000, max_value=3000))
def test_residual_inside_noise_never_flagged(m, noise):
    """A return that differs from the issue by less than the scale half-widths is never flagged."""
    evs = [Event("i", "j", "ISSUE", m, Decimal("0.925"), 2000),
           Event("r", "j", "RETURN_FINISHED", m + noise, Decimal("0.925"), 2000)]
    _, b = bal(evs)
    if abs(noise) <= 4000:
        assert b.verdict == "balanced"


def test_alloy_changes_weight_not_fine():
    evs = [E("i", "ISSUE", "50"), E("cu", "ALLOY_ADD", "2", phi="0"),
           Event("r", "j", "RETURN_FINISHED", to_ug("52", "g"), Decimal("50") * Decimal("0.925") / Decimal("52"), 0)]
    _, b = bal(evs)
    assert abs(b.raw) < Decimal("0.001")


# ------------------------------------------------------------ append-only
def test_corrections_are_new_events():
    evs = [E("i", "ISSUE", "10"), E("r", "RETURN_FINISHED", "19", u="0")]
    evs.append(Event("c", "j", "CORRECTION", to_ug("9", "g"), Decimal(0), parent_event_id="r",
                     value_original="9", unit_original="g"))
    eff, b = bal(evs)
    r = next(x for x in eff if x.id == "r")
    assert r.event.mass_ug == 9_000_000 and r.history == ("c",)
    assert evs[1].mass_ug == 19_000_000  # the source is untouched
    evs.append(Event("v", "j", "CORRECTION", 0, Decimal(0), parent_event_id="c", void=True))
    eff, b = bal(evs)
    assert next(x for x in eff if x.id == "r").voided


def test_malformed_events_rejected():
    with pytest.raises(ValueError):
        Event("x", "j", "RETURN_FINISHED", -5, Decimal("0.925"))
    with pytest.raises(ValueError):
        Event("x", "j", "ISSUE", 5, Decimal("92.5"))
    with pytest.raises(ValueError):
        Event("x", "j", "BOGUS", 5, Decimal("0.9"))
    with pytest.raises(ValueError):
        effective_ledger([Event("c", "j", "CORRECTION", 1, Decimal(0), parent_event_id="nope")])


# ------------------------------------------------- explanation per fault class
BASE = [("i", "ISSUE", "80.000"), ("r1", "RETURN_FINISHED", "40.100"), ("r2", "RETURN_FINISHED", "38.700"),
        ("s", "RETURN_SCRAP", "1.170")]


def base(**over):
    out = []
    for i, t, v in BASE:
        kw = {"pieces": 1} if t == "RETURN_FINISHED" else {}
        kw.update(over.get(i, {}))
        out.append(E(i, t, kw.pop("v", v), document_id=f"d-{i}", **kw))
    return out


def keys(evs, pieces=0, cfg=None):
    eff, b = bal(evs, 0, "0.05")
    res = explain(eff, b, cfg, pieces)
    return b, res, {(e.hyp, e.event_id) for x in res.explanations for e in x.edits}


def test_clean_base_is_balanced():
    b, res, _ = keys(base())
    assert b.verdict == "balanced" and res.status == "balanced"


@pytest.mark.parametrize("fault,expect", [
    ("F2", ("H2", None)), ("F3", ("H3", None)), ("F5", ("H5", "r1")), ("F6", ("H8", "r1")),
    ("F7", ("H6", "r2")), ("F8", ("H7", "dup")), ("F9", ("H6", "i")), ("F1", ("H1", None)), ("F4", ("H4", "r1")),
])
def test_fault_class_listed(fault, expect):
    evs = base()
    pieces = 0
    if fault == "F1":
        evs = [e for e in evs if e.event_id != "r2"]
        pieces = 2
    elif fault == "F2":
        evs = [e for e in evs if e.event_id != "s"]
    elif fault == "F3":
        evs = base(r1={"v": "39.100"})
    elif fault == "F5":
        evs = base(r1={"v": "40.300"})
    elif fault == "F6":
        evs = base(r1={"v": "40.450"})
    elif fault == "F4":
        evs = base(r1={"v": "40.700"})  # copper added, slip still says 0.925
    elif fault == "F7":
        evs = base(r2={"v": "37.800"})  # true 38.700, digits 8 and 7 swapped
        evs[2] = Event("r2", "j", "RETURN_FINISHED", to_ug("37.800", "g"), Decimal("0.925"), 2000,
                       value_original="37.800", pieces=1, document_id="d-r2")
    elif fault == "F8":
        r2 = evs[2]
        evs.append(Event("dup", "j", r2.event_type, r2.mass_ug, r2.fineness, r2.u_mass_ug,
                         value_original=r2.value_original, document_id=r2.document_id, pieces=1))
    elif fault == "F9":
        # the slip says 7 tola (81.6466 g); it was keyed as 70 g
        evs = base(s={"v": "2.822"})
        evs[0] = Event("i", "j", "ISSUE", to_ug("70", "g"), Decimal("0.925"), 2000, value_original="70",
                       unit_original="g", document_id="d-i")
        expect = ("H6", "i")
    b, res, ks = keys(evs, pieces)
    assert b.verdict != "balanced", fault
    assert expect in ks, (fault, ks)


def test_h1_excluded_when_piece_count_matches():
    evs = [e for e in base() if e.event_id != "s"]
    _, _, ks = keys(evs, pieces=2)
    assert ("H1", None) not in ks
    assert ("H2", None) in ks


def test_near_duplicate_with_distinct_photos_not_flagged():
    evs = base()
    r2 = evs[2]
    evs.append(Event("twin", "j", r2.event_type, r2.mass_ug, r2.fineness, r2.u_mass_ug,
                     value_original=r2.value_original, document_id="different-photo", pieces=1))
    _, _, ks = keys(evs)
    assert ("H7", "twin") not in ks


def test_explanations_are_minimal_and_physical():
    evs = base(r1={"v": "41.300"})
    eff, b = bal(evs, 0, "0.05")
    res = explain(eff, b, Config(max_set_size=3))
    found = [frozenset(e.key for e in x.edits) for x in res.explanations if not x.last_resort]
    for s in found:
        for t in found:
            if s != t:
                assert not s < t, "a superset of another explanation was kept"
    from tarazu.analysis import split_effect
    from tarazu.explain import apply_edit_preview
    for x in res.explanations:
        for e, amt in zip(x.edits, split_effect(x)):
            p = apply_edit_preview(e, amt, eff)
            if e.hyp == "H4":  # implied fineness stays inside 0.5..1.0
                assert Decimal("0.5") <= Decimal(p["new_fineness"]) <= 1
            if e.hyp == "H5":  # no negative masses
                assert p["new_mass_ug"] > 0
            if e.hyp in ("H1", "H2", "H3"):  # cannot add more metal than was issued
                assert Decimal(p["add_fine_ug"]) <= b.fine_in


@pytest.mark.skipif(not HAVE_CPSAT, reason="OR-Tools not installed")
def test_cpsat_agrees_with_bruteforce():
    evs = base(r1={"v": "41.900"}, s={"v": "0.150"})
    eff, b = bal(evs, 0, "0.05")
    from tarazu.explain import candidate_edits
    cfg = Config(max_set_size=2)
    c = candidate_edits(eff, b, cfg)
    target = Interval(-b.residual.hi, -b.residual.lo)
    bf = {frozenset(e.key for e in s) for s in minimal_sets_bruteforce(c, target, 2)}
    cp = {frozenset(e.key for e in s) for s in minimal_sets_cpsat(c, target, cfg, limit=10_000, time_limit_s=20)}
    assert bf == cp


# ----------------------------------------------------------------- checks
def test_check_selection_separates_scrap_from_wip():
    evs = [e for e in base() if e.event_id != "s"]
    eff, b = bal(evs, 0, "0.05")
    res = explain(eff, b, None, 2)
    xs = [x for x in res.explanations if not x.last_resort]
    checks = build_checks(xs, eff)
    adv = advise(xs, checks, set())
    assert adv.status == "ask"
    assert adv.check.kind in ("weigh_scrap_bag", "weigh_bench", "photo", "reweigh")
    assert adv.gain > 0
    # truth: unlogged scrap
    truth = (Edit("t", "H2", None, Decimal(0), Decimal(0), True),)
    sim = simulate(xs, checks, truth, "best")
    assert sim["status"] == "resolved" and "H2" in sim["best"].hyps


def test_abstains_when_inseparable():
    a = Edit("a", "H2", None, Decimal(-5), Decimal(0), False)
    from tarazu.explain import Explanation
    xs = [Explanation((a,), 1.0, Decimal(-1), 0.5), Explanation((Edit("b", "H3", None, Decimal(-5), Decimal(0), False),), 1.0, Decimal(-1), 0.5)]
    adv = advise(xs, [], set())
    assert adv.status == "abstain"


# ---------------------------------------------------------------- wording
@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("verdict", ["balanced", "unaccounted", "surplus"])
def test_wording_never_accuses(lang, verdict):
    for status in (None, "resolved", "abstain", "unexplained"):
        lines = narrate(verdict, Decimal(916000), Decimal(910000), Decimal(921000), "silver", lang, 3,
                        ("x", 50), "check", status, ["a", "b"])
        text = " ".join(lines).lower()
        for w in FORBIDDEN:
            assert w not in text, (lang, w)


def test_report_numbers_identical_across_languages():
    evs = [E("i", "ISSUE", "100", phi="0.916"), E("r", "RETURN_FINISHED", "95", phi="0.916"),
           E("s", "RETURN_SCRAP", "4", phi="0.916")]
    reps = [analyse(evs, {"metal": "gold"}, lang=l) for l in LANGS]
    assert len({r["balance"]["excess_g"] for r in reps}) == 1
    for r in reps:
        assert "0.916" in r["narration"][0]


def test_latency_30_events():
    from tarazu.harness import latency_probe
    assert latency_probe()["under_2s"]
