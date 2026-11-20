import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftType, dayType, classifyRun, isRunEvent, planWeek, planWeeks, shiftDate } from '../js/rules.js';

test('recognises shifts by title', () => {
  assert.equal(shiftType('Work-1st Late'), 'late1');
  assert.equal(shiftType('work - 2nd late'), 'late2');
  assert.equal(shiftType('WORK 2ND EARLY 07:00'), 'early2');
  assert.equal(shiftType('Work-1st Early'), 'work');
  assert.equal(shiftType('Workout at gym'), null);
  assert.equal(shiftType('Dentist'), null);
  assert.equal(dayType([null, 'work', 'late2']), 'late2');
  assert.equal(dayType([]), 'off');
});

test('classifies runs', () => {
  assert.equal(classifyRun('Long Run - 18km'), 'long');
  assert.equal(classifyRun('Intervals 6 x 800m'), 'speed');
  assert.equal(classifyRun('Tempo Run'), 'speed');
  assert.equal(classifyRun('Easy Run 5km'), 'easy');
  assert.equal(classifyRun('Recovery jog'), 'easy');
});

test('finds Runna events', () => {
  assert.ok(isRunEvent({ title: 'Easy Run', description: 'Open in Runna' }));
  assert.ok(!isRunEvent({ title: 'Runna: Rest day' }));
  assert.ok(isRunEvent({ title: 'Anything', calendarId: 'c1' }, { runsCalendarId: 'c1' }));
});

const W = (s) => s.split(' '); // 'late1 off …' → array

test('easy runs go to late shifts, long runs to days off, with rest days', () => {
  //          Mon    Tue   Wed  Thu   Fri    Sat Sun
  const days = W('early2 late1 work late2 early2 off off');
  const runs = [
    { id: 'e', type: 'easy', day: 0 },
    { id: 's', type: 'speed', day: 2 },
    { id: 'l', type: 'long', day: 4 },
  ];
  const { assign, issues } = planWeek(days, runs);
  assert.equal(days[assign.e].startsWith('late'), true);
  assert.equal(days[assign.l], 'off');
  const placed = Object.values(assign).sort();
  for (let i = 1; i < placed.length; i++) assert.ok(placed[i] - placed[i - 1] >= 2, `rest day: ${placed}`);
  assert.deepEqual(issues.filter((x) => !x.soft), []);
});

test('long run falls back to 2nd Early when there is no day off', () => {
  const days = W('late1 work late2 work early2 work work');
  const runs = [{ id: 'e', type: 'easy', day: 1 }, { id: 'l', type: 'long', day: 6 }];
  const { assign, issues } = planWeek(days, runs);
  assert.equal(assign.l, 4);
  assert.ok(issues.some((i) => i.soft && /2nd Early/.test(i.text)));
});

test('runs that already fit are not moved', () => {
  const days = W('late1 off late2 off off off off');
  const runs = [{ id: 'a', type: 'easy', day: 0 }, { id: 'b', type: 'easy', day: 2 }, { id: 'c', type: 'long', day: 6 }];
  assert.deepEqual(planWeek(days, runs).assign, { a: 0, b: 2, c: 6 });
});

test('respects a run at the end of the previous week', () => {
  const days = W('late1 off late2 off late1 off off');
  const runs = [{ id: 'a', type: 'easy', day: 0 }];
  const { assign } = planWeek(days, runs, { neighbours: [-1] });
  assert.notEqual(assign.a, 0);
});

test('past and fixed runs stay put; nothing is moved into the past', () => {
  const days = W('late1 off late2 off late1 off off');
  const runs = [{ id: 'a', type: 'easy', day: 1, fixed: true }, { id: 'b', type: 'easy', day: 3 }];
  const { assign } = planWeek(days, runs, { earliest: 2 });
  assert.equal(assign.a, 1);
  assert.equal(assign.b, 4); // late1, not day 2 (next to fixed run)
});

test('reports impossible weeks', () => {
  const days = W('work work work work work work work');
  const { issues } = planWeek(days, [{ id: 'e', type: 'easy', day: 0 }]);
  assert.ok(issues.length);
});

test('planWeeks carries a Sunday run into the next week', () => {
  const week = W('late1 off late2 off late1 off off');
  const [, w2] = planWeeks([
    { days: week, runs: [{ id: 'l', type: 'long', day: 6 }] },
    { days: week, runs: [{ id: 'e', type: 'easy', day: 0 }] },
  ]);
  assert.notEqual(w2.assign.e, 0);
});

test('shiftDate keeps the time of day', () => {
  const d = shiftDate(new Date(2026, 10, 20, 7, 30), 3);
  assert.equal(d.getDate(), 23);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 30);
});
