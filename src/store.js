// One Durable Object holds everything for the single owner:
//   day:YYYY-MM-DD      -> daily metrics pulled from Garmin
//   checkin:YYYY-MM-DD  -> { feeling, symptoms, note, savedAt }
//   spo2:YYYY-MM-DD     -> { v: number|null, at } (Garmin serves SpO2 one day per request)
//   meta                -> { lastSync, syncedFrom, syncedTo, errors, fields }
//   token               -> cached Garmin bearer token

import { DurableObject } from "cloudflare:workers";
import { Garmin, GarminError } from "./garmin.js";
import { assess, BASELINE_DAYS, METRICS, SYMPTOMS, LEVELS } from "./model.js";
import { mockMetrics } from "./mock.js";

const HISTORY_DAYS = BASELINE_DAYS + 30; // enough for a full baseline plus a month of results
const CHUNK_DAYS = 28;
const RESYNC_MINUTES = 30;
const RECENT_REFETCH_DAYS = 3; // Garmin fills in last night's data during the morning
// A free Worker may make ~50 outside requests per invocation; keep a margin.
const REQUEST_BUDGET = 44;
const SOURCES_PER_CHUNK = 5;

export class Store extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/state" && request.method === "GET") {
        const today = url.searchParams.get("today");
        let syncError = null;
        try {
          await this.sync(today, url.searchParams.has("fresh"));
        } catch (err) {
          if (err.status === 400) throw err;
          // Garmin problems must not block check-ins: report them alongside the stored data.
          syncError = { code: err.code || "error", message: err.message };
        }
        return json({ ...(await this.state(today)), syncError });
      }
      if (url.pathname === "/checkin" && request.method === "POST") {
        const body = await request.json();
        await this.saveCheckin(body);
        return json(await this.state(body.today || body.date));
      }
      if (url.pathname === "/checkin" && request.method === "DELETE") {
        const date = url.searchParams.get("date");
        if (!isDate(date)) return json({ error: "date", message: "Bad date." }, 400);
        await this.ctx.storage.delete(`checkin:${date}`);
        return json(await this.state(url.searchParams.get("today") || date));
      }
      return json({ error: "not_found", message: "Unknown route." }, 404);
    } catch (err) {
      return json({ error: err.code || "error", message: err.message }, err.status || 500);
    }
  }

  async sync(today, force) {
    if (!isDate(today)) throw Object.assign(new Error("Parameter today must be YYYY-MM-DD."), { status: 400, code: "date" });
    const storage = this.ctx.storage;
    const meta = (await storage.get("meta")) || {};
    const fresh = meta.lastSync && Date.now() - meta.lastSync < RESYNC_MINUTES * 60000 && meta.syncedTo === today;
    // Local development: MOCK=1 uses sample data, unless GARMIN_BASE_URL points at a fake Garmin.
    const useMock = this.env.MOCK === "1" && !this.env.GARMIN_BASE_URL;
    const garmin = useMock
      ? null
      : new Garmin(
          this.env.GARMIN_API_KEY,
          { get: () => storage.get("token"), put: (v) => storage.put("token", v) },
          (this.env.MOCK === "1" && this.env.GARMIN_BASE_URL) || undefined
        );
    if (fresh && !force) {
      // Keep backfilling SpO2 history on every load until it is complete.
      if (garmin && meta.spo2Pending) {
        const r = await this.syncSpo2(garmin, addDays(today, -(HISTORY_DAYS - 1)), today, REQUEST_BUDGET - 1, meta.fields || {});
        await storage.put("meta", { ...meta, fields: r.fields, spo2Pending: r.pending });
      }
      return;
    }

    const earliest = addDays(today, -(HISTORY_DAYS - 1));
    const from = meta.syncedFrom && meta.syncedFrom <= earliest
      ? minDate(addDays(meta.syncedTo || today, -RECENT_REFETCH_DAYS), addDays(today, -RECENT_REFETCH_DAYS))
      : earliest;

    const errors = {};
    let gotAny = false;
    let used = 1; // the token request
    let fields = meta.fields || {};
    for (let start = from; start <= today; start = addDays(start, CHUNK_DAYS)) {
      const end = minDate(addDays(start, CHUNK_DAYS - 1), today);
      let result;
      try {
        result = garmin ? await garmin.metricsFor(start, end) : { days: mockMetrics(start, end), errors: {} };
      } catch (err) {
        if (err instanceof GarminError && (err.code === "garmin_auth" || err.code === "no_key")) throw err;
        errors[`${start}…${end}`] = err.message;
        continue;
      }
      used += SOURCES_PER_CHUNK;
      Object.assign(errors, result.errors);
      if (result.fields) fields = { ...fields, ...nonEmpty(result.fields) };
      const puts = {};
      for (const [date, metrics] of Object.entries(result.days)) {
        puts[`day:${date}`] = metrics;
        gotAny = true;
      }
      if (Object.keys(puts).length) await storage.put(puts);
    }

    let spo2Pending = false;
    if (garmin) {
      try {
        const r = await this.syncSpo2(garmin, earliest, today, REQUEST_BUDGET - used, fields);
        fields = r.fields;
        spo2Pending = r.pending;
      } catch (err) {
        errors.spo2 = err.message;
        spo2Pending = true;
      }
    }

    await storage.put("meta", {
      lastSync: Date.now(),
      syncedFrom: meta.syncedFrom && meta.syncedFrom < from ? meta.syncedFrom : from,
      syncedTo: today,
      errors,
      gotAny: gotAny || !!meta.gotAny,
      fields,
      spo2Pending,
    });
  }

  /** Fill SpO2 newest-first, a limited number of nights per sync, refreshing the last few. */
  async syncSpo2(garmin, earliest, today, budget, fields) {
    if (budget <= 0) return { fields, pending: true };
    const storage = this.ctx.storage;
    const have = await storage.list({ prefix: "spo2:", start: `spo2:${earliest}` });
    const recentFrom = addDays(today, -RECENT_REFETCH_DAYS);
    const want = [];
    let pending = false;
    for (let d = today; d >= earliest; d = addDays(d, -1)) {
      const rec = have.get(`spo2:${d}`);
      if (!rec || (d >= recentFrom && Date.now() - rec.at > RESYNC_MINUTES * 60000)) {
        if (want.length < budget) want.push(d);
        else if (!rec) pending = true;
      }
    }
    const puts = {};
    for (let i = 0; i < want.length; i += 6) {
      const batch = want.slice(i, i + 6);
      const results = await Promise.allSettled(batch.map((d) => garmin.spo2(d)));
      results.forEach((r, j) => {
        if (r.status === "fulfilled") {
          puts[`spo2:${batch[j]}`] = { v: r.value.value, at: Date.now() };
          if (r.value.fields.length && !fields.spo2?.length) fields = { ...fields, spo2: r.value.fields };
        }
      });
      const failed = results.find((r) => r.status === "rejected");
      if (failed && !Object.keys(puts).length) throw failed.reason;
    }
    if (Object.keys(puts).length) await storage.put(puts);
    return { fields, pending };
  }

  async saveCheckin(body) {
    const date = body?.date;
    if (!isDate(date)) throw Object.assign(new Error("Bad date."), { status: 400, code: "date" });
    const feeling = Number(body.feeling);
    if (!Number.isInteger(feeling) || feeling < 1 || feeling > 5) {
      throw Object.assign(new Error("Feeling must be 1 to 5."), { status: 400, code: "feeling" });
    }
    const symptoms = [...new Set((body.symptoms || []).filter((s) => s in SYMPTOMS))];
    const note = String(body.note || "").slice(0, 1000);
    await this.ctx.storage.put(`checkin:${date}`, { feeling, symptoms, note, savedAt: new Date().toISOString() });
  }

  async state(today) {
    const storage = this.ctx.storage;
    const [dayMap, checkMap, spo2Map, meta] = await Promise.all([
      storage.list({ prefix: "day:" }),
      storage.list({ prefix: "checkin:" }),
      storage.list({ prefix: "spo2:" }),
      storage.get("meta"),
    ]);
    const checkins = {};
    for (const [k, v] of checkMap) checkins[k.slice(8)] = v;
    const byDate = {};
    for (const [k, v] of dayMap) byDate[k.slice(4)] = { ...v };
    for (const [k, rec] of spo2Map) {
      const d = k.slice(5);
      if (typeof rec?.v === "number") (byDate[d] ||= {}).spo2 ??= rec.v;
    }
    for (const d of Object.keys(checkins)) byDate[d] ||= {};
    if (isDate(today)) byDate[today] ||= {};

    const results = assess(
      Object.entries(byDate).map(([date, metrics]) => ({ date, metrics })),
      checkins
    );
    return {
      today,
      days: results.slice(-HISTORY_DAYS),
      metrics: METRICS,
      symptoms: SYMPTOMS,
      levels: LEVELS,
      sync: { lastSync: meta?.lastSync || null, errors: meta?.errors || {}, gotAny: !!meta?.gotAny },
      fields: meta?.fields || {},
      mock: this.env.MOCK === "1",
    };
  }
}

function nonEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v && v.length));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function addDays(date, n) {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

function minDate(a, b) {
  return a < b ? a : b;
}
