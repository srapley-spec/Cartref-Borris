// Page: reads settings, fetches drive times and cached fares, draws. Planning lives in core/plan.js;
// every time shown comes from an option the engine built. Layout follows Cartref Commute's Signal design.
import { answer, options, byPreference, summary, makeDrive, fmt, duration, countdown, addDays } from "./core/plan.js";
import { driveMinutes, bucket, utcMsToLocalMin } from "./google.js";

const LS = { settings: "cb.settings.v1", fares: "cb.fares.v1", drive: "cb.drive.v1", form: "cb.form.v2" };
export const DEFAULTS = { googleKey: "", marginMin: 15, disembarkMin: 20, stops: 1, stopMin: 30, fastFerry: false };

const load = (k, d) => { try { return { ...d, ...(JSON.parse(localStorage.getItem(k)) || {}) }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: ignore */ } };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function start({ fetchFn = fetch, now = () => Date.now() } = {}) {
  const data = await (await fetchFn("data/sailings.json")).json();
  let cachedFares = {};
  try { const r = await fetchFn("data/fares.json"); if (r.ok) cachedFares = (await r.json()).fares || {}; } catch { /* none yet */ }

  const state = { settings: load(LS.settings, DEFAULTS), entered: load(LS.fares, {}), driveCache: load(LS.drive, {}), googleError: null, fetching: 0 };
  const nowMin = () => utcMsToLocalMin(now());
  const today = fmt(nowMin()).date;
  const form = load(LS.form, { dir: "out", question: "now", out: addDays(today, 7), back: addDays(today, 14), outTime: "18:00", backTime: "18:00", outPref: "any", backPref: "any", sort: "time" });
  if (form.out < today) form.out = addDays(today, 7);
  if (form.back && form.back < form.out) form.back = addDays(form.out, 7);

  // ---- controls
  const segs = { dir: "#dirSeg", question: "#questionSeg", pref: "#prefSeg", sort: "#sortSeg" };
  const prefKey = () => (form.dir === "out" ? "outPref" : "backPref");
  function syncControls() {
    const val = { dir: form.dir, question: form.question, pref: form[prefKey()], sort: form.sort };
    for (const [k, sel] of Object.entries(segs)) document.querySelectorAll(`${sel} button`).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === val[k])));
    $("#outDate").value = form.out; $("#backDate").value = form.back || "";
    $("#timeRow").hidden = !["arrive", "around"].includes(form.question);
    $("#timeLabel").textContent = form.question === "arrive" ? `Arrive ${form.dir === "out" ? "Borris" : "home"} by` : "Leave around";
    $("#time").value = form.dir === "out" ? form.outTime : form.backTime;
    $("#stopsVal").textContent = state.settings.stops;
    $("#fastFerry").setAttribute("aria-pressed", String(state.settings.fastFerry));
    $("#fastFerry").textContent = state.settings.fastFerry ? "Fast ferry: on" : "Fast ferry: off";
    const date = form.dir === "out" ? form.out : form.back;
    $("#contextSummary").textContent = [form.question === "now" ? "Today" : niceDate(date || form.out),
      { any: "Day or night", day: "Day only", overnight: "Overnight only" }[form[prefKey()]],
      form.sort === "cost" ? "Cheapest" : "Fastest",
      `${state.settings.stops} stop${state.settings.stops === 1 ? "" : "s"}`,
      state.settings.fastFerry ? "Fast ferry on" : "Fast ferry off"].join(" · ");
  }
  for (const [k, sel] of Object.entries(segs)) document.querySelectorAll(`${sel} button`).forEach(b => b.onclick = () => {
    if (k === "pref") form[prefKey()] = b.dataset.v; else form[k] = b.dataset.v;
    refresh();
  });
  $("#outDate").onchange = e => { form.out = e.target.value; refresh(); };
  $("#backDate").onchange = e => { form.back = e.target.value; refresh(); };
  $("#time").onchange = e => { form[form.dir === "out" ? "outTime" : "backTime"] = e.target.value; refresh(); };
  $("#stopsDown").onclick = () => { state.settings.stops = Math.max(0, state.settings.stops - 1); saveSettings(); };
  $("#stopsUp").onclick = () => { state.settings.stops = Math.min(6, state.settings.stops + 1); saveSettings(); };
  $("#fastFerry").onclick = () => { state.settings.fastFerry = !state.settings.fastFerry; saveSettings(); };
  $("#refresh").onclick = () => { state.googleError = null; refresh(); };
  $("#settingsBtn").onclick = () => { const d = $("#settings"); d.open = !d.open; if (d.open) d.scrollIntoView({ block: "start" }); };
  $("#key").value = state.settings.googleKey;
  $("#margin").value = state.settings.marginMin; $("#disembark").value = state.settings.disembarkMin; $("#stopMin").value = state.settings.stopMin;
  $("#saveSettings").onclick = () => {
    Object.assign(state.settings, { googleKey: $("#key").value.trim(), marginMin: num("#margin", 15), disembarkMin: num("#disembark", 20), stopMin: num("#stopMin", 30) });
    state.googleError = null; saveSettings();
  };
  function num(sel, d) { const v = parseInt($(sel).value, 10); return Number.isFinite(v) && v >= 0 ? v : d; }
  function saveSettings() { save(LS.settings, state.settings); refresh(); }
  $("#banner").textContent = data.verified ? "" : (data.bannerNote || `Ferry times not yet checked with the operators (data as of ${niceDate(data.asOf)}). Confirm before booking.`);

  // ---- data plumbing
  const allFares = () => {
    const f = {};
    for (const [id, v] of Object.entries(cachedFares)) f[id] = { ...v, source: "fetched" };
    for (const [id, v] of Object.entries(state.entered)) f[id] = { ...v, source: "entered" };
    return f;
  };
  const addr = (k) => (data.places[k] || data.ports[k]).address;
  const ckey = (from, to, m) => `${from}>${to}@${bucket(m)}`;
  const lookup = (from, to, m) => { const v = state.driveCache[ckey(from, to, m)]; return v != null ? { min: v, source: "google" } : null; };

  function question(dir, drive, extra = {}) {
    const date = dir === "out" ? form.out : (form.back || form.out);
    return answer(data, { question: form.question, dir, nowMin: nowMin(), date, time: dir === "out" ? form.outTime : form.backTime,
      pref: form[dir === "out" ? "outPref" : "backPref"], sort: form.sort, drive, fares: allFares(), settings: state.settings, ...extra });
  }
  function roundTrip(drive) {
    if (!form.back) return null;
    const mk = (dir, date, pref) => byPreference(options(data, { dir, date, drive, fares: allFares(), settings: state.settings }), pref);
    return summary(mk("out", form.out, form.outPref), mk("back", form.back, form.backPref));
  }

  // Ask Google for every leg the visible answer needs, then redraw. Two passes: leave times move with the result.
  async function fetchDrives() {
    if (!state.settings.googleKey) return;
    for (let pass = 0; pass < 2; pass++) {
      const need = new Map();
      const est = makeDrive(data, null);
      const drive = (from, to, m) => {
        const hit = m != null ? lookup(from, to, m) : null;
        // Legs already in the past belong to options nobody can take: don't pay Google for them.
        if (!hit && m != null && m >= nowMin()) need.set(ckey(from, to, m), { from, to, m: bucket(m) });
        return hit || est(from, to, null);
      };
      question(form.dir, drive); roundTrip(drive);
      if (!need.size) return;
      state.fetching = need.size; drawStatus();
      await Promise.all([...need.entries()].map(async ([k, q]) => {
        try { state.driveCache[k] = await driveMinutes({ key: state.settings.googleKey, origin: addr(q.from), destination: addr(q.to), departLocalMin: q.m, nowMs: now(), fetchFn }); }
        catch (e) { state.googleError = e.message; }
      }));
      state.fetching = 0;
      save(LS.drive, state.driveCache);
      draw();
      if (state.googleError) return;
    }
  }

  // ---- drawing
  function drawStatus() {
    $("#status").textContent = state.fetching ? `Getting ${state.fetching} drive time${state.fetching > 1 ? "s" : ""} from Google…`
      : state.googleError ? `Google drive times failed (${state.googleError}); using estimates.`
      : state.settings.googleKey ? "" : "No Google key in Settings: drive times are rough estimates without traffic.";
  }
  function draw() {
    save(LS.form, form); syncControls();
    const drive = makeDrive(data, lookup);
    const a = question(form.dir, drive);
    const end = form.dir === "out" ? "Borris" : "home";
    const date = form.dir === "out" ? form.out : form.back;
    const caption = {
      now: `If you leave now · ${fmt(nowMin()).time} · best, and the next best`,
      arrive: `Arrive ${end} by ${form.dir === "out" ? form.outTime : form.backTime} · ${niceDate(date || form.out)}`,
      around: `Leave around ${form.dir === "out" ? form.outTime : form.backTime} · ${niceDate(date || form.out)}`,
      fastest: `Fastest door to door · leaving ${niceDate(date || form.out)}`,
    }[form.question];
    const noBack = form.dir === "back" && !form.back && form.question !== "now";
    $("#hero").innerHTML = noBack ? `<p class="empty">Set a date to leave Borris in Journey options.</p>`
      : !a.best ? `<p class="empty">No crossings match. Try “Day or night”, another time or date${state.settings.fastFerry ? "" : ", or turn on the fast ferry"}.</p>`
      : `<div class="hero-cap">${esc(caption)}</div>${a.leastLate ? `<div class="banner-inline">Nothing arrives by then. Least late shown first.</div>` : ""}
         ${card(a.best, { dir: form.dir, label: a.label })}
         ${a.next ? `<div class="next-best"><h3>Next best</h3>${card(a.next, { dir: form.dir })}</div>` : ""}`;
    const rest = noBack ? [] : a.list.slice(2);
    $("#listTitle").hidden = !rest.length;
    $("#listTitle").textContent = `All other options · ${rest.length}`;
    $("#list").innerHTML = rest.map(o => card(o, { dir: form.dir, compact: true })).join("");
    const rt = roundTrip(drive);
    $("#roundTrip").innerHTML = rt ? roundTripHtml(rt) : "";
    drawStatus();
    document.querySelectorAll("input.fare-in").forEach(inp => inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v > 0) state.entered[inp.dataset.id] = { amount: v, currency: "GBP", at: new Date(now()).toISOString() };
      else delete state.entered[inp.dataset.id];
      save(LS.fares, state.entered); draw();
    });
  }

  function refresh() { draw(); fetchDrives().then(draw); }
  refresh();
  setInterval(draw, 30000); // countdowns
  return { form, state, draw };
}

// ---- renderers (presentation only)
function niceDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
const t = (m) => fmt(m).time;
const dayNote = (m, ref) => (fmt(m).date !== fmt(ref).date ? `<small class="nd">${esc(niceDate(fmt(m).date))}</small>` : "");
const money = (f) => `£${f.amount.toFixed(f.amount % 1 ? 2 : 0)}`;

function opBadge(o) {
  return o.logo ? `<span class="op"><img src="${esc(o.logo)}" alt="${esc(o.operator)}" height="28"></span>` : `<span class="op op-text">${esc(o.operator)}</span>`;
}
function timesSource(o) {
  if (!o.verified) return ` · <span class="unverified">Timetable unverified</span>`;
  const on = o.verifiedOn ? ` ${esc(niceDate(o.verifiedOn))}` : "";
  return o.verifiedBy === "operator" ? ` · Times checked with ${esc(o.operator)}${on}` : ` · Times via AFerry${on}`;
}
function driveText(d) {
  return `${duration(d.min)}${d.stops ? ` incl. ${d.stops} stop${d.stops > 1 ? "s" : ""} (${duration(d.stopsMin)})` : ""}${d.source === "estimate" ? " (estimate)" : ""}`;
}

export function card(o, { dir, label, compact }) {
  const [startName, endName] = dir === "out" ? ["home", "Borris"] : ["Borris", "home"];
  const checkInCloses = o.dep - o.checkInMin;
  const steps = [
    [o.leave, `Leave ${startName}`],
    [null, `Drive to ${o.fromPort} · ${driveText(o.driveTo)}`],
    [o.atPortBy, `At ${o.fromPort} (check-in closes ${t(checkInCloses)})`],
    [o.dep, `Sail ${o.operator}${o.vessel ? ` (${o.vessel})` : ""} → ${o.toPort} · ${duration(o.crossingMin)}`],
    [o.arr, `Arrive ${o.toPort}; off the ferry about ${t(o.offAt)}`],
    [null, `Drive to ${endName} · ${driveText(o.driveFrom)}`],
    [o.arrive, `At ${endName}`],
  ];
  return `
  <article class="opt${compact ? " compact" : ""}" data-id="${esc(o.id)}">
    <div class="optrow">
      <div><small>Leave by</small><span class="optbig">${t(o.leave)}</span><small class="nd">${esc(niceDate(fmt(o.leave).date))}</small></div>
      <div class="optarrow" aria-hidden="true">→</div>
      <div><small>At ${endName}</small><span class="optbig arrive">${t(o.arrive)}</span>${dayNote(o.arrive, o.leave)}</div>
    </div>
    <div class="journey-facts"><span class="journey-total-time">Total journey ${duration(o.totalMin)}</span><span class="journey-train-time">${duration(o.crossingMin)} crossing${o.fast ? " · fast ferry" : ""}</span></div>
    ${o.leaveInMin != null ? `<div class="journey-countdown">${esc(countdown(o.leaveInMin))}</div>` : ""}
    <div class="tags">${label ? `<span class="tag best">${esc(label)}</span>` : ""}<span class="tag">${o.overnight ? "Overnight" : "Daytime"}</span>${o.fast ? `<span class="tag">Fast ferry</span>` : ""}</div>
    <div class="next-svc"><b>Next: ${t(o.dep)} ${esc(o.operator)}</b> from ${esc(o.fromPort)}</div>
    <div class="leg-panel">
      <div class="leg-head">${opBadge(o)} <span>Ferry from ${esc(o.fromPort)} → ${esc(o.toPort)}</span></div>
      <div class="leg-cols">
        <div><small>Timetable departure</small><span class="legbig">${t(o.dep)}</span></div>
        <div><small>Expected departure</small><span class="legbig muted">Not live</span></div>
        <div><small>At ${esc(o.toPort)}</small><span class="legbig">${t(o.arr)}</span>${dayNote(o.arr, o.dep)}</div>
      </div>
      <div class="leg-meta">Check-in closes <b>${t(checkInCloses)}</b> · be there by ${t(o.atPortBy)}${o.vessel ? ` · ${esc(o.vessel)}` : ""}${timesSource(o)}</div>
    </div>
    <div class="chips"><span class="chip">Drive ${esc(driveText(o.driveTo))} to ${esc(o.fromPort)}</span><span class="chip">Drive ${esc(driveText(o.driveFrom))} from ${esc(o.toPort)}</span></div>
    <div class="fare">
      ${o.fare ? `<span class="price">${money(o.fare)}</span><span class="src">${o.fare.source === "entered" ? "you entered" : "fetched"}</span>` : (o.typicalFare ? `<span class="src">No quote yet · typical £${o.typicalFare.amount} (AFerry average)</span>` : `<span class="src">No price yet</span>`)}
      <label>Fare £ <input class="fare-in" inputmode="decimal" data-id="${esc(o.id)}" value="${o.fare && o.fare.source === "entered" ? o.fare.amount : ""}" placeholder="quote" aria-label="Fare for ${esc(o.operator)} ${t(o.dep)}"></label>
    </div>
    <div class="actions">
      <details class="steps"><summary>Journey steps</summary><ol>${steps.map(([m, s]) => `<li><span class="st">${m != null ? t(m) : ""}</span><span>${esc(s)}</span></li>`).join("")}</ol>
        ${o.flags.length ? `<div class="flags">${o.flags.map(f => `<span>${esc(f)}</span>`).join("")}</div>` : ""}</details>
      <a class="primary" href="${esc(o.bookingUrl)}" target="_blank" rel="noopener">Check price</a>
    </div>
  </article>`;
}

function roundTripHtml(s) {
  const row = (label, p, val) => p
    ? `<div><small>${label}</small> ${t(p.out.dep)} ${esc(p.out.operator)} out (${esc(niceDate(fmt(p.out.leave).date))}), ${t(p.back.dep)} ${esc(p.back.operator)} back · <b>${val}</b></div>`
    : `<div><small>${label}</small> <span class="src">enter fares in both directions to compare</span></div>`;
  return `<h3>Round trip</h3>` + row("Fastest", s.fastest, s.fastest && `${duration(s.fastest.totalMin)} door to door, both ways`)
    + row("Cheapest", s.cheapest, s.cheapest && `£${s.cheapest.amount.toFixed(0)} (two singles)`);
}
