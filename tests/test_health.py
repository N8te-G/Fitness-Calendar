import random
from datetime import date, timedelta

import pytest

from garmin_health import analysis
from garmin_health.config import Settings
from garmin_health.garmin_client import parse_day
from garmin_health.service import HealthService
from garmin_health.store import Store

TODAY = date(2026, 11, 21)
DEFAULT_WEIGHTS = {k: analysis.METRIC_BY_KEY[k].weight for k in analysis.ILLNESS_KEYS}


def normal_day(rng: random.Random) -> dict:
    return {
        "hrv": rng.gauss(62, 3),
        "rhr": rng.gauss(52, 1),
        "respiration_avg": rng.gauss(14.5, 0.3),
        "spo2_avg": rng.gauss(96, 0.5),
        "sleep_stress": rng.gauss(15, 2),
        "sleep_seconds": rng.gauss(7.5 * 3600, 1200),
        "sleep_score": rng.gauss(80, 4),
        "body_battery_charged": rng.gauss(60, 6),
        "avg_stress": rng.gauss(28, 3),
        "training_load": rng.choice([0, 60, 90, 120]),
        "body_battery_latest": 40,
    }


def history(n=40, seed=1) -> dict[date, dict]:
    rng = random.Random(seed)
    return {TODAY - timedelta(days=i): normal_day(rng) for i in range(n)}


def test_normal_day_is_fine():
    days = history()
    r = analysis.assess_morning(days, TODAY, DEFAULT_WEIGHTS)
    assert r["status"] == "fine", r["reasons"]
    assert r["training"]["intensity"] == "as_planned"


def test_hrv_slide_with_rising_rhr_reads_getting_sick():
    days = history()
    # HRV falling ~35% over the last few days, RHR and respiration creeping up.
    for i, (hrv, rhr, resp) in enumerate([(40, 57, 15.6), (44, 56, 15.3), (48, 55, 15.0)]):
        days[TODAY - timedelta(days=i)].update(hrv=hrv, rhr=rhr, respiration_avg=resp)
    r = analysis.assess_morning(days, TODAY, DEFAULT_WEIGHTS)
    assert r["status"] in ("getting_sick", "sick")
    assert {"hrv", "rhr"} <= set(r["flagged_markers"])
    assert r["vitals"]["hrv"]["pct_vs_baseline"] < -30
    assert r["training"]["intensity"] in ("rest", "rest_or_very_easy")


def test_short_sleep_alone_reads_tired():
    days = history()
    days[TODAY].update(sleep_seconds=4.5 * 3600, sleep_score=50, body_battery_charged=25)
    r = analysis.assess_morning(days, TODAY, DEFAULT_WEIGHTS)
    assert r["status"] == "tired", r
    assert r["training"]["intensity"] == "easy"


def test_not_enough_history_gives_no_baseline():
    days = history(n=5)
    r = analysis.assess_morning(days, TODAY, DEFAULT_WEIGHTS)
    assert r["vitals"] == {}
    assert r["status"] == "fine"


def test_night_check_warns_on_drift_and_high_stress():
    days = history()
    for i in range(3):
        days[TODAY - timedelta(days=i)].update(rhr=56, hrv=45)
    days[TODAY].update(avg_stress=45, body_battery_latest=10)
    r = analysis.assess_night(days, TODAY, DEFAULT_WEIGHTS)
    assert r["tomorrow_outlook"] == "at_risk_of_getting_sick"
    assert r["warnings"]


def test_learning_upweights_markers_that_precede_sickness():
    rng = random.Random(3)
    days = {TODAY - timedelta(days=i): normal_day(rng) for i in range(120)}
    checkins = {}
    for sick_day in (TODAY - timedelta(days=d) for d in (20, 50, 80)):
        for i in range(3):  # RHR rises in the lead-up; HRV doesn't move
            days[sick_day - timedelta(days=i)]["rhr"] = 58
        checkins[sick_day] = {"feeling": "sick"}
    for d in range(5, 110, 9):
        day = TODAY - timedelta(days=d)
        checkins.setdefault(day, {"feeling": "fine"})
    learned = analysis.learn(days, checkins)
    assert learned["active"]
    assert learned["weights"]["rhr"] > analysis.METRIC_BY_KEY["rhr"].weight
    assert learned["weights"]["hrv"] <= analysis.METRIC_BY_KEY["hrv"].weight * 1.2


def test_parse_day_reads_garmin_shapes():
    rec = parse_day(
        sleep={
            "dailySleepDTO": {
                "sleepTimeSeconds": 27000,
                "averageSpO2Value": 95.0,
                "averageRespirationValue": 14.2,
                "avgSleepStress": 12.5,
                "sleepScores": {"overall": {"value": 82}},
            },
            "restingHeartRate": 50,
        },
        hrv={"hrvSummary": {"lastNightAvg": 64, "status": "BALANCED"}},
        summary={"restingHeartRate": 51, "averageStressLevel": -1, "totalSteps": 9000,
                 "moderateIntensityMinutes": 10, "vigorousIntensityMinutes": 5},
        readiness=[{"score": 70, "timestampLocal": "2026-11-21T07:00"},
                   {"score": 55, "timestampLocal": "2026-11-21T18:00"}],
        activities=[{"activityTrainingLoad": 80.5}, {"activityTrainingLoad": None}],
    )
    assert rec["hrv"] == 64 and rec["hrv_status"] == "BALANCED"
    assert rec["rhr"] == 51
    assert rec["sleep_score"] == 82 and rec["spo2_avg"] == 95
    assert rec["avg_stress"] is None  # Garmin's -1 means "no reading"
    assert rec["intensity_minutes"] == 20
    assert rec["training_readiness"] == 70  # morning snapshot, not the evening one
    assert rec["training_load"] == 80.5


class FakeSource:
    def __init__(self, days):
        self.days, self.calls = days, 0

    def fetch_day(self, d):
        self.calls += 1
        return dict(self.days.get(d, {})), []


@pytest.fixture
def service(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, timezone=__import__("zoneinfo").ZoneInfo("UTC"), history_days=40)
    svc = HealthService(settings, source=FakeSource(history()), store=Store(tmp_path / "db.sqlite3"))
    monkeypatch.setattr(svc, "today", lambda: TODAY)
    return svc


def test_service_end_to_end(service):
    brief = service.morning_brief()
    assert brief["status"] == "fine" and brief["last_night_synced"]
    calls = service.source.calls
    service.morning_brief()
    assert service.source.calls - calls <= 2  # only recent days are re-fetched

    saved = service.log_check_in("Getting sick", notes="scratchy throat")
    assert saved["saved"]["feeling"] == "getting_sick"
    assert saved["model_said_this_morning"] == "fine"
    with pytest.raises(ValueError):
        service.log_check_in("meh")

    assert service.night_check()["tomorrow_outlook"] in ("likely_fine", "likely_tired", "at_risk_of_getting_sick")
    assert len(service.vitals(days=7)["days"]) == 7
    summary = service.learning_summary()
    assert summary["accuracy"]["compared_days"] == 1
