import * as R from './rules.js';
import * as G from './google.js';
import { SAMPLE_CALENDARS, sampleEvents } from './sample.js';

// ---------- saved preferences (this browser only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('fitcal2:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fitcal2:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const savedRules = store.get('rules', {});

const state = {
  mode: null, // 'google' | 'sample'
  clientId: store.get('clientId', '') || window.FITCAL_CONFIG?.clientId || '',
  rules: { ...R.DEFAULT_RULES, ...savedRules, shiftNames: { ...R.DEFAULT_RULES.shiftNames, ...savedRules.shiftNames } },
  runsCalendarId: store.get('runsCalendarId', ''),
  weeksAhead: store.get('weeksAhead', 4),
  typeOverride: store.get('typeOverride', {}),
  pinned: {},
  startWeek: R.mondayOf(new Date()),
  calendars: [],
  rawEvents: [],
  events: [],
  weeks: [],
  done: {},
};

// ---------- tiny DOM helper ----------
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const fmtDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 6000);
}

// ---------- loading ----------
function normalize(ev, cal) {
  const allDay = !!ev.start?.date;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  return {
    key: `${cal.id}|${ev.id}`,
    id: ev.id,
    calendarId: cal.id,
    calendarName: cal.name,
    writable: cal.writable,
    title: ev.summary || '(no title)',
    description: ev.description || '',
    allDay,
    start: allDay ? parse(ev.start.date) : new Date(ev.start.dateTime),
    end: allDay ? parse(ev.end.date) : new Date(ev.end.dateTime),
    raw: ev,
    skip: ev.status === 'cancelled' || ev.attendees?.some((a) => a.self && a.responseStatus === 'declined'),
  };
}

const range = () => [R.addDays(state.startWeek, -7), R.addDays(state.startWeek, 7 * state.weeksAhead)];

async function load() {
  document.body.classList.add('busy');
  try {
    if (state.mode === 'sample') {
      state.calendars = SAMPLE_CALENDARS;
      if (!state.rawEvents.length) state.rawEvents = sampleEvents(R.mondayOf(new Date()));
    } else {
      state.calendars = await G.listCalendars();
      const [from, to] = range();
      const lists = await Promise.all(state.calendars.map((c) =>
        G.listEvents(c.id, from, to).then((items) => items.map((e) => ({ ...e, calendarId: c.id })))
          .catch(() => []))); // skip calendars we can't read
      state.rawEvents = lists.flat();
    }
    state.done = {};
    compute();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.body.classList.remove('busy');
  }
}

// ---------- planning ----------
function compute() {
  const calById = Object.fromEntries(state.calendars.map((c) => [c.id, c]));
  state.events = state.rawEvents.filter((e) => calById[e.calendarId]).map((e) => normalize(e, calById[e.calendarId])).filter((e) => !e.skip);

  const isRun = (e) => R.isRunEvent(e, { runsCalendarId: state.runsCalendarId });
  const runs = state.events.filter(isRun).map((e) => ({
    ev: e,
    id: e.key,
    type: state.typeOverride[e.key] || R.classifyRun(e.title),
    date: R.startOfDay(e.start),
  }));

  // Shifts per day
  const shiftsByDay = {};
  for (const e of state.events) {
    if (isRun(e)) continue;
    const type = R.shiftType(e.title, state.rules);
    if (!type) continue;
    (shiftsByDay[R.dateKey(e.start)] ||= []).push({ type, ev: e });
  }

  const today = R.startOfDay(new Date());
  const prior = runs.filter((r) => r.date < state.startWeek).map((r) => R.dayDiff(r.date, state.startWeek));

  const weeks = [];
  for (let w = 0; w < state.weeksAhead; w++) {
    const monday = R.addDays(state.startWeek, 7 * w);
    const dates = [...Array(7)].map((_, i) => R.addDays(monday, i));
    const shifts = dates.map((d) => shiftsByDay[R.dateKey(d)] || []);
    const days = shifts.map((s) => R.dayType(s.map((x) => x.type)));
    const weekRuns = runs.filter((r) => r.date >= monday && r.date < R.addDays(monday, 7))
      .map((r) => ({ ...r, day: R.dayDiff(r.date, monday), past: r.date < today, fixed: r.date < today || !!state.pinned[r.id] }));
    weeks.push({ monday, dates, shifts, days, runs: weekRuns, earliest: Math.min(7, Math.max(0, R.dayDiff(today, monday))) });
  }
  const results = R.planWeeks(weeks, prior);
  weeks.forEach((w, i) => Object.assign(w, results[i]));
  state.weeks = weeks;
  render();
}

// ---------- applying moves ----------
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function movedTimes(ev, delta) {
  if (ev.allDay) {
    return {
      start: { date: R.dateKey(R.addDays(ev.start, delta)) },
      end: { date: R.dateKey(R.addDays(ev.end, delta)) },
    };
  }
  return {
    start: { dateTime: R.shiftDate(ev.start, delta).toISOString(), timeZone: ev.raw.start.timeZone || tz() },
    end: { dateTime: R.shiftDate(ev.end, delta).toISOString(), timeZone: ev.raw.end.timeZone || tz() },
  };
}

async function applyMove(run, week) {
  const delta = week.assign[run.id] - run.day;
  const { start, end } = movedTimes(run.ev, delta);
  try {
    if (state.mode === 'google') {
      if (!run.ev.writable) throw new Error(`“${run.ev.calendarName}” is read-only, so this run can't be moved from here`);
      await G.updateEventTimes(run.ev.calendarId, run.ev.id, start, end);
    } else {
      Object.assign(run.ev.raw, { start, end });
    }
    state.done[run.id] = true;
    return true;
  } catch (err) {
    toast(`${run.ev.title}: ${err.message}`, 'error');
    return false;
  }
}

const pendingMoves = () => state.weeks.flatMap((w) => w.runs.filter((r) => w.assign[r.id] !== r.day && !state.done[r.id]).map((r) => [r, w]));

// Nothing is written to the calendar until the user confirms in this dialog.
let reviewing = [];

function openReview(moves) {
  if (!moves.length) return;
  reviewing = moves;
  const list = $('#review-list');
  list.replaceChildren(...moves.map(([r, w], i) => {
    const to = w.assign[r.id];
    return h('li', { class: `review-item r-${r.type}` },
      h('label', {},
        h('input', { type: 'checkbox', checked: true, 'data-i': i, onchange: updateReviewCount }),
        h('span', { class: 'review-text' },
          h('b', {}, r.ev.title),
          h('span', {}, `${fmtDay.format(w.dates[r.day])} (${R.DAY_TYPES[w.days[r.day]]})`),
          h('span', { class: 'arrow' }, `→ ${fmtDay.format(w.dates[to])} (${R.DAY_TYPES[w.days[to]]})`),
        ),
      ),
    );
  }));
  $('#review-sample').hidden = state.mode !== 'sample';
  updateReviewCount();
  $('#review').showModal();
}

function selectedMoves() {
  return [...document.querySelectorAll('#review-list input:checked')].map((c) => reviewing[+c.dataset.i]);
}

function updateReviewCount() {
  const n = selectedMoves().length;
  const btn = $('#review-confirm');
  btn.disabled = !n;
  btn.textContent = n ? `Confirm ${n} change${n === 1 ? '' : 's'}` : 'Nothing selected';
}

async function confirmReview(e) {
  e.preventDefault();
  const moves = selectedMoves();
  const btn = $('#review-confirm');
  btn.disabled = true;
  btn.textContent = 'Moving…';
  let ok = 0;
  for (const [r, w] of moves) if (await applyMove(r, w)) ok++;
  $('#review').close();
  if (ok) toast(`Moved ${ok} run${ok === 1 ? '' : 's'} in your calendar`, 'ok');
  await (state.mode === 'google' ? load() : Promise.resolve(compute()));
}

// ---------- rendering ----------
function render() {
  $('#welcome').hidden = !!state.mode;
  $('#planner').hidden = !state.mode;
  $('#mode').hidden = !state.mode;
  if (!state.mode) return;
  $('#mode').textContent = state.mode === 'sample' ? 'Sample data' : 'Google Calendar';
  $('#range').textContent = `${fmtDate.format(state.startWeek)} – ${fmtDate.format(R.addDays(state.startWeek, 7 * state.weeksAhead - 1))}`;

  const moves = pendingMoves();
  $('#apply-all').disabled = !moves.length;
  $('#apply-all').textContent = moves.length ? `Review ${moves.length} change${moves.length === 1 ? '' : 's'}` : 'Nothing to move';
  const totalRuns = state.weeks.reduce((n, w) => n + w.runs.length, 0);
  $('#status').textContent = !totalRuns
    ? 'No Runna runs found. Check “Where are your runs?” in Settings.'
    : moves.length ? `Suggested: move ${moves.length} run${moves.length === 1 ? '' : 's'} to fit your rota. Nothing changes until you confirm.` : 'All runs fit your rota. 👍';

  $('#weeks').replaceChildren(...state.weeks.map(renderWeek));
}

function renderWeek(w) {
  const hard = w.issues.filter((i) => !i.soft);
  const soft = w.issues.filter((i) => i.soft);
  const notes = [
    ...hard.map((i) => h('li', { class: 'bad' }, i.text)),
    ...soft.map((i) => h('li', { class: 'meh' }, i.text)),
    w.runs.length && w.runs.length !== state.rules.runsPerWeek ? h('li', { class: 'meh' }, `${w.runs.length} runs this week (you usually run ${state.rules.runsPerWeek})`) : null,
  ].filter(Boolean);

  return h('section', { class: 'week' },
    h('header', { class: 'week-h' },
      h('h2', {}, `Week of ${fmtDay.format(w.monday)}`),
      h('span', { class: 'muted' }, `${w.runs.length} run${w.runs.length === 1 ? '' : 's'}`),
    ),
    notes.length ? h('ul', { class: 'notes' }, ...notes) : null,
    h('div', { class: 'days' }, ...w.dates.map((date, i) => renderDay(w, date, i))),
    w.runs.length ? h('div', { class: 'runs' }, ...w.runs.map((r) => renderRunRow(w, r))) : null,
  );
}

function renderDay(w, date, i) {
  const type = w.days[i];
  const isToday = R.dateKey(date) === R.dateKey(new Date());
  const past = date < R.startOfDay(new Date());
  const shift = w.shifts[i].find((s) => s.type === type) || w.shifts[i][0];
  const here = w.runs.filter((r) => w.assign[r.id] === i);
  const leaving = w.runs.filter((r) => r.day === i && w.assign[r.id] !== i);
  return h('div', { class: `day t-${type}${isToday ? ' today' : ''}${past ? ' past' : ''}` },
    h('div', { class: 'day-date' }, h('b', {}, fmtWeekday.format(date)), ' ', fmtDate.format(date)),
    h('div', { class: 'shift' }, R.DAY_TYPES[type],
      shift && !shift.ev.allDay ? h('small', {}, `${fmtTime.format(shift.ev.start)}–${fmtTime.format(shift.ev.end)}`) : null),
    ...here.map((r) => h('div', { class: `run r-${r.type}${r.day !== i ? ' moved' : ''}`, title: r.ev.title },
      h('span', { class: 'run-type' }, R.RUN_TYPES[r.type]),
      h('span', { class: 'run-title' }, r.ev.title),
      r.day !== i ? h('span', { class: 'from' }, `from ${fmtWeekday.format(w.dates[r.day])}`) : null)),
    ...leaving.map((r) => h('div', { class: `run r-${r.type} ghost`, title: r.ev.title },
      h('span', { class: 'run-title' }, r.ev.title),
      h('span', { class: 'from' }, `→ ${fmtWeekday.format(w.dates[w.assign[r.id]])}`))),
  );
}

function renderRunRow(w, r) {
  const to = w.assign[r.id];
  const moving = to !== r.day;
  const done = state.done[r.id];
  const past = r.date < R.startOfDay(new Date());
  return h('div', { class: `run-row${moving ? ' moving' : ''}` },
    h('select', {
      class: `type-select r-${r.type}`, 'aria-label': `Type of ${r.ev.title}`,
      onchange: (e) => {
        state.typeOverride[r.id] = e.target.value;
        store.set('typeOverride', state.typeOverride);
        compute();
      },
    }, ...Object.entries(R.RUN_TYPES).map(([v, l]) => h('option', { value: v, selected: v === r.type }, l))),
    h('span', { class: 'row-title' }, r.ev.title),
    h('span', { class: 'row-when' },
      fmtDay.format(w.dates[r.day]),
      moving ? h('span', { class: 'arrow' }, ` → ${fmtDay.format(w.dates[to])} (${R.DAY_TYPES[w.days[to]]})`) : h('span', { class: 'muted' }, past ? ' · done' : ' · stays')),
    h('span', { class: 'row-actions' },
      past ? null : h('label', { class: 'pin', title: 'Keep this run on its current day' },
        h('input', { type: 'checkbox', checked: !!state.pinned[r.id], onchange: (e) => { state.pinned[r.id] = e.target.checked; compute(); } }),
        ' Keep day'),
      moving && !done ? h('button', { class: 'btn small', type: 'button', onclick: () => openReview([[r, w]]) }, 'Review') : null,
    ),
  );
}

// ---------- settings ----------
function openSettings() {
  const f = $('#settings-form');
  f.clientId.value = state.clientId;
  f.late1.value = state.rules.shiftNames.late1;
  f.late2.value = state.rules.shiftNames.late2;
  f.early2.value = state.rules.shiftNames.early2;
  f.workPrefix.value = state.rules.workPrefix;
  f.runsPerWeek.value = state.rules.runsPerWeek;
  f.weeksAhead.value = state.weeksAhead;
  f.runsCalendar.replaceChildren(
    h('option', { value: '' }, 'Any calendar: events that mention Runna'),
    ...state.calendars.map((c) => h('option', { value: c.id, selected: c.id === state.runsCalendarId }, `Everything on “${c.name}”`)),
  );
  $('#settings').showModal();
}

function saveSettings(e) {
  e.preventDefault();
  const f = e.target;
  state.clientId = f.clientId.value.trim();
  state.rules = {
    shiftNames: { late1: f.late1.value.trim(), late2: f.late2.value.trim(), early2: f.early2.value.trim() },
    workPrefix: f.workPrefix.value.trim(),
    runsPerWeek: Number(f.runsPerWeek.value) || 3,
  };
  state.runsCalendarId = f.runsCalendar.value;
  const weeksChanged = state.weeksAhead !== Number(f.weeksAhead.value);
  state.weeksAhead = Math.min(8, Math.max(1, Number(f.weeksAhead.value) || 4));
  store.set('clientId', state.clientId);
  store.set('rules', state.rules);
  store.set('runsCalendarId', state.runsCalendarId);
  store.set('weeksAhead', state.weeksAhead);
  $('#settings').close();
  updateWelcome();
  if (state.mode === 'google' && weeksChanged) load();
  else if (state.mode) compute();
}

function updateWelcome() {
  $('#needs-id').hidden = !!state.clientId;
  $('#connect').disabled = !state.clientId;
}

// ---------- wiring ----------
$('#connect').addEventListener('click', async () => {
  try {
    await G.signIn(state.clientId);
    state.mode = 'google';
    state.rawEvents = [];
    render();
    await load();
  } catch (err) { toast(err.message, 'error'); }
});
$('#sample').addEventListener('click', () => { state.mode = 'sample'; state.rawEvents = []; state.startWeek = R.mondayOf(new Date()); load(); });
$('#disconnect').addEventListener('click', () => { G.signOut(); state.mode = null; state.rawEvents = []; render(); });
const goWeek = (d) => { state.startWeek = d; state.pinned = {}; state.mode === 'google' ? load() : compute(); };
$('#prev').addEventListener('click', () => goWeek(R.addDays(state.startWeek, -7)));
$('#next').addEventListener('click', () => goWeek(R.addDays(state.startWeek, 7)));
$('#today').addEventListener('click', () => goWeek(R.mondayOf(new Date())));
$('#refresh').addEventListener('click', load);
$('#apply-all').addEventListener('click', () => openReview(pendingMoves()));
$('#review-form').addEventListener('submit', confirmReview);
$('#review-cancel').addEventListener('click', () => $('#review').close());
for (const b of document.querySelectorAll('.open-settings')) b.addEventListener('click', openSettings);
$('#settings-form').addEventListener('submit', saveSettings);
$('#settings-cancel').addEventListener('click', () => $('#settings').close());
$('#origin').textContent = location.origin;

updateWelcome();
render();
