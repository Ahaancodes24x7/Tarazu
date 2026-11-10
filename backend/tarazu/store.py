"""SQLite persistence. Events are insert-only; approvals live in their own table."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from .ledger import Event

SCHEMA = """
CREATE TABLE IF NOT EXISTS parties (
  party_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  code TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, title TEXT NOT NULL, karigar_id TEXT NOT NULL, jeweller_id TEXT,
  metal TEXT NOT NULL, fineness_default TEXT NOT NULL, wastage_min_pct TEXT NOT NULL,
  wastage_max_pct TEXT NOT NULL, pieces_expected INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, job_id TEXT NOT NULL,
  party_id TEXT, event_type TEXT NOT NULL, mass_ug INTEGER NOT NULL, value_original TEXT,
  unit_original TEXT, fineness TEXT NOT NULL, assay_method TEXT, instrument_id TEXT,
  u_mass_ug INTEGER NOT NULL, u_fineness TEXT NOT NULL, document_id TEXT, parent_event_id TEXT,
  timestamp TEXT, pieces INTEGER NOT NULL DEFAULT 0, note TEXT, void INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only; add a CORRECTION'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only; add a CORRECTION'); END;
CREATE TABLE IF NOT EXISTS approvals (
  event_id TEXT NOT NULL, role TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(event_id, role));
CREATE TABLE IF NOT EXISTS instruments (
  instrument_id TEXT PRIMARY KEY, name TEXT NOT NULL, readability_ug INTEGER NOT NULL,
  u_mass_ug INTEGER NOT NULL, method TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calibrations (
  calibration_id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, check_weight_ug INTEGER NOT NULL,
  readings TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, ledger_version INTEGER NOT NULL,
  check_id TEXT NOT NULL, outcome TEXT NOT NULL, role TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settlements (
  settlement_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, ledger_version INTEGER NOT NULL,
  summary TEXT NOT NULL, jeweller_at TEXT, karigar_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY, job_id TEXT, filename TEXT NOT NULL, mime TEXT NOT NULL,
  created_at TEXT NOT NULL);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


class Store:
    def __init__(self, path: str | os.PathLike):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()

    # --------------------------------------------------------------- helpers
    def _q(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def _x(self, sql, args=()):
        with self._lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    # --------------------------------------------------------------- parties
    def add_party(self, name: str, role: str, code: str = "") -> dict:
        if role not in ("karigar", "jeweller"):
            raise ValueError("role must be karigar or jeweller")
        pid = new_id("p")
        self._x("INSERT INTO parties VALUES (?,?,?,?,?)", (pid, name, role, code, now()))
        return self.party(pid)

    def party(self, pid: str) -> dict | None:
        r = self._q("SELECT * FROM parties WHERE party_id=?", (pid,))
        return r[0] if r else None

    def parties(self) -> list[dict]:
        return self._q("SELECT * FROM parties ORDER BY role, name")

    # ------------------------------------------------------------------ jobs
    def add_job(self, title: str, karigar_id: str, jeweller_id: str = "", metal: str = "silver",
                fineness_default="0.925", wastage_min_pct="0", wastage_max_pct="0",
                pieces_expected: int = 0, simulated: bool = False) -> dict:
        jid = new_id("job")
        self._x("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (jid, title, karigar_id, jeweller_id, metal, str(fineness_default), str(wastage_min_pct),
                 str(wastage_max_pct), int(pieces_expected), int(simulated), now()))
        return self.job(jid)

    def job(self, jid: str) -> dict | None:
        r = self._q("SELECT * FROM jobs WHERE job_id=?", (jid,))
        return r[0] if r else None

    def jobs(self, karigar_id: str | None = None) -> list[dict]:
        if karigar_id:
            return self._q("SELECT * FROM jobs WHERE karigar_id=? ORDER BY created_at DESC", (karigar_id,))
        return self._q("SELECT * FROM jobs ORDER BY created_at DESC")

    # ---------------------------------------------------------------- events
    def add_event(self, e: Event, created_by: str = "") -> dict:
        self._x(
            "INSERT INTO events (event_id, job_id, party_id, event_type, mass_ug, value_original, unit_original,"
            " fineness, assay_method, instrument_id, u_mass_ug, u_fineness, document_id, parent_event_id,"
            " timestamp, pieces, note, void, simulated, created_by, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (e.event_id, e.job_id, e.party_id, e.event_type, e.mass_ug, e.value_original, e.unit_original,
             str(e.fineness), e.assay_method, e.instrument_id, e.u_mass_ug, str(e.u_fineness), e.document_id,
             e.parent_event_id, e.timestamp or now(), e.pieces, e.note, int(e.void), int(e.simulated),
             created_by, now()))
        return self.event_rows(e.job_id)[-1]

    def event_rows(self, jid: str) -> list[dict]:
        rows = self._q("SELECT * FROM events WHERE job_id=? ORDER BY seq", (jid,))
        appr = self._q("SELECT a.event_id, a.role, a.at FROM approvals a JOIN events e ON e.event_id=a.event_id"
                       " WHERE e.job_id=?", (jid,))
        by = {}
        for a in appr:
            by.setdefault(a["event_id"], {})[a["role"]] = a["at"]
        for r in rows:
            a = by.get(r["event_id"], {})
            r["approved_jeweller"] = a.get("jeweller")
            r["approved_karigar"] = a.get("karigar")
            if a.get("jeweller") and a.get("karigar"):
                r["approval_status"] = "approved by both"
            elif a.get("jeweller"):
                r["approval_status"] = "approved by jeweller"
            elif a.get("karigar"):
                r["approval_status"] = "approved by karigar"
            else:
                r["approval_status"] = "pending"
        return rows

    def events(self, jid: str) -> list[Event]:
        out = []
        for r in self._q("SELECT * FROM events WHERE job_id=? ORDER BY seq", (jid,)):
            out.append(Event(
                event_id=r["event_id"], job_id=r["job_id"], event_type=r["event_type"], mass_ug=r["mass_ug"],
                fineness=Decimal(r["fineness"]), u_mass_ug=r["u_mass_ug"], u_fineness=Decimal(r["u_fineness"]),
                party_id=r["party_id"] or "", value_original=r["value_original"] or "",
                unit_original=r["unit_original"] or "g", assay_method=r["assay_method"] or "",
                instrument_id=r["instrument_id"] or "", document_id=r["document_id"] or "",
                parent_event_id=r["parent_event_id"] or "", timestamp=r["timestamp"] or "",
                pieces=r["pieces"], note=r["note"] or "", void=bool(r["void"]), simulated=bool(r["simulated"])))
        return out

    def approve_event(self, event_id: str, role: str):
        if role not in ("jeweller", "karigar"):
            raise ValueError("role must be jeweller or karigar")
        self._x("INSERT OR REPLACE INTO approvals VALUES (?,?,?)", (event_id, role, now()))

    def ledger_version(self, jid: str) -> int:
        return self._q("SELECT COUNT(*) AS n FROM events WHERE job_id=?", (jid,))[0]["n"]

    # ----------------------------------------------------------- instruments
    def add_instrument(self, name: str, readability_ug: int, u_mass_ug: int, method: str) -> dict:
        iid = new_id("scale")
        self._x("INSERT INTO instruments VALUES (?,?,?,?,?,?)", (iid, name, readability_ug, u_mass_ug, method, now()))
        return self.instrument(iid)

    def instrument(self, iid: str) -> dict | None:
        r = self._q("SELECT * FROM instruments WHERE instrument_id=?", (iid,))
        return r[0] if r else None

    def instruments(self) -> list[dict]:
        rows = self._q("SELECT * FROM instruments ORDER BY created_at")
        for r in rows:
            r["calibrations"] = [
                {**c, "readings": json.loads(c["readings"]), "result": json.loads(c["result"])}
                for c in self._q("SELECT * FROM calibrations WHERE instrument_id=? ORDER BY created_at",
                                 (r["instrument_id"],))]
        return rows

    def add_calibration(self, iid: str, check_weight_ug: int, readings: list[int], result: dict):
        self._x("INSERT INTO calibrations VALUES (?,?,?,?,?,?)",
                (new_id("cal"), iid, check_weight_ug, json.dumps(readings), json.dumps(result), now()))
        with self._lock:
            self.db.execute("UPDATE instruments SET u_mass_ug=?, method=? WHERE instrument_id=?",
                            (int(result["u_mass_ug"]), result["method"], iid))
            self.db.commit()

    # -------------------------------------------------------- investigations
    def log_check(self, jid: str, check_id: str, outcome: str, role: str = ""):
        self._x("INSERT INTO investigations (job_id, ledger_version, check_id, outcome, role, at)"
                " VALUES (?,?,?,?,?,?)", (jid, self.ledger_version(jid), check_id, outcome, role, now()))

    def check_log(self, jid: str) -> list[dict]:
        return self._q("SELECT * FROM investigations WHERE job_id=? AND ledger_version=? ORDER BY id",
                       (jid, self.ledger_version(jid)))

    def reset_checks(self, jid: str):
        """Restart the investigation for the current ledger version."""
        self._x("DELETE FROM investigations WHERE job_id=? AND ledger_version=?",
                (jid, self.ledger_version(jid)))

    # ----------------------------------------------------------- settlements
    def add_settlement(self, jid: str, summary: dict) -> dict:
        sid = new_id("set")
        self._x("INSERT INTO settlements VALUES (?,?,?,?,?,?,?)",
                (sid, jid, self.ledger_version(jid), json.dumps(summary), None, None, now()))
        return self.settlement(sid)

    def settlement(self, sid: str) -> dict | None:
        r = self._q("SELECT * FROM settlements WHERE settlement_id=?", (sid,))
        if not r:
            return None
        s = r[0]
        s["summary"] = json.loads(s["summary"])
        s["status"] = "final" if s["jeweller_at"] and s["karigar_at"] else "draft"
        s["stale"] = s["ledger_version"] != self.ledger_version(s["job_id"])
        return s

    def settlements(self, jid: str) -> list[dict]:
        return [self.settlement(r["settlement_id"]) for r in
                self._q("SELECT settlement_id FROM settlements WHERE job_id=? ORDER BY created_at DESC", (jid,))]

    def approve_settlement(self, sid: str, role: str):
        col = {"jeweller": "jeweller_at", "karigar": "karigar_at"}[role]
        with self._lock:
            self.db.execute(f"UPDATE settlements SET {col}=? WHERE settlement_id=?", (now(), sid))
            self.db.commit()

    # ------------------------------------------------------------- documents
    def add_document(self, jid: str, filename: str, mime: str) -> str:
        did = new_id("doc")
        self._x("INSERT INTO documents VALUES (?,?,?,?,?)", (did, jid, filename, mime, now()))
        return did

    def document(self, did: str) -> dict | None:
        r = self._q("SELECT * FROM documents WHERE document_id=?", (did,))
        return r[0] if r else None
