// Run: node test/access.test.mjs
import assert from "node:assert/strict";
import { webcrypto as crypto } from "node:crypto";

// worker.js re-exports the Durable Object (needs cloudflare:workers), so load the
// Access check from source text instead.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8")
  .replace(/^export \{ Store \}.*$/m, "")
  .replace(/^export default[\s\S]*?^};$/m, "");
const mod = await import("data:text/javascript," + encodeURIComponent(src));
const { requireAccess } = mod;

const TEAM = "myteam.cloudflareaccess.com";
const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
globalThis.fetch = async (url) => {
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};
const b64 = (b) => Buffer.from(b).toString("base64url");
async function token(payload, { key = keys.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const h = b64(JSON.stringify({ alg, kid })), p = b64(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: `https://${TEAM}`, aud: ["aud1"], exp: now + 600, email: "me@example.com" };
const req = (t, cookie) => new Request("https://x/api/state", { headers: t ? (cookie ? { Cookie: `a=b; CF_Authorization=${t}` } : { "Cf-Access-Jwt-Assertion": t }) : {} });
const env = { ACCESS_TEAM_DOMAIN: TEAM };
const rejects = async (p, code) => assert.equal((await p.then(() => ({ code: "PASSED" }), (e) => e)).code, code);

await rejects(requireAccess(req(await token(good)), {}), "locked");
await rejects(requireAccess(req(null), env), "no_login");
await requireAccess(req(await token(good)), env);
await requireAccess(req(await token(good), true), env);
await requireAccess(req(await token(good)), { ...env, ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: "aud1", ALLOWED_EMAILS: "ME@example.com" });
await rejects(requireAccess(req(await token(good, { key: other.privateKey })), env), "bad_login");
await rejects(requireAccess(req(await token({ ...good, iss: "https://evil.cloudflareaccess.com" })), env), "bad_login");
await rejects(requireAccess(req(await token({ ...good, exp: now - 5 })), env), "expired");
await rejects(requireAccess(req(await token(good, { alg: "none" })), env), "bad_login");
await rejects(requireAccess(req(await token(good, { kid: "nope" })), env), "bad_login");
await rejects(requireAccess(req(await token(good)), { ...env, ACCESS_AUD: "other" }), "bad_login");
await rejects(requireAccess(req(await token(good)), { ...env, ALLOWED_EMAILS: "someone@else.com" }), "not_allowed");
const t = await token(good); const [h, , s] = t.split(".");
await rejects(requireAccess(req(`${h}.${b64(JSON.stringify({ ...good, email: "x@y" }))}.${s}`), env), "bad_login");
console.log("access tests passed");
