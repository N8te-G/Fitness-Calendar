// Web Push (RFC 8030) with a VAPID signature (RFC 8292) and an encrypted
// message (RFC 8291, aes128gcm). The VAPID key pair is generated once and kept
// in the Durable Object's storage.

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function vapidKeys(storage) {
  let keys = await storage.get("vapid");
  if (!keys) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    keys = {
      publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    await storage.put("vapid", keys);
  }
  return keys;
}

const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Encrypt a message for one subscription (RFC 8291, single aes128gcm record). */
export async function encryptPayload(p256dh, auth, plaintext) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const peer = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(utf8(plaintext), new Uint8Array([2])); // 0x02 marks the last record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));

  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/**
 * Send a push. With subscription keys the message is encrypted and carried in the push;
 * without them an empty push is sent. Returns { status, detail }; 404/410 mean the
 * subscription is gone.
 */
export async function sendPush(keys, sub, contact, message) {
  const { endpoint } = sub;
  const aud = new URL(endpoint).origin;
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const claims = b64urlJson({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact });
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  const headers = {
    TTL: String(6 * 3600),
    Urgency: "high",
    Authorization: `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`,
  };
  let body = new Uint8Array(0);
  if (message && sub.p256dh && sub.auth) {
    body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Type"] = "application/octet-stream";
  }
  const res = await fetch(endpoint, { method: "POST", headers, body });
  const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
  return { status: res.status, detail };
}

/** Local date (YYYY-MM-DD) and minutes past midnight in a time zone. */
export function localNow(timeZone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Should a reminder go out now? Only within 3 hours after the chosen time, once a day. */
export function isDue(sub, now) {
  const [h, m] = sub.time.split(":").map(Number);
  const target = h * 60 + m;
  return sub.lastSentDate !== now.date && now.minutes >= target && now.minutes < target + 180;
}
