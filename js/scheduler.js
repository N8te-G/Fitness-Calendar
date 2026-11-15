// Pure scheduling logic: no DOM, no network. Works in the browser and in Node (tests).

export const MIN = 60_000;
const HARD = new Set(['long', 'interval', 'tempo', 'race']);

export const DEFAULT_SETTINGS = {
  dayStart: '06:00',      // earliest a run may start
  dayEnd: '21:00',        // latest a run may finish
  preferredTime: '07:00', // used when a run has no time yet (all-day event)
  bufferMin: 30,          // free time needed before/after a run (travel, shower)
  stepMin: 15,            // slot granularity
  searchDays: 3,          // how many days either side to look for a new slot
  blockedDays: [],        // 0=Sun … 6=Sat, days you never run
  useWorkHours: false,    // add fixed work hours as busy time
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:30',
  allDayBusy: false,      // treat all-day events (trips, holidays) as busy all day
  paceMinPerKm: 6,        // used to estimate duration from "10km" in a title
  defaultDurations: { easy: 45, long: 100, interval: 60, tempo: 55, race: 120, other: 50 },
};

export const hm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};
export const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const atMinutes = (day, min) => { const d = startOfDay(day); d.setMinutes(min); return d; };
export const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
export const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86_400_000);
export const mondayOf = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

export function classifyRun(title = '') {
  const t = title.toLowerCase();
  if (/\brace\b|parkrun|marathon|half\b|10k race|5k race/.test(t)) return 'race';
  if (/long/.test(t)) return 'long';
  if (/interval|repeat|reps|\d+\s*x\s*\d|fartlek|hill|speed|track|strides/.test(t)) return 'interval';
  if (/tempo|threshold|progression|steady|pace|cruise/.test(t)) return 'tempo';
  if (/easy|recovery|shake ?out|jog|conversational/.test(t)) return 'easy';
  return 'other';
}

export const isHard = (type) => HARD.has(type);

export function looksLikeRun(ev) {
  const text = `${ev.title} ${ev.description || ''}`;
  return /runna/i.test(text) && !/rest day/i.test(ev.title);
}

export function estimateDuration(title, type, settings = DEFAULT_SETTINGS) {
  const m = /(\d+(?:\.\d+)?)\s*(km|k|mi|miles?)\b/i.exec(title || '');
  if (m) {
    const km = parseFloat(m[1]) * (/^mi/i.test(m[2]) ? 1.609 : 1);
    const mins = Math.round((km * settings.paceMinPerKm) / 5) * 5;
    if (mins >= 15 && mins <= 300) return mins;
  }
  return settings.defaultDurations[type] ?? settings.defaultDurations.other;
}

/** Fixed work-hour blocks for `days` days starting at `rangeStart`. */
export function workBlocks(rangeStart, days, settings) {
  if (!settings.useWorkHours) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(rangeStart, i);
    if (!settings.workDays.includes(day.getDay())) continue;
    out.push({
      title: 'Work hours', source: 'work',
      start: atMinutes(day, hm(settings.workStart)),
      end: atMinutes(day, hm(settings.workEnd)),
    });
  }
  return out;
}

/** Why a run at `slot` doesn't work. Empty array = slot is fine. */
export function conflictsFor(slot, busy, settings) {
  if (slot.allDay) return [{ type: 'unscheduled', label: 'No time set' }];
  const reasons = [];
  if (settings.blockedDays.includes(slot.start.getDay())) {
    reasons.push({ type: 'blocked-day', label: 'Not a running day' });
  }
  const s = minutesOfDay(slot.start);
  const e = s + (slot.end - slot.start) / MIN;
  if (s < hm(settings.dayStart) || e > hm(settings.dayEnd)) {
    reasons.push({ type: 'outside-window', label: 'Outside your running hours' });
  }
  const b = settings.bufferMin * MIN;
  for (const ev of busy) {
    if (overlaps(+slot.start - b, +slot.end + b, +ev.start, +ev.end)) {
      reasons.push({ type: 'overlap', label: `Clashes with “${ev.title}”`, event: ev });
    }
  }
  return reasons;
}

/**
 * Candidate slots for `run`, best first (one best slot per day).
 * `others` = the other runs' current planned slots: [{ start, type }].
 */
export function suggestSlots(run, others, busy, settings, { now = null, limit = 5 } = {}) {
  const dur = run.durationMin;
  const origDay = startOfDay(run.start);
  const pref = run.allDay ? hm(settings.preferredTime) : minutesOfDay(run.start);
  const offsets = [0];
  for (let i = 1; i <= settings.searchDays; i++) offsets.push(-i, i);

  const results = [];
  for (const off of offsets) {
    const day = addDays(origDay, off);
    if (settings.blockedDays.includes(day.getDay())) continue;
    if (others.some((o) => sameDay(o.start, day))) continue; // one run per day

    let penalty = Math.abs(off) * 100;
    const notes = [];
    if (isHard(run.type) && others.some((o) => isHard(o.type) && Math.abs(dayDiff(o.start, day)) === 1)) {
      penalty += 150;
      notes.push('next to another hard session');
    }
    if (run.type === 'long' && isWeekend(origDay) && !isWeekend(day)) penalty += 40;
    if (mondayOf(day).getTime() !== mondayOf(origDay).getTime()) {
      penalty += 60;
      notes.push('moves to another week');
    }

    let best = null;
    for (let m = hm(settings.dayStart); m + dur <= hm(settings.dayEnd); m += settings.stepMin) {
      const start = atMinutes(day, m);
      const end = new Date(+start + dur * MIN);
      if (now && start < now) continue;
      if (conflictsFor({ start, end }, busy, settings).length) continue;
      const score = penalty + Math.abs(m - pref) / 6;
      if (!best || score < best.score) best = { start, end, score, dayOffset: off, notes };
    }
    if (best) results.push(best);
  }
  return results.sort((a, b) => a.score - b.score).slice(0, limit);
}

/**
 * Plan the week. `runs`: [{ id, title, type, start, end, allDay, durationMin }].
 * `locked`: { [runId]: 'keep' | { start, end } } — user decisions that must be respected.
 * Returns one item per run with conflicts on the original time, alternatives and the chosen slot.
 */
export function planSchedule(runs, busy, settings, { now = null, locked = {} } = {}) {
  const plan = [...runs]
    .sort((a, b) => a.start - b.start)
    .map((run) => ({ run, start: run.start, end: run.end, allDay: run.allDay, moved: false, conflicts: [], alternatives: [] }));

  // Locked decisions first, so automatic moves work around them.
  for (const p of plan) {
    const l = locked[p.run.id];
    if (l && l !== 'keep') Object.assign(p, { start: l.start, end: l.end, allDay: false, moved: true });
  }

  for (const p of plan) {
    p.conflicts = conflictsFor(p.run, busy, settings);
    const past = now && startOfDay(p.run.start) < startOfDay(now);
    if (!p.conflicts.length || past) continue;

    const others = plan.filter((q) => q !== p).map((q) => ({ start: q.start, type: q.run.type }));
    p.alternatives = suggestSlots(p.run, others, busy, settings, { now });
    if (locked[p.run.id]) continue;
    const best = p.alternatives[0];
    if (best) Object.assign(p, { start: best.start, end: best.end, allDay: false, moved: true });
  }
  return plan;
}
