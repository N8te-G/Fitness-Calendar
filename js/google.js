// Google sign-in (Google Identity Services token flow) + Calendar REST API calls.
// Runs entirely in the browser: the access token never leaves this page.

const API = 'https://www.googleapis.com/calendar/v3';
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

let tokenClient = null;
let token = null;
let tokenExpiry = 0;
let pending = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in. Check your connection or ad blocker.'));
    document.head.appendChild(s);
  });
}

export async function signIn(clientId, { silent = false } = {}) {
  if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first.');
  await loadGis();
  if (!tokenClient || tokenClient._clientId !== clientId) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) return pending?.reject(new Error(resp.error_description || resp.error));
        token = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        pending?.resolve(token);
      },
      error_callback: (err) => pending?.reject(new Error(err.message || err.type || 'Sign-in cancelled')),
    });
    tokenClient._clientId = clientId;
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token);
  token = null;
  tokenExpiry = 0;
}

export const isSignedIn = () => !!token;

async function call(path, { method = 'GET', body, params } = {}) {
  if (!token) throw new Error('Not signed in');
  if (Date.now() > tokenExpiry && tokenClient) {
    await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* keep status text */ }
    throw new Error(`Google Calendar: ${msg}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function listCalendars() {
  const out = [];
  let pageToken;
  do {
    const r = await call('/users/me/calendarList', { params: { maxResults: 250, ...(pageToken ? { pageToken } : {}) } });
    out.push(...r.items);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out.map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    primary: !!c.primary,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
  }));
}

export async function listEvents(calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken;
  do {
    const r = await call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      params: {
        timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: 250,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    out.push(...r.items);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function moveEvent(calendarId, eventId, start, end) {
  return call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: { start: { dateTime: start.toISOString(), timeZone: tz() }, end: { dateTime: end.toISOString(), timeZone: tz() } },
  });
}

export function createEvent(calendarId, { title, description, start, end }) {
  return call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: {
      summary: title, description,
      start: { dateTime: start.toISOString(), timeZone: tz() },
      end: { dateTime: end.toISOString(), timeZone: tz() },
    },
  });
}
