// Page: reads settings, fetches drive times and cached fares, draws. Planning lives in core/plan.js.
import { options, byPreference, rankByTime, rankByCost, summary, makeDrive, fmt, duration, addDays } from "./core/plan.js";
import { driveMinutes, bucket } from "./google.js";

const LS = { settings: "cb.settings.v1", fares: "cb.fares.v1", drive: "cb.drive.v1", form: "cb.form.v1" };
const DEFAULTS = { googleKey: "", marginMin: 15, disembarkMin: 20 };

const load = (k, d) => { try { return { ...d, ...(JSON.parse(localStorage.getItem(k)) || {}) }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: ignore */ } };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function start({ fetchFn = fetch, now = () => Date.now() } = {}) {
  const data = await (await fetchFn("data/sailings.json")).json();
  let cachedFares = {};
  try { const r = await fetchFn("data/fares.json"); if (r.ok) cachedFares = (await r.json()).fares || {}; } catch { /* none yet */ }

  const state = {
    settings: load(LS.settings, DEFAULTS),
    entered: load(LS.fares, {}),
    driveCache: load(LS.drive, {}),
    googleError: null,
  };
  const today = fmt(Math.floor(now() / 60000)).date;
  const form = load(LS.form, { out: addDays(today, 7), back: addDays(today, 14), outPref: "any", backPref: "any", sort: "time" });
  if (form.out < today) form.out = addDays(today, 7);
  if (form.back && form.back < form.out) form.back = addDays(form.out, 7);

  // Form wiring
  $("#out").value = form.out; $("#back").value = form.back || "";
  for (const k of ["outPref", "backPref", "sort"]) setSeg(k, form[k]);
  $("#out").onchange = e => { form.out = e.target.value; refresh(); };
  $("#back").onchange = e => { form.back = e.target.value; refresh(); };
  document.querySelectorAll(".seg button").forEach(b => b.onclick = () => { form[b.parentElement.dataset.k] = b.dataset.v; setSeg(b.parentElement.dataset.k, b.dataset.v); refresh(); });
  $("#key").value = state.settings.googleKey;
  $("#margin").value = state.settings.marginMin; $("#disembark").value = state.settings.disembarkMin;
  $("#saveSettings").onclick = () => {
    state.settings = { googleKey: $("#key").value.trim(), marginMin: +$("#margin").value || 0, disembarkMin: +$("#disembark").value || 0 };
    save(LS.settings, state.settings); state.googleError = null; refresh();
  };
  $("#banner").textContent = data.verified ? "" : `Timetable not yet verified with the operators (data as of ${data.asOf}). Confirm times before booking.`;

  function setSeg(k, v) { document.querySelectorAll(`.seg[data-k="${k}"] button`).forEach(b => b.classList.toggle("on", b.dataset.v === v)); }

  const allFares = () => {
    const f = {};
    for (const [id, v] of Object.entries(cachedFares)) f[id] = { ...v, source: "fetched" };
    for (const [id, v] of Object.entries(state.entered)) f[id] = { ...v, source: "entered" };
    return f;
  };
  const addr = (k) => (data.places[k] || data.ports[k]).address;
  const ckey = (from, to, m) => `${from}>${to}@${bucket(m)}`;
  const lookup = (from, to, m) => {
    const v = state.driveCache[ckey(from, to, m)];
    return v != null ? { min: v, source: "google" } : null;
  };

  // Ask Google for every leg the current options need, then redraw. Two passes: leaving times move with the result.
  async function fetchDrives(dirs) {
    if (!state.settings.googleKey) return;
    for (let pass = 0; pass < 2; pass++) {
      const need = new Map();
      const drive = (from, to, m) => {
        const hit = m != null ? lookup(from, to, m) : null;
        if (!hit && m != null) need.set(ckey(from, to, m), { from, to, m: bucket(m) });
        return hit || makeDrive(data, null)(from, to, null);
      };
      for (const { dir, date } of dirs) options(data, { dir, date, drive, settings: state.settings });
      if (!need.size) return;
      $("#status").textContent = `Getting ${need.size} drive time${need.size > 1 ? "s" : ""} from Google…`;
      await Promise.all([...need.entries()].map(async ([k, q]) => {
        try {
          state.driveCache[k] = await driveMinutes({ key: state.settings.googleKey, origin: addr(q.from), destination: addr(q.to), departLocalMin: q.m, nowMs: now(), fetchFn });
        } catch (e) { state.googleError = e.message; }
      }));
      save(LS.drive, state.driveCache);
      draw();
      if (state.googleError) return;
    }
  }

  function dirs() { return [{ dir: "out", date: form.out }, ...(form.back ? [{ dir: "back", date: form.back }] : [])]; }

  function compute(dir, date, pref) {
    const drive = makeDrive(data, lookup);
    return byPreference(options(data, { dir, date, drive, fares: allFares(), settings: state.settings }), pref);
  }

  function draw() {
    save(LS.form, form);
    const outOpts = compute("out", form.out, form.outPref);
    const backOpts = form.back ? compute("back", form.back, form.backPref) : [];
    const rank = form.sort === "cost" ? rankByCost : rankByTime;
    $("#outList").innerHTML = list(rank(outOpts), "out");
    $("#outTitle").textContent = `Out · leave home ${niceDate(form.out)}`;
    $("#backSection").hidden = !form.back;
    if (form.back) { $("#backList").innerHTML = list(rank(backOpts), "back"); $("#backTitle").textContent = `Back · leave Borris ${niceDate(form.back)}`; }
    $("#summary").innerHTML = form.back ? summaryHtml(summary(outOpts, backOpts)) : "";
    $("#status").textContent = state.googleError ? `Google drive times failed (${state.googleError}); using estimates.`
      : state.settings.googleKey ? "" : "No Google key in Settings: drive times are rough estimates.";
    document.querySelectorAll("input.fare").forEach(inp => inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v > 0) state.entered[inp.dataset.id] = { amount: v, currency: "GBP", at: new Date(now()).toISOString() };
      else delete state.entered[inp.dataset.id];
      save(LS.fares, state.entered); draw();
    });
  }

  function refresh() { draw(); fetchDrives(dirs()).then(draw); }
  refresh();
  return { form, state, draw };
}

function niceDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
const t = (m) => fmt(m).time;
const dayNote = (m, ref) => (fmt(m).date !== fmt(ref).date ? ` <span class="nd">${esc(niceDate(fmt(m).date))}</span>` : "");
const money = (f) => `£${f.amount.toFixed(f.amount % 1 ? 2 : 0)}`;

function list(opts, dir) {
  if (!opts.length) return `<p class="empty">No sailings match. Try “Either” or another date.</p>`;
  const [startName, endName] = dir === "out" ? ["home", "Borris"] : ["Borris", "home"];
  return opts.map((o, i) => `
  <article class="opt" data-id="${esc(o.id)}">
    <div class="head">
      <div class="leave"><span class="lbl">Leave ${startName}</span><span class="big">${t(o.leave)}</span></div>
      <div class="total"><span class="lbl">Door to door</span><span class="big">${duration(o.totalMin)}</span></div>
      <div class="arrive"><span class="lbl">Arrive ${endName}</span><span class="big">${t(o.arrive)}</span>${dayNote(o.arrive, o.leave)}</div>
    </div>
    <div class="sail"><b>${esc(o.operator)}</b> ${esc(o.fromPort)} <b>${t(o.dep)}</b>${dayNote(o.dep, o.leave)} → ${esc(o.toPort)} ${t(o.arr)}
      ${o.overnight ? `<span class="tag night">Overnight</span>` : `<span class="tag day">Day</span>`}${i === 0 ? `<span class="tag best">Top</span>` : ""}</div>
    <div class="legs">Drive ${duration(o.driveTo.min)}${o.driveTo.source === "estimate" ? "*" : ""} · at port by ${t(o.atPortBy)} · crossing ${duration(o.crossingMin)} · drive ${duration(o.driveFrom.min)}${o.driveFrom.source === "estimate" ? "*" : ""}</div>
    <div class="fare">
      ${o.fare ? `<span class="price">${money(o.fare)}</span> <span class="src">${o.fare.source === "entered" ? "you entered" : "fetched"}</span>` : `<span class="src">No price yet</span>`}
      <label>Fare £ <input class="fare" inputmode="decimal" data-id="${esc(o.id)}" value="${o.fare && o.fare.source === "entered" ? o.fare.amount : ""}" placeholder="quote"></label>
      <a href="${esc(o.bookingUrl)}" target="_blank" rel="noopener">Check price ↗</a>
    </div>
    ${o.flags.length ? `<div class="flags">${o.flags.map(f => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
  </article>`).join("");
}

function summaryHtml(s) {
  const row = (label, p, val) => p ? `<div><span class="lbl">${label}</span> ${esc(p.out.operator)} ${t(p.out.dep)} out, ${esc(p.back.operator)} ${t(p.back.dep)} back · <b>${val}</b></div>` : `<div><span class="lbl">${label}</span> <span class="src">enter fares for both directions to compare</span></div>`;
  return row("Fastest round trip", s.fastest, s.fastest && duration(s.fastest.totalMin) + " door to door, both ways")
    + row("Cheapest round trip", s.cheapest, s.cheapest && `£${s.cheapest.amount.toFixed(0)} (two singles)`);
}
