// Made-up rota and Runna plan for trying the app without connecting Google.
import { addDays } from './rules.js';

export const SAMPLE_CALENDARS = [
  { id: 'primary', name: 'My calendar', color: '#4285f4', primary: true, writable: true },
  { id: 'runna', name: 'Runna', color: '#ff6d3a', primary: false, writable: true },
];

const SHIFTS = {
  e1: ['Work-1st Early', 6, 14],
  e2: ['Work-2nd Early', 7, 15],
  l1: ['Work-1st Late', 14, 22],
  l2: ['Work-2nd Late', 15, 23],
};
// 4-week rota starting on a Monday ('-' = day off)
const ROTA = 'e1 e1 - - l1 l1 l2  e2 e2 - - - l1 l2  l1 l2 e1 e1 - - -  - l2 l1 e2 e2 - -'.split(/\s+/);

const toApiTime = (d) => ({ dateTime: d.toISOString() });
const at = (day, h, m = 0) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d; };

export function sampleEvents(monday) {
  const raw = [];
  ROTA.forEach((code, i) => {
    if (code === '-') return;
    const [title, h1, h2] = SHIFTS[code];
    const day = addDays(monday, i);
    raw.push({ calendarId: 'primary', id: `shift${i}`, summary: title, start: toApiTime(at(day, h1)), end: toApiTime(at(day, h2)) });
  });
  // Runna's usual pattern: easy Tue, speed Thu, long Sun.
  const plan = [['Easy Run - 5km', 1, 45], ['Intervals - 6 x 800m', 3, 60], ['Long Run - 14km', 6, 90]];
  for (let w = 0; w < 4; w++) {
    for (const [title, dow, mins] of plan) {
      const start = at(addDays(monday, w * 7 + dow), 8);
      raw.push({
        calendarId: 'runna', id: `run${w}${dow}`, summary: title.replace('14km', `${14 + w * 2}km`),
        description: 'Workout from your Runna plan',
        start: toApiTime(start), end: toApiTime(new Date(+start + mins * 60_000)),
      });
    }
  }
  return raw;
}
