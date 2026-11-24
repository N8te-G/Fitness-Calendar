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

// ---------- SpO2 ----------

const SPO2_KEYS = [
  "averageSpO2Value", "avgSleepSpO2", "averageSleepSpO2", "avgSleepSpo2", "sleepAverageSpO2",
  "averageSpO2", "averageSPO2", "averageSpo2", "avgSpO2", "avgSpo2", "spo2Average",
];

export function findSpo2(raw) {
  const v = deepFind(raw, SPO2_KEYS);
  return v != null && v > 50 && v <= 100 ? v : null;
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
export function fieldNames(raw, limit = 80) {
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
  }

  for (const b of rows(raw.bodyBattery)) {
    set(dateOf(b), "bbCharged", num(b.charged ?? b.bodyBatteryChargedValue));
    const values = (b.bodyBatteryValuesArray || [])
      .map((v) => num(Array.isArray(v) ? v[1] : v?.value))
      .filter((v) => v != null);
    if (values.length) set(dateOf(b), "bbHigh", Math.max(...values));
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
    set(d, "bbCharged", num(s.bodyBatteryChargedValue ?? s.values?.bodyBatteryChargedValue));
    set(d, "steps", num(s.totalSteps ?? s.values?.totalSteps));
  }
  return days;
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
