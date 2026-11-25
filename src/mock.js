// Fake Garmin metrics for local development only (MOCK = "1" in .dev.vars).
// Includes a short illness episode ending today so every state of the UI shows.

function noise(seed) {
  let x = (seed * 2654435761) % 2147483647 || 1;
  const next = () => (x = (x * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4; i++) next();
  return () => next() + next() + next() - 1.5; // roughly normal, sd ~0.5
}

export function mockMetrics(start, end) {
  const days = {};
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86400000) {
    const ago = Math.round((today - t) / 86400000);
    const n = noise(t / 86400000);
    // Illness: starts 2 days ago, worst today.
    const sick = ago <= 2 ? [0.4, 0.8, 1.2][2 - ago] : 0;
    const sore = ago === 9 ? 1 : 0; // the morning after the hard session
    if (ago === 40) continue; // a missing night, as happens when the watch is off
    days[new Date(t).toISOString().slice(0, 10)] = {
      hrv: Math.round(58 + n() * 8 - sick * 9 - sore * 12),
      rhr: Math.round(52 + n() * 3 + sick * 3 + sore * 5),
      resp: Math.round((14.2 + n() * 0.6 + sick * 0.7) * 10) / 10,
      sleepScore: Math.round(78 + n() * 12 - sick * 8),
      sleepSeconds: Math.round((7.3 + n()) * 3600),
      bbOvernight: Math.round(62 + n() * 16 - sick * 12),
      stress: Math.round(27 + n() * 8 + sick * 5),
      spo2: Math.round(96 + n() * 1.2 - sick * 1.5),
      spo2Low: Math.round(91 + n() * 2.5 - sick * 2),
      sleepHr: Math.round(60 + n() * 3 + sick * 4),
      wakes: Math.max(0, Math.round(2 + n() * 2 + sick)),
      restless: Math.max(0, Math.round(10 + n() * 6 + sick * 5)),
      // Training most days, with a hard session 10 days ago.
      trainingLoad: ago === 10 ? 320 : Math.round(n() > -0.15 ? 90 + n() * 60 : 0),
      trainingTop: ago === 10 ? "Long run" : "Workout",
      skinTemp: Math.round((n() * 0.25 + sick * 0.45) * 100) / 100,
    };
  }
  return days;
}
