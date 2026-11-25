// Run: node test/training.test.mjs
import assert from "node:assert/strict";
import { assess } from "../src/model.js";

const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;

function scenario(lastDayLoad) {
  const days = [];
  for (let i = 0; i < 40; i++) {
    const date = addDays("2026-10-01", i);
    const last = i === 39;
    days.push({ date, metrics: {
      hrv: last ? 44 : 58 + rnd() * 6, // the same dip on the final morning in every scenario
      rhr: last ? 58 : 52 + rnd() * 2,
      resp: 14 + rnd() * 0.4,
      trainingLoad: i === 38 ? lastDayLoad : i % 2 ? 100 : 0, // usual training day: load 100
      trainingTop: i === 38 ? "Long run" : "Workout",
    } });
  }
  return days;
}

seed = 3; const easy = assess(scenario(100)).at(-1);
seed = 3; const moderate = assess(scenario(160)).at(-1);
seed = 3; const hard = assess(scenario(250)).at(-1);

assert.equal(easy.training.damp, 1, "a normal training day changes nothing");
assert.equal(moderate.training.damp, 0.8, "1.5× usual load: exercise-sensitive metrics count 80%");
assert.equal(hard.training.damp, 0.6, "2× usual load: exercise-sensitive metrics count 60%");
assert.equal(hard.training.typical, 100);
assert.equal(hard.training.name, "Long run");
assert.ok(Math.abs(hard.phys - easy.phys * 0.6) < 1e-9, "same dip scores 60% after a hard day");
assert.ok(hard.phys < easy.phys && moderate.phys < easy.phys);

// Feeling unwell still counts in full after a hard day.
seed = 3;
const days = scenario(250);
const sick = assess(days, { [days.at(-1).date]: { feeling: 2, symptoms: ["throat", "fever"] } }).at(-1);
assert.ok(Math.abs(sick.self - 1.9) < 1e-9, "check-in unaffected by training");

// A rest day before doesn't dampen anything.
seed = 3;
const rest = scenario(0);
assert.equal(assess(rest).at(-1).training.damp, 1);
console.log(`easy ${easy.phys.toFixed(2)} · moderate ${moderate.phys.toFixed(2)} · hard ${hard.phys.toFixed(2)}`);
console.log("training tests passed");
