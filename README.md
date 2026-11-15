# 🏃 Fitness Calendar

A small web app that reads your Google Calendar, finds your **Runna** runs, checks them against work and other events, and suggests better times for runs that clash.

- Spots clashes with meetings, including a buffer before and after each run for travel and a shower.
- Gives a time to Runna runs that only have a day (all-day events).
- Looks for a slot the same day first, then nearby days. It keeps one run per day, avoids putting hard sessions (intervals, tempo, long runs) on back-to-back days, and keeps long runs on the weekend where possible.
- You choose each move from a list (or pick your own time), then apply the changes to Google Calendar or copy them as a list.
- Runs entirely in your browser. There's no server, and your calendar data goes only between your browser and Google.

## Try it

```bash
python3 -m http.server 8000
# open http://localhost:8000 and click "Try with sample data"
```

## Connect your Google Calendar (one-time setup, ~5 minutes)

Google requires every app that reads a calendar to have its own OAuth client ID. You create it yourself, so the app runs under your own Google account:

1. Go to <https://console.cloud.google.com/> and create a project, for example "Fitness Calendar".
2. **APIs & Services → Library**: search for **Google Calendar API** and click **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type: **External**. Enter an app name and your email.
   - Under **Audience / Test users**, add your own Google account. (In "Testing" mode only listed users can sign in, which is fine for personal use.)
   - Under **Data access / Scopes**, add `.../auth/calendar.readonly` and `.../auth/calendar.events`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - **Authorised JavaScript origins**: add every address you open the app from, e.g. `http://localhost:8000` and, if you host it, `https://<your-user>.github.io`.
5. Copy the client ID (`…apps.googleusercontent.com`). Paste it into **Settings** in the app, or into `config.js`.
6. Click **Connect Google Calendar**. Google warns that the app is unverified, because it's your own unpublished app. Choose **Continue**.

### Host it on GitHub Pages (optional)

Repository **Settings → Pages → Deploy from branch**, choose your branch and `/ (root)`. Then add `https://<your-user>.github.io` as an authorised origin (step 4).

## How Runna runs are found

- Any calendar whose name contains "Runna" is treated as **Runs** by default. You can change each calendar's role (Runs / Busy time / Ignore) in the side panel.
- Events on other calendars also count as runs when their title or description mentions Runna.
- Holiday and birthday calendars are ignored by default. All-day events don't block time unless you turn that on in Settings.

## Applying changes

Runna's Google Calendar feed is a **subscribed calendar, which Google makes read-only**, so the app can't move those events directly. When you apply a change:

- **Run on a calendar you can edit** → the event is moved.
- **Run on the read-only Runna calendar** → a copy (`🏃 Easy Run…`) is added to your main calendar at the new time, and the original is hidden from the planner. Move the workout in the Runna app as well, so your plan, watch and calendar feed stay in sync. **Copy list** gives you a checklist for doing this.

## Development

```
index.html        page layout
styles.css        styles (light/dark)
config.js         optional client ID
js/scheduler.js   clash detection + slot suggestions (pure functions)
js/google.js      Google sign-in + Calendar API
js/app.js         UI
js/demo.js        sample data
tests/            node --test unit tests for the scheduler
```

Run the tests with `npm test` (Node 18+). No dependencies are needed.
