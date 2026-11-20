// Planning rules. Pure functions only (no DOM, no network) so they can be unit-tested in Node.

export const DAY_TYPES = {
  off: 'Day off',
  late1: '1st Late',
  late2: '2nd Late',
  early2: '2nd Early',
  work: 'Other shift',
};

export const RUN_TYPES = { easy: 'Easy', speed: 'Speed', long: 'Long', race: 'Race' };

/**
 * Which day types each run type may go on, with a cost (lower = preferred).
 * A day type that is missing is not allowed.
 */
export const ALLOWED = {
  easy: { late1: 0, late2: 0 },
  speed: { late1: 0, late2: 0, off: 0, early2: 0 },
  long: { off: 0, early2: 40 }, // 2nd Early only as a last resort
};

export const DEFAULT_RULES = {
  shiftNames: { late1: 'Work-1st Late', late2: 'Work-2nd Late', early2: 'Work-2nd Early' },
  workPrefix: 'Work', // any other event starting with this word is some other shift
  runsPerWeek: 3,
};

const HARD = 1000; // cost of breaking a rule
const MOVE_COST = 2; // per day a run is moved
const REORDER_COST = 3; // per pair of runs that swap order

// ---------- date helpers (local time) ----------
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const mondayOf = (d) => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
export const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / 86_400_000);
export const dateKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ---------- classification ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Shift type for an event title, or null if it isn't a work shift. */
export function shiftType(title, rules = DEFAULT_RULES) {
  const t = norm(title);
  if (!t) return null;
  for (const [type, name] of Object.entries(rules.shiftNames)) {
    if (name && t.includes(norm(name))) return type;
  }
  if (rules.workPrefix && new RegExp(`^${escapeRe(rules.workPrefix.trim())}(?![a-z])`, 'i').test(String(title).trim())) {
    return 'work';
  }
  return null;
}

/** Day type from the shift types found on that day. A specific shift wins over "other shift". */
export function dayType(shiftTypes) {
  const found = shiftTypes.filter(Boolean);
  return found.find((t) => t !== 'work') || found[0] || 'off';
}

export function classifyRun(title = '') {
  const t = title.toLowerCase();
  if (/\brace\b|parkrun|race day/.test(t)) return 'race';
  if (/long/.test(t)) return 'long';
  if (/interval|tempo|threshold|fartlek|hill|repeat|progression|speed|track|pyramid|\d+\s*x\s*\d/.test(t)) return 'speed';
  return 'easy';
}

export function isRunEvent(ev, { runsCalendarId = '' } = {}) {
  if (/\brest\b/i.test(ev.title)) return false;
  if (runsCalendarId) return ev.calendarId === runsCalendarId;
  return /runna/i.test(`${ev.title} ${ev.description || ''} ${ev.calendarName || ''}`);
}

// ---------- planning ----------
function ruleCost(run, dayTypeName) {
  const allowed = ALLOWED[run.type];
  if (!allowed || !(dayTypeName in allowed)) return HARD;
  return allowed[dayTypeName];
}

/**
 * Plan one Mon–Sun week.
 * @param days   7 day types, Monday first, e.g. ['late1', 'off', …]
 * @param runs   [{ id, type, day, fixed }] where day is 0–6 (original day)
 * @param opts.earliest  first day index runs may be moved to (e.g. today)
 * @param opts.neighbours day indices of runs outside this week (e.g. -1 = last Sunday)
 * @returns { assign: { [id]: day }, cost, issues: [{ id?, text }] }
 */
export function planWeek(days, runs, { earliest = 0, neighbours = [] } = {}) {
  const fixed = runs.filter((r) => r.fixed || r.type === 'race');
  const movable = runs.filter((r) => !fixed.includes(r)).sort((a, b) => a.day - b.day);
  const fixedDays = fixed.map((r) => r.day);
  const free = [];
  for (let d = Math.max(0, earliest); d < 7; d++) if (!fixedDays.includes(d)) free.push(d);

  let best = null;
  const cur = [];

  const finish = (cost) => {
    const all = [...fixedDays, ...cur, ...neighbours].sort((a, b) => a - b);
    for (let i = 1; i < all.length; i++) if (all[i] - all[i - 1] <= 1) cost += HARD;
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) if (cur[i] > cur[j]) cost += REORDER_COST;
    if (!best || cost < best.cost) best = { cost, days: [...cur] };
  };

  const rec = (i, cost, used) => {
    if (best && cost >= best.cost) return;
    if (i === movable.length) return finish(cost);
    for (const d of free) {
      if (used.has(d)) continue;
      const r = movable[i];
      cur[i] = d;
      used.add(d);
      rec(i + 1, cost + ruleCost(r, days[d]) + Math.abs(d - r.day) * MOVE_COST, used);
      used.delete(d);
    }
    cur.length = i;
  };

  const assign = {};
  for (const r of fixed) assign[r.id] = r.day;
  if (movable.length <= free.length) {
    rec(0, 0, new Set());
    movable.forEach((r, i) => { assign[r.id] = best.days[i]; });
  } else {
    for (const r of movable) assign[r.id] = r.day; // not enough days left: leave as is
  }
  return { assign, cost: best?.cost ?? null, issues: findIssues(days, runs, assign, neighbours) };
}

/** Human-readable problems with a finished plan. */
export function findIssues(days, runs, assign, neighbours = []) {
  const issues = [];
  for (const r of runs) {
    const d = assign[r.id];
    if (r.type === 'race' || r.past) continue; // nothing to do about runs already done
    const cost = ruleCost(r, days[d]);
    if (cost >= HARD) issues.push({ id: r.id, text: `No allowed day left for the ${RUN_TYPES[r.type].toLowerCase()} run (it's on ${DAY_TYPES[days[d]]})` });
    else if (r.type === 'long' && days[d] === 'early2') issues.push({ id: r.id, text: 'Long run on 2nd Early (no day off available)', soft: true });
  }
  const placed = [...runs.map((r) => assign[r.id]), ...neighbours].sort((a, b) => a - b);
  for (let i = 1; i < placed.length; i++) {
    if (placed[i] - placed[i - 1] <= 1) {
      issues.push({ text: placed[i - 1] < 0 ? 'No rest day after last week’s final run' : 'Two runs without a rest day in between' });
    }
  }
  return issues;
}

/**
 * Plan several consecutive weeks, carrying each week's last run into the next.
 * @param weeks [{ days: [7 day types], runs: [...], earliest }]
 * @param priorRunDays day indices relative to the first week of runs before the horizon (e.g. [-1, -3])
 */
export function planWeeks(weeks, priorRunDays = []) {
  let carry = priorRunDays;
  return weeks.map((w) => {
    const result = planWeek(w.days, w.runs, { earliest: w.earliest ?? 0, neighbours: carry.filter((d) => d >= -1) });
    carry = Object.values(result.assign).map((d) => d - 7);
    return result;
  });
}

/** Same time of day, different date. */
export function shiftDate(date, days) {
  const x = new Date(date);
  x.setDate(x.getDate() + days);
  return x;
}
