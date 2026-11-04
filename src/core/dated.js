// Pure: dated operator records (data/sailing-status.json) -> planner sailings and status views. No clock reads.
//
// Record (one per operator sailing per date, written by tools/collect-status.mjs):
//   { operator, routeId, from, to, date, dep, arr, arrDate, originalDep, revisedDep, estimatedDep, estimatedArr, ship,
//     statusLabel, status, notice, replacement: { operator, port } | null, checkInMin, source, fetchedAt, operatorUpdatedAt }
//   dep/arr are the operator's displayed (current scheduled) times. estimatedDep/Arr only when the operator states an
//   estimate. status: on-time | early | delayed | cancelled | departed | arrived | boarding | other.
// Coverage: dated.coverage["routeId|date"] = { fetchedAt, operatorUpdatedAt, source } means the operator's list for
//   that route and date was retrieved in full: within coverage, the dated records ARE the sailings for that date.
import { dayStart, hhmm, addDays } from "./plan.js";

export const DELAY_MINOR_MAX_MIN = 59;      // Sam, 4 Nov: delayed under an hour yellow, an hour or more amber
export const STATUS_STALE_MIN = 120;        // operator status older than this is shown as unavailable, not as current

export const PORT_COUNTRY = { HHD: "UK", FGD: "UK", PEM: "UK", DUB: "IE", RSL: "IE" };
const PORT_BY_NAME = { Holyhead: "HHD", Dublin: "DUB", Fishguard: "FGD", Rosslare: "RSL", Pembroke: "PEM" };

function minutesAt(date, time) { return dayStart(date) + hhmm(time); }
function dur(depDate, dep, arrDate, arr) { return minutesAt(arrDate || depDate, arr) - minutesAt(depDate, dep); }

/** Explicit delay in minutes (estimated − scheduled departure), or null when the operator gives no estimate. */
export function delayMinutes(rec) {
  if (!rec || !rec.estimatedDep) return null;
  let d = hhmm(rec.estimatedDep) - hhmm(rec.dep);
  if (d < -12 * 60) d += 24 * 60; // estimate after midnight for a late-evening sailing
  return d;
}

/** Effective ports, times and check-in for a record, honouring an explicit replacement sailing (e.g. Irish Ferries
 *  "will now be on the StenaLine sailing to Fishguard … at the earlier departure time of 08:15"). */
export function effectiveSailing(data, rec, dated) {
  let from = rec.from, to = rec.to, dep = rec.dep, arr = rec.arr, arrDate = rec.arrDate || rec.date, arrSource = arr ? "operator" : null;
  let onOperator = rec.operator, note = null, hostShip = null;
  if (rec.replacement) {
    const port = PORT_BY_NAME[rec.replacement.port];
    if (port && PORT_COUNTRY[port] === "UK") from = PORT_COUNTRY[rec.from] === "UK" ? port : from, to = PORT_COUNTRY[rec.to] === "UK" ? port : to;
    if (port && PORT_COUNTRY[port] === "IE") from = PORT_COUNTRY[rec.from] === "IE" ? port : from, to = PORT_COUNTRY[rec.to] === "IE" ? port : to;
    onOperator = rec.replacement.operator;
    if (rec.revisedDep) dep = rec.revisedDep;
    // Arrival: the replacement operator's own dated record if we hold it, else that route's timetable duration, else assume the original duration.
    const host = dated?.sailings?.[`${onOperator}-${from}-${to}|${rec.date}|${dep}`];
    const hostRoute = data.routes.find(r => r.operator === onOperator && r.from === from && r.to === to);
    const pattern = hostRoute?.sailings.find(s => s.dep === dep);
    if (host) hostShip = host.ship || null;
    if (host && host.arr) { arr = host.arr; arrDate = host.arrDate || rec.date; arrSource = "operator"; }
    else if (pattern) { const m = minutesAt(rec.date, dep) + pattern.durMin; arrDate = addDays(rec.date, Math.floor((hhmm(dep) + pattern.durMin) / 1440)); arr = fmtTime(m); arrSource = "timetable"; }
    else if (rec.arr) { const d = dur(rec.date, rec.dep, rec.arrDate, rec.arr); const m = minutesAt(rec.date, dep) + d; arrDate = addDays(rec.date, Math.floor((hhmm(dep) + d) / 1440)); arr = fmtTime(m); arrSource = "assumed"; }
    const hostName = data.operators[onOperator]?.name || onOperator;
    note = `${data.operators[rec.operator]?.name || rec.operator} ticket; sails on ${hostName} from ${data.ports[from]?.name || from} at ${dep} (operator notice)`;
  }
  const checkInMin = rec.checkInMin ?? data.routes.find(r => r.id === rec.routeId)?.checkInMin ?? 60;
  return { from, to, dep, arr, arrDate, arrSource, onOperator, checkInMin, note, moved: !!rec.replacement, hostShip };
}
function fmtTime(min) { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

/** Planner sailings for route+date from dated records, or null when that route/date is not covered. */
export function datedSailingsFor(data, dated, route, date) {
  if (!dated || !dated.coverage || !dated.coverage[`${route.id}|${date}`]) return null;
  const out = [];
  for (const rec of Object.values(dated.sailings || {})) {
    if (rec.routeId !== route.id || rec.date !== date) continue;
    const eff = effectiveSailing(data, rec, dated);
    if (!eff.arr) continue; // no arrival time at all: cannot plan a journey on it (kept out rather than invented)
    const depMin = minutesAt(date, eff.dep), arrMin = minutesAt(eff.arrDate, eff.arr);
    const estDep = rec.estimatedDep ? minutesAt(date, rec.estimatedDep) + (hhmm(rec.estimatedDep) < hhmm(rec.dep) - 720 ? 1440 : 0) : null;
    const estArr = rec.estimatedArr ? minutesAt(eff.arrDate, rec.estimatedArr) : estDep != null ? estDep + (arrMin - depMin) : null;
    out.push({
      id: `${route.id}|${date}|${rec.dep}`, route, date,
      sailing: { dep: rec.dep, durMin: arrMin - depMin, vessel: eff.hostShip || rec.ship || null },
      vessel: eff.hostShip || rec.ship || null, // a moved sailing is on the host operator's ship when we hold its record
      dep: depMin, arr: arrMin, durMin: arrMin - depMin,
      estDep, estArr,
      fromKey: eff.from, toKey: eff.to, checkInMin: eff.checkInMin, onOperator: eff.onOperator,
      arrSource: eff.arrSource, moved: eff.moved, movedNote: eff.note,
      cancelled: rec.status === "cancelled",
      record: rec, source: "operator",
    });
  }
  return out.sort((a, b) => a.dep - b.dep);
}

/**
 * Status for display. rec may be null (timetable estimate). Returns
 * { kind, level: "ok"|"caution"|"warn"|"bad"|"none", label, detail, expected, stale }.
 * level is the status colour (green/yellow/amber/red); "none" is neutral grey.
 */
export function statusView(rec, { nowMin = null, staleAfterMin = STATUS_STALE_MIN, fetchedAtMin = null } = {}) {
  if (!rec) return { kind: "estimate", level: "none", label: "Timetable estimate", detail: "No operator status for this date", expected: "Not live", stale: false };
  const stale = nowMin != null && fetchedAtMin != null && nowMin - fetchedAtMin > staleAfterMin;
  const delay = delayMinutes(rec);
  const base = { stale, expected: rec.estimatedDep || null };
  const moved = rec.replacement ? ` · moved to ${rec.replacement.operator === "stena" ? "Stena Line" : "Irish Ferries"} from ${rec.replacement.port}${rec.revisedDep ? ` ${rec.revisedDep}` : ""}` : "";
  let v;
  switch (rec.status) {
    case "cancelled": v = { kind: "cancelled", level: "bad", label: "Cancelled", detail: rec.notice || rec.statusLabel, expected: "Cancelled" }; break;
    case "delayed":
      if (delay == null) v = { kind: "delayed-unknown", level: "warn", label: "Delayed, no estimate", detail: rec.notice || rec.statusLabel, expected: "No estimate" };
      else if (delay <= DELAY_MINOR_MAX_MIN) v = { kind: "delayed-minor", level: "caution", label: `Delayed ${delay} min`, detail: rec.notice || `Expected ${rec.estimatedDep}`, expected: rec.estimatedDep };
      else v = { kind: "delayed-major", level: "warn", label: `Delayed ${Math.floor(delay / 60)}h ${String(delay % 60).padStart(2, "0")}m`, detail: rec.notice || `Expected ${rec.estimatedDep}`, expected: rec.estimatedDep };
      break;
    case "early": v = { kind: "early", level: "ok", label: rec.originalDep ? `Early sailing · was ${rec.originalDep}` : "Early sailing", detail: rec.notice || rec.statusLabel, expected: "On time" }; break;
    case "on-time": v = { kind: "on-time", level: "ok", label: "On time", detail: rec.notice || "Operator reports on time", expected: "On time" }; break;
    case "boarding": v = { kind: "boarding", level: "ok", label: "Boarding", detail: rec.notice || rec.statusLabel, expected: "Boarding" }; break;
    case "departed": v = { kind: "departed", level: "none", label: "Departed", detail: rec.notice || rec.statusLabel, expected: "Departed" }; break;
    case "arrived": v = { kind: "arrived", level: "none", label: "Arrived", detail: rec.notice || rec.statusLabel, expected: "Arrived" }; break;
    default: v = { kind: "other", level: "none", label: rec.statusLabel || "Status", detail: rec.notice || "", expected: rec.statusLabel || "—" };
  }
  if (rec.replacement && v.level !== "bad") v = { ...v, kind: "moved", level: v.level === "warn" ? "warn" : "caution", label: `${v.label}${moved}`.replace(/^On time · /, "") };
  if (stale) v = { ...v, level: "none", label: `Status unavailable · last ${v.label.toLowerCase()}`, expected: "Status unavailable" };
  return { ...base, ...v, stale };
}
