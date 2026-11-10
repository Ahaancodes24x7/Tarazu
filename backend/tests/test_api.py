import os
import sqlite3
import tempfile

import pytest

os.environ["TARAZU_DB"] = os.path.join(tempfile.mkdtemp(), "t.sqlite3")
os.environ["TARAZU_DATA"] = tempfile.mkdtemp()

from fastapi.testclient import TestClient  # noqa: E402

from tarazu.api import app, store  # noqa: E402

c = TestClient(app)


@pytest.fixture()
def job():
    jw = c.post("/api/parties", json={"name": "J", "role": "jeweller"}).json()
    k = c.post("/api/parties", json={"name": "K", "role": "karigar"}).json()
    j = c.post("/api/jobs", json={"title": "t", "karigar_id": k["party_id"], "jeweller_id": jw["party_id"],
                                  "metal": "gold", "fineness_default": "0.916", "pieces_expected": 1}).json()
    return j, k, jw


def ev(jid, **kw):
    body = {"event_type": "ISSUE", "value": "100", "unit": "g", "fineness": "0.916", "role": "jeweller"}
    body.update(kw)
    return c.post(f"/api/jobs/{jid}/events", json=body)


def test_full_flow_worked_example(job):
    j, k, jw = job
    jid = j["job_id"]
    assert ev(jid).status_code == 200
    assert ev(jid, event_type="RETURN_FINISHED", value="95", pieces=1).status_code == 200
    assert ev(jid, event_type="RETURN_SCRAP", value="4").status_code == 200
    d = c.get(f"/api/jobs/{jid}").json()
    rep = d["report"]
    assert rep["balance"]["verdict"] == "unaccounted"
    assert rep["balance"]["excess_g"] == "0.9160"
    assert "0.916 g fine gold is unaccounted for" in rep["narration"][0]
    nc = rep["investigation"]["next_check"]
    assert nc and nc["outcomes"]
    # settlement refused while unbalanced
    assert c.post(f"/api/jobs/{jid}/settlements").status_code == 409
    # answer the check: scrap found
    r = c.post(f"/api/jobs/{jid}/checks", json={"check_id": "weigh_scrap_bag", "outcome": "unlogged scrap found"})
    assert r.status_code == 200
    rep = c.get(f"/api/jobs/{jid}").json()["report"]
    assert rep["investigation"]["status"] == "resolved"
    best = rep["investigation"]["best"]
    assert "H2" in best
    # apply with the measured bag weight -> balance closes
    r = c.post(f"/api/jobs/{jid}/apply", json={"key": best, "mass_g": "1.000", "role": "jeweller"})
    assert r.status_code == 200, r.text
    rep = c.get(f"/api/jobs/{jid}").json()["report"]
    assert rep["balance"]["verdict"] == "balanced"
    # settlement is a draft until both approve
    s = c.post(f"/api/jobs/{jid}/settlements").json()
    assert s["status"] == "draft"
    s = c.post(f"/api/settlements/{s['settlement_id']}/approve", json={"role": "jeweller"}).json()
    assert s["status"] == "draft"
    s = c.post(f"/api/settlements/{s['settlement_id']}/approve", json={"role": "karigar"}).json()
    assert s["status"] == "final"


def test_malformed_input(job):
    jid = job[0]["job_id"]
    assert ev(jid, fineness="").status_code == 422  # blank fineness
    assert ev(jid, value="0").status_code == 422  # zero weight
    assert ev(jid, value="-3").status_code == 422  # negative return
    assert ev(jid, unit="").status_code == 422  # unit missing
    assert ev(jid, fineness="92.5").status_code == 422
    assert ev(jid, event_type="CORRECTION", value="3").status_code == 422  # must point at a parent
    assert ev(jid, value="abc").status_code == 422


def test_events_are_append_only(job):
    jid = job[0]["job_id"]
    e = ev(jid).json()
    with pytest.raises(sqlite3.DatabaseError):
        store.db.execute("UPDATE events SET mass_ug=1 WHERE event_id=?", (e["event_id"],))
    with pytest.raises(sqlite3.DatabaseError):
        store.db.execute("DELETE FROM events WHERE event_id=?", (e["event_id"],))
    store.db.rollback()


def test_karigar_sees_only_own_account(job):
    j, k, jw = job
    other = c.post("/api/parties", json={"name": "K2", "role": "karigar"}).json()
    assert c.get(f"/api/jobs/{j['job_id']}?viewer={other['party_id']}").status_code == 403
    assert c.get(f"/api/jobs/{j['job_id']}?viewer={k['party_id']}").status_code == 200
    assert all(x["karigar_id"] == other["party_id"] for x in c.get(f"/api/jobs?karigar_id={other['party_id']}").json())


def test_same_explanation_for_both_sides(job):
    j, k, jw = job
    jid = j["job_id"]
    ev(jid)
    ev(jid, event_type="RETURN_FINISHED", value="99", pieces=1)
    a = c.get(f"/api/jobs/{jid}?viewer={k['party_id']}").json()["report"]
    b = c.get(f"/api/jobs/{jid}?viewer={jw['party_id']}").json()["report"]
    a.pop("latency_ms"), b.pop("latency_ms")
    assert a == b


def test_export_and_convert(job):
    j, k, _ = job
    ev(j["job_id"])
    r = c.get(f"/api/parties/{k['party_id']}/export?format=csv")
    assert r.status_code == 200 and "ISSUE" in r.text
    assert c.get(f"/api/parties/{k['party_id']}/export").json()["jobs"]
    cv = c.post("/api/convert", json={"value": "1", "unit": "tola"}).json()
    assert cv["units"]["g"] == "11.6638"


def test_calibration():
    i = c.post("/api/instruments", json={"name": "S"}).json()
    r = c.post(f"/api/instruments/{i['instrument_id']}/calibrate",
               json={"check_weight_g": "10", "readings_g": ["10.001", "9.999", "10.000", "10.002", "10.000", "9.998"]})
    assert r.status_code == 200
    assert r.json()["u_mass_ug"] >= 2000


def test_quick_and_demo():
    r = c.post("/api/quick", json={"events": [{"event_type": "ISSUE", "value": "10"},
                                              {"event_type": "RETURN_FINISHED", "value": "9.5"}], "lang": "hi"})
    assert r.status_code == 200 and r.json()["balance"]["verdict"] == "unaccounted"
    assert c.post("/api/demo/seed").json()["seeded"]
    assert len(c.get("/api/jobs").json()) >= 5


def test_summary_and_detail_expose_review_fields(job):
    """Read-only fields the redesigned workbench uses: last update, settlement approvals, record times."""
    j, k, jw = job
    jid = j["job_id"]
    ev(jid)
    ev(jid, event_type="RETURN_FINISHED", value="91.6", fineness="1", pieces=1)
    s = next(x for x in c.get("/api/jobs").json() if x["job_id"] == jid)
    assert s["updated_at"] >= s["created_at"]
    assert s["settlement"] is None and s["settlement_approvals"] is None
    d = c.get(f"/api/jobs/{jid}").json()
    e0 = d["report"]["events"][0]
    assert e0["created_at"] and e0["approved_jeweller_at"] and e0["approved_karigar_at"] is None  # creator approves own slip
    st = c.post(f"/api/jobs/{jid}/settlements").json()
    c.post(f"/api/settlements/{st['settlement_id']}/approve", json={"role": "jeweller"})
    s = next(x for x in c.get("/api/jobs").json() if x["job_id"] == jid)
    assert s["settlement"] == "draft"
    assert s["settlement_approvals"]["jeweller_at"] and not s["settlement_approvals"]["karigar_at"]


def test_convert_fine_metal_is_computed_server_side():
    r = c.post("/api/convert", json={"value": "1", "unit": "tola", "fineness": "0.916"}).json()
    assert r["fine_g"] == "10.6840"  # 11.6638 g x 0.916, rounded half-even to 0.1 mg
    assert "fine_g" not in c.post("/api/convert", json={"value": "1", "unit": "tola"}).json()
    assert c.post("/api/convert", json={"value": "1", "unit": "g", "fineness": "1.2"}).status_code == 422
