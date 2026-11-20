// Google sign-in (Google Identity Services, token flow) and the Calendar API calls the app needs.
// Everything happens in the browser: the access token never leaves this page.

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

let client = null;
let clientFor = '';
let token = null;
let expiresAt = 0;
let waiting = null;

function loadScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection or ad blocker.'));
    document.head.append(s);
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    client.requestAccessToken({ prompt });
  });
}

export async function signIn(clientId) {
  if (!clientId) throw new Error('Add your Google client ID in Settings first.');
  await loadScript();
  if (!client || clientFor !== clientId) {
    client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (r) => {
        if (r.error) return waiting?.reject(new Error(r.error_description || r.error));
        token = r.access_token;
        expiresAt = Date.now() + (Number(r.expires_in) - 60) * 1000;
        waiting?.resolve();
      },
      error_callback: (e) => waiting?.reject(new Error(e.message || 'Sign-in was cancelled')),
    });
    clientFor = clientId;
  }
  await requestToken('');
}

export function signOut() {
  if (token) window.google?.accounts?.oauth2?.revoke(token);
  token = null;
}

async function call(path, { method = 'GET', params, body } = {}) {
  if (!token) throw new Error('Not connected to Google');
  if (Date.now() > expiresAt) await requestToken('');
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function pages(path, params) {
  const items = [];
  let pageToken;
  do {
    const r = await call(path, { params: { ...params, pageToken } });
    items.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return items;
}

export async function listCalendars() {
  const items = await pages('/users/me/calendarList', { maxResults: 250 });
  return items.map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    primary: !!c.primary,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
  }));
}

export function listEvents(calendarId, from, to) {
  return pages(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin: from.toISOString(), timeMax: to.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: 250,
  });
}

/** PATCH an event's start/end. `start`/`end` are Calendar API time objects ({ date } or { dateTime, timeZone }). */
export function updateEventTimes(calendarId, eventId, start, end) {
  return call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: { start, end },
  });
}
