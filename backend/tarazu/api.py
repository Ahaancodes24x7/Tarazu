"""FastAPI service. Serves the API under /api and the front end at /."""
from __future__ import annotations

import csv
import io
import json
import os
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .analysis import analyse, split_effect
from .checks import DEFAULT_COSTS, FRICTION_MINUTES
from .explain import HYPOTHESES, Config, explain
from .instrument import U_FINENESS, bound
from .ledger import EVENT_TYPES, Event, compute_balance, effective_ledger
from .store import Store, new_id, now
from .units import UG_PER_UNIT, fmt_g, from_ug, to_ug
from .wording import CHECK_TEXT, HYP_TEXT, LANGS, TYPE_LABEL

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("TARAZU_DATA", ROOT / "data"))
FRONT = ROOT / "frontend"
store = Store(os.environ.get("TARAZU_DB", DATA / "tarazu.sqlite3"))
SLIPS = DATA / "slips"
SLIPS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Tarazu", version=__version__,
              description="Fine-metal dispute investigator. Weighs the evidence; never accuses.")
_last_harness: dict = {}

_COMPRESSED = (".woff2", ".png", ".jpg", ".jpeg", ".webp", ".wasm", ".zip", ".whl")


def _install_transport(app_) -> None:
    """Server only: gzip text responses and set caching rules (the app's in-process dispatcher needs neither).

    Pages, scripts and styles revalidate with their ETag on every load (a 304 costs a few bytes), so an
    update is never stuck behind a cache. Fonts have content-hashed names and are cached for a year.
    """
    if not hasattr(app_, "add_middleware"):
        return
    from starlette.middleware.gzip import GZipMiddleware

    class _Gzip(GZipMiddleware):
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"].endswith(_COMPRESSED):
                return await self.app(scope, receive, send)
            return await super().__call__(scope, receive, send)

    @app_.middleware("http")
    async def _cache_headers(request, call_next):
        res = await call_next(request)
        p = request.url.path
        if p.startswith("/api/"):
            res.headers.setdefault("Cache-Control", "no-store")
        elif p.startswith("/assets/fonts/"):
            res.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            res.headers["Cache-Control"] = "no-cache"
        return res

    app_.add_middleware(_Gzip, minimum_size=800, compresslevel=6)


_install_transport(app)

DEFAULT_U_FINENESS = U_FINENESS


def bad(msg: str, code: int = 422):
    raise HTTPException(code, msg)


def dec(x, name: str) -> Decimal:
    try:
        return Decimal(str(x).strip())
    except (InvalidOperation, AttributeError):
        bad(f"{name} must be a number")


# ------------------------------------------------------------------ meta
@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__}


@app.get("/api/meta")
def meta():
    return {"hypotheses": HYPOTHESES, "hyp_text": HYP_TEXT, "check_text": CHECK_TEXT, "type_label": TYPE_LABEL,
            "event_types": sorted(EVENT_TYPES), "units": list(UG_PER_UNIT), "langs": LANGS,
            "check_costs": DEFAULT_COSTS, "friction_minutes": FRICTION_MINUTES,
            "assay_methods": DEFAULT_U_FINENESS, "version": __version__}


class ConvertIn(BaseModel):
    value: str
    unit: str = "g"
    fineness: Optional[str] = None


@app.post("/api/convert")
def convert(body: ConvertIn):
    try:
        ug = to_ug(body.value, body.unit)
    except Exception as e:
        bad(str(e))
    out = {"ug": ug, "units": {u: str(from_ug(ug, u).quantize(Decimal("0.0001"))) for u in
                               ("g", "mg", "tola", "masha", "ratti")}}
    if body.fineness not in (None, ""):
        phi = dec(body.fineness, "fineness")
        if not (0 <= phi <= 1):
            bad("Fineness must be between 0 and 1, e.g. 0.925")
        out["fine_g"] = fmt_g(Decimal(ug) * phi, 4)
    return out


# ------------------------------------------------------------- quick check
class QuickEvent(BaseModel):
    event_type: str
    value: str
    unit: str = "g"
    fineness: str = "0.925"
    u_mass_g: str = "0.002"
    u_fineness: str = "0"
    pieces: int = 0


class QuickIn(BaseModel):
    events: list[QuickEvent]
    metal: str = "silver"
    wastage_min_pct: str = "0"
    wastage_max_pct: str = "0"
    pieces_expected: int = 0
    lang: str = "en"
    check_log: list[dict] = Field(default_factory=list)


@app.post("/api/quick")
def quick(body: QuickIn):
    """Analyse an ad-hoc ledger without saving anything (landing-page live demo)."""
    evs = []
    for i, q in enumerate(body.events):
        try:
            evs.append(Event(f"q{i + 1}", "quick", q.event_type, to_ug(q.value, q.unit), dec(q.fineness, "fineness"),
                             to_ug(q.u_mass_g, "g"), dec(q.u_fineness, "u_fineness"), value_original=q.value,
                             unit_original=q.unit, pieces=q.pieces))
        except ValueError as e:
            bad(f"Row {i + 1}: {e}")
    job = {"metal": body.metal, "wastage_min_pct": body.wastage_min_pct, "wastage_max_pct": body.wastage_max_pct,
           "pieces_expected": body.pieces_expected}
    return analyse(evs, job, body.check_log, body.lang if body.lang in LANGS else "en")


# ---------------------------------------------------------------- parties
class PartyIn(BaseModel):
    name: str
    role: str
    code: str = ""


@app.get("/api/parties")
def parties():
    return store.parties()


@app.post("/api/parties")
def add_party(body: PartyIn):
    if not body.name.strip():
        bad("Name is required")
    try:
        return store.add_party(body.name.strip(), body.role, body.code)
    except ValueError as e:
        bad(str(e))


# ------------------------------------------------------------------- jobs
class JobIn(BaseModel):
    title: str
    karigar_id: str
    jeweller_id: str = ""
    metal: str = "silver"
    fineness_default: str = "0.925"
    wastage_min_pct: str = "0"
    wastage_max_pct: str = "0"
    pieces_expected: int = 0


def _job_summary(j: dict) -> dict:
    evs = store.events(j["job_id"])
    try:
        bal = compute_balance(effective_ledger(evs), j["wastage_min_pct"], j["wastage_max_pct"])
        verdict, excess = bal.verdict, fmt_g(bal.excess, 3)
    except Exception:
        verdict, excess = "error", "0"
    k = store.party(j["karigar_id"]) or {}
    sets = store.settlements(j["job_id"])
    cur = sets[0] if sets and not sets[0]["stale"] else None
    # last activity: newest slip, approval or settlement action (read-only, for sorting and display)
    stamps = [j["created_at"]]
    for r in store.event_rows(j["job_id"]):
        stamps += [r["created_at"], r.get("approved_jeweller") or "", r.get("approved_karigar") or ""]
    for st_ in sets:
        stamps += [st_["created_at"], st_.get("jeweller_at") or "", st_.get("karigar_at") or ""]
    return {**j, "karigar_name": k.get("name", ""), "n_events": len(evs), "verdict": verdict,
            "excess_g": excess, "settlement": cur["status"] if cur else None,
            "settlement_approvals": {"jeweller_at": cur.get("jeweller_at"), "karigar_at": cur.get("karigar_at")} if cur else None,
            "updated_at": max(x for x in stamps if x)}


@app.get("/api/jobs")
def jobs(karigar_id: Optional[str] = None):
    return [_job_summary(j) for j in store.jobs(karigar_id)]


@app.post("/api/jobs")
def add_job(body: JobIn):
    if not store.party(body.karigar_id):
        bad("Unknown karigar")
    for name, v in (("fineness", body.fineness_default), ("wastage_min_pct", body.wastage_min_pct),
                    ("wastage_max_pct", body.wastage_max_pct)):
        dec(v, name)
    if dec(body.wastage_min_pct, "w") > dec(body.wastage_max_pct, "w"):
        bad("Wastage minimum cannot exceed the maximum")
    if not (0 < dec(body.fineness_default, "fineness") <= 1):
        bad("Fineness must be between 0 and 1, e.g. 0.925")
    return store.add_job(body.title.strip() or "Untitled job", body.karigar_id, body.jeweller_id, body.metal,
                         body.fineness_default, body.wastage_min_pct, body.wastage_max_pct, body.pieces_expected)


def _job_or_404(jid: str, viewer: Optional[str] = None) -> dict:
    j = store.job(jid)
    if not j:
        bad("Job not found", 404)
    if viewer and viewer != j["karigar_id"] and viewer != j.get("jeweller_id"):
        # a karigar sees only his own account, never another worker's
        bad("This account belongs to another karigar", 403)
    return j


@app.get("/api/jobs/{jid}")
def job(jid: str, lang: str = "en", viewer: Optional[str] = None, threshold: float = 0.9):
    j = _job_or_404(jid, viewer)
    evs = store.events(jid)
    rows = {r["event_id"]: r for r in store.event_rows(jid)}
    rep = analyse(evs, j, store.check_log(jid), lang if lang in LANGS else "en", threshold=threshold)
    for e in rep["events"]:
        r = rows.get(e["event_id"], {})
        e["approval_status"] = r.get("approval_status", "pending")
        e["created_by"] = r.get("created_by", "")
        e["created_at"] = r.get("created_at", "")
        e["approved_jeweller_at"] = r.get("approved_jeweller")
        e["approved_karigar_at"] = r.get("approved_karigar")
    return {"job": _job_summary(j), "karigar": store.party(j["karigar_id"]),
            "jeweller": store.party(j["jeweller_id"]) if j.get("jeweller_id") else None,
            "report": rep, "settlements": store.settlements(jid), "ledger_version": store.ledger_version(jid)}


# ----------------------------------------------------------------- events
class EventIn(BaseModel):
    event_type: str
    value: str = "0"
    unit: str = "g"
    fineness: Optional[str] = None
    u_mass_g: Optional[str] = None
    instrument_id: str = ""
    u_fineness: Optional[str] = None
    assay_method: str = "declared"
    pieces: int = 0
    note: str = ""
    parent_event_id: str = ""
    document_id: str = ""
    timestamp: str = ""
    void: bool = False
    role: str = ""


def build_event(jid: str, j: dict, b: EventIn) -> Event:
    et = b.event_type.upper()
    if et not in EVENT_TYPES:
        bad(f"Unknown event type {b.event_type}")
    if et in ("REWEIGH", "ASSAY", "CORRECTION") and not b.parent_event_id:
        bad(f"{et} must point at the event it corrects")
    if b.parent_event_id and b.parent_event_id not in {e.event_id for e in store.events(jid)}:
        bad("The event being corrected is not in this job")
    if b.value in ("", None):
        bad("A weight is required (enter 0 only for a void correction or an assay)")
    v = dec(b.value, "weight")
    if v < 0:
        bad("A weight cannot be negative. If a slip was wrong, add a correction.")
    if v == 0 and et not in ("ASSAY", "CORRECTION"):
        bad("A weight of zero is not a weighing. Check the slip.")
    if not b.unit:
        bad("The unit is missing from the slip entry: choose g, tola, masha or ratti")
    try:
        ug = to_ug(v, b.unit)
    except ValueError as e:
        bad(str(e))
    if b.fineness in (None, "") and et not in ("REWEIGH", "CORRECTION"):
        if et == "STONE_SET":
            phi = dec(j["fineness_default"], "fineness")
        elif et == "ALLOY_ADD":
            bad("Give the fineness of the alloy's precious content (0 for pure copper)")
        else:
            bad("Fineness is blank. Enter it as written on the slip, e.g. 0.925")
    else:
        phi = dec(b.fineness or "0", "fineness")
    if phi > 1 or phi < 0:
        bad("Fineness must be between 0 and 1. Write 92.5% as 0.925")
    if et not in ("ALLOY_ADD", "STONE_SET", "REWEIGH", "CORRECTION") and phi and phi < Decimal("0.5"):
        bad("Precious-metal fineness below 0.5 is outside the physical range Tarazu accepts")
    if b.u_mass_g not in (None, ""):
        u_ug = to_ug(dec(b.u_mass_g, "u_mass_g"), "g")
    elif b.instrument_id and store.instrument(b.instrument_id):
        u_ug = store.instrument(b.instrument_id)["u_mass_ug"]
    else:
        u_ug = 2000
    method = (b.assay_method or "declared").lower()
    u_phi = dec(b.u_fineness, "u_fineness") if b.u_fineness not in (None, "") else Decimal(
        DEFAULT_U_FINENESS.get(method, "0.003"))
    try:
        return Event(new_id("ev"), jid, et, ug, phi, u_ug, u_phi, party_id=j["karigar_id"],
                     value_original=str(b.value).strip(), unit_original=b.unit, assay_method=method,
                     instrument_id=b.instrument_id, document_id=b.document_id, parent_event_id=b.parent_event_id,
                     timestamp=b.timestamp or now(), pieces=max(int(b.pieces or 0), 0), note=b.note[:500],
                     void=b.void, simulated=bool(j.get("simulated")))
    except ValueError as e:
        bad(str(e))


@app.post("/api/jobs/{jid}/events")
def add_event(jid: str, body: EventIn):
    j = _job_or_404(jid)
    e = build_event(jid, j, body)
    try:
        effective_ledger(store.events(jid) + [e])
    except ValueError as err:
        bad(str(err))
    row = store.add_event(e, body.role)
    if body.role in ("jeweller", "karigar"):
        store.approve_event(e.event_id, body.role)  # the author approves his own entry
    return row


class RoleIn(BaseModel):
    role: str


@app.post("/api/events/{eid}/approve")
def approve_event(eid: str, body: RoleIn):
    try:
        store.approve_event(eid, body.role)
    except ValueError as e:
        bad(str(e))
    return {"ok": True}


# --------------------------------------------------------- investigation
class CheckIn(BaseModel):
    check_id: str
    outcome: str
    role: str = ""


@app.post("/api/jobs/{jid}/checks")
def log_check(jid: str, body: CheckIn):
    _job_or_404(jid)
    kind = body.check_id.split(":")[0]
    if kind not in DEFAULT_COSTS:
        bad("Unknown check")
    store.log_check(jid, body.check_id, body.outcome, body.role)
    return {"ok": True}


@app.delete("/api/jobs/{jid}/checks")
def reset_checks(jid: str):
    _job_or_404(jid)
    store.reset_checks(jid)
    return {"ok": True}


class ApplyIn(BaseModel):
    key: str
    mass_g: Optional[str] = None  # measured value from the check, if any
    fineness: Optional[str] = None
    role: str = ""


@app.post("/api/jobs/{jid}/apply")
def apply_explanation(jid: str, body: ApplyIn):
    """Turn a confirmed explanation into appended ledger events (never an edit)."""
    j = _job_or_404(jid)
    evs = store.events(jid)
    eff = effective_ledger(evs)
    bal = compute_balance(eff, j["wastage_min_pct"], j["wastage_max_pct"])
    res = explain(eff, bal, Config(), int(j.get("pieces_expected") or 0))
    x = next((x for x in res.explanations if x.key == body.key and not x.last_resort), None)
    if not x:
        bad("That explanation no longer fits the current ledger", 409)
    by_id = {ee.id: ee.event for ee in eff}
    phi_job = Decimal(j["fineness_default"])
    created = []
    note = f"Applied after investigation: {body.key}"
    for ed, amt in zip(x.edits, split_effect(x)):
        if len(x.edits) == 1 and body.mass_g:
            override_ug = to_ug(dec(body.mass_g, "mass_g"), "g")
        else:
            override_ug = None
        ev = by_id.get(ed.event_id)
        info = ed.info
        if ed.hyp in ("H1", "H2", "H3"):
            et = {"H1": "RETURN_FINISHED", "H2": "RETURN_SCRAP", "H3": "WIP_HOLD"}[ed.hyp]
            ug = override_ug or int(-amt / phi_job)
            b = EventIn(event_type=et, value=fmt_g(ug, 4), unit="g", fineness=str(phi_job),
                        pieces=1 if ed.hyp == "H1" else 0, note=note, role=body.role)
        elif ed.hyp == "H4":
            m = Decimal(ev.mass_ug)
            nphi = Decimal(body.fineness) if body.fineness else (ev.fineness + amt / (-m if _is_out(ev) else m))
            b = EventIn(event_type="ASSAY", value="0", fineness=str(nphi.quantize(Decimal("0.0001"))),
                        assay_method="xrf", parent_event_id=ev.event_id, note=note, role=body.role)
        elif ed.hyp == "H5":
            ug = override_ug or int(ev.mass_ug + amt / ((-1 if _is_out(ev) else 1) * ev.fineness))
            b = EventIn(event_type="REWEIGH", value=fmt_g(ug, 4), unit="g", parent_event_id=ev.event_id,
                        u_mass_g=fmt_g(ev.u_mass_ug, 4), note=note, role=body.role)
        elif ed.hyp == "H6":
            if "new_fineness" in info:
                b = EventIn(event_type="CORRECTION", value="0", fineness=info["new_fineness"],
                            parent_event_id=ev.event_id, note=f"{note} ({info.get('reason')})", role=body.role)
            else:
                b = EventIn(event_type="CORRECTION", value=info["new_value"], unit=info["new_unit"],
                            parent_event_id=ev.event_id, note=f"{note} ({info.get('reason')})", role=body.role)
        elif ed.hyp == "H7":
            b = EventIn(event_type="CORRECTION", value="0", void=True, parent_event_id=ev.event_id,
                        note=f"{note} (duplicate of {info.get('duplicate_of')})", role=body.role)
        elif ed.hyp == "H8":
            ug = override_ug or int(amt / ev.fineness)
            b = EventIn(event_type="STONE_SET", value=fmt_g(ug, 4), unit="g", fineness=str(ev.fineness),
                        parent_event_id="", note=f"{note} (stones in {ev.event_id})", role=body.role)
        else:
            continue
        created.append(add_event(jid, b))
    store.reset_checks(jid)
    return {"created": created}


def _is_out(ev: Event) -> bool:
    return ev.event_type in ("RETURN_FINISHED", "RETURN_SCRAP", "WIP_HOLD", "TRANSFER")


# ------------------------------------------------------------ settlements
@app.post("/api/jobs/{jid}/settlements")
def draft_settlement(jid: str):
    j = _job_or_404(jid)
    evs = store.events(jid)
    if not evs:
        bad("Nothing to settle yet")
    bal = compute_balance(effective_ledger(evs), j["wastage_min_pct"], j["wastage_max_pct"])
    if bal.verdict != "balanced":
        bad("The balance does not close yet. Resolve the unaccounted fine metal first, "
            "or both parties can record an agreed correction.", 409)
    summary = {"fine_in_g": fmt_g(bal.fine_in, 4), "fine_out_g": fmt_g(bal.fine_out, 4),
               "fine_deduct_g": fmt_g(bal.fine_deduct, 4), "wastage_used_g": fmt_g(bal.raw, 4),
               "wastage_band_g": [fmt_g(bal.loss_band.lo, 4), fmt_g(bal.loss_band.hi, 4)],
               "residual_g": [fmt_g(bal.residual.lo, 4), fmt_g(bal.residual.hi, 4)],
               "wastage_used_pct": str((bal.raw / bal.fine_in * 100).quantize(Decimal("0.001"))) if bal.fine_in else "0",
               "metal": j["metal"], "events": len(evs)}
    return store.add_settlement(jid, summary)


@app.post("/api/settlements/{sid}/approve")
def approve_settlement(sid: str, body: RoleIn):
    s = store.settlement(sid)
    if not s:
        bad("Settlement not found", 404)
    if s["stale"]:
        bad("The ledger changed after this draft. Draft a new settlement.", 409)
    if body.role not in ("jeweller", "karigar"):
        bad("role must be jeweller or karigar")
    store.approve_settlement(sid, body.role)
    return store.settlement(sid)


# -------------------------------------------------------------- documents
@app.post("/api/documents")
async def upload(file: UploadFile = File(...), job_id: str = Form("")):
    data = await file.read()
    if len(data) > 8 * 1024 * 1024:
        bad("Slip photo must be under 8 MB")
    mime = file.content_type or "application/octet-stream"
    if not mime.startswith("image/"):
        bad("Upload a photo of the slip (an image file)")
    did = store.add_document(job_id, file.filename or "slip", mime)
    (SLIPS / did).write_bytes(data)
    return {"document_id": did}


@app.get("/api/documents/{did}")
def document(did: str):
    d = store.document(did)
    if not d or not (SLIPS / did).exists():
        bad("No photo stored for this slip", 404)
    return Response((SLIPS / did).read_bytes(), media_type=d["mime"], headers={"Cache-Control": "private, max-age=86400"})


# ------------------------------------------------------------ instruments
class InstrumentIn(BaseModel):
    name: str
    readability_g: str = "0.001"
    u_mass_g: str = "0.002"


@app.get("/api/instruments")
def instruments():
    return store.instruments()


@app.post("/api/instruments")
def add_instrument(body: InstrumentIn):
    return store.add_instrument(body.name, to_ug(body.readability_g, "g"), to_ug(body.u_mass_g, "g"),
                                "entered by hand")


class CalibrationIn(BaseModel):
    check_weight_g: str
    readings_g: list[str]


@app.post("/api/instruments/{iid}/calibrate")
def calibrate(iid: str, body: CalibrationIn):
    """Phase 0: repeat weighings of a certified check weight give an empirical half-width.

    No Gaussian assumption is needed for the bound we use: u = max(|bias| + 3s,
    largest observed deviation, readability).
    """
    inst = store.instrument(iid)
    if not inst:
        bad("Instrument not found", 404)
    if len(body.readings_g) < 5:
        bad("Enter at least 5 repeat readings (the protocol asks for 30 per check weight)")
    ref = to_ug(body.check_weight_g, "g")
    rd = [to_ug(r, "g") for r in body.readings_g]
    result = {**bound(ref, rd, inst["readability_ug"]),
              "method": f"max(|bias|+3s, max deviation, readability) from {len(rd)} readings of {body.check_weight_g} g"}
    store.add_calibration(iid, ref, rd, result)
    return {**result, "instrument": store.instrument(iid)}


# ----------------------------------------------------------------- export
@app.get("/api/parties/{pid}/export")
def export(pid: str, format: str = "json"):
    p = store.party(pid)
    if not p:
        bad("Party not found", 404)
    js = store.jobs(pid) if p["role"] == "karigar" else [j for j in store.jobs() if j.get("jeweller_id") == pid]
    acct = {"party": p, "exported_at": now(), "tarazu_version": __version__, "jobs": []}
    rows = []
    for j in js:
        evs = store.events(j["job_id"])
        bal = compute_balance(effective_ledger(evs), j["wastage_min_pct"], j["wastage_max_pct"])
        acct["jobs"].append({"job": j, "balance": {"verdict": bal.verdict, "fine_in_g": fmt_g(bal.fine_in, 4),
                                                   "fine_out_g": fmt_g(bal.fine_out, 4),
                                                   "residual_g": [fmt_g(bal.residual.lo, 4), fmt_g(bal.residual.hi, 4)]},
                             "events": store.event_rows(j["job_id"]), "settlements": store.settlements(j["job_id"])})
        for r in store.event_rows(j["job_id"]):
            rows.append({"job": j["title"], **{k: r[k] for k in ("event_id", "event_type", "value_original",
                                                                 "unit_original", "mass_ug", "fineness",
                                                                 "u_mass_ug", "u_fineness", "parent_event_id",
                                                                 "timestamp", "approval_status", "note")}})
    fname = f"tarazu-account-{p['name'].replace(' ', '_')}"
    if format == "csv":
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{fname}.csv"'})
    return JSONResponse(acct, headers={"Content-Disposition": f'attachment; filename="{fname}.json"'})


# ---------------------------------------------------------------- harness
class HarnessIn(BaseModel):
    seed: int = 2026
    n_clean: int = 60
    n_per_fault: int = 10
    n_sweep: int = 8
    n_pairs: int = 10


@app.post("/api/harness/run")
def harness(body: HarnessIn):
    if not (10 <= body.n_clean <= 200 and 2 <= body.n_per_fault <= 40 and 2 <= body.n_sweep <= 30):
        bad("Keep run counts modest: clean 10-200, per fault 2-40, sweep 2-30")
    from .harness import run_suite  # imported on demand: it is the heaviest module and rarely used
    global _last_harness
    _last_harness = run_suite(body.seed, body.n_clean, 40, body.n_per_fault, body.n_sweep, body.n_pairs)
    return _last_harness


@app.get("/api/harness/last")
def harness_last():
    return _last_harness or {}


# ------------------------------------------------------------------ demo
@app.post("/api/demo/seed")
def demo_seed():
    from .demo import seed_demo
    return seed_demo(store)


# ----------------------------------------------------------- front end
if FRONT.exists():
    @app.get("/app")
    def app_page():
        return FileResponse(FRONT / "app.html")

    app.mount("/", StaticFiles(directory=FRONT, html=True), name="front")
