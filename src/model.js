// Illness-risk model.
//
// For each day, every metric is compared with a personal baseline: the median of
// the previous 60 days, with spread measured by the median absolute deviation.
// Days you were ill (by check-in or by a high score) are left out of later
// baselines so an illness does not drag your "normal" with it.
//
// This is a heuristic early-warning signal, not a medical diagnosis.

export const METRICS = {
  hrv: { label: "Overnight HRV", unit: "ms", bad: -1, weight: 0.5, floor: 3, relFloor: 0.07, digits: 0 },
  rhr: { label: "Resting heart rate", unit: "bpm", bad: 1, weight: 0.35, floor: 2, digits: 0 },
  skinTemp: { label: "Skin temperature change", unit: "°C", bad: 1, weight: 0.3, floor: 0.2, digits: 1 },
  resp: { label: "Sleep breathing rate", unit: "brpm", bad: 1, weight: 0.25, floor: 0.4, digits: 1 },
  spo2: { label: "Sleep SpO2", unit: "%", bad: -1, weight: 0.15, floor: 1, digits: 0 },
  sleepScore: { label: "Sleep score", unit: "", bad: -1, weight: 0.15, floor: 4, digits: 0 },
  bbCharged: { label: "Body Battery recharge", unit: "", bad: -1, weight: 0.1, floor: 5, digits: 0 },
  stress: { label: "Average stress", unit: "", bad: 1, weight: 0.1, floor: 3, digits: 0 },
};

export const SYMPTOMS = {
  throat: "Sore throat",
  nose: "Runny or blocked nose",
  cough: "Cough",
  fatigue: "Unusual tiredness",
  aches: "Muscle aches",
  headache: "Headache",
  fever: "Fever or chills",
  stomach: "Stomach upset",
};

export const BASELINE_DAYS = 60;
export const MIN_BASELINE = 14;
const Z_CAP = 4;
// Deviations inside half an SD are ordinary night-to-night noise and score nothing.
const DEAD_ZONE = 0.5;
// A metric is listed as a reason once it is this many SDs the wrong way.
const REASON_Z = 1.5;

export const LEVELS = [
  { key: "normal", label: "Normal", min: -Infinity },
  { key: "watch", label: "Watch", min: 1.0 },
  { key: "elevated", label: "Elevated", min: 1.75 },
  { key: "high", label: "High", min: 2.75 },
];

export function levelFor(score) {
  let out = LEVELS[0];
  for (const l of LEVELS) if (score >= l.min) out = l;
  return out.key;
}

export function selfScore(checkin) {
  if (!checkin) return 0;
  const f = Number(checkin.feeling);
  let s = 0;
  if (f === 1) s += 1.4;
  else if (f === 2) s += 0.8;
  else if (f === 3) s += 0.15;
  const n = (checkin.symptoms || []).filter((k) => k in SYMPTOMS).length;
  s += Math.min(1.4, n * 0.35);
  if ((checkin.symptoms || []).includes("fever")) s += 0.4;
  return Math.min(2.2, s);
}

function selfSick(checkin) {
  if (!checkin) return false;
  return Number(checkin.feeling) <= 2 || (checkin.symptoms || []).length >= 2;
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

const dayMs = 86400000;
const toT = (d) => Date.parse(d + "T00:00:00Z");

/**
 * @param {Array<{date:string, metrics:object}>} days  any order; one entry per date
 * @param {Record<string, object>} checkins  by date
 * @returns per-day assessments, ascending by date
 */
export function assess(days, checkins = {}) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const excluded = new Set();
  const out = [];
  let prevPhys = 0;
  let prevDate = null;

  for (let i = 0; i < sorted.length; i++) {
    const { date, metrics = {} } = sorted[i];
    const t = toT(date);
    const checkin = checkins[date] || null;
    const z = {};
    let phys = 0;
    let ready = false;

    for (const [key, cfg] of Object.entries(METRICS)) {
      const history = [];
      for (let j = i - 1; j >= 0; j--) {
        const d = sorted[j];
        if (t - toT(d.date) > BASELINE_DAYS * dayMs) break;
        if (excluded.has(d.date)) continue;
        const v = d.metrics?.[key];
        if (typeof v === "number") history.push(v);
      }
      const value = metrics[key];
      const entry = { value: typeof value === "number" ? value : null, n: history.length };
      if (history.length >= MIN_BASELINE) {
        history.sort((a, b) => a - b);
        const med = median(history);
        const mad = median(history.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
        const sd = Math.max(mad * 1.4826, cfg.floor, (cfg.relFloor || 0) * Math.abs(med));
        entry.median = med;
        entry.sd = sd;
        if (entry.value != null) {
          entry.z = (entry.value - med) / sd;
          entry.zBad = Math.min(Z_CAP, Math.max(0, entry.z * cfg.bad - DEAD_ZONE));
          phys += cfg.weight * entry.zBad;
        }
        if (key === "hrv") ready = true;
      }
      z[key] = entry;
    }

    const consecutive = prevDate && t - toT(prevDate) === dayMs;
    const persist = consecutive && prevPhys >= 0.6 && phys >= 0.6 ? 0.3 : 0;
    const self = selfScore(checkin);
    const score = phys + persist + self;
    let level = levelFor(score);
    if (!ready && !checkin) level = "building";

    const reasons = Object.entries(z)
      .filter(([key, e]) => e.z != null && e.z * METRICS[key].bad >= REASON_Z)
      .sort((a, b) => METRICS[b[0]].weight * b[1].zBad - METRICS[a[0]].weight * a[1].zBad)
      .map(([key, e]) => ({ key, value: e.value, median: e.median, sd: e.sd, z: e.z }));

    out.push({ date, metrics, checkin, z, phys, persist, self, score, level, reasons, ready });

    if (selfSick(checkin) || level === "elevated" || level === "high") excluded.add(date);
    prevPhys = phys;
    prevDate = date;
  }
  return out;
}
