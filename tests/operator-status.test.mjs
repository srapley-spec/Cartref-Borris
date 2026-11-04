import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIrishStatusPage, parseNotice, normaliseStatus, resolveDayMonth, parseIrishStatus } from "../tools/irish-status-parse.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const DH = fx("irish-status-dublin-holyhead-2026-11-04.html");
const RP = fx("irish-status-rosslare-pembroke-2026-11-04.html");

test("Irish Ferries page: four dated tabs, one record per sailing per date, no warnings", () => {
  const r = parseIrishStatusPage(DH, "2026-11-04");
  assert.deepEqual(r.dates, { yesterday: "2026-11-03", today: "2026-11-04", tomorrow: "2026-11-05", dayaftertomorrow: "2026-11-06" });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.sailings.length, 32); // 4 dates × 2 directions × 4 sailings
  assert.equal(r.checkInNote, "All sailings are shown in local times. Latest check in 30 minutes before departure");
  assert.ok(r.sailings.every(s => s.checkInMin === 30));
});

test("Identical departure times on different dates keep their own status (Arrived / Departed / Early Sailing)", () => {
  const r = parseIrishStatusPage(DH, "2026-11-04").sailings.filter(s => s.routeId === "irish-DUB-HHD" && s.dep === "07:30");
  assert.deepEqual(r.map(s => [s.date, s.status, s.statusLabel]), [
    ["2026-11-03", "arrived", "Arrived"], ["2026-11-04", "departed", "Departed"], ["2026-11-05", "early", "Early Sailing"], ["2026-11-06", "early", "Early Sailing"]]);
});

test("Early sailings: displayed time is the revised one; the notice gives the original, which is kept, verbatim notice too", () => {
  const s = parseIrishStatusPage(DH, "2026-11-04").sailings.find(x => x.routeId === "irish-HHD-DUB" && x.date === "2026-11-05" && x.dep === "01:30");
  assert.equal(s.originalDep, "02:40"); assert.equal(s.revisedDep, null); assert.equal(s.ship, "Ulysses"); assert.equal(s.arr, "05:00");
  assert.match(s.notice, /^We wish to advise that for operational reasons your 05\/11\/2026 02:40 Holyhead to Dublin Ulysses sailing will depart at earlier time of 01:30\./);
});

test("Overnight arrival rolls the arrival date; the Thursday 02:45 Pembroke sailing is listed although our weekday pattern omitted it", () => {
  const r = parseIrishStatusPage(RP, "2026-11-04").sailings;
  const night = r.find(s => s.routeId === "irish-RSL-PEM" && s.date === "2026-11-05" && s.dep === "20:45");
  assert.equal(night.arr, "00:46"); assert.equal(night.arrDate, "2026-11-06");
  const thu = r.find(s => s.routeId === "irish-PEM-RSL" && s.date === "2026-11-05" && s.dep === "02:45");
  assert.ok(thu, "Thu 5 Nov 02:45 Pembroke → Rosslare is on the operator's page");
  assert.equal(thu.ship, "Isle of Innisfree"); // page abbreviates to "Innisfree"
});

test("A sailing moved onto the other operator: 'On Time' label kept, replacement port/operator and revised time from the notice", () => {
  const s = parseIrishStatusPage(RP, "2026-11-04").sailings.find(x => x.routeId === "irish-RSL-PEM" && x.date === "2026-11-04" && x.dep === "08:45");
  assert.equal(s.statusLabel, "On Time"); assert.equal(s.status, "on-time");
  assert.deepEqual(s.replacement, { operator: "stena", port: "Fishguard" });
  assert.equal(s.revisedDep, "08:15"); assert.equal(s.checkInMin, 60);
  assert.match(s.notice, /will now be on the StenaLine sailing to Fishguard/);
});

test("notice parsing and status normalisation edge cases", () => {
  assert.deepEqual(parseNotice("Your 12/12/2026 22:30 sailing is cancelled due to adverse weather."), { originalDate: "2026-12-12", originalDep: "22:30", cancelled: true });
  assert.equal(parseNotice("will depart at later time of 16:40. Check-in is 1 hour before departure.").revisedDep, "16:40");
  assert.equal(parseNotice("Please check in 1 hour before departure.").checkInMin, 60);
  for (const [l, v] of [["Cancelled", "cancelled"], ["Sailing Cancelled", "cancelled"], ["On Time", "on-time"], ["Delayed", "delayed"], ["Late Sailing", "delayed"], ["Early Sailing", "early"], ["Boarding", "boarding"], ["Weather Watch", "other"]]) assert.equal(normaliseStatus(l), v, l);
  assert.equal(resolveDayMonth("2", "Jan", "2026-12-30"), "2027-01-02");
  assert.equal(resolveDayMonth("30", "Dec", "2027-01-02"), "2026-12-30");
});

test("A page with no recognisable rows yields no sailings (never 'no sailings' silently: warnings explain)", () => {
  const r = parseIrishStatusPage("<html><body><div class='sailing-updates__desktop'><p>Service unavailable</p></div></body></html>", "2026-11-04");
  assert.equal(r.sailings.length, 0);
  assert.ok(r.warnings.some(w => /date strip not found/.test(w)));
});

test("legacy today-only view still works from the HTML (daily ships job)", () => {
  const rows = parseIrishStatus(RP, "2026-11-04");
  assert.deepEqual(rows.map(r => `${r.routeId}|${r.dep}`), ["irish-RSL-PEM|08:45", "irish-RSL-PEM|20:45", "irish-PEM-RSL|02:45", "irish-PEM-RSL|14:45"]);
  assert.equal(rows[0].ship, "Isle of Innisfree");
});
