"""Compare each day with *your* normal and turn that into a status.

Everything here is plain arithmetic on the cached daily records, so the
numbers Claude reports are reproducible and explainable rather than guessed.

Baseline
    For day D the baseline is the 28 days from D-31 to D-4: median and a
    robust spread (MAD x 1.4826, with a per-metric floor so a very steady
    metric doesn't turn tiny wobbles into alarms). The three days before D are
    left out on purpose, so a slide that has been building for a few days
    is measured against your normal rather than against itself.

Deviation
    z = (value - median) / spread, signed so that a positive "strain" value is
    always the unhealthy direction (higher RHR, lower HRV, ...).

Status
    Illness markers (RHR, HRV, respiration, SpO2, sleep stress) and fatigue
    markers (sleep, sleep score, Body Battery recharge, training load) are
    scored separately, then combined by a few transparent rules. Your
    check-ins adjust how much each illness marker counts (see ``learn``).
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

BASELINE_DAYS = 28
BASELINE_GAP = 3  # days just before the assessed day that are kept out of the baseline
MIN_BASELINE_POINTS = 7


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    unit: str
    bad: int  # +1: higher is worse, -1: lower is worse
    floor: float  # minimum spread, in the metric's unit
    group: str  # "illness" or "fatigue"
    weight: float = 1.0
    rel_floor: float = 0.0  # minimum spread as a fraction of the median


METRICS: tuple[Metric, ...] = (
    Metric("rhr", "Resting HR", "bpm", +1, 1.5, "illness", 1.2),
    Metric("hrv", "Overnight HRV", "ms", -1, 3.0, "illness", 1.0, rel_floor=0.06),
    Metric("respiration_avg", "Respiration", "brpm", +1, 0.4, "illness", 1.0),
    Metric("spo2_avg", "SpO2", "%", -1, 0.7, "illness", 0.6),
    Metric("sleep_stress", "Sleep stress", "", +1, 3.0, "illness", 0.6),
    Metric("sleep_seconds", "Sleep", "h", -1, 1800, "fatigue", 1.0),
    Metric("sleep_score", "Sleep score", "", -1, 5.0, "fatigue", 0.8),
    Metric("body_battery_charged", "Body Battery recharge", "", -1, 8.0, "fatigue", 0.8),
    Metric("avg_stress", "Daytime stress", "", +1, 3.0, "fatigue", 0.6),
)
METRIC_BY_KEY = {m.key: m for m in METRICS}
ILLNESS_KEYS = [m.key for m in METRICS if m.group == "illness"]
# Markers that move with infection more specifically than with a bad night.
SPECIFIC_ILLNESS_KEYS = {"rhr", "respiration_avg", "spo2_avg"}

FLAG_TODAY = 1.5   # strain z for a single day to count as off-normal
FLAG_TREND = 1.0   # mean strain z over the last 3 days to count as a drift

STATUSES = ("fine", "tired", "getting_sick", "sick")


# --------------------------------------------------------------------------
# Baselines and deviations
# --------------------------------------------------------------------------
def baseline_window(day: date) -> tuple[date, date]:
    end = day - timedelta(days=BASELINE_GAP + 1)
    return end - timedelta(days=BASELINE_DAYS - 1), end


def baseline(days: dict[date, dict], metric: Metric, day: date) -> dict[str, float] | None:
    start, end = baseline_window(day)
    vals = [
        float(r[metric.key])
        for d, r in days.items()
        if start <= d <= end and r.get(metric.key) is not None
    ]
    if len(vals) < MIN_BASELINE_POINTS:
        return None
    med = statistics.median(vals)
    mad = statistics.median(abs(v - med) for v in vals) * 1.4826
    spread = max(mad, metric.floor, abs(med) * metric.rel_floor)
    return {"median": med, "spread": spread, "n": len(vals)}


def deviation(days: dict[date, dict], metric: Metric, day: date) -> dict[str, Any] | None:
    """How far ``day`` is from normal for one metric, plus a 3-day trend."""
    base = baseline(days, metric, day)
    rec = days.get(day) or {}
    value = rec.get(metric.key)
    if base is None:
        return None

    def strain(v: float) -> float:
        return metric.bad * (v - base["median"]) / base["spread"]

    recent = [
        strain(float(days[d][metric.key]))
        for d in (day - timedelta(days=i) for i in range(3))
        if d in days and days[d].get(metric.key) is not None
    ]
    out: dict[str, Any] = {
        "metric": metric.key,
        "label": metric.label,
        "unit": metric.unit,
        "value": value,
        "baseline": base["median"],
        "baseline_days": base["n"],
        "strain_z": round(strain(float(value)), 2) if value is not None else None,
        "trend_3d_z": round(sum(recent) / len(recent), 2) if len(recent) >= 2 else None,
    }
    if value is not None and base["median"]:
        out["pct_vs_baseline"] = round(100 * (float(value) - base["median"]) / base["median"], 1)
    out["flag"] = bool(
        (out["strain_z"] is not None and out["strain_z"] >= FLAG_TODAY)
        or (out["trend_3d_z"] is not None and out["trend_3d_z"] >= FLAG_TREND)
    )
    if metric.key == "sleep_seconds":
        for k in ("value", "baseline"):
            if out[k] is not None:
                out[k] = round(out[k] / 3600, 2)
    elif out["value"] is not None:
        out["value"] = round(float(out["value"]), 1)
        out["baseline"] = round(out["baseline"], 1)
    return out


def training_load(days: dict[date, dict], day: date, include_day: bool) -> dict[str, Any] | None:
    """Acute (last 3 days) vs chronic (last 28 days) daily training load."""
    last = day if include_day else day - timedelta(days=1)

    def mean_load(n: int) -> float | None:
        vals = [
            (days[d].get("training_load") or 0)
            for d in (last - timedelta(days=i) for i in range(n))
            if d in days
        ]
        return sum(vals) / len(vals) if len(vals) >= max(2, n // 2) else None

    acute, chronic = mean_load(3), mean_load(28)
    if acute is None or chronic is None:
        return None
    ratio = acute / chronic if chronic > 0 else None
    return {
        "acute_3d_avg": round(acute),
        "chronic_28d_avg": round(chronic),
        "ratio": round(ratio, 2) if ratio is not None else None,
        "flag": bool(ratio is not None and ratio >= 1.5 and acute >= 50),
    }


# --------------------------------------------------------------------------
# Learning from check-ins
# --------------------------------------------------------------------------
def learn(days: dict[date, dict], checkins: dict[date, dict]) -> dict[str, Any]:
    """Re-weight illness markers from your own check-in history.

    For every day you said you were getting sick or sick, the two days before
    it count as "lead-up" too (that's the window an early warning is useful
    in). We compare each marker's average strain on those days against days
    you said you were fine. Markers that clearly separate the two get more
    weight, markers that don't get less. Until there are at least three
    sick/getting-sick check-ins the default weights are used unchanged.
    """
    sick_days = sorted(d for d, c in checkins.items() if c["feeling"] in ("getting_sick", "sick"))
    fine_days = {d for d, c in checkins.items() if c["feeling"] == "fine"}
    positive = {d - timedelta(days=i) for d in sick_days for i in range(3)} - fine_days

    weights = {k: METRIC_BY_KEY[k].weight for k in ILLNESS_KEYS}
    detail: dict[str, Any] = {}
    active = len(sick_days) >= 3 and len(fine_days) >= 5
    for key in ILLNESS_KEYS:
        m = METRIC_BY_KEY[key]

        def zs(ds: set[date]) -> list[float]:
            out = []
            for d in ds:
                dev = deviation(days, m, d)
                if dev and dev["strain_z"] is not None:
                    out.append(dev["strain_z"])
            return out

        pos, neg = zs(positive), zs(fine_days)
        if len(pos) >= 3 and len(neg) >= 3:
            sep = statistics.mean(pos) - statistics.mean(neg)
            detail[key] = {
                "avg_strain_before_or_while_sick": round(statistics.mean(pos), 2),
                "avg_strain_when_fine": round(statistics.mean(neg), 2),
                "separation": round(sep, 2),
            }
            if active:
                weights[key] = round(m.weight * min(2.0, max(0.5, 1 + 0.5 * sep)), 2)
    return {
        "active": active,
        "sick_checkins": len(sick_days),
        "fine_checkins": len(fine_days),
        "weights": weights,
        "markers": detail,
        "note": (
            "Weights are personalised from your check-ins."
            if active
            else "Using default weights until there are at least 3 getting-sick/sick "
            "and 5 fine check-ins."
        ),
    }


# --------------------------------------------------------------------------
# Assessment
# --------------------------------------------------------------------------
def _illness_score(devs: dict[str, dict], weights: dict[str, float]) -> float:
    score = 0.0
    for key in ILLNESS_KEYS:
        dev = devs.get(key)
        if not dev:
            continue
        z = max(dev["strain_z"] or 0, dev["trend_3d_z"] or 0)
        score += weights.get(key, 1.0) * min(4.0, max(0.0, z))
    return round(score, 2)


def _fatigue_score(devs: dict[str, dict], load: dict | None) -> float:
    score = 0.0
    for m in METRICS:
        if m.group != "fatigue" or m.key not in devs:
            continue
        score += m.weight * min(4.0, max(0.0, devs[m.key]["strain_z"] or 0))
    hrv = devs.get("hrv")
    if hrv:  # a low HRV with nothing else going on usually means "tired"
        score += 0.5 * min(4.0, max(0.0, hrv["strain_z"] or 0))
    if load and load["flag"]:
        score += 1.5
    return round(score, 2)


def classify(
    devs: dict[str, dict],
    load: dict | None,
    weights: dict[str, float],
    recent_checkin: dict | None = None,
) -> dict[str, Any]:
    illness = _illness_score(devs, weights)
    fatigue = _fatigue_score(devs, load)
    flagged = [k for k in ILLNESS_KEYS if devs.get(k, {}).get("flag")]
    specific = [k for k in flagged if k in SPECIFIC_ILLNESS_KEYS]
    reasons: list[str] = []

    already_unwell = bool(recent_checkin and recent_checkin["feeling"] in ("getting_sick", "sick"))
    if (illness >= 7 and len(flagged) >= 3 and specific) or (already_unwell and len(flagged) >= 2):
        status = "sick"
        reasons.append(
            "Several illness markers are well off your normal"
            + (" and you reported feeling unwell recently" if already_unwell else "")
        )
    elif (len(flagged) >= 2 and specific) or illness >= 4.5:
        status = "getting_sick"
        reasons.append("Two or more illness markers have moved away from your normal together")
    elif fatigue >= 3 or flagged:
        status = "tired"
        reasons.append("Recovery markers are below your normal, without a clear illness pattern")
    else:
        status = "fine"
        reasons.append("Everything is within your normal range")

    for k in flagged:
        d = devs[k]
        if d["trend_3d_z"] is not None and d["trend_3d_z"] >= FLAG_TREND and (d["strain_z"] or 0) < FLAG_TODAY:
            reasons.append(f"{d['label']} has been drifting the wrong way for 3 days")
        else:
            reasons.append(f"{d['label']} is off your normal ({d.get('pct_vs_baseline', '?')}% vs baseline)")
    if load and load["flag"]:
        reasons.append(f"Training load over the last 3 days is {load['ratio']}x your 4-week average")

    return {
        "status": status,
        "illness_score": illness,
        "fatigue_score": fatigue,
        "flagged_markers": flagged,
        "reasons": reasons,
    }


TRAINING_ADVICE = {
    "sick": {
        "intensity": "rest",
        "advice": "Rest day. No training; prioritise sleep, fluids and food.",
    },
    "getting_sick": {
        "intensity": "rest_or_very_easy",
        "advice": "Skip intensity. Rest, or at most an easy walk / Zone 1 for up to 30 minutes.",
    },
    "tired": {
        "intensity": "easy",
        "advice": "Keep it easy: Zone 2 or technique work, shorter than planned. Move hard sessions.",
    },
    "fine": {
        "intensity": "as_planned",
        "advice": "Good to train as planned, including intensity.",
    },
}


def assess_morning(
    days: dict[date, dict],
    day: date,
    weights: dict[str, float],
    recent_checkin: dict | None = None,
) -> dict[str, Any]:
    """Morning assessment of ``day`` based on the night that just ended."""
    rec = days.get(day) or {}
    synced = rec.get("sleep_seconds") is not None or rec.get("hrv") is not None
    devs = {m.key: dv for m in METRICS if m.key != "avg_stress" and (dv := deviation(days, m, day))}
    load = training_load(days, day, include_day=False)
    result = classify(devs, load, weights, recent_checkin)
    advice = dict(TRAINING_ADVICE[result["status"]])
    if result["status"] == "fine" and (rec.get("training_readiness") or 100) < 40:
        advice = {
            "intensity": "moderate",
            "advice": "Vitals look normal, but Garmin Training Readiness is low; "
            "train moderately rather than going all out.",
        }
    return {
        "date": day.isoformat(),
        "last_night_synced": synced,
        **result,
        "training": advice,
        "vitals": devs,
        "training_load": load,
        "garmin": {
            "training_readiness": rec.get("training_readiness"),
            "hrv_status": rec.get("hrv_status"),
            "sleep_score": rec.get("sleep_score"),
        },
        "baseline_window": [d.isoformat() for d in baseline_window(day)],
    }


def assess_night(
    days: dict[date, dict],
    day: date,
    weights: dict[str, float],
    recent_checkin: dict | None = None,
) -> dict[str, Any]:
    """Evening outlook for tomorrow, from today's daytime data and recent nights."""
    rec = days.get(day) or {}
    morning = assess_morning(days, day, weights, recent_checkin)
    stress = deviation(days, METRIC_BY_KEY["avg_stress"], day)
    load = training_load(days, day, include_day=True)

    warnings: list[str] = []
    risk = 0.0
    illness_trend = [
        v for k, v in morning["vitals"].items()
        if k in ILLNESS_KEYS and (v.get("trend_3d_z") or 0) >= FLAG_TREND
    ]
    if illness_trend:
        risk += 1.5 * len(illness_trend)
        warnings.append(
            "Overnight markers have been drifting for a few days: "
            + ", ".join(v["label"] for v in illness_trend)
        )
    if morning["status"] in ("getting_sick", "sick"):
        risk += 2
        warnings.append(f"This morning's check already read '{morning['status'].replace('_', ' ')}'")
    if stress and (stress["strain_z"] or 0) >= FLAG_TODAY:
        risk += 1
        warnings.append(
            f"Daytime stress is high for you ({stress['value']} vs {stress['baseline']}); "
            "with a normal training day that can be an early sign of fighting something off"
        )
    bb = rec.get("body_battery_latest")
    if bb is not None and bb <= 15:
        risk += 1
        warnings.append(f"Body Battery is down to {int(bb)}")
    sleep = morning["vitals"].get("sleep_seconds")
    if sleep and (sleep.get("trend_3d_z") or 0) >= FLAG_TREND:
        risk += 1
        warnings.append("You're carrying a sleep deficit from the last few nights")
    if load and load["flag"]:
        risk += 1
        warnings.append(f"Training load is {load['ratio']}x your recent average")

    if risk >= 4:
        outlook = "at_risk_of_getting_sick"
    elif risk >= 1.5:
        outlook = "likely_tired"
    else:
        outlook = "likely_fine"

    tips = []
    if sleep and sleep.get("baseline"):
        tips.append(f"Aim for at least your normal {sleep['baseline']} h of sleep tonight")
    if outlook != "likely_fine":
        tips += ["Get to bed earlier than usual", "Skip alcohol and late hard sessions", "Hydrate"]

    return {
        "date": day.isoformat(),
        "tomorrow_outlook": outlook,
        "risk_score": round(risk, 1),
        "warnings": warnings,
        "tips": tips,
        "today": {
            "daytime_stress": stress,
            "body_battery_latest": bb,
            "steps": rec.get("steps"),
            "intensity_minutes": rec.get("intensity_minutes"),
            "training_load_today": rec.get("training_load"),
        },
        "this_morning": {k: morning[k] for k in ("status", "reasons", "illness_score", "fatigue_score")},
        "training_load": load,
    }


def accuracy(assessments: dict[date, dict], checkins: dict[date, dict]) -> dict[str, Any]:
    """How often the morning status matched what you said you felt that day."""
    pairs = [(assessments[d]["status"], checkins[d]["feeling"]) for d in assessments if d in checkins]
    if not pairs:
        return {"compared_days": 0}
    exact = sum(a == f for a, f in pairs)
    unwell = {"getting_sick", "sick"}
    caught = [a in unwell for a, f in pairs if f in unwell]
    false_alarms = [a in unwell for a, f in pairs if f == "fine"]
    return {
        "compared_days": len(pairs),
        "exact_match_pct": round(100 * exact / len(pairs)),
        "unwell_days_flagged_pct": round(100 * sum(caught) / len(caught)) if caught else None,
        "false_alarm_pct": round(100 * sum(false_alarms) / len(false_alarms)) if false_alarms else None,
    }
