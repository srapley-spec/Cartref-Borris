// Pure parser for Stena Line's FerryCheck route pages (https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=N),
// the board embedded in stenaline.co.uk/customer-service/latest-sailing-updates/<route>. One record per sailing per date.
// Structure (4 Nov 2026): page-title "24HR SAILING UPDATES FOR HOLYHEAD - DUBLIN"; date tabs <li data-day="YYYYMMDD">;
// per date, rows of <div name="vessel-YYYYMMDD-i"> … "departure-…" "arrival-…" "status-…" (icon class status-icons-N and
// a text label) and a "remark-…" div (free text; the last one carries the route's check-in rules). "Last updated" is
// filled in by script, so the operator's own timestamp is not available from the HTML.
import { normaliseStatus } from "./irish-status-parse.mjs";

export const STENA_ROUTES = {
  6: { routeId: "stena-HHD-DUB", from: "HHD", to: "DUB" }, 5: { routeId: "stena-DUB-HHD", from: "DUB", to: "HHD" },
  8: { routeId: "stena-FGD-RSL", from: "FGD", to: "RSL" }, 7: { routeId: "stena-RSL-FGD", from: "RSL", to: "FGD" },
};
const PORTS = { HOLYHEAD: "HHD", DUBLIN: "DUB", FISHGUARD: "FGD", ROSSLARE: "RSL", PEMBROKE: "PEM" };
const clean = (s) => s.replace(/&#x?[0-9A-Fa-f]+;/g, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const isoDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
function addDaysISO(iso, n) { return new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10); }

/** Vehicle check-in minutes from the route remark ("Vehicles: … no later than 30 minutes before …"), else null. */
export function parseCheckIn(remark) {
  const m = remark.match(/Vehicles?:[^.]*?(\d+)\s*minutes/i) || remark.match(/(\d+)\s*minutes before/i);
  return m ? +m[1] : null;
}

/** html, routeIdHint (from the URL's id) -> { routeId, from, to, dates: [YYYY-MM-DD], checkInMin, checkInNote, sailings, warnings } */
export function parseStenaStatusPage(html, routeIdHint = null) {
  const warnings = [];
  const title = clean((html.match(/page-title">([\s\S]*?)<\/h1>/) || [, ""])[1]);
  const tm = title.toUpperCase().match(/FOR ([A-Z]+) - ([A-Z]+)/);
  let from = tm && PORTS[tm[1]], to = tm && PORTS[tm[2]];
  const hinted = routeIdHint && STENA_ROUTES[routeIdHint];
  if (hinted && (!from || !to)) { from = hinted.from; to = hinted.to; }
  if (hinted && from && to && (from !== hinted.from || to !== hinted.to)) warnings.push(`page title says ${from}-${to} but id ${routeIdHint} is ${hinted.from}-${hinted.to}; using the title`);
  if (!from || !to) return { routeId: null, from, to, dates: [], checkInMin: null, checkInNote: null, sailings: [], warnings: [...warnings, "route not recognised from page title"] };
  const routeId = `stena-${from}-${to}`;
  const dates = [...new Set([...html.matchAll(/data-day="(\d{8})"/g)].map(m => isoDay(m[1])))];
  if (!dates.length) warnings.push("no date tabs found");
  // The check-in remark appears once per date pane (last remark); take the first non-empty one.
  const remarks = [...html.matchAll(/name="remark-(\d{8})-(\d+)"[^>]*>([\s\S]*?)<\/div>/g)].map(m => ({ day: isoDay(m[1]), i: +m[2], text: clean(m[3]) }));
  // Check-in rules live in a "customerNotes" section under the board (older pages put them in the last remark).
  const notes = clean((html.match(/class="row customerNotes"[\s\S]*?(?=<div class="row|<\/body>|$)/) || [, ""])[0] || "");
  const ciText = /check-?in/i.test(notes) ? notes : (remarks.find(r => /check-?in/i.test(r.text))?.text || null);
  const ciRemark = ciText ? { text: ciText } : null;
  const checkInMin = ciText ? parseCheckIn(ciText) : null;
  const sailings = [];
  for (const m of html.matchAll(/name="vessel-(\d{8})-(\d+)"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*name="departure-\1-\2"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*name="arrival-\1-\2"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*name="status-\1-\2"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*name="moreinfo-\1-\2"[^>]*>([\s\S]*?)<\/div>/g)) {
    const date = isoDay(m[1]), i = +m[2];
    const ship = clean(m[3]).replace(/^Vessel:\s*/i, "") || null;
    const dep = (clean(m[4]).match(/\d\d:\d\d/) || [])[0];
    const arr = (clean(m[5]).match(/\d\d:\d\d/) || [])[0] || null;
    const statusHtml = m[6];
    const iconCode = (statusHtml.match(/status-icons-(\d+)/) || [])[1] || null;
    const statusLabel = clean(statusHtml).replace(/^Status:\s*/i, "").trim();
    const more = clean(m[7]);
    const remark = remarks.find(r => r.day === date && r.i === i && !/check-?in/i.test(r.text))?.text || null;
    if (!dep) { warnings.push(`row ${date}-${i} has no departure time`); continue; }
    const text = [statusLabel, more, remark].filter(Boolean).join(" ");
    const est = text.match(/(?:expected|estimated|revised|new)[^0-9]{0,40}(\d\d:\d\d)/i);
    let status = normaliseStatus(statusLabel);
    if (status === "other" && /cancel/i.test(text)) status = "cancelled";
    sailings.push({ operator: "stena", from, to, routeId, date, dep, arr, arrDate: arr && arr < dep ? addDaysISO(date, 1) : date,
      ship, statusLabel, statusCode: iconCode, status, notice: [more, remark].filter(Boolean).join(" ") || null,
      originalDep: null, revisedDep: null, estimatedDep: status === "delayed" && est ? est[1] : null,
      replacement: null, checkInMin });
  }
  if (!sailings.length) warnings.push("no sailing rows parsed");
  return { routeId, from, to, dates, checkInMin, checkInNote: ciRemark ? ciRemark.text : null, sailings, warnings };
}
