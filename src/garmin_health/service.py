"""Glue between Garmin, the local store and the analysis."""

from __future__ import annotations

import logging
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any

from . import analysis
from .config import Settings
from .garmin_client import GarminSource
from .store import FEELINGS, Store

log = logging.getLogger(__name__)

# Re-fetch recent days for a while, because Garmin keeps filling them in as
# the watch syncs (sleep lands in the morning, steps and stress all day).
RECENT_REFRESH = timedelta(minutes=20)
SETTLED_AFTER = timedelta(days=2)


class HealthService:
    def __init__(self, settings: Settings, source: GarminSource | None = None, store: Store | None = None):
        self.settings = settings
        self.source = source or GarminSource(settings.token_path)
        self.store = store or Store(settings.db_path)
        self._lock = threading.Lock()

    def today(self) -> date:
        return datetime.now(self.settings.timezone).date()

    def _parse_day(self, day: str | None) -> date:
        return date.fromisoformat(day) if day else self.today()

    # --- syncing ----------------------------------------------------------
    def _needs_fetch(self, day: date, now: datetime) -> bool:
        fetched = self.store.fetched_at(day)
        if fetched is None:
            return True
        day_end = datetime.combine(day + timedelta(days=1), datetime.min.time(), self.settings.timezone)
        if fetched >= day_end + SETTLED_AFTER:
            return False  # fetched long after the day ended: final
        return now - fetched > RECENT_REFRESH

    def sync(self, end: date | None = None, days: int | None = None, force_recent: bool = False) -> dict[str, Any]:
        end = end or self.today()
        days = days or self.settings.history_days
        now = datetime.now(timezone.utc)
        fetched, errors = [], []
        with self._lock:
            for i in range(days, -1, -1):
                d = end - timedelta(days=i)
                if d > self.today():
                    continue
                if not (self._needs_fetch(d, now) or (force_recent and i <= 1)):
                    continue
                try:
                    record, acts = self.source.fetch_day(d)
                except RuntimeError:
                    raise  # not logged in: surface the instructions
                except Exception as e:
                    log.exception("Failed to fetch %s", d)
                    errors.append(f"{d}: {e}")
                    continue
                self.store.upsert_day(d, record, acts)
                fetched.append(d.isoformat())
        return {"fetched_days": len(fetched), "errors": errors}

    def _window(self, day: date) -> dict[date, dict]:
        start = day - timedelta(days=analysis.BASELINE_DAYS + analysis.BASELINE_GAP + 3)
        return self.store.days(start, day)

    def _weights(self) -> dict[str, Any]:
        all_days = self.store.days(date(2000, 1, 1), self.today())
        return analysis.learn(all_days, self.store.checkins())

    def _recent_checkin(self, day: date) -> dict | None:
        recent = self.store.checkins(day - timedelta(days=2), day - timedelta(days=1))
        return recent[max(recent)] if recent else None

    # --- tools ------------------------------------------------------------
    def morning_brief(self, day: str | None = None) -> dict[str, Any]:
        d = self._parse_day(day)
        sync = self.sync(end=d, force_recent=True)
        learned = self._weights()
        result = analysis.assess_morning(self._window(d), d, learned["weights"], self._recent_checkin(d))
        self.store.save_assessment(d, "morning", result["status"], result["illness_score"], result["fatigue_score"])
        result["personalisation"] = {"active": learned["active"], "note": learned["note"]}
        result["checkin_already_logged"] = self.store.checkins(d, d).get(d)
        result["sync"] = sync
        return result

    def night_check(self, day: str | None = None) -> dict[str, Any]:
        d = self._parse_day(day)
        sync = self.sync(end=d, force_recent=True)
        learned = self._weights()
        result = analysis.assess_night(self._window(d), d, learned["weights"], self._recent_checkin(d))
        self.store.save_assessment(d, "night", result["tomorrow_outlook"], result["risk_score"], 0)
        result["checkin_already_logged"] = self.store.checkins(d, d).get(d)
        result["sync"] = sync
        return result

    def log_check_in(self, feeling: str, notes: str | None = None, day: str | None = None) -> dict[str, Any]:
        feeling = feeling.strip().lower().replace(" ", "_").replace("-", "_")
        if feeling not in FEELINGS:
            raise ValueError(f"feeling must be one of: {', '.join(FEELINGS)}")
        d = self._parse_day(day)
        self.store.log_checkin(d, feeling, notes)
        morning = self.store.assessments("morning").get(d)
        return {
            "saved": {"date": d.isoformat(), "feeling": feeling, "notes": notes},
            "model_said_this_morning": morning["status"] if morning else None,
            "learning": self._weights()["note"],
        }

    def vitals(self, days: int = 14, end: str | None = None) -> dict[str, Any]:
        e = self._parse_day(end)
        self.sync(end=e)
        window = self._window(e)
        rows = []
        for i in range(days - 1, -1, -1):
            d = e - timedelta(days=i)
            rec = window.get(d)
            if not rec:
                continue
            row: dict[str, Any] = {"date": d.isoformat()}
            for m in analysis.METRICS:
                dev = analysis.deviation(window, m, d)
                row[m.key] = (
                    {"value": dev["value"], "baseline": dev["baseline"], "strain_z": dev["strain_z"]}
                    if dev
                    else rec.get(m.key)
                )
            for k in ("hrv_status", "training_readiness", "steps", "training_load", "body_battery_high"):
                row[k] = rec.get(k)
            rows.append(row)
        checkins = self.store.checkins(e - timedelta(days=days), e)
        return {
            "days": rows,
            "checkins": {d.isoformat(): c["feeling"] for d, c in checkins.items()},
            "note": "strain_z > 0 means worse than your normal; >= 1.5 is notable.",
        }

    def activities(self, days: int = 7) -> dict[str, Any]:
        e = self.today()
        self.sync(end=e, days=max(days, 2))
        return {"activities": self.store.activities(e - timedelta(days=days - 1), e)}

    def learning_summary(self) -> dict[str, Any]:
        learned = self._weights()
        learned["accuracy"] = analysis.accuracy(self.store.assessments("morning"), self.store.checkins())
        return learned
