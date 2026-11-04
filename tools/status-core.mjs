// Sailing-status collector core (pure apart from the injected fetch/clock): operator pages -> status file contents.
// Used by tools/collect-status.mjs (GitHub Action, writes data/sailing-status.json) and by the Cloudflare Worker (/status,
// live on demand), so it must not touch node:fs.
// Sources: Stena Line FerryCheck route boards (today + tomorrow) and Irish Ferries sailing-updates pages (yesterday …
// day after tomorrow). Each fetch is parsed per date. A failed fetch or an empty parse never means "no sailings": the
// previous good data for that source is kept with its original timestamp and the source is marked failed.
// Pure core (`collect`) with injected fetch/clock for tests; `main` reads/writes the file.
import { parseIrishStatusPage } from "./irish-status-parse.mjs";
import { parseStenaStatusPage, STENA_ROUTES } from "./stena-status-parse.mjs";

export const STATUS_UA = "Mozilla/5.0 (compatible; cartref-borris personal trip planner; sailing status a few times an hour)";
export const KEEP_DAYS_BACK = 1;   // keep yesterday's records (overnight arrivals), drop older
export const SOURCES = [
  ...Object.entries(STENA_ROUTES).map(([id, r]) => ({ key: `stena-ferrycheck-${id}`, operator: "stena", kind: "stena", id: +id,
    url: `https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=${id}`, routeIds: [r.routeId],
    publicUrl: `https://www.stenaline.co.uk/customer-service/latest-sailing-updates/${r.from === "HHD" ? "holyhead-dublin" : r.from === "DUB" ? "dublin-holyhead" : r.from === "FGD" ? "fishguard-rosslare" : "rosslare-fishguard"}` })),
  { key: "irish-dublin-holyhead", operator: "irish", kind: "irish", url: "https://www.irishferries.com/ie-en/sailing-updates/dublin-holyhead/", routeIds: ["irish-DUB-HHD", "irish-HHD-DUB"] },
  { key: "irish-rosslare-pembroke", operator: "irish", kind: "irish", url: "https://www.irishferries.com/ie-en/sailing-updates/rosslare-pembroke/", routeIds: ["irish-RSL-PEM", "irish-PEM-RSL"] },
];

export const recordKey = (r) => `${r.routeId}|${r.date}|${r.originalDep || r.dep}`;
const localDate = (ms) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)); const g = Object.fromEntries(p.map(x => [x.type, x.value])); return `${g.year}-${g.month}-${g.day}`; };
const addDaysUTC = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);

/** Parse one source's HTML. Returns { sailings, dates (covered), checkInMin, checkInNote, warnings }. */
export function parseSource(src, html, collectedOn) {
  if (src.kind === "stena") {
    const r = parseStenaStatusPage(html, src.id);
    return { sailings: r.sailings, dates: r.dates, routeIds: r.routeId ? [r.routeId] : [], checkInMin: r.checkInMin, checkInNote: r.checkInNote, warnings: r.warnings };
  }
  const r = parseIrishStatusPage(html, collectedOn);
  return { sailings: r.sailings, dates: Object.values(r.dates), routeIds: src.routeIds, checkInMin: 30, checkInNote: r.checkInNote, warnings: r.warnings };
}

/**
 * prev: previous file contents (or null). fetchFn(url, init) -> Response. now() -> ms.
 * Returns { file, report }: file is the new data/sailing-status.json content.
 */
export async function collect({ prev = null, fetchFn = fetch, now = () => Date.now(), sources = SOURCES, timetable = null } = {}) {
  const nowIso = new Date(now()).toISOString(), today = localDate(now());
  const out = { schema: 1, collectedAt: nowIso, collectedOn: today, cadenceNote: "GitHub Actions schedule (see .github/workflows/status.yml); not a guaranteed real-time feed",
    sources: { ...(prev?.sources || {}) }, coverage: { ...(prev?.coverage || {}) }, sailings: { ...(prev?.sailings || {}) }, unscheduled: [] };
  const report = [];
  for (const src of sources) {
    const base = { url: src.url, publicUrl: src.publicUrl || src.url, operator: src.operator, routeIds: src.routeIds, attemptedAt: nowIso };
    const previous = prev?.sources?.[src.key] || {};
    try {
      const res = await fetchFn(src.url, { headers: { "User-Agent": STATUS_UA, Accept: "text/html", "Accept-Language": "en-GB" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const p = parseSource(src, html, today);
      if (!p.sailings.length) throw new Error(`parsed no sailings (${p.warnings.join("; ") || "no warnings"})`);
      // Success: this source's routes × returned dates are now authoritative. Drop its old records for those keys first.
      const covered = new Set();
      for (const rid of p.routeIds) for (const d of p.dates) covered.add(`${rid}|${d}`);
      for (const [k, r] of Object.entries(out.sailings)) if (covered.has(`${r.routeId}|${r.date}`)) delete out.sailings[k];
      for (const s of p.sailings) {
        if (!covered.has(`${s.routeId}|${s.date}`)) covered.add(`${s.routeId}|${s.date}`);
        out.sailings[recordKey(s)] = { ...s, source: src.key, fetchedAt: nowIso, operatorUpdatedAt: null, checkInMin: s.checkInMin ?? p.checkInMin ?? null };
      }
      for (const k of covered) out.coverage[k] = { source: src.key, fetchedAt: nowIso, operatorUpdatedAt: null };
      out.sources[src.key] = { ...base, ok: true, fetchedAt: nowIso, httpStatus: res.status, error: null, warnings: p.warnings, dates: p.dates, sailingsSeen: p.sailings.length, checkInMin: p.checkInMin, checkInNote: p.checkInNote, lastGoodAt: nowIso };
      report.push(`${src.key}: ok, ${p.sailings.length} sailings over ${p.dates.join(", ")}${p.warnings.length ? ` (warnings: ${p.warnings.join("; ")})` : ""}`);
    } catch (e) {
      // Failure: keep the previous records and coverage for this source untouched, with their original fetchedAt.
      out.sources[src.key] = { ...previous, ...base, ok: false, error: `${e.name === "TimeoutError" ? "timeout" : e.message}`, fetchedAt: previous.fetchedAt || null, lastGoodAt: previous.lastGoodAt || previous.fetchedAt || null };
      report.push(`${src.key}: FAILED (${out.sources[src.key].error}); kept previous data${previous.fetchedAt ? ` from ${previous.fetchedAt}` : " (none)"}`);
    }
  }
  // Drop records and coverage older than yesterday.
  const cutoff = addDaysUTC(today, -KEEP_DAYS_BACK);
  for (const [k, r] of Object.entries(out.sailings)) if (r.date < cutoff) delete out.sailings[k];
  for (const k of Object.keys(out.coverage)) if (k.split("|")[1] < cutoff) delete out.coverage[k];
  // Dated sailings our timetable pattern doesn't know (information for maintaining data/sailings.json).
  if (timetable) {
    const runsOn = (route, x, date) => {
      const dow = new Date(Date.parse(date)).getUTCDay();
      if (x.days && !x.days.includes(dow)) return false;
      const season = x.season ?? route.season; if (!season) return true;
      const md = date.slice(5);
      return season.from <= season.to ? md >= season.from && md <= season.to : md >= season.from || md <= season.to;
    };
    for (const r of Object.values(out.sailings)) {
      const route = timetable.routes.find(t => t.id === r.routeId);
      const match = route && route.sailings.find(x => x.dep === r.dep && runsOn(route, x, r.date));
      if (!match) out.unscheduled.push({ routeId: r.routeId, date: r.date, dep: r.dep, ship: r.ship, status: r.status, reason: route && route.sailings.some(x => x.dep === r.dep) ? "timetable says not on this day" : "time not in timetable" });
    }
  }
  out.complete = sources.every(s => out.sources[s.key]?.ok);
  return { file: out, report };
}

