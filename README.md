# 🏃 Fitness Calendar

Moves your Runna runs in Google Calendar so they fit your shift rota.

**Live app:** https://n8te-g.github.io/Fitness-Calendar/

## The rules

| Run | Allowed days |
| --- | --- |
| Easy / short | Work-1st Late, Work-2nd Late |
| Long | A day off, or Work-2nd Early as a last resort |
| Speed (intervals, tempo…) | Any of the above |

- There's always a rest day between runs, including from Sunday into Monday.
- Runs stay as close to Runna's day as possible and keep their time of day. Only the date changes.
- Runs on days that have already passed are never moved, and nothing is moved into the past.
- Races stay where they are. Tick **Keep day** to pin any other run.
- A day with no `Work…` event is a day off. Shift names can be changed in Settings.

If a week can't meet every rule, the app shows what it couldn't fix. It never breaks a rule without telling you.

## How it works

- `js/rules.js`: shift and run detection plus the weekly planner. It tries every possible arrangement of the week's runs and picks the one that keeps all the rules with the fewest moves.
- `js/google.js`: Google sign-in and the Calendar API (read events, move an event).
- `js/app.js`: the screen. `js/sample.js` holds a made-up rota for **Try with sample data**.
- `tests/`: `npm test` (Node 18+, no dependencies).

Everything runs in the browser. Calendar data goes only between the page and Google.

## Setup

### 1. GitHub Pages
Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. Every push then runs the tests and publishes the site (`.github/workflows/pages.yml`).

### 2. Google client ID (one time)
1. https://console.cloud.google.com → create a project.
2. Enable the **Google Calendar API**.
3. **Google Auth Platform**: External audience, then add yourself under **Audience → Test users**. Under **Data access**, add the scopes `calendar.readonly` and `calendar.events`.
4. **Clients → Create client → Web application**, with these authorised JavaScript origins:
   - `https://n8te-g.github.io`
   - `http://localhost:8000` (for running locally)
5. Copy the client ID into the app's **Settings**, or into `config.js` so it's filled in on every device.

### Run locally
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
