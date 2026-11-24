// Wellness Watch Worker.
// Serves the web app from ./public and a small JSON API under /api, backed by a
// single Durable Object that stores Garmin metrics and daily check-ins.
//
// Every /api request must carry a valid Cloudflare Access login. Until
// ACCESS_TEAM_DOMAIN is configured the API stays locked, so the data is never
// public, even between the first deploy and turning Access on.

export { Store } from "./store.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (env.MOCK !== "1") await requireAccess(request, env);
      if (request.method !== "GET") {
        // Cross-site forms can't send this header without a CORS preflight, which we never allow.
        if (request.headers.get("X-Requested-With") !== "wellness-watch") {
          throw new HttpError(403, "csrf", "Missing request header.");
        }
      }
      const route = url.pathname.slice(4); // "/state", "/checkin", "/reminder/..."
      const routes = ["/state", "/checkin", "/reminder/key", "/reminder/status", "/reminder/save", "/reminder/delete", "/reminder/test"];
      if (!routes.includes(route)) throw new HttpError(404, "not_found", "Unknown API route.");
      const forwarded = new Request(`https://store${route}${url.search}`, request);
      forwarded.headers.set("X-App-Origin", url.origin);
      return await store(env).fetch(forwarded);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return new Response(JSON.stringify({ error: err.code || "error", message: err.message }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  },

  // Every 15 minutes: send any morning check-in reminders that are due.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(store(env).fetch("https://store/cron", { method: "POST" }));
  },
};

const store = (env) => env.STORE.get(env.STORE.idFromName("owner"));

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- Cloudflare Access ----------

let certCache = { team: "", keys: [], fetchedAt: 0 };

export async function requireAccess(request, env) {
  const team = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!team) {
    throw new HttpError(403, "locked", "The app is locked until Cloudflare Access is set up and ACCESS_TEAM_DOMAIN is configured.");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || readCookie(request, "CF_Authorization");
  if (!token) throw new HttpError(401, "no_login", "No Cloudflare Access login on this request.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "bad_login", "Malformed Access token.");
  let header, payload;
  try {
    header = JSON.parse(b64urlText(parts[0]));
    payload = JSON.parse(b64urlText(parts[1]));
  } catch {
    throw new HttpError(401, "bad_login", "Malformed Access token.");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "bad_login", "Unexpected token algorithm.");

  const key = await accessKey(team, header.kid);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new HttpError(401, "bad_login", "Access token signature is invalid.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://${team}`) throw new HttpError(401, "bad_login", "Access token is from another team.");
  if (typeof payload.exp !== "number" || payload.exp < now) throw new HttpError(401, "expired", "Your Access login has expired.");
  if (payload.nbf && payload.nbf > now + 60) throw new HttpError(401, "bad_login", "Access token not yet valid.");
  const aud = (env.ACCESS_AUD || "").trim();
  if (aud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new HttpError(401, "bad_login", "Access token is for another application.");
  }
  const allowed = (env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(payload.email || "").toLowerCase())) {
    throw new HttpError(403, "not_allowed", "This login is not allowed to see the data.");
  }
}

async function accessKey(team, kid) {
  const fresh = certCache.team === team && Date.now() - certCache.fetchedAt < 3600_000;
  let jwk = fresh && certCache.keys.find((k) => k.kid === kid);
  if (!jwk) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new HttpError(502, "access_certs", `Could not load Access keys (${res.status}).`);
    const body = await res.json();
    certCache = { team, keys: body.keys || [], fetchedAt: Date.now() };
    jwk = certCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new HttpError(401, "bad_login", "Unknown Access signing key.");
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}
