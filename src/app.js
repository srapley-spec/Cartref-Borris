// Page: reads settings, fetches drive times and cached fares, draws. Planning lives in core/plan.js;
// every time shown comes from an option the engine built. Layout follows Cartref Commute's Signal design.
import { answer, options, byPreference, summary, makeDrive, fmt, duration, countdown, addDays } from "./core/plan.js";
import { driveMinutes, bucket, utcMsToLocalMin } from "./google.js";
import { freshness, timetableCheckedOn, STALE_AFTER_DAYS } from "./core/freshness.js";
import { priceSearches, mapLiveRows } from "./core/prices.js";
import { statusView, STATUS_STALE_MIN } from "./core/dated.js";

const LS = { settings: "cb.settings.v1", fares: "cb.fares.v1", drive: "cb.drive.v1", form: "cb.form.v2", live: "cb.live.v1" };
export const LIVE_TTL_MS = 60 * 60000; // live prices are re-searched after an hour
export const DEFAULTS = { googleKey: "", marginMin: 15, disembarkMin: 20, stops: 1, stopMin: 30, fastFerry: false, proxyUrl: "" };

const load = (k, d) => { try { return { ...d, ...(JSON.parse(localStorage.getItem(k)) || {}) }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: ignore */ } };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function start({ fetchFn = fetch, now = () => Date.now() } = {}) {
  const data = await (await fetchFn("data/sailings.json")).json();
  let shipData = { sailings: {}, fastShipsSeen: {} };
  try { const r = await fetchFn("data/ships.json"); if (r.ok) shipData = { sailings: {}, fastShipsSeen: {}, ...(await r.json()) }; } catch { /* none yet */ }
  const ships = shipData.sailings;
  // Operator sailing status (dated records + coverage), collected by .github/workflows/status.yml. Same-origin file.
  let dated = null;
  try { const r = await fetchFn("data/sailing-status.json"); if (r.ok) dated = await r.json(); } catch { /* none yet */ }
  const statusFetchedMin = (o) => { const c = dated?.coverage?.[`${o.record?.routeId}|${o.record?.date}`]; return c?.fetchedAt ? utcMsToLocalMin(Date.parse(c.fetchedAt)) : null; };
  let fareData = { quotes: {}, routes: {} };
  try { const r = await fetchFn("data/fares.json"); if (r.ok) fareData = { quotes: {}, routes: {}, ...(await r.json()) }; } catch { /* none yet */ }
  // Typical price for a sailing: AFerry's 12-month average for that route and month, else its operator average.
  const typical = (routeKey, op, dateISO) => {
    const rt = fareData.routes[routeKey]; if (!rt) return null;
    const m = rt.monthly?.[+dateISO.slice(5, 7)];
    if (m) return { amount: m.amount, basis: `route average for ${MONTHS[+dateISO.slice(5, 7) - 1]}`, seenOn: rt.fetchedOn };
    const a = rt.operatorAvg?.[op];
    return a ? { amount: a.amount, basis: "operator average", seenOn: rt.fetchedOn } : null;
  };

  const state = { settings: load(LS.settings, DEFAULTS), entered: load(LS.fares, {}), driveCache: load(LS.drive, {}), googleError: null, fetching: 0 };
  // Drive times are kept per leg and departure time; drop entries older than 7 days (and pre-timestamp ones).
  for (const [k, v] of Object.entries(state.driveCache)) if (!v || typeof v !== "object" || !v.at || now() - Date.parse(v.at) > STALE_AFTER_DAYS.drive * 864e5) delete state.driveCache[k];
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
    $("#fastNote").textContent = fastNote(data, shipData);
    const date = form.dir === "out" ? form.out : form.back;
    $("#contextSummary").textContent = [form.question === "now" ? "Today" : niceDate(date || form.out),
      { any: "Day or night", day: "Day only", overnight: "Overnight only" }[form[prefKey()]],
      { cost: "Cheapest", sleep: "Best sleep" }[form.sort] || "Fastest",
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
  $("#key").value = state.settings.googleKey; $("#proxy").value = state.settings.proxyUrl || "";
  $("#margin").value = state.settings.marginMin; $("#disembark").value = state.settings.disembarkMin; $("#stopMin").value = state.settings.stopMin;
  $("#saveSettings").onclick = () => {
    Object.assign(state.settings, { googleKey: $("#key").value.trim(), proxyUrl: $("#proxy").value.trim().replace(/\/+$/, ""), marginMin: num("#margin", 15), disembarkMin: num("#disembark", 20), stopMin: num("#stopMin", 30) });
    state.googleError = null; saveSettings();
  };
  function num(sel, d) { const v = parseInt($(sel).value, 10); return Number.isFinite(v) && v >= 0 ? v : d; }
  function saveSettings() { save(LS.settings, state.settings); refresh(); }
  // When was each data source last updated? Shown at the top (one line) and in full under "Data sources".
  function sources() {
    const today = fmt(nowMin()).date;
    const driveAts = Object.values(state.driveCache).map(v => v.at).filter(Boolean).sort();
    const quotes = Object.keys(fareData.quotes || {}).length;
    return freshness([
      { key: "times", label: "Ferry times", verb: "checked", updatedOn: timetableCheckedOn(data),
        detail: "Irish Ferries routes against Irish Ferries' own status pages; Stena routes via AFerry. Dublin Swift times unverified." },
      { key: "prices", label: "Prices", verb: "updated", updatedOn: [fareData.fetchedOn, ...Object.values(state.live).map(v => v.checkedAt)].filter(Boolean).sort().at(-1) || null,
        detail: fareData.fetchedOn ? `${state.settings.proxyUrl ? "Live AFerry searches for the dates on screen (re-searched after an hour); " : ""}AFerry: ${quotes} dated price${quotes === 1 ? "" : "s"} for specific sailings, plus monthly typical prices, refreshed daily.` : "No fetched prices yet." },
      { key: "ships", label: "Ships", verb: "updated", updatedOn: shipData.updatedOn || null,
        detail: shipData.updatedOn ? "Which ship ran each Irish Ferries sailing, from its status pages. Refreshed daily." : "Not yet recorded." },
      { key: "status", label: "Sailing status", verb: "collected", updatedOn: statusUpdatedAt(),
        detail: statusDetail() },
      { key: "drive", label: "Drive times", verb: "updated", optional: true, updatedOn: state.settings.googleKey && driveAts.length ? driveAts.at(-1) : null,
        detail: state.settings.googleKey ? "Google Routes with traffic for each departure time; kept up to 7 days." : "No Google key: rough estimates without traffic (marked “estimate”)." },
    ], today);
  }
  function statusUpdatedAt() {
    const good = Object.values(dated?.sources || {}).map(x => x.fetchedAt).filter(Boolean).sort();
    return good.at(-1) || null;
  }
  function statusDetail() {
    if (!dated) return "No operator status collected yet.";
    const src = Object.values(dated.sources || {});
    const failed = src.filter(x => !x.ok);
    const at = (iso) => iso ? `${niceDate(iso.slice(0, 10))} ${clock(iso)}` : "never";
    const parts = [`Stena Line FerryCheck boards and Irish Ferries sailing updates, collected ${at(dated.collectedAt)}${dated.complete ? "" : " (incomplete)"}.`];
    if (failed.length) parts.push(`Not reachable last time: ${failed.map(x => `${x.operator === "stena" ? "Stena" : "Irish Ferries"} ${x.routeIds.join("/")} (last good ${at(x.lastGoodAt)})`).join("; ")}.`);
    parts.push("Operators do not publish an update time on these pages; the time shown is when we read them. Status older than 2 hours is shown as unavailable.");
    return parts.join(" ");
  }
  function drawSources() {
    const list = sources();
    const bit = (x) => x.key === "drive" && !state.settings.googleKey ? `<span>Drive times: estimates</span>`
      : `<span class="${x.stale ? "stale" : ""}">${esc(x.label)} ${x.updatedOn ? `${x.verb} ${esc(x.ageText)}` : "never updated"}</span>`;
    $("#banner").innerHTML = list.map(bit).join(" · ") + (list.some(x => x.stale) ? ` <b class="stale">Check before booking.</b>` : "");
    $("#sources").innerHTML = `<h3>Data sources</h3>` + list.map(x => `<div class="src-row${x.stale ? " stale" : ""}"><b>${esc(x.label)}</b>
      <span>${x.updatedOn ? `${x.verb} ${esc(niceDate(x.updatedOn.slice(0, 10)))} (${esc(x.ageText)})` : "never updated"}${x.stale ? " · out of date" : ""}</span>
      <small>${esc(x.detail)}</small></div>`).join("");
  }

  // ---- live prices via the proxy (AFerry search), cached per search for an hour on the phone
  state.live = load(LS.live, {});
  for (const [k, v] of Object.entries(state.live)) if (!v.checkedAt || now() - Date.parse(v.checkedAt) > LIVE_TTL_MS) delete state.live[k];
  state.liveError = null; state.liveFetching = 0;
  function livePrices() {
    const out = {};
    for (const v of Object.values(state.live)) Object.assign(out, mapLiveRows(data, v.rows || [], v.checkedAt).prices);
    return out;
  }
  function liveDates() {
    const d = form.question === "now" ? [fmt(nowMin()).date] : [form.dir === "out" ? form.out : (form.back || form.out)];
    return form.question === "now" ? [d[0], addDays(d[0], 1)] : d;
  }
  async function fetchLive() {
    if (!state.settings.proxyUrl) return;
    const todo = priceSearches(form.dir, liveDates()).filter(q => !state.live[`${q.route}|${q.date}|${q.time}`]);
    if (!todo.length) return;
    state.liveFetching = todo.length; drawStatus();
    await Promise.all(todo.map(async (q) => {
      try {
        const r = await fetchFn(`${state.settings.proxyUrl}/prices?route=${q.route}&date=${q.date}&time=${q.time}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        state.live[`${q.route}|${q.date}|${q.time}`] = { checkedAt: j.checkedAt, rows: j.rows || [] };
      } catch (e) { state.liveError = e.message; }
    }));
    state.liveFetching = 0;
    save(LS.live, state.live);
  }

  // ---- data plumbing
  const allFares = () => {
    const f = {};
    for (const [id, v] of Object.entries(fareData.quotes)) f[id] = { ...v, source: "fetched" };
    for (const [id, v] of Object.entries(livePrices())) f[id] = { ...v, source: "live" };
    for (const [id, v] of Object.entries(state.entered)) f[id] = { ...v, source: "entered" };
    return f;
  };
  const addr = (k) => (data.places[k] || data.ports[k]).address;
  const ckey = (from, to, m) => `${from}>${to}@${bucket(m)}`;
  const lookup = (from, to, m) => {
    const v = state.driveCache[ckey(from, to, m)];
    if (v == null) return null;
    return { min: v.min, roads: v.roads || [], source: "google", at: v.at };
  };

  function question(dir, drive, extra = {}) {
    const date = dir === "out" ? form.out : (form.back || form.out);
    return answer(data, { question: form.question, dir, nowMin: nowMin(), date, time: dir === "out" ? form.outTime : form.backTime,
      pref: form[dir === "out" ? "outPref" : "backPref"], sort: form.sort, drive, fares: allFares(), typical, ships, dated, settings: state.settings, ...extra });
  }
  function roundTrip(drive) {
    if (!form.back) return null;
    const mk = (dir, date, pref) => byPreference(options(data, { dir, date, drive, fares: allFares(), typical, ships, dated, settings: state.settings }), pref);
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
        try { state.driveCache[k] = { ...(await driveMinutes({ key: state.settings.googleKey, origin: addr(q.from), destination: addr(q.to), departLocalMin: q.m, nowMs: now(), fetchFn })), at: new Date(now()).toISOString() }; }
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
    if (state.liveFetching) { $("#status").textContent = `Getting live prices (${state.liveFetching} search${state.liveFetching > 1 ? "es" : ""}, about 20 seconds)…`; return; }
    if (state.liveError && !state.fetching) { $("#status").textContent = `Live prices failed (${state.liveError}); showing other prices.`; return; }
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
    const nm = nowMin();
    const viewFor = (o) => statusView(o.record || null, { nowMin: nm, fetchedAtMin: statusFetchedMin(o), staleAfterMin: STATUS_STALE_MIN });
    $("#hero").innerHTML = noBack ? `<p class="empty">Set a date to leave Borris in Journey options.</p>`
      : !a.best ? `<p class="empty">No crossings match. Try “Day or night”, another time or date${state.settings.fastFerry ? "" : ", or turn on the fast ferry"}.</p>`
      : `<div class="hero-cap">${esc(caption)}</div>${a.leastLate ? `<div class="banner-inline">Nothing arrives by then. Least late shown first.</div>` : ""}
         ${card(a.best, { dir: form.dir, label: a.label, status: viewFor(a.best) })}
         ${a.next ? `<div class="next-best"><h3>Next best</h3>${card(a.next, { dir: form.dir, status: viewFor(a.next) })}</div>` : ""}`;
    const rest = noBack ? [] : a.list.filter(o => o !== a.best && o !== a.next);
    $("#listTitle").hidden = !rest.length;
    $("#listTitle").textContent = `All other options · ${rest.length}`;
    $("#list").innerHTML = rest.map(o => card(o, { dir: form.dir, compact: true, status: viewFor(o) })).join("");
    const rt = roundTrip(drive);
    $("#roundTrip").innerHTML = rt ? roundTripHtml(rt) : "";
    drawStatus(); drawSources();
    document.querySelectorAll("input.fare-in").forEach(inp => inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v) && v > 0) state.entered[inp.dataset.id] = { amount: v, currency: "GBP", at: new Date(now()).toISOString() };
      else delete state.entered[inp.dataset.id];
      save(LS.fares, state.entered); draw();
    });
  }

  function refresh() { draw(); fetchDrives().then(draw); fetchLive().then(draw); }
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
/** Has the fast ferry actually been seen sailing? Only Irish Ferries' status pages are watched. */
export function fastNote(data, shipData) {
  return (data.fastShips || []).map(ship => {
    const seen = shipData.fastShipsSeen?.[ship];
    if (seen) return `${ship} last seen sailing on Irish Ferries' status page ${niceDate(seen)}.`;
    return shipData.watchingSince ? `${ship} not seen on Irish Ferries' status pages since ${niceDate(shipData.watchingSince)}; its times here are from memory.`
      : `${ship} not yet checked against Irish Ferries' status pages; its times here are from memory.`;
  }).join(" ");
}
function clock(iso) { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }); }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fareHtml(o) {
  if (o.fare && o.fare.source === "entered") return `<span class="price">${money(o.fare)}</span><span class="src">you entered</span>`;
  if (o.fare && o.fare.source === "live") return `<span class="price">${money(o.fare)}</span><span class="src">AFerry live price, checked ${esc(clock(o.fare.checkedAt))}</span>`;
  if (o.fare) return `<span class="price">${money(o.fare)}</span><span class="src">AFerry price for this sailing, seen ${esc(niceDate(o.fare.seenOn || o.fare.date))}</span>`;
  if (o.typicalFare) return `<span class="price typical">~£${o.typicalFare.amount}</span><span class="src">typical, not a quote (AFerry ${esc(o.typicalFare.basis || "average")})</span>`;
  return `<span class="src">No price yet</span>`;
}
/** Road number as a lozenge in that country's sign colours: motorways (and A(M)) blue; UK A roads green with yellow
 *  numbers; Irish N roads green; Irish R roads white. */
export function roadSign(road, country) {
  const kind = /^M\d|\(M\)$/.test(road) ? "m" : road[0] === "A" ? "a" : road[0] === "N" ? "n" : "r";
  return `<span class="road road-${kind}${country === "IE" ? " ie" : ""}">${esc(road)}</span>`;
}
function driveLeg(d, where) {
  const roads = d.roads ? `<span class="roads">${d.roads.list.map(r => roadSign(r, d.country)).join("")}</span>${d.roads.source === "typical" ? `<small class="roads-src">typical roads, unchecked</small>` : ""}` : "";
  return `<div class="drive-leg"><span class="dl">Drive ${esc(driveText(d))} ${esc(where)}</span>${roads}</div>`;
}
function timesSource(o) {
  if (o.source === "operator") return ` · Times from ${o.record.operator === "stena" ? "Stena Line" : "Irish Ferries"} for this date`;
  if (!o.verified) return ` · <span class="unverified">Timetable unverified</span>`;
  const on = o.verifiedOn ? ` ${esc(niceDate(o.verifiedOn))}` : "";
  return o.verifiedBy === "operator" ? ` · Times checked with ${esc(o.operator)}${on}` : ` · Times via AFerry${on}`;
}
function driveText(d) {
  return `${duration(d.min)}${d.stops ? ` incl. ${d.stops} stop${d.stops > 1 ? "s" : ""} (${duration(d.stopsMin)})` : ""}${d.source === "estimate" ? " (estimate)" : ""}`;
}

export function card(o, { dir, label, compact, status }) {
  const [startName, endName] = dir === "out" ? ["home", "Borris"] : ["Borris", "home"];
  const sv = status || statusView(o.record || null);
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
  <article class="opt${compact ? " compact" : ""}${o.unavailable ? " unavailable" : ""}" data-id="${esc(o.id)}">
    <div class="optrow">
      <div><small>Leave by</small><span class="optbig">${t(o.leave)}</span><small class="nd">${esc(niceDate(fmt(o.leave).date))}</small></div>
      <div class="optarrow" aria-hidden="true">→</div>
      <div><small>At ${endName}${o.estArr != null ? " (expected)" : ""}</small><span class="optbig arrive${o.estArr != null ? " lvl-warn" : ""}">${t(o.arrive)}</span>${dayNote(o.arrive, o.leave)}${o.estArr != null ? `<small class="nd">timetable ${t(o.scheduledArrive)}</small>` : ""}</div>
    </div>
    <div class="journey-facts"><span class="journey-total-time">Total journey ${duration(o.totalMin)}</span><span class="journey-train-time">${duration(o.crossingMin)} crossing${o.fast ? " · fast ferry" : ""}</span></div>
    ${o.leaveInMin != null ? `<div class="journey-countdown">${esc(countdown(o.leaveInMin))}</div>` : ""}
    <div class="tags">${o.unavailable ? `<span class="tag lvl-bad">Cancelled</span>` : ""}${label ? `<span class="tag best">${esc(label)}</span>` : ""}<span class="tag">${o.overnight ? "Overnight" : "Daytime"}</span><span class="tag ship-tag">${esc(o.shipType)}</span>${o.sleepMin ? `<span class="tag sleep">Sleep ~${duration(o.sleepMin)} on board</span>` : ""}${o.nightDriveMin ? `<span class="tag night-drive">Driving ${duration(o.nightDriveMin)} between midnight and 5am</span>` : ""}</div>
    <div class="next-svc"><b>Next: ${t(o.dep)} ${esc(o.operator)}</b> from ${esc(o.fromPort)}</div>
    <div class="leg-panel">
      <div class="leg-head">${opBadge(o)} <span>Ferry from ${esc(o.fromPort)} → ${esc(o.toPort)}</span></div>
      <div class="ship"><b>${esc(o.shipType)}</b>${o.vessel ? ` · ${esc(o.vessel)}` : ""}</div>
      <div class="leg-cols">
        <div><small>Timetable departure</small><span class="legbig">${t(o.dep)}</span></div>
        <div><small>Expected departure</small>${/^\d\d:\d\d$/.test(sv.expected || "") ? `<span class="legbig lvl-${sv.level}">${esc(sv.expected)}</span>` : `<span class="legbig muted">${esc(sv.expected || "Not live")}</span>`}</div>
        <div><small>At ${esc(o.toPort)}</small><span class="legbig">${t(o.arr)}</span>${dayNote(o.arr, o.dep)}</div>
      </div>
      <div class="leg-status"><span class="status-lz lvl-${sv.level}">${esc(sv.label)}</span>${o.record ? `<small>${o.record.operator === "stena" ? "Stena Line" : "Irish Ferries"} status, read ${esc(clock(o.record.fetchedAt))}</small>` : `<small>no operator status for this date</small>`}</div>
      ${o.record && sv.detail && sv.detail !== sv.label && sv.kind !== "on-time" ? `<div class="leg-notice">${esc(sv.detail)}</div>` : ""}
      <div class="leg-meta">Check-in closes <b>${t(checkInCloses)}</b> · be there by ${t(o.atPortBy)}${o.vessel ? ` · ${esc(o.vessel)}` : ""}${timesSource(o)}</div>
    </div>
    ${driveLeg(o.driveTo, `to ${o.fromPort}`)}
    ${driveLeg(o.driveFrom, `from ${o.toPort}`)}
    <div class="fare">
      ${fareHtml(o)}
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
