// Run: node test/learning.test.mjs
import assert from "node:assert/strict";
import { assess, learn, illnessEpisodes, METRICS } from "../src/model.js";

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

// A year of normal nights, with illnesses whose warning sign is resting HR rising 2 days early.
const start = "2026-01-01";
const onsets = ["2026-03-10", "2026-05-02", "2026-07-15", "2026-09-20", "2026-11-05"];
const days = [];
const checkins = {};
for (let i = 0; i < 330; i++) {
  const date = addDays(start, i);
  const ahead = Math.min(...onsets.map((o) => (Date.parse(o) - Date.parse(date)) / 864e5).filter((x) => x >= -3));
  const pre = ahead <= 2 && ahead >= 0 ? 1 : 0; // the 2 days before and onset day
  const ill = ahead <= 0 && ahead >= -3 ? 1 : 0;
  days.push({ date, metrics: {
    hrv: 60 + rnd() * 6 - ill * 3,
    rhr: 52 + rnd() * 2 + pre * 7 + ill * 6,
    resp: 14 + rnd() * 0.4,
    sleepScore: 78 + rnd() * 8,
    bbCharged: 60 + rnd() * 10,
    stress: 25 + rnd() * 6,
  } });
  // Check in most days; feeling unwell during each illness.
  if (i % 4 !== 3) checkins[date] = ill ? { feeling: 2, symptoms: ["throat", "fatigue"] } : { feeling: 4, symptoms: [] };
}

const eps = illnessEpisodes(checkins);
assert.equal(eps.length, 5, "five separate illnesses");
// Onset is the first day you *reported* feeling ill (a day without a check-in can shift it by one).
eps.forEach((e, i) => assert.ok((Date.parse(e.onset) - Date.parse(onsets[i])) / 864e5 <= 1, `onset ${e.onset} ~ ${onsets[i]}`));

// With only 2 illnesses so far: track record yes, tuning not yet.
const early = Object.fromEntries(Object.entries(checkins).filter(([d]) => d < "2026-06-01"));
const r2 = learn(assess(days, early), early);
assert.equal(r2.record.illnesses, 2);
assert.equal(r2.influence, 0, "no tuning before 3 illnesses");
assert.deepEqual(r2.weights, r2.research, "research weights unchanged");

// All 5: maximum influence of 30%.
const res = assess(days, checkins);
const l = learn(res, checkins);
assert.equal(l.record.illnesses, 5);
assert.equal(l.influence, 0.3);
assert.ok(l.record.caught >= 4, `caught most illnesses (got ${l.record.caught})`);
assert.ok(l.record.avgLeadDays >= 1, "warned at least a day ahead on average");
const total = (w) => Object.values(w).reduce((a, b) => a + b, 0);
assert.ok(Math.abs(total(l.weights) - total(l.research)) < 1e-9, "total weight unchanged");
assert.equal(l.weights.skinTemp, l.research.skinTemp, "metrics without data keep their research weight");
assert.equal(l.weights.spo2, l.research.spo2, "metrics without data keep their research weight");
assert.ok(l.weights.rhr > l.research.rhr, "resting HR gains weight");
assert.ok(l.weights.hrv < l.research.hrv, "HRV loses some weight");
for (const k of Object.keys(METRICS)) {
  const ratio = l.weights[k] / l.research[k];
  assert.ok(ratio > 0.7 && ratio < 1.4, `${k} stays close to research (${ratio.toFixed(2)})`);
}
console.log("record", l.record);
console.log("weights", Object.fromEntries(Object.entries(l.weights).map(([k, v]) => [k, `${l.research[k]} -> ${v.toFixed(3)}`])));
console.log("learning tests passed");
