import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, classifyRun, estimateDuration, conflictsFor, suggestSlots,
  planSchedule, workBlocks, looksLikeRun, MIN,
} from '../js/scheduler.js';

const S = { ...DEFAULT_SETTINGS };
// Monday 2026-11-16
const at = (day, h, m = 0) => new Date(2026, 10, 16 + day, h, m);
const run = (id, title, day, h, dur, extra = {}) => {
  const start = at(day, h);
  return { id, title, type: classifyRun(title), start, end: new Date(+start + dur * MIN), allDay: false, durationMin: dur, ...extra };
};
const ev = (title, day, h1, h2) => ({ title, start: at(day, h1), end: at(day, h2) });

test('classifies Runna titles', () => {
  assert.equal(classifyRun('Long Run - 18km'), 'long');
  assert.equal(classifyRun('Intervals: 6 x 800m'), 'interval');
  assert.equal(classifyRun('Tempo Run'), 'tempo');
  assert.equal(classifyRun('Easy Run 5km'), 'easy');
  assert.equal(classifyRun('Parkrun'), 'race');
});

test('detects Runna events on other calendars', () => {
  assert.ok(looksLikeRun({ title: 'Easy run', description: 'Created by Runna' }));
  assert.ok(!looksLikeRun({ title: 'Runna: Rest day' }));
  assert.ok(!looksLikeRun({ title: 'Dentist' }));
});

test('estimates duration from distance', () => {
  assert.equal(estimateDuration('Long Run 16km', 'long', S), 95);
  assert.equal(estimateDuration('Intervals', 'interval', S), 60);
});

test('buffer creates a conflict', () => {
  const r = run('a', 'Easy Run', 1, 7, 45); // 7:00-7:45
  const c = conflictsFor(r, [ev('Standup', 1, 8, 9)], S); // buffer 30 → 8:15
  assert.equal(c.length, 1);
  assert.equal(c[0].type, 'overlap');
  assert.equal(conflictsFor(r, [ev('Standup', 1, 9, 10)], S).length, 0);
});

test('suggests a same-day slot when possible', () => {
  const r = run('a', 'Easy Run', 1, 7, 45);
  const busy = [ev('Early meeting', 1, 7, 8)];
  const [best] = suggestSlots(r, [], busy, S);
  assert.equal(best.dayOffset, 0);
  assert.ok(best.start >= at(1, 8, 30));
});

test('avoids days that already have a run and hard sessions back-to-back', () => {
  const r = run('a', 'Intervals 6x800', 1, 7, 60); // Tue
  const busy = [ev('All-day workshop', 1, 6, 21)];
  const others = [{ start: at(0, 7), type: 'easy' }, { start: at(3, 7), type: 'tempo' }]; // Mon, Thu
  const alts = suggestSlots(r, others, busy, S);
  assert.ok(alts.every((a) => a.dayOffset !== -1)); // Monday taken
  assert.equal(alts[0].dayOffset, 1); // Wed, even though next to Thu tempo it beats 2+ days away
  assert.ok(alts[0].notes.includes('next to another hard session'));
});

test('planSchedule moves conflicting runs and respects locks', () => {
  const runs = [run('a', 'Easy Run', 1, 7, 45), run('b', 'Long Run 16km', 6, 9, 95)];
  const busy = [ev('Breakfast meeting', 1, 7, 8), ev('Brunch', 6, 10, 12)];
  const plan = planSchedule(runs, busy, S);
  assert.ok(plan.every((p) => p.moved));
  assert.equal(plan[0].start.getDate(), at(1, 0).getDate());

  const keep = planSchedule(runs, busy, S, { locked: { a: 'keep' } });
  assert.equal(+keep[0].start, +runs[0].start);
  assert.equal(keep[0].moved, false);
});

test('unscheduled (all-day) runs get a time', () => {
  const r = { ...run('a', 'Easy Run 5km', 2, 0, 30), allDay: true, start: at(2, 0), end: at(3, 0) };
  const [p] = planSchedule([r], [], S);
  assert.equal(p.conflicts[0].type, 'unscheduled');
  assert.equal(p.start.getHours(), 7);
});

test('work hours become busy blocks', () => {
  const blocks = workBlocks(at(0, 0), 7, { ...S, useWorkHours: true });
  assert.equal(blocks.length, 5);
});
