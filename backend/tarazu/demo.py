"""Demo workshop. Every party, job and event here is SIMULATED and labelled so."""
from __future__ import annotations

from decimal import Decimal

from .ledger import Event
from .store import Store, new_id
from .units import to_ug


def _ev(jid, kid, et, value, unit="g", phi="0.925", u="0.002", uphi="0", doc="", pieces=0, note="",
        ts="", parent="", void=False):
    return Event(new_id("ev"), jid, et, to_ug(value, unit) if value else 0, Decimal(phi), to_ug(u, "g"),
                 Decimal(uphi), party_id=kid, value_original=str(value), unit_original=unit,
                 assay_method="declared", instrument_id="", document_id=doc, parent_event_id=parent,
                 timestamp=ts, pieces=pieces, note=note, void=void, simulated=True)


def seed_demo(store: Store) -> dict:
    if any(p["name"].endswith("(demo)") for p in store.parties()):
        return {"seeded": False, "message": "Demo workshop already exists"}
    jw = store.add_party("Mehra Jewellers (demo)", "jeweller", "J-01")
    k1 = store.add_party("Karigar K-01 (demo)", "karigar", "K-01")
    k2 = store.add_party("Karigar K-02 (demo)", "karigar", "K-02")
    store.add_instrument("Scale A, 0.001 g (demo)", 1000, 2000, "entered by hand")
    store.add_instrument("Scale B, 0.001 g (demo)", 1000, 2000, "entered by hand")
    out = []

    def job(title, kid, metal="silver", phi="0.925", wmin="0", wmax="0", pieces=0, events=()):
        j = store.add_job(f"{title} (demo)", kid["party_id"], jw["party_id"], metal, phi, wmin, wmax, pieces,
                          simulated=True)
        for e in events(j["job_id"], kid["party_id"]):
            store.add_event(e, "jeweller")
            store.approve_event(e.event_id, "jeweller")
        out.append(j["job_id"])
        return j

    # 1. The protocol's worked example: 0.916 g unaccounted in 22 K gold.
    job("Worked example: 22 K bangle", k1, "gold", "0.916", pieces=1, events=lambda j, k: [
        _ev(j, k, "ISSUE", "100", phi="0.916", ts="2026-11-02T10:05:00", doc="slip-101"),
        _ev(j, k, "RETURN_FINISHED", "95", phi="0.916", pieces=1, ts="2026-11-05T17:40:00", doc="slip-102"),
        _ev(j, k, "RETURN_SCRAP", "4", phi="0.916", ts="2026-11-05T17:42:00", doc="slip-103"),
    ])
    # 2. Unit confusion: scrap written in masha, entered as grams.
    job("Payal pair, sterling", k1, wmax="0.05", pieces=2, events=lambda j, k: [
        _ev(j, k, "ISSUE", "62.400", ts="2026-11-03T09:30:00", doc="slip-201"),
        _ev(j, k, "RETURN_FINISHED", "30.112", pieces=1, ts="2026-11-06T16:00:00", doc="slip-202"),
        _ev(j, k, "RETURN_FINISHED", "29.874", pieces=1, ts="2026-11-06T16:01:00", doc="slip-203"),
        _ev(j, k, "RETURN_SCRAP", "2.47", ts="2026-11-06T16:05:00", doc="slip-204",
            note="Karigar notebook says 2.47 (unit not written)"),
    ])
    # 3. Duplicate slip: the same return keyed twice from one slip.
    job("Chain links, sterling", k2, wmax="0.05", pieces=3, events=lambda j, k: [
        _ev(j, k, "ISSUE", "48.000", ts="2026-11-01T11:00:00", doc="slip-301"),
        _ev(j, k, "RETURN_FINISHED", "20.150", pieces=1, ts="2026-11-04T15:10:00", doc="slip-302"),
        _ev(j, k, "RETURN_FINISHED", "12.020", pieces=1, ts="2026-11-04T15:12:00", doc="slip-303"),
        _ev(j, k, "RETURN_FINISHED", "15.380", pieces=1, ts="2026-11-04T15:14:00", doc="slip-304"),
        _ev(j, k, "RETURN_SCRAP", "0.432", ts="2026-11-04T15:20:00", doc="slip-305"),
        _ev(j, k, "RETURN_FINISHED", "12.020", pieces=1, ts="2026-11-04T15:12:00", doc="slip-303"),
    ])
    # 4. Clean job inside the agreed wastage band: ready to settle.
    job("Toe rings, sterling", k2, wmax="0.5", pieces=4, events=lambda j, k: [
        _ev(j, k, "ISSUE", "40.000", ts="2026-11-02T10:00:00", doc="slip-401"),
        _ev(j, k, "RETURN_FINISHED", "9.802", pieces=1, ts="2026-11-05T12:00:00", doc="slip-402"),
        _ev(j, k, "RETURN_FINISHED", "9.911", pieces=1, ts="2026-11-05T12:01:00", doc="slip-403"),
        _ev(j, k, "RETURN_FINISHED", "9.756", pieces=1, ts="2026-11-05T12:02:00", doc="slip-404"),
        _ev(j, k, "RETURN_FINISHED", "9.843", pieces=1, ts="2026-11-05T12:03:00", doc="slip-405"),
        _ev(j, k, "RETURN_SCRAP", "0.598", ts="2026-11-05T12:10:00", doc="slip-406"),
    ])
    # 5. Stone left in a piece: more metal recorded as returned than was issued.
    job("Pendant with stone, sterling", k1, wmax="0.1", pieces=1, events=lambda j, k: [
        _ev(j, k, "ISSUE", "25.000", ts="2026-11-04T10:00:00", doc="slip-501"),
        _ev(j, k, "ALLOY_ADD", "0.400", phi="0.650", ts="2026-11-04T13:00:00", doc="slip-502",
            note="Silver solder, 65% silver"),
        _ev(j, k, "RETURN_FINISHED", "25.525", phi="0.9205", pieces=1, ts="2026-11-07T18:00:00", doc="slip-503"),
        _ev(j, k, "RETURN_SCRAP", "0.215", phi="0.9205", ts="2026-11-07T18:05:00", doc="slip-504"),
    ])
    return {"seeded": True, "jobs": out, "jeweller": jw["party_id"], "karigars": [k1["party_id"], k2["party_id"]]}
