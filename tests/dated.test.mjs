// Dated operator records driving the planner: coverage, revised times, cancellations, delays, moved sailings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { options, answer, sailingsOn, rankByTime, rankByCost, makeDrive, dayStart, fmt } from "../src/core/plan.js";
import { datedSailingsFor, effectiveSailing, statusView, delayMinutes, DELAY_MINOR_MAX_MIN, STATUS_STALE_MIN } from "../src/core/dated.js";

const data = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url)));
const settings = { marginMin: 15, disembarkMin: 20, stops: 0, stopMin: 0, fastFerry: false };
const est = makeDrive(data, null);
const T = (date, hm) => dayStart(date) + (+hm.slice(0, 2)) * 60 + +hm.slice(3);
const rec = (routeId, date, dep, arr, extra = {}) => {
  const [op, from, to] = routeId.split("-");
  return { operator: op, routeId, from, to, date, dep, arr, arrDate: arr < dep ? fmt(dayStart(date) + 1440).date : date, originalDep: null, revisedDep: null,
    estimatedDep: null, estimatedArr: null, ship: "Test Ship", statusLabel: "On Time", status: "on-time", notice: null, replacement: null, checkInMin: null,
    source: "test", fetchedAt: "2026-11-04T10:00:00Z", operatorUpdatedAt: null, ...extra };
};
const dated = (records, coverage) => ({
  coverage: Object.fromEntries(coverage.map(k => [k, { fetchedAt: "2026-11-04T10:00:00Z", source: "test" }])),
  sailings: Object.fromEntries(records.map(r => [`${r.routeId}|${r.date}|${r.originalDep || r.dep}`, r])),
});

test("within coverage the operator's dated list replaces the pattern: Thursday 02:45 Pembroke runs; outside coverage the pattern stays", () => {
  const thu = "2026-11-05"; // our pattern says no 02:45 on Thursdays
  assert.ok(!sailingsOn(data, "out", [thu]).some(s => s.id === "irish-PEM-RSL|2026-11-05|02:45"));
  const d = dated([rec("irish-PEM-RSL", thu, "02:45", "06:46", { ship: "Isle of Innisfree" }), rec("irish-PEM-RSL", thu, "14:45", "18:46")], [`irish-PEM-RSL|${thu}`]);
  const on = sailingsOn(data, "out", [thu], settings, null, d);
  const pem = on.filter(s => s.route.id === "irish-PEM-RSL");
  assert.deepEqual(pem.map(s => [s.id, s.source, s.vessel]), [["irish-PEM-RSL|2026-11-05|02:45", "operator", "Isle of Innisfree"], ["irish-PEM-RSL|2026-11-05|14:45", "operator", "Test Ship"]]);
  assert.ok(on.filter(s => s.route.id === "stena-FGD-RSL").every(s => s.source === "timetable"), "uncovered routes keep the timetable");
  // A covered date with a sailing missing from the operator's list: that sailing is not offered.
  const d2 = dated([rec("irish-HHD-DUB", thu, "07:30", "11:00")], [`irish-HHD-DUB|${thu}`]);
  assert.deepEqual(sailingsOn(data, "out", [thu], settings, null, d2).filter(s => s.route.id === "irish-HHD-DUB").map(s => s.sailing.dep), ["07:30"]);
  assert.equal(datedSailingsFor(data, d2, data.routes.find(r => r.id === "irish-HHD-DUB"), "2026-11-06"), null, "not covered");
});

test("identical departure times on different dates carry their own status and are separate options", () => {
  const d = dated([rec("irish-HHD-DUB", "2026-11-05", "07:30", "11:00", { status: "on-time" }), rec("irish-HHD-DUB", "2026-11-06", "07:30", "11:00", { status: "cancelled", statusLabel: "Cancelled" })],
    ["irish-HHD-DUB|2026-11-05", "irish-HHD-DUB|2026-11-06"]);
  const a = options(data, { dir: "out", dates: ["2026-11-05", "2026-11-06"], drive: est, dated: d, settings }).filter(o => /^irish-HHD-DUB\|2026-11-0[56]\|07:30$/.test(o.id));
  assert.deepEqual(a.map(o => [o.id, o.cancelled]), [["irish-HHD-DUB|2026-11-05|07:30", false], ["irish-HHD-DUB|2026-11-06|07:30", true]]);
});

test("cancelled: visible, flagged, ranked last by every ordering, never the recommendation", () => {
  const d = dated([rec("irish-HHD-DUB", "2026-11-20", "07:30", "11:00", { status: "cancelled", statusLabel: "Cancelled", notice: "Cancelled due to adverse weather." }),
    rec("irish-HHD-DUB", "2026-11-20", "13:15", "16:45")], ["irish-HHD-DUB|2026-11-20"]);
  const a = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", drive: est, dated: d, settings });
  const c = a.list.find(o => o.id === "irish-HHD-DUB|2026-11-20|07:30");
  assert.ok(c && c.unavailable && c.flags.includes("cancelled by the operator"));
  assert.equal(a.list.at(-1).id, c.id); assert.notEqual(a.best.id, c.id); assert.notEqual(a.next?.id, c.id);
  assert.equal(rankByCost(a.list).at(-1).id, c.id); assert.equal(rankByTime(a.list).at(-1).id, c.id);
  const now = answer(data, { question: "now", dir: "out", nowMin: T("2026-11-20", "00:30"), drive: est, dated: d, settings });
  assert.ok(now.list.some(o => o.id === c.id) && now.best.id !== c.id);
});

test("delay with an estimate moves the arrival home, not the check-in deadline; scheduled arrival is kept", () => {
  const base = rec("irish-PEM-RSL", "2026-11-20", "14:45", "18:46");
  const late = { ...base, status: "delayed", statusLabel: "Delayed", estimatedDep: "16:15" };
  const pick = (d) => options(data, { dir: "out", date: "2026-11-20", drive: est, dated: d, settings }).find(o => o.id === "irish-PEM-RSL|2026-11-20|14:45");
  const o0 = pick(dated([base], ["irish-PEM-RSL|2026-11-20"])), o1 = pick(dated([late], ["irish-PEM-RSL|2026-11-20"]));
  assert.equal(o1.atPortBy, o0.atPortBy); assert.equal(o1.leave, o0.leave);
  assert.equal(o1.arrive - o0.arrive, 90); assert.equal(o1.scheduledArrive, o0.arrive);
  assert.equal(delayMinutes(late), 90);
  const v = statusView(late); assert.equal(v.kind, "delayed-major"); assert.equal(v.level, "warn"); assert.equal(v.expected, "16:15");
  const minor = statusView({ ...base, status: "delayed", estimatedDep: "15:30" }); assert.equal(minor.kind, "delayed-minor"); assert.equal(minor.level, "caution"); assert.equal(minor.label, "Delayed 45 min");
  const none = statusView({ ...base, status: "delayed" }); assert.equal(none.level, "warn"); assert.equal(none.expected, "No estimate");
  assert.equal(DELAY_MINOR_MAX_MIN, 59);
});

test("a sailing moved onto the other operator: port, time, check-in and crossing come from the replacement; the note is kept", () => {
  const moved = rec("irish-PEM-RSL", "2026-11-20", "14:45", "18:46", { replacement: { operator: "stena", port: "Fishguard" }, revisedDep: "14:00", checkInMin: 60,
    notice: "We wish to advise that your sailing on 20/11/2026 14:45 will now be on the StenaLine sailing from Fishguard … at the earlier departure time of 14:00. Please check in 1 hour before departure." });
  const eff = effectiveSailing(data, moved, null);
  assert.deepEqual([eff.from, eff.to, eff.dep, eff.arr, eff.arrSource, eff.checkInMin, eff.onOperator], ["FGD", "RSL", "14:00", "17:30", "timetable", 60, "stena"]);
  // With Stena's own dated record for that sailing, its arrival wins.
  const withHost = dated([moved, rec("stena-FGD-RSL", "2026-11-20", "14:00", "17:40", { ship: "Stena Nordica" })], ["irish-PEM-RSL|2026-11-20", "stena-FGD-RSL|2026-11-20"]);
  assert.equal(effectiveSailing(data, moved, withHost).arr, "17:40");
  const hosted = datedSailingsFor(data, withHost, data.routes.find(r => r.id === "irish-PEM-RSL"), "2026-11-20")[0];
  assert.equal(hosted.vessel, "Stena Nordica"); // the host record's ship, not the Irish Ferries ship named on the ticket
  const [o] = options(data, { dir: "out", date: "2026-11-20", drive: est, dated: dated([moved], ["irish-PEM-RSL|2026-11-20"]), settings }).filter(x => x.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(o.fromPort, "Fishguard"); assert.equal(fmt(o.dep).time, "14:00"); assert.equal(o.atPortBy, T("2026-11-20", "12:45")); // 14:00 − 60 − 15
  assert.equal(o.driveTo.min, data.driveEstimatesMin["home>FGD"]);
  assert.ok(o.moved && o.flags.some(f => /sails on Stena Line from Fishguard at 14:00/.test(f)));
  const v = statusView(moved); assert.equal(v.kind, "moved"); assert.equal(v.level, "caution"); assert.match(v.label, /moved to Stena Line from Fishguard 14:00/);
});

test("status views: on time green; early green with original time; departed/arrived neutral; stale status is 'unavailable'; no record is a timetable estimate", () => {
  const r = rec("stena-HHD-DUB", "2026-11-04", "10:00", "13:30");
  assert.deepEqual([statusView(r).level, statusView(r).label, statusView(r).expected], ["ok", "On time", "On time"]);
  const e = statusView({ ...r, status: "early", statusLabel: "Early Sailing", originalDep: "10:45" }); assert.equal(e.level, "ok"); assert.equal(e.label, "Early sailing · was 10:45");
  assert.equal(statusView({ ...r, status: "departed", statusLabel: "Departed" }).level, "none");
  const stale = statusView(r, { nowMin: 1000 + STATUS_STALE_MIN + 1, fetchedAtMin: 1000 });
  assert.equal(stale.stale, true); assert.equal(stale.level, "none"); assert.match(stale.label, /^Status unavailable/); assert.equal(stale.expected, "Status unavailable");
  assert.equal(statusView(r, { nowMin: 1000 + STATUS_STALE_MIN, fetchedAtMin: 1000 }).stale, false);
  const none = statusView(null); assert.equal(none.kind, "estimate"); assert.equal(none.expected, "Not live"); assert.equal(none.level, "none");
  assert.equal(statusView({ ...r, status: "cancelled", statusLabel: "Cancelled" }).level, "bad");
});

test("a rescheduled sailing is one record, keyed by its original time: no duplicate option", () => {
  const r = rec("irish-DUB-HHD", "2026-11-05", "01:15", "04:45", { originalDep: "02:00", status: "early", statusLabel: "Early Sailing" });
  const d = dated([r], ["irish-DUB-HHD|2026-11-05"]);
  assert.deepEqual(Object.keys(d.sailings), ["irish-DUB-HHD|2026-11-05|02:00"]);
  // A 01:15 sailing on the 5th means leaving Borris on the evening of the 4th.
  const a = options(data, { dir: "back", date: "2026-11-04", drive: est, dated: d, settings }).filter(o => o.id.startsWith("irish-DUB-HHD|2026-11-05"));
  assert.deepEqual(a.map(o => o.id), ["irish-DUB-HHD|2026-11-05|01:15"]); // option id uses the time it actually sails (and is sold) at
});
