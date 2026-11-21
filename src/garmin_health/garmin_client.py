"""Fetch one day of Garmin Connect data and flatten it into a single record.

Garmin's endpoints are unofficial and their field names drift between
firmware/API versions, so every field is read defensively from a few known
spellings and missing data is simply ``None``.
"""

from __future__ import annotations

import logging
from datetime import date
from pathlib import Path
from typing import Any, Callable

from garminconnect import Garmin, GarminConnectNotFoundError

log = logging.getLogger(__name__)

# The flattened daily record. "Overnight" fields describe the night that ended
# on the morning of ``date`` (Garmin files sleep under the wake-up date).
DAILY_FIELDS = (
    "hrv",                # overnight average HRV, ms
    "hrv_status",         # Garmin's HRV status label (BALANCED, UNBALANCED, LOW...)
    "rhr",                # resting heart rate, bpm
    "sleep_seconds",
    "deep_seconds",
    "rem_seconds",
    "awake_seconds",
    "sleep_score",        # 0-100
    "spo2_avg",           # overnight average SpO2, %
    "spo2_low",           # overnight lowest SpO2, %
    "respiration_avg",    # overnight breaths per minute
    "sleep_stress",       # average stress during sleep, 0-100
    "avg_stress",         # all-day average stress, 0-100
    "body_battery_high",
    "body_battery_low",
    "body_battery_charged",  # how much Body Battery recharged overnight
    "body_battery_latest",   # most recent Body Battery reading that day
    "steps",
    "active_kcal",
    "intensity_minutes",  # moderate + 2x vigorous, as Garmin counts them
    "training_readiness",
    "training_load",      # sum of activity training load that day
)


def _first(d: dict[str, Any] | None, *keys: str) -> Any:
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # Garmin uses negative sentinels (e.g. -1, -2) for "no reading".
    return f if f >= 0 else None


def parse_day(
    sleep: dict | None,
    hrv: dict | None,
    summary: dict | None,
    readiness: Any,
    activities: list[dict] | None,
) -> dict[str, Any]:
    """Turn raw Garmin JSON for one day into the flat record (pure, testable)."""
    dto = _first(sleep, "dailySleepDTO") or {}
    hrv_summary = _first(hrv, "hrvSummary") or {}

    rec: dict[str, Any] = {k: None for k in DAILY_FIELDS}

    rec["hrv"] = _num(_first(hrv_summary, "lastNightAvg")) or _num(
        _first(sleep, "avgOvernightHrv")
    ) or _num(_first(dto, "avgSleepHRV"))
    rec["hrv_status"] = _first(hrv_summary, "status") or _first(sleep, "hrvStatus")

    rec["rhr"] = _num(_first(summary, "restingHeartRate")) or _num(
        _first(sleep, "restingHeartRate")
    )

    rec["sleep_seconds"] = _num(_first(dto, "sleepTimeSeconds"))
    rec["deep_seconds"] = _num(_first(dto, "deepSleepSeconds"))
    rec["rem_seconds"] = _num(_first(dto, "remSleepSeconds"))
    rec["awake_seconds"] = _num(_first(dto, "awakeSleepSeconds"))
    scores = _first(dto, "sleepScores") or {}
    rec["sleep_score"] = _num(_first(_first(scores, "overall") or {}, "value"))

    rec["spo2_avg"] = _num(_first(dto, "averageSpO2Value", "avgSpO2"))
    rec["spo2_low"] = _num(_first(dto, "lowestSpO2Value"))
    rec["respiration_avg"] = _num(_first(dto, "averageRespirationValue"))
    rec["sleep_stress"] = _num(_first(dto, "avgSleepStress"))

    rec["avg_stress"] = _num(_first(summary, "averageStressLevel"))
    rec["body_battery_high"] = _num(_first(summary, "bodyBatteryHighestValue"))
    rec["body_battery_low"] = _num(_first(summary, "bodyBatteryLowestValue"))
    rec["body_battery_charged"] = _num(_first(summary, "bodyBatteryChargedValue")) or _num(
        _first(sleep, "bodyBatteryChange")
    )
    rec["body_battery_latest"] = _num(_first(summary, "bodyBatteryMostRecentValue"))
    rec["steps"] = _num(_first(summary, "totalSteps"))
    rec["active_kcal"] = _num(_first(summary, "activeKilocalories"))
    mod = _num(_first(summary, "moderateIntensityMinutes")) or 0
    vig = _num(_first(summary, "vigorousIntensityMinutes")) or 0
    rec["intensity_minutes"] = (mod + 2 * vig) if summary else None

    if isinstance(readiness, dict):
        readiness = [readiness]
    if isinstance(readiness, list):
        scored = [r for r in readiness if isinstance(r, dict) and _num(r.get("score")) is not None]
        if scored:
            # The first snapshot of the day is the morning (post-wake) one.
            scored.sort(key=lambda r: r.get("timestampLocal") or r.get("timestamp") or "")
            rec["training_readiness"] = _num(scored[0]["score"])

    if activities is not None:
        rec["training_load"] = sum(_num(a.get("activityTrainingLoad")) or 0 for a in activities)

    return rec


def parse_activity(a: dict[str, Any]) -> dict[str, Any]:
    atype = _first(a, "activityType") or {}
    return {
        "activity_id": a.get("activityId"),
        "start_local": a.get("startTimeLocal"),
        "name": a.get("activityName"),
        "type": atype.get("typeKey") if isinstance(atype, dict) else None,
        "duration_min": round((_num(a.get("duration")) or 0) / 60, 1),
        "distance_km": round((_num(a.get("distance")) or 0) / 1000, 2),
        "avg_hr": _num(a.get("averageHR")),
        "max_hr": _num(a.get("maxHR")),
        "training_load": _num(a.get("activityTrainingLoad")),
        "aerobic_te": _num(a.get("aerobicTrainingEffect")),
        "anaerobic_te": _num(a.get("anaerobicTrainingEffect")),
    }


class GarminSource:
    """Thin wrapper around ``garminconnect.Garmin`` using saved login tokens."""

    def __init__(self, token_path: Path):
        self.token_path = token_path
        self._api: Garmin | None = None

    def _client(self) -> Garmin:
        if self._api is None:
            if not self.token_path.exists():
                raise RuntimeError(
                    f"No Garmin login tokens at {self.token_path}. "
                    "Run `garmin-health-login` once to sign in."
                )
            api = Garmin()
            # Loading from a file path makes the library write refreshed
            # tokens back to the same file, so the login keeps working.
            api.login(str(self.token_path))
            self._api = api
        return self._api

    def _call(self, fn: Callable[[Garmin], Any]) -> Any:
        try:
            return fn(self._client())
        except GarminConnectNotFoundError:
            return None
        except Exception as e:  # one failing endpoint shouldn't sink the day
            log.warning("Garmin call failed: %s", e)
            return None

    def fetch_day(self, day: date) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        d = day.isoformat()
        self._client()  # fail loudly here if not logged in
        sleep = self._call(lambda g: g.get_sleep_data(d))
        hrv = self._call(lambda g: g.get_hrv_data(d))
        summary = self._call(lambda g: g.get_user_summary(d))
        readiness = self._call(lambda g: g.get_training_readiness(d))
        acts = self._call(lambda g: g.get_activities_by_date(d, d)) or []
        record = parse_day(sleep, hrv, summary, readiness, acts)
        return record, [parse_activity(a) for a in acts]
