// Run: node test/push.test.mjs
import assert from "node:assert/strict";
import { vapidKeys, sendPush, localNow, isDue } from "../src/push.js";

// In-memory stand-in for Durable Object storage.
const mem = new Map();
const storage = { get: async (k) => mem.get(k), put: async (k, v) => mem.set(k, v) };

const keys = await vapidKeys(storage);
assert.deepEqual(await vapidKeys(storage), keys, "key pair is generated once and reused");
assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65, "uncompressed P-256 public key");

let captured;
globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
const status = await sendPush(keys, "https://fcm.googleapis.com/fcm/send/abc123", "https://wellness-watch.example.workers.dev");
assert.equal(status, 201);
assert.equal(captured.init.method, "POST");
assert.equal(captured.init.headers.TTL, String(6 * 3600));
const m = captured.init.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
assert.ok(m, "VAPID authorization header");
assert.equal(m[2], keys.publicKey);
const [h, p, sig] = m[1].split(".");
const claims = JSON.parse(Buffer.from(p, "base64url"));
assert.equal(claims.aud, "https://fcm.googleapis.com");
assert.equal(claims.sub, "https://wellness-watch.example.workers.dev");
assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, "exp within 24h");
const pub = await crypto.subtle.importKey("raw", Buffer.from(keys.publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(`${h}.${p}`)), "JWT signature verifies");

// Time zones: 07:30 UTC in winter is 07:30 London, 08:30 Paris.
const winter = new Date("2026-12-01T07:30:00Z");
assert.deepEqual(localNow("Europe/London", winter), { date: "2026-12-01", minutes: 450 });
assert.deepEqual(localNow("Europe/Paris", winter), { date: "2026-12-01", minutes: 510 });
// Summer time: 07:30 UTC is 08:30 London.
assert.equal(localNow("Europe/London", new Date("2026-07-01T07:30:00Z")).minutes, 510);

const sub = { time: "08:00" };
assert.equal(isDue(sub, { date: "2026-12-01", minutes: 479 }), false, "not before the time");
assert.equal(isDue(sub, { date: "2026-12-01", minutes: 480 }), true, "at the time");
assert.equal(isDue(sub, { date: "2026-12-01", minutes: 659 }), true, "within 3 hours");
assert.equal(isDue(sub, { date: "2026-12-01", minutes: 660 }), false, "not hours later");
assert.equal(isDue({ ...sub, lastSentDate: "2026-12-01" }, { date: "2026-12-01", minutes: 500 }), false, "once a day");
assert.equal(isDue({ ...sub, lastSentDate: "2026-11-30" }, { date: "2026-12-01", minutes: 500 }), true, "again next day");
console.log("push tests passed");
