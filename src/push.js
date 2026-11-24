// Web Push without a payload: the push only wakes the service worker, which
// shows the reminder. That needs just a VAPID signature (RFC 8292), no
// message encryption. The VAPID key pair is generated once and kept in the
// Durable Object's storage.

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

/** Send an empty push. Returns the HTTP status (404/410 mean the subscription is gone). */
export async function sendPush(keys, endpoint, contact) {
  const aud = new URL(endpoint).origin;
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const claims = b64urlJson({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact });
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: String(6 * 3600),
      Urgency: "normal",
      Authorization: `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`,
      "Content-Length": "0",
    },
  });
  return res.status;
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
