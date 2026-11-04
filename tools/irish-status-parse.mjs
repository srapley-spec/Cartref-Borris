// Pure parser for Irish Ferries sailing-updates pages (ie-en or uk-en), one record per sailing per date.
// Page structure (4 Nov 2026): a date strip (yesterday / today / tomorrow / dayaftertomorrow, each "DD <em>Dow</em> Mon"),
// then for each date and direction a <div class="sailing-item {tab}"> holding a header "from <port>", rows
// <ul class="sailing-listing …"> with <li class="dept|arr|ship|stats">, an optional notice after each row, and an
// <h3>Weekday Nth Month</h3>. Notices like "your 03/11/2026 02:00 Dublin to Holyhead … will depart at earlier time of
// 01:15" give the original and revised departure explicitly; displayed times already incorporate the change.
import { PORTS } from "./aferry-parse.mjs";

export const SHIP_ALIASES = { Innisfree: "Isle of Innisfree" };
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TABS = ["yesterday", "today", "tomorrow", "dayaftertomorrow"];

const clean = (s) => s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** Normalised status from the operator's label. Unknown labels become "other"; the label itself is always kept. */
export function normaliseStatus(label) {
  const l = label.trim().toLowerCase();
  if (/cancel/.test(l)) return "cancelled";
  if (/^on time$/.test(l)) return "on-time";
  if (/arrived/.test(l)) return "arrived";
  if (/departed|sailed/.test(l)) return "departed";
  if (/early/.test(l)) return "early";
  if (/delay|late/.test(l)) return "delayed";
  if (/boarding|check-?in/.test(l)) return "boarding";
  return "other";
}

/** "DD Mon" seen on collectedOn (YYYY-MM-DD) -> the nearest YYYY-MM-DD (handles the year boundary). */
export function resolveDayMonth(day, mon, collectedOn) {
  const y0 = +collectedOn.slice(0, 4), m = MON3.indexOf(mon.slice(0, 3));
  if (m < 0) return null;
  const base = Date.parse(collectedOn);
  let best = null;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(+day).padStart(2, "0")}`;
    const d = Math.abs(Date.parse(iso) - base);
    if (best == null || d < best.d) best = { iso, d };
  }
  return best.iso;
}

export function addDaysISO(iso, n) { return new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10); }

/** Explicit facts in a notice: original departure, revised time, cancellation, replacement sailing, check-in. */
export function parseNotice(text) {
  const out = {};
  const orig = text.match(/\b(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d)\b/);
  if (orig) { out.originalDate = `${orig[3]}-${orig[2]}-${orig[1]}`; out.originalDep = orig[4]; }
  const rev = text.match(/(?:earlier|later|revised|new|rescheduled|estimated) (?:departure )?time of (\d\d:\d\d)/i) || text.match(/depart(?:ing)? at (\d\d:\d\d)/i);
  if (rev) out.revisedDep = rev[1];
  if (/cancel/i.test(text)) out.cancelled = true;
  const repl = text.match(/on the (StenaLine|Stena Line|Irish Ferries) sailing (?:to|from) ([A-Z][a-z]+)/i);
  if (repl) out.replacement = { operator: /stena/i.test(repl[1]) ? "stena" : "irish", port: repl[2] };
  const ci = text.match(/check[- ]?in(?: time)?(?: is)?(?: at least)? (\d+) (minutes?|hours?|hr) before/i);
  if (ci) out.checkInMin = /hour|hr/.test(ci[2]) ? +ci[1] * 60 : +ci[1];
  return out;
}

/**
 * html: the page (or its desktop sailing-updates section). collectedOn: YYYY-MM-DD the page was fetched (local).
 * Returns { dates: { tab: YYYY-MM-DD }, checkInNote, sailings, warnings }.
 * Each sailing: { operator: "irish", from, to, routeId, date, dep, arr, arrDate, ship, statusLabel, status, notice,
 *   originalDep, revisedDep, replacement, checkInMin, tab }. dep/arr are the operator's displayed (current) times.
 */
export function parseIrishStatusPage(html, collectedOn) {
  const warnings = [];
  const i = html.indexOf("sailing-updates__desktop");
  const section = i >= 0 ? html.slice(i) : html;
  const dates = {};
  const strip = section.match(/<ul class="sailing-date-list[\s\S]*?<\/ul>/);
  if (strip) {
    for (const m of strip[0].matchAll(/data-datetime="(\w+)"[\s\S]*?<span class="day">\s*(\d{1,2})\s*<em>[^<]*<\/em>\s*<\/span>\s*<span class="month">\s*([A-Za-z]{3})/g)) {
      dates[m[1]] = resolveDayMonth(m[2], m[3], collectedOn);
    }
  }
  if (!Object.keys(dates).length) {
    warnings.push("date strip not found; dates inferred from the collection date");
    TABS.forEach((t, k) => { dates[t] = addDaysISO(collectedOn, k - 1); });
  }
  const checkInNote = clean((section.match(/<h2 class="heading--grey">([\s\S]*?)<\/h2>/) || [, ""])[1]) || null;
  const sailings = [];
  const blockRe = /<div class="sailing-item (\w+)"[^>]*>([\s\S]*?)(?=<div class="sailing-item |<div class="sailing-updates__mobile|$)/g;
  for (const b of section.matchAll(blockRe)) {
    const tab = b[1], body = b[2];
    const date = dates[tab];
    if (!date) { warnings.push(`unknown date tab ${tab}`); continue; }
    const h3 = clean((body.match(/<h3>([\s\S]*?)<\/h3>/) || [, ""])[1]);
    if (h3) { const dm = h3.match(/(\d{1,2})(?:st|nd|rd|th)? ([A-Z][a-z]+)/); if (dm && resolveDayMonth(dm[1], dm[2], collectedOn) !== date) warnings.push(`tab ${tab} says ${date} but heading says ${h3}`); }
    const rowRe = /<ul class="sailing-listing(?!-header)[^"]*">([\s\S]*?)<\/ul>\s*(?:<div class="sailing-alert-box[\s\S]*?<div class="text-entry">([\s\S]*?)<\/div>)?/g;
    for (const r of body.matchAll(rowRe)) {
      const li = Object.fromEntries([...r[1].matchAll(/<li class="(\w+)[^"]*">([\s\S]*?)<\/li>/g)].map(m => [m[1], clean(m[2])]));
      const route = (li.from || "").match(/^([A-Z][a-z]+) - ([A-Z][a-z]+)$/);
      if (!route || !/^\d\d:\d\d$/.test(li.dept || "")) { warnings.push(`unparsed row in ${tab}: ${JSON.stringify(li).slice(0, 120)}`); continue; }
      const from = PORTS[route[1]], to = PORTS[route[2]];
      if (!from || !to) continue; // other Irish Ferries routes (France, Dover)
      const notice = r[2] ? clean(r[2]) : null;
      const n = notice ? parseNotice(notice) : {};
      const ship = SHIP_ALIASES[li.ship] || li.ship || null;
      const arr = /^\d\d:\d\d$/.test(li.arr || "") ? li.arr : null;
      const statusLabel = li.stats || "";
      let status = normaliseStatus(statusLabel);
      if (n.cancelled && status !== "cancelled") status = "cancelled";
      sailings.push({ operator: "irish", from, to, routeId: `irish-${from}-${to}`, date, dep: li.dept, arr, arrDate: arr && arr < li.dept ? addDaysISO(date, 1) : date,
        ship, statusLabel, status, notice,
        originalDep: n.originalDep && n.originalDep !== li.dept ? n.originalDep : null,
        revisedDep: n.revisedDep && n.revisedDep !== li.dept ? n.revisedDep : null,
        replacement: n.replacement || null, checkInMin: n.checkInMin ?? null, tab });
    }
  }
  return { dates, checkInNote, sailings, warnings };
}

/** Today's rows keyed by route|dep for the daily ships job (HTML or legacy flattened text). */
export function parseIrishStatus(textOrHtml, collectedOn = new Date().toISOString().slice(0, 10)) {
  if (/<ul class="sailing-listing/.test(textOrHtml)) {
    return parseIrishStatusPage(textOrHtml, collectedOn).sailings.filter(s => s.tab === "today")
      .map(s => ({ routeId: s.routeId, from: s.from, to: s.to, dep: s.dep, arr: s.arr, ship: s.ship, status: s.statusLabel }));
  }
  const flat = textOrHtml.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ");
  const STATUS = "On Time|Arrived|Departed|Delayed|Cancelled|Early Sailing|Late Sailing|Rescheduled|Scheduled|Boarding|Not Operating";
  const ROW = new RegExp(`\\b(Dublin|Holyhead|Rosslare|Pembroke) - (Dublin|Holyhead|Rosslare|Pembroke) (\\d\\d:\\d\\d) (\\d\\d:\\d\\d) ([A-Z][A-Za-z.' ]{1,30}?) (${STATUS})\\b`, "g");
  const seen = new Map();
  for (const m of flat.matchAll(ROW)) {
    const routeId = `irish-${PORTS[m[1]]}-${PORTS[m[2]]}`;
    seen.set(`${routeId}|${m[3]}`, { routeId, from: PORTS[m[1]], to: PORTS[m[2]], dep: m[3], arr: m[4], ship: SHIP_ALIASES[m[5].trim()] || m[5].trim(), status: m[6] });
  }
  return [...seen.values()];
}
