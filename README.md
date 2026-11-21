# Garmin Health MCP

A personal MCP server that lets Claude read your Garmin Connect data and tell
you each morning whether you're **fine, tired, getting sick or sick**, by
comparing your vitals with *your own* normal rather than generic ranges.

> Not medical advice. It's an early "you're off your normal" nudge.

## What it does

| Tool | What you get |
| --- | --- |
| `morning_brief` | Status (fine / tired / getting sick / sick) with reasons, last night's HRV, resting HR, sleep, respiration, SpO2 and sleep stress vs your baseline, and how hard to train today. Ends with "how do you feel?" |
| `night_check` | Tomorrow's outlook (likely fine / likely tired / at risk of getting sick) from today's stress, Body Battery, training load and the last few nights, plus tips for tonight. |
| `log_check_in` | Saves how you actually felt. Used to learn which of your markers really move before you get ill. |
| `get_vitals` | Day-by-day table (up to 30 days) with baseline and deviation for each metric. |
| `get_recent_activities` | Recent workouts with training load and training effect. |
| `get_learning_summary` | Personalised marker weights and how often the morning status matched how you felt. |
| `refresh_garmin_data` | Force a re-download after syncing your watch. |

### How the call is made

- **Baseline:** for each day, the median and robust spread of the 28 days
  from 31 to 4 days earlier. The 3 most recent days are left out so a slide
  that's been building for a few days doesn't hide itself.
- **Illness markers:** resting HR, HRV, respiration, SpO2 and sleep stress.
  **Fatigue markers:** sleep duration, sleep score, Body Battery recharge,
  daytime stress and a 3-day vs 28-day training load ratio.
- A marker is **flagged** when today is 1.5 spreads worse than normal, or the
  3-day average is 1 spread worse (catches a gradual HRV slide).
- **Getting sick:** 2+ illness markers flagged including RHR, respiration or
  SpO2, or a high combined illness score. **Sick:** a strong multi-marker
  pattern, or still off-normal after you said you felt unwell.
  **Tired:** recovery is down without an illness pattern.
- **Learning:** once you have 3+ getting-sick/sick and 5+ fine check-ins, each
  illness marker is re-weighted (0.5x–2x) by how well it separated your sick
  days and the 2 days before them from your fine days.

All of this is in `src/garmin_health/analysis.py`, so it's easy to tune.

Metrics depend on your watch: SpO2 needs Pulse Ox enabled during sleep, and
HRV needs a watch with HRV Status.

## Setup

### 1. Install and sign in (on your own computer)

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install .
garmin-health-login
```

This asks for your Garmin email, password and MFA code if you use one. The
password is used once and never stored; Garmin's login tokens are saved to
`~/.garmin-health/garmin_tokens.json` and refreshed automatically. It then
downloads the last 45 days so baselines work straight away.

Data lives in `~/.garmin-health` (change it with `GARMIN_HEALTH_DATA_DIR`).
Set `GARMIN_HEALTH_TZ` (e.g. `Europe/London`) if the server runs somewhere
other than your own timezone.

This uses the same unofficial endpoints as the Garmin Connect website (via
[`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)),
so it may break if Garmin changes things, and it's only meant for reading your
own data.

### 2. Connect it to Claude

**Claude Desktop only (simplest):** add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin-health": { "command": "/full/path/to/.venv/bin/garmin-health-mcp" }
  }
}
```

**Claude on your phone and the web (custom connector):** the server needs a
public HTTPS URL. Generate a secret, which becomes part of the URL:

```bash
export MCP_SECRET=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')
garmin-health-mcp --http --host 0.0.0.0 --port 8000
```

Then expose port 8000 over HTTPS, for example:

- **A computer that's always on at home** (or a Raspberry Pi) with
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), both free; or
- **A small cloud host** using the `Dockerfile` (Fly.io, Railway, etc.). Give it
  a persistent volume at `/data`, set `MCP_SECRET`, and copy your
  `garmin_tokens.json` into the volume. Garmin sometimes blocks *sign-ins*
  from cloud servers, which is why you sign in on your own computer first.

In Claude go to **Settings → Connectors → Add custom connector** and paste
`https://<your-host>/<MCP_SECRET>/mcp`. Treat that URL like a password: anyone
who has it can read your health data.

### 3. Daily use

- Morning: "Give me my morning brief" (or the `morning` prompt).
- Evening: "Do my night check".
- Answer the "how do you feel?" question; Claude logs it for you.
- To get them automatically, set up two scheduled tasks in Claude, e.g.
  07:30 "Give me my morning brief" and 21:30 "Do my night check".

## Development

```bash
pip install -e '.[dev]'
pytest
```
