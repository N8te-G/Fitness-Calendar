import * as S from './scheduler.js';
import * as G from './google.js';
import { DEMO_CALENDARS, demoEvents } from './demo.js';

// ---------- persistence (per-browser conveniences only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('fitcal:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fitcal:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const savedSettings = store.get('settings', {});
const state = {
  mode: null, // 'google' | 'demo'
  calendars: [],
  roles: store.get('roles', {}),
  settings: { ...S.DEFAULT_SETTINGS, ...savedSettings, defaultDurations: { ...S.DEFAULT_SETTINGS.defaultDurations, ...savedSettings.defaultDurations } },
  clientId: store.get('clientId', '') || window.FITCAL_CONFIG?.clientId || '',
  weekStart: S.mondayOf(new Date()),
  events: [],
  locked: {},
  plan: [],
  busy: [],
  done: {}, // runId -> message after applying
};

const MOVED_MARK = /fitcal:moved-from=(\S+)/;
const $ = (sel) => document.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtSlot = (start, end, allDay) => allDay ? `${fmtDay.format(start)} · no time` : `${fmtDay.format(start)} · ${fmtTime.format(start)}–${fmtTime.format(end)}`;
const TYPE_LABEL = { easy: 'Easy', long: 'Long', interval: 'Intervals', tempo: 'Tempo', race: 'Race', other: 'Run' };

function toast(msg, kind = 'info') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 5000);
}

// ---------- data ----------
function defaultRole(cal) {
  if (/runna/i.test(cal.name)) return 'runs';
  if (/holiday|birthday|week numbers|contacts|phases of the moon/i.test(cal.name)) return 'ignore';
  return 'busy';
}
const role = (calId) => state.roles[calId] || defaultRole(state.calendars.find((c) => c.id === calId) || { name: '' });

function normalize(ev, cal) {
  const allDay = !!ev.start?.date;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  return {
    id: ev.id, calendarId: cal.id,
    title: ev.summary || '(no title)',
    description: ev.description || '',
    start: allDay ? parseDate(ev.start.date) : new Date(ev.start.dateTime),
    end: allDay ? parseDate(ev.end.date) : new Date(ev.end.dateTime),
    allDay,
    transparent: ev.transparency === 'transparent',
    declined: !!ev.attendees?.some((a) => a.self && a.responseStatus === 'declined'),
    cancelled: ev.status === 'cancelled',
  };
}

const fetchRange = () => [S.addDays(state.weekStart, -state.settings.searchDays), S.addDays(state.weekStart, 7 + state.settings.searchDays)];

async function load() {
  $('#main').classList.add('loading');
  try {
    if (state.mode === 'demo') {
      state.calendars = DEMO_CALENDARS;
      if (!state.demoEvents) state.demoEvents = demoEvents(demoWeek());
      state.events = state.demoEvents;
    } else {
      state.calendars = await G.listCalendars();
      const [from, to] = fetchRange();
      const wanted = state.calendars.filter((c) => role(c.id) !== 'ignore');
      const lists = await Promise.all(wanted.map((c) => G.listEvents(c.id, from, to).then((items) => items.map((e) => normalize(e, c)))));
      state.events = lists.flat();
    }
    state.locked = {};
    state.done = {};
    compute();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    $('#main').classList.remove('loading');
  }
}

function compute() {
  const st = state.settings;
  const weekEnd = S.addDays(state.weekStart, 7);
  const evs = state.events.filter((e) => role(e.calendarId) !== 'ignore' && !e.cancelled && !e.declined);

  const isRunEvent = (e) => MOVED_MARK.test(e.description) || (role(e.calendarId) === 'runs' ? !/rest day/i.test(e.title) : S.looksLikeRun(e));
  const runEvents = evs.filter(isRunEvent);
  // Runs we already copied elsewhere (because their calendar is read-only) are superseded by the copy.
  const superseded = new Set(runEvents.map((e) => MOVED_MARK.exec(e.description)?.[1]).filter(Boolean));
  const runs = runEvents
    .filter((e) => !superseded.has(`${e.calendarId}|${e.id}`) && e.start >= state.weekStart && e.start < weekEnd)
    .map((e) => {
      const type = S.classifyRun(e.title);
      return {
        id: `${e.calendarId}|${e.id}`, title: e.title, type, start: e.start, end: e.end, allDay: e.allDay,
        durationMin: e.allDay ? S.estimateDuration(e.title, type, st) : Math.round((e.end - e.start) / S.MIN),
        event: e,
      };
    });

  const runSet = new Set(runEvents);
  const [from] = fetchRange();
  state.busy = [
    ...evs.filter((e) => !runSet.has(e) && role(e.calendarId) === 'busy' && !e.transparent && (!e.allDay || st.allDayBusy))
      .map((e) => ({ ...e, source: 'calendar' })),
    ...S.workBlocks(from, 7 + 2 * st.searchDays, st),
  ];
  state.allDayInfo = evs.filter((e) => e.allDay && !runSet.has(e));
  state.plan = S.planSchedule(runs, state.busy, st, { now: new Date(), locked: state.locked });
  render();
}

// ---------- applying changes ----------
function changeText(p) {
  return `${p.run.title}: ${fmtSlot(p.run.start, p.run.end, p.run.allDay)} → ${fmtSlot(p.start, p.end, false)}`;
}

async function apply(p) {
  const e = p.run.event;
  const cal = state.calendars.find((c) => c.id === e.calendarId);
  const primary = state.calendars.find((c) => c.primary) || state.calendars.find((c) => c.writable);
  try {
    if (cal?.writable) {
      if (state.mode === 'google') await G.moveEvent(cal.id, e.id, p.start, p.end);
      else Object.assign(e, { start: p.start, end: p.end, allDay: false });
      state.done[p.run.id] = 'Moved in your calendar';
    } else {
      if (!primary) throw new Error('No calendar you can write to.');
      const copy = {
        title: `🏃 ${p.run.title}`,
        description: `Moved by Fitness Calendar from ${fmtSlot(p.run.start, p.run.end, p.run.allDay)}.\nRemember to move it in the Runna app too.\n\nfitcal:moved-from=${p.run.id}`,
        start: p.start, end: p.end,
      };
      if (state.mode === 'google') await G.createEvent(primary.id, copy);
      else state.demoEvents.push({ ...copy, id: `copy-${Date.now()}`, calendarId: primary.id, allDay: false });
      state.done[p.run.id] = `Added to “${primary.name}” — also move it in Runna`;
    }
    toast(`${p.run.title}: ${state.done[p.run.id]}`, 'ok');
    return true;
  } catch (err) {
    toast(`${p.run.title}: ${err.message}`, 'error');
    return false;
  }
}

async function applyAll() {
  const todo = state.plan.filter((p) => p.moved && !state.done[p.run.id]);
  for (const p of todo) await apply(p);
  await load();
}

async function copyChanges() {
  const lines = state.plan.filter((p) => p.moved).map(changeText);
  const text = lines.length ? `Run changes for week of ${fmtDay.format(state.weekStart)}:\n` + lines.map((l) => `• ${l}`).join('\n') : 'No changes this week.';
  try { await navigator.clipboard.writeText(text); toast('Change list copied', 'ok'); }
  catch { prompt('Copy your change list:', text); }
}

// ---------- rendering ----------
function render() {
  $('#welcome').hidden = !!state.mode;
  $('#app').hidden = !state.mode;
  if (!state.mode) return;
  $('#mode-badge').textContent = state.mode === 'demo' ? 'Sample data' : 'Google Calendar';
  $('#mode-badge').className = `badge ${state.mode}`;
  $('#week-label').textContent = `${fmtDay.format(state.weekStart)} – ${fmtDay.format(S.addDays(state.weekStart, 6))}`;
  renderCalendars();
  renderChanges();
  renderGrid();
}

function renderCalendars() {
  const list = $('#calendar-list');
  list.replaceChildren(...state.calendars.map((c) => h('li', {},
    h('span', { class: 'swatch', style: `background:${c.color}` }),
    h('span', { class: 'cal-name', title: c.name }, c.name),
    h('select', {
      'aria-label': `Use of ${c.name}`,
      onchange: (ev) => { state.roles[c.id] = ev.target.value; store.set('roles', state.roles); state.mode === 'google' ? load() : compute(); },
    }, ...[['runs', 'Runs'], ['busy', 'Busy time'], ['ignore', 'Ignore']].map(([v, l]) => h('option', { value: v, selected: role(c.id) === v }, l))),
  )));
}

function renderChanges() {
  const items = state.plan.filter((p) => p.conflicts.length || p.moved);
  const ok = state.plan.length - items.length;
  const pending = state.plan.filter((p) => p.moved && !state.done[p.run.id]).length;
  $('#summary').textContent = !state.plan.length
    ? 'No runs found this week. Check that your Runna calendar is set to “Runs”.'
    : `${state.plan.length} run${state.plan.length === 1 ? '' : 's'} this week · ${ok} fit${ok === 1 ? 's' : ''} as planned · ${items.length} need${items.length === 1 ? 's' : ''} attention`;
  $('#apply-all').disabled = !pending;
  $('#apply-all').textContent = pending ? `Apply ${pending} change${pending === 1 ? '' : 's'}` : 'Apply changes';

  $('#changes').replaceChildren(...items.map((p) => {
    const id = p.run.id;
    const lock = state.locked[id];
    const cal = state.calendars.find((c) => c.id === p.run.event.calendarId);
    const options = [
      ...p.alternatives.map((a, i) => h('option', { value: `alt:${i}`, selected: p.moved && +a.start === +p.start },
        `${fmtSlot(a.start, a.end)}${a.dayOffset === 0 ? ' (same day)' : ''}${a.notes.length ? ' · ' + a.notes.join(', ') : ''}`)),
      h('option', { value: 'keep', selected: !p.moved }, 'Keep original time'),
      h('option', { value: 'custom', selected: lock && lock !== 'keep' && !p.alternatives.some((a) => +a.start === +lock.start) }, 'Pick a time…'),
    ];
    const custom = h('input', {
      type: 'datetime-local', class: 'custom-time', 'aria-label': 'Custom start time',
      hidden: !(lock && lock !== 'keep' && !p.alternatives.some((a) => +a.start === +lock.start)),
      value: toLocalInput(p.start),
      onchange: (ev) => {
        if (!ev.target.value) return;
        const start = new Date(ev.target.value);
        state.locked[id] = { start, end: new Date(+start + p.run.durationMin * S.MIN) };
        compute();
      },
    });
    const select = h('select', {
      'aria-label': `New time for ${p.run.title}`,
      onchange: (ev) => {
        const v = ev.target.value;
        if (v === 'custom') { custom.hidden = false; custom.focus(); return; }
        if (v === 'keep') state.locked[id] = 'keep';
        else { const a = p.alternatives[+v.slice(4)]; state.locked[id] = { start: a.start, end: a.end }; }
        compute();
      },
    }, ...options);
    const newConflicts = p.moved ? S.conflictsFor(p, state.busy, state.settings) : [];
    const done = state.done[id];
    return h('article', { class: `change ${done ? 'done' : ''}`, style: `--type: var(--run-${p.run.type})` },
      h('header', {},
        h('span', { class: 'chip' }, TYPE_LABEL[p.run.type]),
        h('h3', {}, p.run.title),
      ),
      h('p', { class: 'was' }, h('span', { class: 'k' }, 'Planned'), fmtSlot(p.run.start, p.run.end, p.run.allDay)),
      h('ul', { class: 'reasons' }, ...p.conflicts.map((c) => h('li', {}, c.label))),
      p.alternatives.length || p.moved
        ? h('label', { class: 'new' }, h('span', { class: 'k' }, 'Move to'), select)
        : h('p', { class: 'warn' }, `No free slot within ${state.settings.searchDays} days. Try a shorter buffer or wider running hours in Settings.`),
      custom,
      newConflicts.length ? h('p', { class: 'warn' }, 'That time still has a clash: ' + newConflicts.map((c) => c.label).join('; ')) : null,
      h('footer', {},
        done
          ? h('span', { class: 'done-msg' }, '✓ ' + done)
          : h('button', { class: 'btn small', disabled: !p.moved, onclick: async (ev) => { ev.target.disabled = true; if (await apply(p)) renderChanges(); else ev.target.disabled = false; } },
            cal?.writable ? 'Move event' : `Add to ${(state.calendars.find((c) => c.primary) || {}).name || 'my calendar'}`),
        !cal?.writable ? h('span', { class: 'hint' }, 'The Runna calendar is read-only. Move the run in the Runna app too.') : null,
      ),
    );
  }));
}

const toLocalInput = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const GRID_START = 5 * 60, GRID_END = 23 * 60;
function renderGrid() {
  const grid = $('#grid');
  const pct = (min) => `${((Math.min(Math.max(min, GRID_START), GRID_END) - GRID_START) / (GRID_END - GRID_START)) * 100}%`;
  const block = (start, end, cls, label, extra = {}) => {
    const s = S.minutesOfDay(start);
    const e = S.sameDay(start, end) ? S.minutesOfDay(end) : 24 * 60;
    if (e <= GRID_START || s >= GRID_END) return null;
    return h('div', { class: `blk ${cls}`, style: `top:${pct(s)};height:calc(${pct(e)} - ${pct(s)});${extra.style || ''}`, title: `${label}\n${fmtTime.format(start)}–${fmtTime.format(end)}` },
      h('span', { class: 'blk-t' }, fmtTime.format(start)), ' ', label);
  };

  const hours = [];
  for (let m = GRID_START; m < GRID_END; m += 60) hours.push(h('div', { class: 'hour', style: `top:${pct(m)}` }, `${String(m / 60).padStart(2, '0')}:00`));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = S.addDays(state.weekStart, i);
    const isToday = S.sameDay(day, new Date());
    const allDay = [
      ...state.allDayInfo.filter((e) => e.start <= day && e.end > day).map((e) => h('div', { class: 'allday info', title: e.title }, e.title)),
      ...state.plan.filter((p) => p.run.allDay && S.sameDay(p.run.start, day) && !p.moved).map((p) => h('div', { class: 'allday run', style: `--type: var(--run-${p.run.type})` }, '🏃 ' + p.run.title)),
    ];
    const blocks = [];
    for (const b of state.busy) if (S.sameDay(b.start, day)) {
      const cal = state.calendars.find((c) => c.id === b.calendarId);
      blocks.push(block(b.start, b.end, b.source === 'work' ? 'work' : 'busy', b.title, { style: cal ? `--cal:${cal.color}` : '' }));
    }
    for (const p of state.plan) {
      if (p.moved && !p.run.allDay && S.sameDay(p.run.start, day)) blocks.push(block(p.run.start, p.run.end, 'run ghost', p.run.title, { style: `--type: var(--run-${p.run.type})` }));
      if (!p.allDay && S.sameDay(p.start, day)) {
        const cls = p.moved ? 'run moved' : p.conflicts.length ? 'run clash' : 'run';
        blocks.push(block(p.start, p.end, cls, (p.moved ? '→ ' : '') + p.run.title, { style: `--type: var(--run-${p.run.type})` }));
      }
    }
    days.push(h('div', { class: `day ${isToday ? 'today' : ''}` },
      h('div', { class: 'day-h' }, fmtDay.format(day)),
      h('div', { class: 'day-allday' }, ...allDay),
      h('div', { class: 'day-body' }, ...blocks.filter(Boolean)),
    ));
  }
  grid.replaceChildren(
    h('div', { class: 'gutter' }, h('div', { class: 'day-h' }), h('div', { class: 'day-allday' }), h('div', { class: 'day-body' }, ...hours)),
    ...days,
  );
}

// ---------- settings dialog ----------
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function openSettings() {
  const st = state.settings;
  const f = $('#settings-form');
  f.clientId.value = state.clientId;
  for (const k of ['dayStart', 'dayEnd', 'preferredTime', 'workStart', 'workEnd']) f[k].value = st[k];
  for (const k of ['bufferMin', 'searchDays', 'paceMinPerKm']) f[k].value = st[k];
  f.useWorkHours.checked = st.useWorkHours;
  f.allDayBusy.checked = st.allDayBusy;
  const dayBoxes = (name, selected) => DAY_NAMES.map((d, i) => h('label', { class: 'daybox' }, h('input', { type: 'checkbox', name, value: i, checked: selected.includes(i) }), d));
  $('#blocked-days').replaceChildren(...dayBoxes('blockedDays', st.blockedDays));
  $('#work-days').replaceChildren(...dayBoxes('workDays', st.workDays));
  $('#settings').showModal();
}

function saveSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  state.clientId = f.clientId.value.trim();
  store.set('clientId', state.clientId);
  const checked = (name) => [...f.querySelectorAll(`input[name=${name}]:checked`)].map((i) => +i.value);
  Object.assign(state.settings, {
    dayStart: f.dayStart.value, dayEnd: f.dayEnd.value, preferredTime: f.preferredTime.value,
    workStart: f.workStart.value, workEnd: f.workEnd.value,
    bufferMin: +f.bufferMin.value, searchDays: +f.searchDays.value, paceMinPerKm: +f.paceMinPerKm.value,
    useWorkHours: f.useWorkHours.checked, allDayBusy: f.allDayBusy.checked,
    blockedDays: checked('blockedDays'), workDays: checked('workDays'),
  });
  store.set('settings', state.settings);
  $('#settings').close();
  if (state.mode === 'google') load(); else if (state.mode) compute();
  updateWelcome();
}

function updateWelcome() {
  $('#setup-hint').hidden = !!state.clientId;
  $('#connect').disabled = !state.clientId;
}

// ---------- wiring ----------
async function connect() {
  try {
    await G.signIn(state.clientId);
    state.mode = 'google';
    render();
    await load();
  } catch (err) { toast(err.message, 'error'); }
}

$('#connect').addEventListener('click', connect);
// Sample data lives in the coming week so every run is still in the future.
const demoWeek = () => S.addDays(S.mondayOf(new Date()), 7);
$('#demo').addEventListener('click', () => { state.mode = 'demo'; state.weekStart = demoWeek(); load(); });
$('#signout').addEventListener('click', () => { G.signOut(); state.mode = null; state.events = []; state.demoEvents = null; render(); });
$('#prev').addEventListener('click', () => { state.weekStart = S.addDays(state.weekStart, -7); load(); });
$('#next').addEventListener('click', () => { state.weekStart = S.addDays(state.weekStart, 7); load(); });
$('#this-week').addEventListener('click', () => { state.weekStart = S.mondayOf(new Date()); load(); });
$('#refresh').addEventListener('click', load);
$('#apply-all').addEventListener('click', applyAll);
$('#copy').addEventListener('click', copyChanges);
$('#reset').addEventListener('click', () => { state.locked = {}; compute(); });
for (const b of document.querySelectorAll('.open-settings')) b.addEventListener('click', openSettings);
$('#settings-form').addEventListener('submit', saveSettings);
$('#settings-cancel').addEventListener('click', () => $('#settings').close());
$('#origin').textContent = location.origin;

updateWelcome();
render();
