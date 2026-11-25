// Garmin Connect Personal API: exchanges the personal API key for a 24-hour
// bearer token and reads daily health metrics.

export const GARMIN_BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

export class GarminError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Garmin {
  constructor(apiKey, tokenStore, base = GARMIN_BASE) {
    this.base = base;
    this.apiKey = (apiKey || "").trim();
    this.tokenStore = tokenStore; // { get(): Promise<{value,exp}|undefined>, put(v) }
    this.token = null;
  }

  bearer(force = false) {
    // Parallel requests share one token exchange instead of each starting their own.
    if (!this.pending || force) {
      this.pending = this.fetchBearer(force).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async fetchBearer(force) {
    const now = Date.now() / 1000;
    if (!this.token && !force) this.token = (await this.tokenStore.get()) || null;
    if (!force && this.token && this.token.exp - now > 3600) return this.token.value;
    if (!this.apiKey) throw new GarminError("no_key", "The GARMIN_API_KEY secret is not set.", 500);
    const res = await fetch(this.base + TOKEN_PATH, {
      method: "POST",
      headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
    });
    if (!res.ok) {
      throw new GarminError("garmin_auth", `Garmin rejected the API key (${res.status}). Check the GARMIN_API_KEY secret.`);
    }
    const value = (await res.text()).trim();
    let exp = now + 23 * 3600;
    try {
      const p = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      exp = JSON.parse(atob(p + "=".repeat((4 - (p.length % 4)) % 4))).exp || exp;
    } catch {
      // Not a readable JWT; assume 23 hours.
    }
    this.token = { value, exp };
    await this.tokenStore.put(this.token);
    return value;
  }

  async get(path, params) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${await this.bearer(attempt > 0)}` },
      });
      if (res.status !== 401) break;
    }
    if (!res.ok) throw new GarminError("garmin", `Garmin ${path} returned ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  sources(start, end) {
    return {
      hrv: () => this.get(`/hrv-service/hrv/daily/${start}/${end}`),
      sleep: () => this.get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: start, endDate: end }),
      bodyBattery: () =>
        this.get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: start, endDate: end }),
      stress: () => this.get(`/usersummary-service/stats/stress/daily/${start}/${end}`),
      summaries: () => this.get("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end }),
      activities: async () => {
        const all = [];
        for (let offset = 0; offset < 300; offset += 100) {
          const page = await this.get("/activitylist-service/activities/search/activities", {
            start: offset, limit: 100, startDate: start, endDate: end,
          });
          const list = Array.isArray(page) ? page : page?.activityList || page?.activities || [];
          all.push(...list);
          if (list.length < 100) break;
        }
        return all;
      },
    };
  }

  /** Fetch every source for a range and merge into { date: metrics }. */
  async metricsFor(start, end) {
    const src = this.sources(start, end);
    const names = Object.keys(src);
    const results = await Promise.allSettled(names.map((n) => src[n]()));
    const raw = {};
    const errors = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") raw[names[i]] = r.value;
      else errors[names[i]] = r.reason?.message || String(r.reason);
    });
    const auth = results.find((r) => r.status === "rejected" && ["garmin_auth", "no_key"].includes(r.reason?.code));
    if (auth) throw auth.reason;
    return { days: extract(raw), errors, fields: inventory(raw) };
  }
}

// ---------- SpO2 and skin temperature ----------

const SPO2_KEYS = [
  "averageSpO2Value", "avgSleepSpO2", "averageSleepSpO2", "avgSleepSpo2", "sleepAverageSpO2",
  "averageSpO2", "averageSPO2", "averageSpo2", "avgSpO2", "avgSpo2", "spo2Average",
];

export function findSpo2(raw) {
  const v = deepFind(raw, SPO2_KEYS);
  return v != null && v > 50 && v <= 100 ? v : null;
}

/**
 * Overnight skin-temperature change in °C, if Garmin includes one. Matches any
 * numeric field whose name mentions skin temperature, preferring ones that are
 * a change from baseline; absolute readings (around 30 °C) are ignored.
 */
export function findSkinTemp(obj) {
  let best = null;
  walk(obj, 5, (key, value) => {
    const n = num(value);
    if (n == null || !/skin.?temp/i.test(key)) return;
    const fahrenheit = /(f|fahrenheit)$/i.test(key);
    const c = fahrenheit ? n / 1.8 : n; // a change converts by scale only
    if (Math.abs(c) >= 5) return; // an absolute temperature, not a change
    const rank = /dev|change|delta|diff/i.test(key) ? 2 : 1;
    if (!best || rank > best.rank) best = { v: c, rank };
  });
  return best ? Math.round(best.v * 100) / 100 : null;
}

function deepFind(obj, keys, depth = 4) {
  let found = null;
  for (const k of keys) {
    walk(obj, depth, (key, value) => {
      if (found == null && key === k) {
        const n = num(value);
        if (n != null) found = n;
      }
    });
    if (found != null) return found;
  }
  return null;
}

function walk(obj, depth, visit) {
  if (!obj || typeof obj !== "object" || depth < 0) return;
  if (Array.isArray(obj)) {
    for (const item of obj.slice(0, 3)) walk(item, depth - 1, visit);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    visit(k, v);
    if (v && typeof v === "object") walk(v, depth - 1, visit);
  }
}

/** Field names (never values) in a response, for the in-app data check. */
export function fieldNames(raw, limit = 400) {
  const names = new Set();
  walk(raw, 3, (k) => {
    if (!/^\d+$/.test(k)) names.add(k);
  });
  return [...names].slice(0, limit);
}

function inventory(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = fieldNames(v);
  return out;
}

// ---------- shape-tolerant extraction ----------

export function extract(raw) {
  const days = {};
  const set = (date, key, v) => {
    if (date && typeof v === "number" && Number.isFinite(v)) (days[date] ||= {})[key] ??= v;
  };

  for (const h of rows(raw.hrv, ["hrvSummaries", "hrvSummary"])) {
    set(dateOf(h), "hrv", num(h.lastNightAvg ?? h.lastNight ?? h.nightlyAvg));
  }

  for (const s of rows(raw.sleep, ["dailySleepDTOs", "sleepSummaries"])) {
    const dto = s.dailySleepDTO || s;
    const d = dateOf(dto) || dateOf(s);
    set(d, "sleepScore", num(dto.sleepScores?.overall?.value ?? dto.overallSleepScore?.value ?? dto.sleepScore ?? dto.overallScore));
    set(d, "resp", num(dto.averageRespirationValue ?? dto.avgSleepRespiration ?? dto.averageRespiration ?? s.averageRespirationValue));
    set(d, "rhr", num(s.restingHeartRate ?? dto.restingHeartRate));
    set(d, "sleepSeconds", num(dto.sleepTimeSeconds ?? dto.totalSleepSeconds));
    set(d, "spo2", findSpo2(s));
    set(d, "sleepHr", num(dto.avgHeartRate ?? s.avgHeartRate ?? dto.averageHeartRate));
    set(d, "wakes", num(dto.awakeCount ?? s.awakeCount));
    set(d, "restless", deepFind(s, ["restlessMomentsCount", "restlessMoments", "restlessCount"]));
    set(d, "skinTemp", findSkinTemp(s));
    // Overnight Body Battery gain, as shown on Garmin's sleep screen.
    set(d, "bbOvernight", deepFind(s, ["bodyBatteryChange", "bodyBatteryChangeValue"]));
  }

  const bbPoints = [];
  for (const b of rows(raw.bodyBattery)) {
    // Whole-day charge: only used for completed days when no overnight figure exists.
    set(dateOf(b), "bbDaily", num(b.charged ?? b.bodyBatteryChargedValue));
    bbPoints.push(...bodyBatteryPoints(b));
  }

  // Overnight Body Battery change = level when you woke minus level when you fell asleep.
  bbPoints.sort((a, b) => a[0] - b[0]);
  for (const s of rows(raw.sleep, ["dailySleepDTOs", "sleepSummaries"])) {
    const dto = s.dailySleepDTO || s;
    const d = dateOf(dto) || dateOf(s);
    const start = epochMs(dto.sleepStartTimestampGMT ?? s.sleepStartTimestampGMT);
    const end = epochMs(dto.sleepEndTimestampGMT ?? s.sleepEndTimestampGMT);
    if (!d || start == null || end == null || end <= start) continue;
    const result = overnightChange(bbPoints, start, end);
    if (result.value != null) set(d, "bbOvernight", result.value);
    (days[d] ||= {}).bbInfo = result.info; // shown in the Data check
  }

  // Training load per day (the sum of that day's workouts), and the biggest workout's name.
  const byDay = {};
  for (const a of Array.isArray(raw.activities) ? raw.activities : []) {
    const d = String(a.startTimeLocal || "").slice(0, 10);
    const load = num(a.activityTrainingLoad ?? a.trainingLoad);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || load == null || load <= 0) continue;
    const day = (byDay[d] ||= { total: 0, top: null, topLoad: 0 });
    day.total += load;
    if (load > day.topLoad) {
      day.topLoad = load;
      day.top = String(a.activityName || a.activityType?.typeKey || "Workout").slice(0, 60);
    }
  }
  for (const [d, v] of Object.entries(byDay)) {
    set(d, "trainingLoad", Math.round(v.total));
    (days[d] ||= {}).trainingTop = v.top;
  }

  for (const s of rows(raw.stress)) {
    const v = num(s.values?.overallStressLevel ?? s.overallStressLevel ?? s.averageStressLevel);
    if (v != null && v >= 0) set(dateOf(s), "stress", v);
  }

  for (const s of rows(raw.summaries)) {
    const d = dateOf(s);
    set(d, "rhr", num(s.heartRate?.restingValue ?? s.restingHeartRate ?? s.restingHeartRateValue ?? s.values?.restingHeartRate));
    const st = num(s.averageStressLevel ?? s.values?.averageStressLevel);
    if (st != null && st >= 0) set(d, "stress", st);
    set(d, "bbDaily", num(s.bodyBattery?.chargedValue ?? s.bodyBatteryChargedValue ?? s.values?.bodyBatteryChargedValue));
    set(d, "skinTemp", findSkinTemp(s));
    set(d, "steps", num(s.totalSteps ?? s.values?.totalSteps));
  }
  return days;
}

/** [epochMs, level] pairs from a Body Battery report, using its descriptor list when present. */
export function bodyBatteryPoints(report) {
  const desc = report.bodyBatteryValueDescriptorDTOList || report.bodyBatteryValueDescriptorsDTOList || [];
  const idx = (re, fallback) => {
    const hit = desc.find((x) => re.test(x.bodyBatteryValueDescriptorKey || x.key || ""));
    return hit ? Number(hit.bodyBatteryValueDescriptorIndex ?? hit.index) : fallback;
  };
  const ti = idx(/timestamp/i, 0);
  const li = idx(/level|value$/i, -1);
  const out = [];
  for (const v of report.bodyBatteryValuesArray || []) {
    if (!Array.isArray(v)) continue;
    const t = epochMs(v[ti]);
    // Without descriptors, Garmin's usual layout is [timestamp, status, level, version] or [timestamp, level].
    const level = num(v[li >= 0 ? li : v.length >= 3 ? 2 : 1]);
    if (t != null && level != null && level >= 0 && level <= 100) out.push([t, level]);
  }
  return out;
}

const MIN = 60000;
// Readings may start up to 2 hours after you fall asleep (watch still charging, say)
// and end up to 1 hour before you wake.
const START_SLACK = 120 * MIN;
const END_SLACK = 60 * MIN;

/**
 * Overnight Body Battery change: the last reading during sleep minus the first.
 * Returns { value, info } where info explains the result for the Data check.
 */
export function overnightChange(points, start, end) {
  const clock = (t) => new Date(t).toISOString().slice(11, 16);
  const inside = points.filter(([ts]) => ts >= start - 15 * MIN && ts <= end + 15 * MIN);
  const info = { sleep: `${clock(start)}–${clock(end)} GMT`, readings: inside.length };
  if (!points.length) return { value: null, info: { ...info, reason: "no Body Battery readings downloaded" } };
  if (!inside.length) return { value: null, info: { ...info, reason: "no Body Battery readings during sleep" } };
  const [firstTs, firstLevel] = inside[0];
  const [lastTs, lastLevel] = inside[inside.length - 1];
  info.firstGapMin = Math.max(0, Math.round((firstTs - start) / MIN));
  info.lastGapMin = Math.max(0, Math.round((end - lastTs) / MIN));
  if (firstTs - start > START_SLACK) return { value: null, info: { ...info, reason: `readings start ${info.firstGapMin} min after you fell asleep` } };
  if (end - lastTs > END_SLACK) return { value: null, info: { ...info, reason: `readings stop ${info.lastGapMin} min before you woke` } };
  return { value: lastLevel - firstLevel, info: { ...info, reason: "ok" } };
}

function epochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + "Z"); // GMT strings may lack a zone
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function rows(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const k of [...keys, "data", "values", "summaries", "dailySummaries"]) {
    if (Array.isArray(value[k])) return value[k];
  }
  return dateOf(value) ? [value] : [];
}

function dateOf(o) {
  if (!o || typeof o !== "object") return null;
  const v = o.calendarDate ?? o.date ?? o.summaryDate ?? o.sleepDate;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
