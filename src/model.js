// Illness-risk model.
//
// For each day, every metric is compared with a personal baseline: the median of
// the previous 60 days, with spread measured by the median absolute deviation.
// Days you were ill (by check-in or by a high score) are left out of later
// baselines so an illness does not drag your "normal" with it.
//
// This is a heuristic early-warning signal, not a medical diagnosis.

export const METRICS = {
  hrv: { label: "Overnight HRV", unit: "ms", bad: -1, weight: 0.5, floor: 3, relFloor: 0.07, digits: 0, exercise: true },
  rhr: { label: "Resting heart rate", unit: "bpm", bad: 1, weight: 0.35, floor: 2, digits: 0, exercise: true },
  // Overlaps with resting HR, so it carries less weight on its own.
  sleepHr: { label: "Overnight average heart rate", unit: "bpm", bad: 1, weight: 0.2, floor: 1.5, digits: 0, exercise: true },
  skinTemp: { label: "Skin temperature change", unit: "°C", bad: 1, weight: 0.3, floor: 0.2, digits: 1 },
  resp: { label: "Sleep breathing rate", unit: "brpm", bad: 1, weight: 0.25, floor: 0.4, digits: 1 },
  spo2: { label: "Sleep SpO2", unit: "%", bad: -1, weight: 0.15, floor: 1, digits: 0 },
  sleepScore: { label: "Sleep score", unit: "", bad: -1, weight: 0.15, floor: 4, digits: 0 },
  bbCharged: { label: "Overnight Body Battery charge", unit: "", bad: -1, weight: 0.1, floor: 5, digits: 0 },
  stress: { label: "Average stress", unit: "", bad: 1, weight: 0.1, floor: 3, digits: 0 },
  restless: { label: "Restless moments", unit: "", bad: 1, weight: 0.08, floor: 2, digits: 0 },
  wakes: { label: "Times awake", unit: "", bad: 1, weight: 0.07, floor: 1, digits: 0 },
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
// Hard training lowers HRV and raises heart rate the next morning, like early illness does.
// After an unusually hard day, exercise-sensitive metrics count for less.
export const TRAINING = { hard: 2, moderate: 1.5, hardDamp: 0.6, moderateDamp: 0.8, absoluteHard: 200, minDays: 5 };
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

/** How you feel, split into the rating and the symptoms (capped at 2.2 in total). */
export function selfParts(checkin) {
  if (!checkin) return { rating: 0, symptoms: 0 };
  const f = Number(checkin.feeling);
  const rating = f === 1 ? 1.4 : f === 2 ? 0.8 : f === 3 ? 0.15 : 0;
  const listed = (checkin.symptoms || []).filter((k) => k in SYMPTOMS);
  let symptoms = Math.min(1.4, listed.length * 0.35) + (listed.includes("fever") ? 0.4 : 0);
  const total = rating + symptoms;
  if (total > 2.2) {
    const k = 2.2 / total;
    return { rating: rating * k, symptoms: symptoms * k };
  }
  return { rating, symptoms };
}

export function selfScore(checkin) {
  const p = selfParts(checkin);
  return p.rating + p.symptoms;
}

export function selfSick(checkin) {
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
 * How hard the previous day's training was compared with your typical training day.
 * damp < 1 means exercise-sensitive metrics count for less this morning.
 */
function trainingContext(sorted, i, t) {
  const prev = sorted[i - 1];
  const none = { load: null, typical: null, damp: 1, name: null };
  if (!prev || t - toT(prev.date) !== dayMs) return none;
  const load = prev.metrics?.trainingLoad;
  if (typeof load !== "number" || load <= 0) return none;
  const loads = [];
  for (let j = i - 1; j >= 0 && t - toT(sorted[j].date) <= BASELINE_DAYS * dayMs; j--) {
    const v = sorted[j].metrics?.trainingLoad;
    if (typeof v === "number" && v > 0) loads.push(v);
  }
  loads.sort((a, b) => a - b);
  const typical = loads.length >= TRAINING.minDays ? median(loads) : null;
  const ratio = typical ? load / typical : null;
  let damp = 1;
  if ((ratio != null && ratio >= TRAINING.hard) || (typical == null && load >= TRAINING.absoluteHard)) damp = TRAINING.hardDamp;
  else if (ratio != null && ratio >= TRAINING.moderate) damp = TRAINING.moderateDamp;
  return { load, typical, damp, name: prev.metrics?.trainingTop || null };
}

/**
 * @param {Array<{date:string, metrics:object}>} days  any order; one entry per date
 * @param {Record<string, object>} checkins  by date
 * @param {Record<string, number>} [weights]  per-metric weights; defaults to the research weights
 * @returns per-day assessments, ascending by date
 */
export function assess(days, checkins = {}, weights = null) {
  const w = (key) => weights?.[key] ?? METRICS[key].weight;
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  const excluded = new Set();
  const out = [];
  let prevPhys = 0;
  let prevDate = null;

  for (let i = 0; i < sorted.length; i++) {
    const { date, metrics = {} } = sorted[i];
    const t = toT(date);
    const training = trainingContext(sorted, i, t);
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
          phys += w(key) * entry.zBad * (cfg.exercise ? training.damp : 1);
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
      .sort((a, b) => w(b[0]) * b[1].zBad - w(a[0]) * a[1].zBad)
      .map(([key, e]) => ({ key, value: e.value, median: e.median, sd: e.sd, z: e.z }));

    out.push({ date, metrics, checkin, z, phys, persist, self, selfParts: selfParts(checkin), score, level, reasons, ready, training });

    if (selfSick(checkin) || level === "elevated" || level === "high") excluded.add(date);
    prevPhys = phys;
    prevDate = date;
  }
  return out;
}

// ---------- learning from check-ins ----------
//
// Check-ins mark when you were actually ill. From those, the app keeps a track
// record of its warnings and, once enough illnesses are logged, nudges the
// research weights towards the metrics that warned early for you. Research
// keeps at least 70% of the say.

export const LEARNING = {
  minEpisodes: 3, // personal tuning starts after this many reported illnesses
  maxInfluence: 0.3, // personal data never decides more than 30% of a weight
  influencePerEpisode: 0.1, // 10% at 3 illnesses, 20% at 4, 30% from 5
  leadDays: 3, // a warning up to 3 days before you felt ill counts as caught
  signalDays: 2, // the days just before onset used to measure each metric's early signal
  quietDays: 7, // an illness starts after at least a week of feeling fine
  factorRange: [0.5, 2], // a metric's personal weight stays within half to double its research weight
};

const BODY_ALERT = 1.0; // body signals alone at Watch level or above

const addDays = (date, n) => new Date(toT(date) + n * dayMs).toISOString().slice(0, 10);

/** Runs of days you reported feeling unwell, each starting after a week of feeling fine. */
export function illnessEpisodes(checkins) {
  const sickDates = Object.keys(checkins).filter((d) => selfSick(checkins[d])).sort();
  const episodes = [];
  let current = null;
  for (const d of sickDates) {
    if (current && toT(d) - toT(current.end) <= 2 * dayMs) {
      current.end = d; // one fine day in between still counts as the same illness
      current.days++;
      continue;
    }
    // A new run: only an onset if no sick day in the week before.
    const quiet = !sickDates.some((x) => x < d && toT(d) - toT(x) <= LEARNING.quietDays * dayMs);
    current = { onset: d, end: d, days: 1, counted: quiet };
    episodes.push(current);
  }
  return episodes.filter((e) => e.counted).map(({ counted, ...e }) => e);
}

/**
 * Track record and personal weights from per-day results of assess().
 * Body-signal alerts use physical signals only, so feeling unwell can't count as its own warning.
 */
export function learn(results, checkins) {
  const byDate = Object.fromEntries(results.map((r) => [r.date, r]));
  const episodes = illnessEpisodes(checkins);
  const bodyAlert = (r) => r && r.ready && r.phys + r.persist >= BODY_ALERT;

  // Caught or missed: any body alert in the lead window up to and including onset day.
  const judged = [];
  for (const ep of episodes) {
    let lead = null;
    for (let k = LEARNING.leadDays; k >= 0; k--) {
      if (bodyAlert(byDate[addDays(ep.onset, -k)])) {
        lead = k;
        break;
      }
    }
    const hasData = [...Array(LEARNING.leadDays + 1)].some((_, k) => byDate[addDays(ep.onset, -k)]?.ready);
    judged.push({ ...ep, caught: lead != null, leadDays: lead, hasData });
  }

  // False alarms: body alerts not near an illness, judged only when you checked in over the next 3 days.
  let alerts = 0;
  let falseAlarms = 0;
  for (const r of results) {
    if (!bodyAlert(r)) continue;
    const near = episodes.some((ep) => r.date >= addDays(ep.onset, -LEARNING.leadDays) && r.date <= ep.end);
    if (near) {
      alerts++;
      continue;
    }
    const after = [0, 1, 2, 3].map((k) => checkins[addDays(r.date, k)]).filter(Boolean);
    if (after.length < 2) continue; // not enough check-ins to know
    alerts++;
    if (!after.some(selfSick)) falseAlarms++;
  }

  // Personal signal per metric: how far it moved the wrong way just before onset, compared with healthy days.
  const usable = judged.filter((e) => e.hasData);
  const sickNear = new Set();
  for (const ep of episodes) {
    for (let d = addDays(ep.onset, -LEARNING.leadDays - 1); d <= addDays(ep.end, 2); d = addDays(d, 1)) sickNear.add(d);
  }
  const signals = {};
  for (const key of Object.keys(METRICS)) {
    const pre = [];
    for (const ep of usable) {
      const vals = [...Array(LEARNING.signalDays)].map((_, k) => byDate[addDays(ep.onset, -(k + 1))]?.z?.[key]?.zBad).filter((v) => v != null);
      if (vals.length) pre.push(Math.max(...vals));
    }
    const healthy = results.filter((r) => r.checkin && !selfSick(r.checkin) && !sickNear.has(r.date)).map((r) => r.z?.[key]?.zBad).filter((v) => v != null);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    signals[key] = { pre: mean(pre), healthy: mean(healthy), episodes: pre.length };
  }

  const influence = usable.length >= LEARNING.minEpisodes
    ? Math.min(LEARNING.maxInfluence, LEARNING.influencePerEpisode * (usable.length - LEARNING.minEpisodes + 1))
    : 0;

  // Blend: research weight × (1 − influence) + personal weight × influence, keeping the total the same.
  const research = Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.weight]));
  let weights = { ...research };
  if (influence > 0) {
    const lifts = Object.fromEntries(Object.entries(signals).map(([k, sg]) =>
      [k, sg.pre == null ? null : Math.max(0, sg.pre - (sg.healthy ?? 0))]));
    const known = Object.values(lifts).filter((v) => v != null);
    const avgLift = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
    const [lo, hi] = LEARNING.factorRange;
    const blended = {};
    for (const [k, base] of Object.entries(research)) {
      const factor = lifts[k] == null ? 1 : Math.min(hi, Math.max(lo, (lifts[k] + 0.25) / (avgLift + 0.25)));
      blended[k] = base * (1 - influence) + base * factor * influence;
    }
    // Rebalance only among metrics with data, so their total stays the same and
    // metrics this watch doesn't send keep exactly their research weight.
    const active = Object.keys(blended).filter((k) => lifts[k] != null);
    const sum = (obj) => active.reduce((a, k) => a + obj[k], 0);
    const scale = sum(blended) ? sum(research) / sum(blended) : 1;
    weights = Object.fromEntries(Object.entries(blended).map(([k, v]) => [k, active.includes(k) ? v * scale : research[k]]));
  }

  const caught = judged.filter((e) => e.caught && e.hasData);
  return {
    episodes: judged,
    record: {
      illnesses: judged.length,
      withData: usable.length,
      caught: caught.length,
      avgLeadDays: caught.length ? caught.reduce((a, e) => a + e.leadDays, 0) / caught.length : null,
      alerts,
      falseAlarms,
    },
    signals,
    influence,
    research,
    weights,
    minEpisodes: LEARNING.minEpisodes,
  };
}
