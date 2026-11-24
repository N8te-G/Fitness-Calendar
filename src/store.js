// One Durable Object holds everything for the single owner:
//   day:YYYY-MM-DD      -> daily metrics pulled from Garmin
//   checkin:YYYY-MM-DD  -> { feeling, symptoms, note, savedAt }
//   meta                -> { lastSync, syncedFrom, syncedTo, errors, fields }
//   token               -> cached Garmin bearer token
//   vapid               -> push signing key pair
//   push:<id>           -> { endpoint, time: "HH:MM", tz, origin, lastSentDate }

import { DurableObject } from "cloudflare:workers";
import { Garmin, GarminError } from "./garmin.js";
import { assess, BASELINE_DAYS, METRICS, SYMPTOMS, LEVELS } from "./model.js";
import { mockMetrics } from "./mock.js";
import { vapidKeys, sendPush, localNow, isDue } from "./push.js";

const HISTORY_DAYS = BASELINE_DAYS + 30; // enough for a full baseline plus a month of results
const CHUNK_DAYS = 28;
const RESYNC_MINUTES = 30;
// Bump when the way Garmin data is read changes, so stored history is re-downloaded.
const EXTRACT_VERSION = 4;
const RECENT_REFETCH_DAYS = 3; // Garmin fills in last night's data during the morning


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
      if (url.pathname.startsWith("/reminder")) return json(await this.reminder(url.pathname, request));
      if (url.pathname === "/cron" && request.method === "POST") return json(await this.sendDueReminders());
      return json({ error: "not_found", message: "Unknown route." }, 404);
    } catch (err) {
      return json({ error: err.code || "error", message: err.message }, err.status || 500);
    }
  }

  async sync(today, force) {
    if (!isDate(today)) throw Object.assign(new Error("Parameter today must be YYYY-MM-DD."), { status: 400, code: "date" });
    const storage = this.ctx.storage;
    const meta = (await storage.get("meta")) || {};
    const current = meta.version === EXTRACT_VERSION;
    const fresh = current && meta.lastSync && Date.now() - meta.lastSync < RESYNC_MINUTES * 60000 && meta.syncedTo === today;
    // Local development: MOCK=1 uses sample data, unless GARMIN_BASE_URL points at a fake Garmin.
    const useMock = this.env.MOCK === "1" && !this.env.GARMIN_BASE_URL;
    const garmin = useMock
      ? null
      : new Garmin(
          this.env.GARMIN_API_KEY,
          { get: () => storage.get("token"), put: (v) => storage.put("token", v) },
          (this.env.MOCK === "1" && this.env.GARMIN_BASE_URL) || undefined
        );
    if (fresh && !force) return;

    const earliest = addDays(today, -(HISTORY_DAYS - 1));
    const from = current && meta.syncedFrom && meta.syncedFrom <= earliest
      ? minDate(addDays(meta.syncedTo || today, -RECENT_REFETCH_DAYS), addDays(today, -RECENT_REFETCH_DAYS))
      : earliest;

    const errors = {};
    let gotAny = false;
    let fields = meta.fields || {};
    for (let start = from; start <= today; start = addDays(start, CHUNK_DAYS)) {
      const end = minDate(addDays(start, CHUNK_DAYS - 1), today);
      // Fetch from the day before, so the first night's falling-asleep reading is included.
      const fetchFrom = addDays(start, -1);
      let result;
      try {
        result = garmin ? await garmin.metricsFor(fetchFrom, end) : { days: mockMetrics(start, end), errors: {} };
        // The extra day is only there for its readings; don't store its partial figures.
        delete result.days[fetchFrom];
      } catch (err) {
        if (err instanceof GarminError && (err.code === "garmin_auth" || err.code === "no_key")) throw err;
        errors[`${start}…${end}`] = err.message;
        continue;
      }
      Object.assign(errors, result.errors);
      if (result.fields) fields = { ...fields, ...nonEmpty(result.fields) };
      // Merge with what's stored: a figure that needs the previous day's data (like the
      // overnight Body Battery change on a chunk's first day) keeps its earlier value.
      const keys = Object.keys(result.days).map((d) => `day:${d}`);
      const existing = keys.length ? await storage.get(keys) : new Map();
      const puts = {};
      for (const [date, metrics] of Object.entries(result.days)) {
        const before = current ? existing.get(`day:${date}`) || {} : {};
        puts[`day:${date}`] = { ...before, ...metrics };
        gotAny = true;
      }
      if (Object.keys(puts).length) await storage.put(puts);
    }

    await storage.put("meta", {
      lastSync: Date.now(),
      syncedFrom: meta.syncedFrom && meta.syncedFrom < from ? meta.syncedFrom : from,
      syncedTo: today,
      errors,
      gotAny: gotAny || !!meta.gotAny,
      fields,
      version: EXTRACT_VERSION,
    });
  }

  // ---------- morning reminder ----------

  async reminder(path, request) {
    const storage = this.ctx.storage;
    const keys = await vapidKeys(storage);
    if (path === "/reminder/key") return { publicKey: keys.publicKey };
    if (request.method !== "POST") throw httpError(405, "method", "Use POST.");
    const body = await request.json().catch(() => ({}));
    const endpoint = String(body.endpoint || "");
    if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 2000) throw httpError(400, "endpoint", "Bad push endpoint.");
    const key = `push:${await sha(endpoint)}`;

    if (path === "/reminder/status") {
      const sub = await storage.get(key);
      return { publicKey: keys.publicKey, reminder: sub ? { time: sub.time, tz: sub.tz } : null };
    }
    if (path === "/reminder/save") {
      const time = String(body.time || "");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw httpError(400, "time", "Time must be HH:MM.");
      const tz = String(body.tz || "UTC");
      try {
        localNow(tz);
      } catch {
        throw httpError(400, "tz", "Unknown time zone.");
      }
      const prev = await storage.get(key);
      const origin = request.headers.get("X-App-Origin") || "https://example.invalid";
      // If the reminder time today has already passed, don't fire straight away.
      const now = localNow(tz);
      const [h, m] = time.split(":").map(Number);
      const lastSentDate = prev?.lastSentDate || (now.minutes >= h * 60 + m ? now.date : null);
      await storage.put(key, { endpoint, time, tz, origin, lastSentDate });
      return { reminder: { time, tz } };
    }
    if (path === "/reminder/delete") {
      await storage.delete(key);
      return { reminder: null };
    }
    if (path === "/reminder/test") {
      const sub = await storage.get(key);
      if (!sub) throw httpError(404, "no_reminder", "Turn the reminder on first.");
      const status = await sendPush(keys, sub.endpoint, sub.origin);
      if (status >= 400) throw httpError(502, "push", `The browser's push service refused the message (${status}).`);
      return { sent: true };
    }
    throw httpError(404, "not_found", "Unknown reminder route.");
  }

  async sendDueReminders() {
    const storage = this.ctx.storage;
    const subs = await storage.list({ prefix: "push:" });
    if (!subs.size) return { sent: 0 };
    const keys = await vapidKeys(storage);
    let sent = 0;
    for (const [key, sub] of subs) {
      const now = localNow(sub.tz);
      if (!isDue(sub, now)) continue;
      if (await storage.get(`checkin:${now.date}`)) {
        await storage.put(key, { ...sub, lastSentDate: now.date }); // already checked in today
        continue;
      }
      const status = await sendPush(keys, sub.endpoint, sub.origin).catch(() => 0);
      if (status === 404 || status === 410) await storage.delete(key); // phone unsubscribed
      else if (status >= 200 && status < 300) {
        await storage.put(key, { ...sub, lastSentDate: now.date });
        sent++;
      }
    }
    return { sent };
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
    const [dayMap, checkMap, meta] = await Promise.all([
      storage.list({ prefix: "day:" }),
      storage.list({ prefix: "checkin:" }),
      storage.get("meta"),
    ]);
    const checkins = {};
    for (const [k, v] of checkMap) checkins[k.slice(8)] = v;
    const byDate = {};
    for (const [k, v] of dayMap) {
      const date = k.slice(4);
      const m = { ...v };
      // Prefer the overnight charge. A whole-day total is only comparable for completed days:
      // this morning's would count just the hours since midnight.
      const bb = m.bbOvernight ?? (isDate(today) && date < today ? m.bbDaily : undefined);
      if (bb != null) m.bbCharged = bb;
      byDate[date] = m;
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

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function sha(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
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
