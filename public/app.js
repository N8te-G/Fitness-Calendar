const $ = (id) => document.getElementById(id);
const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "wellness-watch" };

const LEVEL_TEXT = {
  normal: { label: "Normal", headline: "Your body looks like its usual self." },
  watch: { label: "Watch", headline: "Some signals are off your normal. Go a bit easier today and check in again tomorrow." },
  elevated: { label: "Elevated", headline: "Several signals suggest your body is fighting something. Rest and keep training light." },
  high: { label: "High", headline: "Strong signs of strain or illness. Prioritise rest, and get medical advice if you feel unwell." },
  building: { label: "Building baseline", headline: "" },
};
const FEELINGS = { 1: "Unwell", 2: "Below par", 3: "Okay", 4: "Good", 5: "Great" };

// ---------- dates ----------
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = iso(new Date());
const addDays = (s, n) => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return iso(d);
};
const shortDate = (s) => new Date(s + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayLabel = (s) => (s === today ? "Today" : s === addDays(today, -1) ? "Yesterday" : shortDate(s));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- state ----------
let state = null;
let checkinDate = today;
let editing = false;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Request failed (${res.status})`), { code: body.error });
  return body;
}

async function load(fresh = false) {
  setBusy(true);
  try {
    state = await api(`/api/state?today=${today}${fresh ? "&fresh=1" : ""}`);
    $("notice").hidden = true;
    if (state.syncError) showError(state.syncError);
    else showSyncNotice();
    render();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  $("refresh").classList.toggle("spin", on);
  if (on) $("status").textContent = "Syncing with Garmin…";
  else if (state?.sync?.lastSync) {
    const t = new Date(state.sync.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("status").textContent = `Synced ${t}${state.mock ? " · sample data" : ""}`;
  } else $("status").textContent = "";
}

function showSyncNotice() {
  const failed = Object.keys(state.sync?.errors || {});
  if (!failed.length && state.sync?.gotAny) return;
  const el = $("notice");
  el.className = "notice";
  el.innerHTML = !state.sync.gotAny
    ? `<h2>No Garmin data yet</h2><p>The key works, but Garmin returned no daily metrics. Wear your watch overnight and sync it with Garmin Connect.</p>`
    : `<p>Some Garmin data couldn't be loaded (${failed.map(esc).join(", ")}). The score uses what's available.</p>`;
  el.hidden = false;
}

function showError(err) {
  const el = $("notice");
  el.className = "notice error";
  const msgs = {
    locked: `<h2>Locked until Cloudflare Access is on</h2>
      <p>Your health data stays hidden until the app knows which Cloudflare Access login to trust.</p>
      <ol><li>Turn on Cloudflare Access for this Worker and allow only your email.</li>
      <li>Put your team domain (like <code>yourteam.cloudflareaccess.com</code>) in <code>ACCESS_TEAM_DOMAIN</code> in <code>wrangler.toml</code>, then deploy again.</li></ol>`,
    no_login: `<h2>Sign in again</h2><p>${esc(err.message)} Reload the page to go through the Cloudflare Access login.</p>`,
    garmin_auth: `<h2>Garmin key problem</h2><p>${esc(err.message)}</p><p>Update the <code>GARMIN_API_KEY</code> secret in GitHub and re-run the deploy. Check-ins still save in the meantime.</p>`,
  };
  msgs.expired = msgs.bad_login = msgs.no_login;
  msgs.no_key = msgs.garmin_auth;
  el.innerHTML = msgs[err.code] || `<h2>Couldn't load your data</h2><p>${esc(err.message)}</p>`;
  el.hidden = false;
}

// ---------- render ----------
function render() {
  document.body.classList.toggle("no-state", !state);
  if (!state) return;
  renderVerdict();
  renderCheckin();
  renderBaseline();
  renderCharts();
  renderHistory();
  renderRecord();
  renderDataCheck();
}

function renderRecord() {
  const L = state.learning;
  if (!L) return;
  const r = L.record;
  const need = L.minEpisodes;
  $("record-status").textContent = L.influence > 0
    ? `Personal tuning on · ${Math.round(L.influence * 100)}% your data`
    : `Personal tuning starts at ${need} illnesses`;

  if (!r.illnesses) {
    $("record").innerHTML = `<p>No illnesses logged yet. When you check in feeling unwell (1 or 2, or with two or more symptoms), it's recorded as an illness. The app then checks whether your body signals warned you in the 3 days before.</p>`;
    return;
  }
  const leadText = (d) => (d < 0.05 ? "on the day" : `on average ${d.toFixed(1)} day${d.toFixed(1) === "1.0" ? "" : "s"} ahead`);
  const lead = r.avgLeadDays == null ? "" : `, ${leadText(r.avgLeadDays)}`;
  const stats = [
    [`${r.caught} of ${r.withData}`, `illnesses warned about${lead}`],
    [r.alerts ? `${r.falseAlarms} of ${r.alerts}` : "–", "warnings that were false alarms"],
    [`${r.illnesses}`, `illness${r.illnesses === 1 ? "" : "es"} logged${r.withData < r.illnesses ? ` (${r.illnesses - r.withData} without enough Garmin data)` : ""}`],
  ].map(([v, l]) => `<div class="record-stat"><div class="value">${esc(v)}</div><div class="label">${esc(l)}</div></div>`).join("");

  const episodes = L.episodes.slice(-6).reverse().map((e) => {
    const span = e.onset === e.end ? shortDate(e.onset) : `${shortDate(e.onset)} – ${shortDate(e.end)}`;
    const verdict = !e.hasData ? "not enough data" : e.caught ? (e.leadDays ? `warned ${e.leadDays} day${e.leadDays === 1 ? "" : "s"} ahead` : "warned on the day") : "missed";
    return `<div><span>${esc(span)}</span><span>${esc(verdict)}</span></div>`;
  }).join("");

  let tuning;
  if (L.influence > 0) {
    const rows = Object.entries(L.weights)
      .filter(([k]) => L.signals[k]?.pre != null)
      .map(([k, w]) => {
        const base = L.research[k];
        const pct = Math.round((w / base - 1) * 100);
        const cls = pct > 2 ? "up" : pct < -2 ? "down" : "";
        return `<tr><td>${esc(state.metrics[k].label)}</td><td>${base.toFixed(2)}</td><td class="${cls}">${w.toFixed(2)} ${pct > 0 ? "+" : ""}${pct}%</td></tr>`;
      }).join("");
    tuning = `<p>Weightings now lean ${Math.round(L.influence * 100)}% towards the metrics that moved before your illnesses (up to 30% at most).</p>
      <table class="weights"><thead><tr><th>Metric</th><th>Research</th><th>Yours</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    tuning = `<p>Using research-based weightings. Personal tuning starts after ${need} reported illnesses with Garmin data (${r.withData} so far).</p>`;
  }
  $("record").innerHTML = `<div class="record-stats">${stats}</div>${tuning}${episodes ? `<h3 class="sub-head">Recent illnesses</h3><div class="episodes">${episodes}</div>` : ""}`;
}

function renderDataCheck() {
  const recent = state.days.slice(-30);
  const rows = Object.entries(state.metrics).map(([key, m]) => {
    const n = recent.filter((d) => typeof d.metrics?.[key] === "number").length;
    return `<tr><td>${esc(m.label)}</td><td class="${n ? "dc-ok" : "dc-miss"}">${n ? `${n} of ${recent.length} days` : "not received"}</td></tr>`;
  }).join("");
  const fields = Object.entries(state.fields || {})
    .map(([src, names]) => `<p class="dc-fields"><b>${esc(src)}:</b> ${esc(names.join(", "))}</p>`)
    .join("");
  const bb = todayEntry()?.metrics?.bbInfo;
  const bbLine = bb
    ? `<p class="dc-fields"><b>Overnight Body Battery, last night:</b> sleep ${esc(bb.sleep)}, ${bb.readings} readings during sleep${
        bb.firstGapMin != null ? ` (first ${bb.firstGapMin} min after falling asleep, last ${bb.lastGapMin} min before waking)` : ""
      }. ${bb.reason === "ok" ? "Calculated." : `Not calculated: ${esc(bb.reason)}.`}</p>`
    : `<p class="dc-fields"><b>Overnight Body Battery, last night:</b> no sleep record from Garmin yet.</p>`;
  $("datacheck").innerHTML = `<table class="dc-table"><tbody>${rows}</tbody></table>${bbLine}
    ${fields ? `<p class="dc-fields">Field names Garmin returned (no values):</p>${fields}` : ""}`;
}

const todayEntry = () => state.days.find((d) => d.date === today) || state.days[state.days.length - 1];

function fmt(key, v) {
  if (v == null) return "–";
  const m = state.metrics[key];
  const txt = v.toFixed(m.digits).replace(/^-(0\.?0*)$/, "$1");
  return `${txt}${m.unit ? ` ${m.unit}` : ""}`;
}

function renderVerdict() {
  const d = todayEntry();
  const el = $("verdict");
  const lv = d.level;
  el.className = `verdict lv-${lv}`;
  let headline = LEVEL_TEXT[lv].headline;
  if (lv === "building") {
    const n = d.z?.hrv?.n || 0;
    headline = `Your baseline needs at least 14 nights of HRV. So far there are ${n}. Keep wearing your watch overnight, and check in each day.`;
  }
  const lastNight = d.metrics && Object.keys(d.metrics).length;
  if (lv !== "building" && !lastNight) headline += " Last night's data hasn't arrived from Garmin yet, so this is based on your check-in only.";

  const max = 4;
  const pos = Math.min(max, Math.max(0, d.score || 0)) / max * 100;
  const segs = [
    ["normal", 0, 1], ["watch", 1, 1.75], ["elevated", 1.75, 2.75], ["high", 2.75, max],
  ].map(([k, a, b]) => `<span style="width:${((b - a) / max) * 100}%;background:var(--${k});opacity:.85"></span>`).join("");

  const reasons = d.reasons.map((r) => {
    const m = state.metrics[r.key];
    const dir = r.z < 0 ? "below" : "above";
    return `<li>${esc(m.label)} ${fmt(r.key, r.value)}: ${Math.abs(r.z).toFixed(1)} SD ${dir} your normal of ${fmt(r.key, r.median)}</li>`;
  });
  if (d.checkin && d.self > 0) {
    const sy = (d.checkin.symptoms || []).map((k) => state.symptoms[k]?.toLowerCase()).filter(Boolean);
    reasons.push(`<li>You reported feeling ${esc(FEELINGS[d.checkin.feeling].toLowerCase())}${sy.length ? `, with ${esc(sy.join(", "))}` : ""}</li>`);
  }
  if (d.persist) reasons.push(`<li>Body signals have been off two days running</li>`);
  if (d.training?.damp < 1) {
    const tr = d.training;
    const vs = tr.typical ? ` against your usual ${Math.round(tr.typical)}` : "";
    reasons.push(`<li class="context">Hard training yesterday${tr.name ? ` (${esc(tr.name)})` : ""}: load ${Math.round(tr.load)}${vs}. Heart rate and HRV count ${Math.round(tr.damp * 100)}% this morning, since hard exercise moves them too.</li>`);
  }

  el.innerHTML = `
    <div class="eyebrow">Illness risk · ${esc(dayLabel(d.date))}</div>
    <div class="level">${esc(LEVEL_TEXT[lv].label)}</div>
    <p class="headline">${esc(headline)}</p>
    ${lv === "building" ? "" : `
    <div class="meter">
      <div class="meter-wrap"><div class="meter-track">${segs}</div><div class="meter-mark" style="left:${pos}%"></div></div>
      <div class="meter-labels"><span>Normal</span><span>Watch</span><span>Elevated</span><span>High</span></div>
    </div>
    <div class="score-line">Score ${d.score.toFixed(1)} = body signals ${(d.phys + d.persist).toFixed(1)} + how you feel ${d.self.toFixed(1)}${
      d.self > 0 ? ` (rating ${d.selfParts.rating.toFixed(1)}${d.selfParts.symptoms > 0 ? ` + symptoms ${d.selfParts.symptoms.toFixed(1)}` : ""})` : ""
    }</div>`}
    ${reasons.length ? `<ul class="reasons">${reasons.join("")}</ul>` : ""}`;
}

function renderCheckin() {
  const sel = $("checkin-date");
  if (!sel.options.length) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(today, -i);
      sel.add(new Option(dayLabel(d), d));
    }
    const box = $("symptoms");
    for (const [key, label] of Object.entries(state.symptoms)) {
      box.insertAdjacentHTML("beforeend",
        `<label><input type="checkbox" name="symptom" value="${esc(key)}" id="sym-${esc(key)}"><span>${esc(label)}</span></label>`);
    }
  }
  sel.value = checkinDate;
  $("checkin-title").textContent = checkinDate === today ? "How do you feel today?" : `How did you feel on ${shortDate(checkinDate)}?`;

  const existing = state.days.find((d) => d.date === checkinDate)?.checkin;
  const form = $("checkin-form");
  const summary = $("checkin-summary");
  if (existing && !editing) {
    const sy = (existing.symptoms || []).map((k) => state.symptoms[k]).filter(Boolean);
    summary.innerHTML = `<div><p><b>${existing.feeling} · ${esc(FEELINGS[existing.feeling])}</b>${sy.length ? ` · ${esc(sy.join(", "))}` : " · no symptoms"}</p>
      ${existing.note ? `<p class="muted">${esc(existing.note)}</p>` : ""}</div>
      <button type="button" class="ghost" id="checkin-edit">Edit</button>`;
    summary.hidden = false;
    form.hidden = true;
    $("checkin-edit").onclick = () => { editing = true; renderCheckin(); };
  } else {
    summary.hidden = true;
    form.hidden = false;
    form.reset();
    if (existing) {
      form.querySelector(`input[name=feeling][value="${existing.feeling}"]`).checked = true;
      for (const s of existing.symptoms || []) {
        const box = form.querySelector(`input[name=symptom][value="${CSS.escape(s)}"]`);
        if (box) box.checked = true;
      }
      $("checkin-note").value = existing.note || "";
    }
    $("checkin-cancel").hidden = !existing;
    $("checkin-delete").hidden = !existing;
    $("checkin-msg").textContent = "";
  }
}

const fmtNum = (v, digits) => v.toFixed(digits).replace(/^-(0\.?0*)$/, "$1");

function renderBaseline() {
  const d = todayEntry();
  // Hide metrics this watch has never sent; the Data check still lists them.
  const sent = (key) => state.days.some((x) => typeof x.metrics?.[key] === "number");
  const rows = Object.entries(state.metrics).filter(([key]) => sent(key)).map(([key, m]) => {
    const e = d.z?.[key] || {};
    const has = e.median != null;
    const range = has ? `${fmtNum(e.median - e.sd, m.digits)} to ${fmtNum(e.median + e.sd, m.digits)}` : null;
    const vals = has
      ? `Normal ${range}${m.unit ? ` ${m.unit}` : ""} · ${e.n} days`
      : e.n
        ? `Baseline needs 14 days · ${e.n} so far`
        : "Not received from Garmin yet";
    return `<div class="brow">
      <div><div class="bname">${esc(m.label)}</div><div class="bvals">${esc(vals)}</div></div>
      <div class="bnow">${e.value != null ? esc(fmt(key, e.value)) : "–"}${e.z != null ? `<br><small>${e.z >= 0 ? "+" : "−"}${Math.abs(e.z).toFixed(1)} SD</small>` : e.value == null ? "<br><small>no data</small>" : ""}</div>
      <div class="gauge">${gauge(m.bad, e.z)}</div>
    </div>`;
  });
  $("baseline").innerHTML = rows.join("");
}

function gauge(bad, z) {
  // −3…+3 SD. The strain side is shaded; the ±1 SD band is the normal range.
  const W = 300, H = 22, x = (v) => ((Math.max(-3, Math.min(3, v)) + 3) / 6) * W;
  const badX = bad < 0 ? 0 : x(1);
  const zBad = z == null ? 0 : Math.max(0, z * bad) - 0.5;
  const color = zBad >= 2 ? "var(--high)" : zBad >= 1 ? "var(--elevated)" : "var(--normal)";
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${z == null ? "No reading" : `${z.toFixed(1)} standard deviations from baseline`}">
    <rect x="0" y="8" width="${W}" height="6" rx="3" fill="var(--sunk)"/>
    <rect x="${badX}" y="8" width="${x(-1)}" height="6" fill="var(--bad-zone)"/>
    <rect x="${x(-1)}" y="8" width="${x(1) - x(-1)}" height="6" fill="var(--band)"/>
    <line x1="${x(0)}" x2="${x(0)}" y1="5" y2="17" stroke="var(--muted)" stroke-width="1"/>
    ${z == null ? "" : `<circle cx="${x(z)}" cy="11" r="6" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`}
  </svg>`;
}

function renderCharts() {
  const days = state.days.slice(-30);
  $("charts").innerHTML = [
    scoreChart(days),
    lineChart(days, "hrv", "Overnight HRV", "lower = strain"),
    lineChart(days, "rhr", "Resting heart rate", "higher = strain"),
  ].join("");
}

const CW = 600, CH = 130, PAD = { l: 30, r: 8, t: 8, b: 20 };
const cx = (i, n) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (CW - PAD.l - PAD.r));

function axisDates(days) {
  const n = days.length;
  return days
    .map((d, i) => (i % 7 === (n - 1) % 7 ? `<text x="${cx(i, n)}" y="${CH - 4}" text-anchor="middle">${esc(new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }))}</text>` : ""))
    .join("");
}

function scoreChart(days) {
  const n = days.length, max = 4;
  const y = (v) => PAD.t + (1 - Math.min(max, v) / max) * (CH - PAD.t - PAD.b);
  const bw = Math.max(4, (CW - PAD.l - PAD.r) / n - 4);
  const bars = days.map((d, i) => {
    if (d.level === "building") return "";
    const h = Math.max(2, y(0) - y(d.score));
    return `<rect x="${cx(i, n) - bw / 2}" y="${y(0) - h}" width="${bw}" height="${h}" rx="2" fill="var(--${d.level})"><title>${esc(shortDate(d.date))}: ${d.level}, score ${d.score.toFixed(1)}</title></rect>`;
  }).join("");
  const feel = days.map((d, i) => d.checkin && d.checkin.feeling <= 2
    ? `<circle cx="${cx(i, n)}" cy="${PAD.t + 3}" r="3.5" fill="var(--fg)"><title>Felt ${esc(FEELINGS[d.checkin.feeling].toLowerCase())}</title></circle>` : "").join("");
  const lines = [[1, "watch"], [1.75, "elevated"], [2.75, "high"]].map(([v, k]) =>
    `<line x1="${PAD.l}" x2="${CW - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--${k})" stroke-dasharray="3 4" stroke-width="1" opacity=".7"/>`).join("");
  const ticks = [0, 1, 2, 3, 4].map((v) => `<text x="${PAD.l - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("");
  return `<div class="chart"><h3>Illness risk score <span>● = you felt unwell</span></h3>
    <svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="Daily illness risk score for the last ${n} days">${ticks}${lines}${bars}${feel}${axisDates(days)}</svg></div>`;
}

function lineChart(days, key, title, note) {
  const n = days.length;
  const vals = days.flatMap((d) => [d.z?.[key]?.value, d.z?.[key]?.median != null ? d.z[key].median - d.z[key].sd : null, d.z?.[key]?.median != null ? d.z[key].median + d.z[key].sd : null]).filter((v) => v != null);
  if (!vals.length) return `<div class="chart"><h3>${esc(title)}</h3><p class="hint">No data yet.</p></div>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 2;
  lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (CH - PAD.t - PAD.b);

  const bandPts = days.map((d, i) => d.z?.[key]?.median != null ? [i, d.z[key].median, d.z[key].sd] : null).filter(Boolean);
  const band = bandPts.length > 1
    ? `<path d="M${bandPts.map(([i, m, s]) => `${cx(i, n)},${y(m + s)}`).join("L")}L${bandPts.slice().reverse().map(([i, m, s]) => `${cx(i, n)},${y(m - s)}`).join("L")}Z" fill="var(--band)"/>
       <path d="M${bandPts.map(([i, m]) => `${cx(i, n)},${y(m)}`).join("L")}" fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>`
    : "";
  let path = "", pen = false;
  days.forEach((d, i) => {
    const v = d.z?.[key]?.value;
    if (v == null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${cx(i, n)},${y(v)}`;
    pen = true;
  });
  const dots = days.map((d, i) => {
    const e = d.z?.[key];
    if (e?.value == null) return "";
    const zb = e.z != null ? e.z * state.metrics[key].bad - 0.5 : 0;
    const fill = zb >= 2 ? "var(--high)" : zb >= 1 ? "var(--elevated)" : "var(--fg)";
    const last = i === n - 1 || days.slice(i + 1).every((x) => x.z?.[key]?.value == null);
    return `<circle cx="${cx(i, n)}" cy="${y(e.value)}" r="${last ? 4.5 : 2.5}" fill="${fill}"${last ? ` stroke="var(--surface)" stroke-width="2"` : ""}><title>${esc(shortDate(d.date))}: ${esc(fmt(key, e.value))}</title></circle>`;
  }).join("");
  const ticks = [lo, Math.round((lo + hi) / 2), hi].map((v) => `<text x="${PAD.l - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>
    <line x1="${PAD.l}" x2="${CW - PAD.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`).join("");
  return `<div class="chart"><h3>${esc(title)} (${esc(state.metrics[key].unit)}) <span>band = your normal range · ${esc(note)}</span></h3>
    <svg viewBox="0 0 ${CW} ${CH}" role="img" aria-label="${esc(title)} for the last ${n} days against your normal range">${ticks}${band}<path d="${path}" fill="none" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"/>${dots}${axisDates(days)}</svg></div>`;
}

function renderHistory() {
  const days = state.days.slice(-14).reverse();
  $("history").innerHTML = days.map((d) => {
    const c = d.checkin;
    const sy = c ? (c.symptoms || []).map((k) => state.symptoms[k]).filter(Boolean) : [];
    const feel = c
      ? `<b>${c.feeling} ${esc(FEELINGS[c.feeling])}</b>${sy.length ? ` · ${esc(sy.join(", "))}` : ""}${c.note ? ` · ${esc(c.note)}` : ""}`
      : `<span>No check-in</span>`;
    return `<div class="hrow"><span class="hdate">${esc(dayLabel(d.date))}</span>
      <span><span class="pill lv-${d.level}">${esc(d.level === "building" ? "Building" : LEVEL_TEXT[d.level].label)}</span></span>
      <span class="hfeel">${feel}</span></div>`;
  }).join("");
}

// ---------- events ----------
$("refresh").addEventListener("click", () => load(true));
$("checkin-date").addEventListener("change", (e) => {
  checkinDate = e.target.value;
  editing = false;
  renderCheckin();
});
$("checkin-cancel").addEventListener("click", () => { editing = false; renderCheckin(); });
$("checkin-delete").addEventListener("click", async () => {
  const btn = $("checkin-delete");
  // Two taps: the first asks for confirmation.
  if (btn.dataset.confirm !== checkinDate) {
    btn.dataset.confirm = checkinDate;
    btn.textContent = "Tap again to remove";
    setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "Remove check-in"; }, 4000);
    return;
  }
  btn.dataset.confirm = "";
  btn.textContent = "Remove check-in";
  try {
    state = await api(`/api/checkin?date=${checkinDate}&today=${today}`, { method: "DELETE", headers: HEADERS });
    editing = false;
    render();
    $("checkin-msg").textContent = "Check-in removed.";
  } catch (err) {
    $("checkin-msg").textContent = `Not removed: ${err.message}`;
  }
});
$("checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const feeling = form.querySelector("input[name=feeling]:checked")?.value;
  if (!feeling) {
    $("checkin-msg").textContent = "Pick how you feel, from 1 to 5.";
    return;
  }
  const symptoms = [...form.querySelectorAll("input[name=symptom]:checked")].map((i) => i.value);
  $("checkin-save").disabled = true;
  $("checkin-msg").textContent = "Saving…";
  try {
    state = await api("/api/checkin", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ date: checkinDate, today, feeling: Number(feeling), symptoms, note: $("checkin-note").value }),
    });
    editing = false;
    render();
  } catch (err) {
    $("checkin-msg").textContent = `Not saved: ${err.message}`;
  } finally {
    $("checkin-save").disabled = false;
  }
});

// ---------- morning reminder ----------
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let swReg = null;

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const subKeys = (sub) => {
  const j = sub.toJSON();
  return { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth };
};

const post = (path, body) => api(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });

function showReminder(reminder) {
  $("reminder-on").textContent = reminder ? "Save time" : "Turn on";
  $("reminder-off").hidden = !reminder;
  $("reminder-state").textContent = reminder ? `On · ${reminder.time} each day` : "Off";
  if (reminder) $("reminder-time").value = reminder.time;
}

async function initReminder() {
  if (!pushSupported) {
    $("reminder-text").textContent = "This browser can't receive notifications. On Android, open the app in Chrome.";
    $("reminder-on").disabled = true;
    return;
  }
  try {
    swReg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    swReg.update().catch(() => {});
    const sub = await swReg.pushManager.getSubscription();
    if (!sub) return showReminder(null);
    const { reminder } = await post("/api/reminder/status", { endpoint: sub.endpoint });
    showReminder(reminder);
  } catch (err) {
    $("reminder-msg").textContent = `Reminder settings unavailable: ${err.message}`;
  }
}

$("reminder-on").addEventListener("click", async () => {
  const msg = $("reminder-msg");
  msg.textContent = "";
  try {
    if (Notification.permission === "denied") {
      msg.textContent = "Notifications are blocked for this site. Allow them in Chrome's site settings, then try again.";
      return;
    }
    if ((await Notification.requestPermission()) !== "granted") {
      msg.textContent = "Notifications weren't allowed, so the reminder is off.";
      return;
    }
    swReg ||= await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    let sub = await swReg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api("/api/reminder/key");
      sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const { reminder } = await post("/api/reminder/save", { ...subKeys(sub), time: $("reminder-time").value, tz });
    showReminder(reminder);
    msg.textContent = `Reminder set for ${reminder.time}. It only arrives if you haven't checked in.`;
  } catch (err) {
    msg.textContent = `Couldn't turn on the reminder: ${err.message}`;
  }
});

$("reminder-off").addEventListener("click", async () => {
  const msg = $("reminder-msg");
  try {
    const sub = await swReg?.pushManager.getSubscription();
    if (sub) {
      await post("/api/reminder/delete", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    showReminder(null);
    msg.textContent = "Reminder turned off.";
  } catch (err) {
    msg.textContent = `Couldn't turn it off: ${err.message}`;
  }
});

document.body.classList.add("no-state");
load();
initReminder();
