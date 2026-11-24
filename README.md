# Wellness Watch

A private web app that watches your Garmin data for early signs of illness.

- **Baseline:** for each metric, the median of your previous 60 days, with a robust normal range (±1 SD).
- **Daily score:** last night's overnight HRV (weighted most), resting heart rate, sleep breathing rate,
  sleep SpO2, sleep score, Body Battery recharge and stress are compared with your baseline. Deviations under half an
  SD are ignored as noise; two days off in a row add to the score.
- **Daily check-in:** how you feel (1–5), symptoms and a note. These add to the score, and days you were
  unwell are left out of future baselines.

Levels: Normal (< 1), Watch (≥ 1), Elevated (≥ 1.75), High (≥ 2.75). This is an early-warning aid, not a
medical diagnosis.

## How it runs

A Cloudflare Worker (`src/worker.js`) serves `public/` and a small API. One Durable Object
(`src/store.js`) syncs daily metrics from the Garmin Connect Personal API (`src/garmin.js`) and stores
check-ins. The scoring lives in `src/model.js`.

Every `/api` request must carry a valid Cloudflare Access login. While `ACCESS_TEAM_DOMAIN` in
`wrangler.toml` is empty, the API refuses all requests.

## Setup

GitHub repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from the "Edit Cloudflare Workers" template |
| `GARMIN_API_KEY` | Garmin Connect personal API key |

Every push deploys via `.github/workflows/deploy.yml`. Then turn on Cloudflare Access for the
`workers.dev` route and set `ACCESS_TEAM_DOMAIN`.

## Local development

```sh
npm install
echo 'MOCK = "1"' > .dev.vars   # sample data, no login needed
npm run dev
npm test
```
