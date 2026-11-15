// Sample calendars and events for trying the app without a Google account.
import { addDays, atMinutes } from './scheduler.js';

export const DEMO_CALENDARS = [
  { id: 'me', name: 'Personal', color: '#4285f4', primary: true, writable: true },
  { id: 'work', name: 'Work', color: '#7986cb', primary: false, writable: true },
  { id: 'runna', name: 'Runna', color: '#ff6d3a', primary: false, writable: false },
  { id: 'holidays', name: 'Holidays in United Kingdom', color: '#0b8043', primary: false, writable: false },
];

export function demoEvents(weekStart) {
  const ev = (calendarId, title, day, h1, m1, h2, m2, extra = {}) => ({
    id: `${calendarId}-${day}-${h1}${m1}`,
    calendarId, title,
    start: atMinutes(addDays(weekStart, day), h1 * 60 + m1),
    end: atMinutes(addDays(weekStart, day), h2 * 60 + m2),
    allDay: false, ...extra,
  });
  const allDay = (calendarId, title, day) => ({
    id: `${calendarId}-${day}-allday`, calendarId, title,
    start: addDays(weekStart, day), end: addDays(weekStart, day + 1), allDay: true,
  });
  const events = [];
  for (let d = 0; d < 5; d++) events.push(ev('work', 'Work', d, 9, 0, 17, 30));
  events.push(
    ev('work', 'Breakfast with client', 1, 7, 30, 8, 30),
    ev('work', 'Late release call', 3, 17, 30, 19, 0),
    ev('me', 'Dinner with Sam', 3, 19, 30, 22, 0),
    ev('me', 'Brunch', 6, 10, 0, 12, 0),
    ev('me', 'Physio', 4, 7, 0, 7, 45),
    // Runna plan
    ev('runna', 'Easy Run - 6km', 0, 7, 0, 7, 40),
    ev('runna', 'Intervals: 6 x 800m', 1, 7, 0, 8, 0),
    ev('runna', 'Tempo Run - 8km', 3, 18, 0, 19, 0),
    allDay('runna', 'Easy Run - 5km', 4),
    ev('runna', 'Long Run - 18km', 6, 9, 0, 10, 50),
    allDay('holidays', 'Public holiday (sample)', 6),
  );
  return events;
}
