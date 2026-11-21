"""Local SQLite cache of daily data, activities, check-ins and past assessments."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .garmin_client import DAILY_FIELDS

FEELINGS = ("fine", "tired", "getting_sick", "sick")

_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS daily (
    date TEXT PRIMARY KEY,
    {", ".join(f"{f} {'TEXT' if f == 'hrv_status' else 'REAL'}" for f in DAILY_FIELDS)},
    fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
    activity_id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_date ON activities(date);
CREATE TABLE IF NOT EXISTS checkins (
    date TEXT PRIMARY KEY,
    feeling TEXT NOT NULL CHECK (feeling IN {FEELINGS!r}),
    notes TEXT,
    logged_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assessments (
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    illness_score REAL,
    fatigue_score REAL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (date, kind)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path | str):
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)

    # --- daily data -------------------------------------------------------
    def upsert_day(self, day: date, record: dict[str, Any], activities: Iterable[dict]) -> None:
        cols = ["date", *DAILY_FIELDS, "fetched_at"]
        vals = [day.isoformat(), *(record.get(f) for f in DAILY_FIELDS), _now()]
        with self.conn:
            self.conn.execute(
                f"INSERT OR REPLACE INTO daily ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' * len(cols))})",
                vals,
            )
            self.conn.execute("DELETE FROM activities WHERE date = ?", (day.isoformat(),))
            for a in activities:
                if a.get("activity_id") is None:
                    continue
                self.conn.execute(
                    "INSERT OR REPLACE INTO activities (activity_id, date, data) VALUES (?, ?, ?)",
                    (a["activity_id"], day.isoformat(), json.dumps(a)),
                )

    def fetched_at(self, day: date) -> datetime | None:
        row = self.conn.execute(
            "SELECT fetched_at FROM daily WHERE date = ?", (day.isoformat(),)
        ).fetchone()
        return datetime.fromisoformat(row["fetched_at"]) if row else None

    def days(self, start: date, end: date) -> dict[date, dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM daily WHERE date BETWEEN ? AND ? ORDER BY date",
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        return {date.fromisoformat(r["date"]): dict(r) for r in rows}

    def activities(self, start: date, end: date) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT date, data FROM activities WHERE date BETWEEN ? AND ? ORDER BY date",
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        return [{"date": r["date"], **json.loads(r["data"])} for r in rows]

    # --- check-ins --------------------------------------------------------
    def log_checkin(self, day: date, feeling: str, notes: str | None) -> None:
        if feeling not in FEELINGS:
            raise ValueError(f"feeling must be one of {FEELINGS}")
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO checkins (date, feeling, notes, logged_at) VALUES (?, ?, ?, ?)",
                (day.isoformat(), feeling, notes, _now()),
            )

    def checkins(self, start: date | None = None, end: date | None = None) -> dict[date, dict]:
        q, args = "SELECT * FROM checkins", ()
        if start and end:
            q, args = q + " WHERE date BETWEEN ? AND ?", (start.isoformat(), end.isoformat())
        rows = self.conn.execute(q + " ORDER BY date", args).fetchall()
        return {date.fromisoformat(r["date"]): dict(r) for r in rows}

    # --- assessments (what the model said, to compare with check-ins) -----
    def save_assessment(self, day: date, kind: str, status: str, illness: float, fatigue: float) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO assessments VALUES (?, ?, ?, ?, ?, ?)",
                (day.isoformat(), kind, status, illness, fatigue, _now()),
            )

    def assessments(self, kind: str) -> dict[date, dict]:
        rows = self.conn.execute(
            "SELECT * FROM assessments WHERE kind = ? ORDER BY date", (kind,)
        ).fetchall()
        return {date.fromisoformat(r["date"]): dict(r) for r in rows}
