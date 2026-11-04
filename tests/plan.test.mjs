import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { options, byPreference, rankByTime, rankByCost, summary, makeDrive, isOvernight, dayStart, fmt, sailingsOn } from "../src/core/plan.js";

const data = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url)));
const settings = { marginMin: 15, disembarkMin: 20 };
const est = makeDrive(data, null);
const T = (date, hm) => dayStart(date) + (+hm.slice(0, 2)) * 60 + +hm.slice(3);

test("door-to-door timing: leave = dep − check-in − margin − drive; arrive = arr + disembark + drive", () => {
  // Fri 20 Nov 2026, Irish Ferries Pembroke 14:45 → Rosslare (241 min), check-in 30.
  const o = options(data, { dir: "out", date: "2026-11-20", drive: est, settings }).find(x => x.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(o.atPortBy, T("2026-11-20", "14:00"));
  assert.equal(o.leave, T("2026-11-20", "09:05"));       // 14:00 − 295
  assert.equal(o.arr, T("2026-11-20", "18:46"));
  assert.equal(o.arrive, T("2026-11-20", "20:26"));      // 18:46 + 20 + 80
  assert.equal(o.totalMin, 11 * 60 + 21);
  assert.equal(o.overnight, false);
  assert.deepEqual(o.flags, ["drive time estimated", "no price yet"]); // times checked with Irish Ferries
  assert.equal(o.verifiedBy, "operator"); assert.equal(o.typicalFare.amount, 171);
});

test("leaving date means leaving the house: an early-hours sailing next day belongs to the evening before", () => {
  const fri = options(data, { dir: "out", date: "2026-11-20", drive: est, settings }).map(o => o.id);
  assert.ok(fri.includes("irish-PEM-RSL|2026-11-21|02:45"), "Sat 02:45 sailing is a Friday-evening departure");
  assert.ok(!fri.includes("irish-PEM-RSL|2026-11-20|02:45"), "Fri 02:45 would mean leaving Thursday");
  const thu = options(data, { dir: "out", date: "2026-11-19", drive: est, settings }).map(o => o.id);
  assert.ok(thu.includes("irish-PEM-RSL|2026-11-20|02:45"));
});

test("day-of-week patterns are respected (Pembroke 02:45 does not run Mon or Thu)", () => {
  const mon = sailingsOn(data, "out", ["2026-11-23"]).map(s => s.id); // Monday
  assert.ok(!mon.includes("irish-PEM-RSL|2026-11-23|02:45"));
  assert.ok(mon.includes("irish-PEM-RSL|2026-11-23|14:45"));
  const sun = sailingsOn(data, "back", ["2026-11-22"]).map(s => s.id); // Sunday: no 20:45 Rosslare
  assert.ok(!sun.includes("irish-RSL-PEM|2026-11-22|20:45"));
});

test("direction: out uses only UK→Ireland, back only Ireland→UK", () => {
  for (const s of sailingsOn(data, "out", ["2026-11-20"])) assert.equal(data.ports[s.route.from].country, "UK");
  for (const s of sailingsOn(data, "back", ["2026-11-20"])) assert.equal(data.ports[s.route.from].country, "IE");
});

test("overnight interval check: touching 00:00–05:00, boundaries exact", () => {
  assert.equal(isOvernight(T("2026-11-20", "19:30"), T("2026-11-20", "23:00")), false);
  assert.equal(isOvernight(T("2026-11-20", "20:45"), T("2026-11-21", "00:46")), true);
  assert.equal(isOvernight(T("2026-11-20", "05:00"), T("2026-11-20", "08:30")), false);
  assert.equal(isOvernight(T("2026-11-20", "04:59"), T("2026-11-20", "08:30")), true);
  assert.equal(isOvernight(T("2026-11-20", "21:00"), T("2026-11-21", "00:00")), false);
  assert.equal(isOvernight(T("2026-11-20", "21:00"), T("2026-11-21", "00:01")), true);
});

test("overnight is judged door to door, not by the crossing alone", () => {
  const all = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const early = all.find(o => o.id === "irish-HHD-DUB|2026-11-20|07:30"); // leave home ~02:00 for a daytime crossing
  assert.equal(fmt(early.leave).time, "02:00");
  assert.equal(early.overnightCrossing, false);
  assert.equal(early.overnight, true);
  const late = all.find(o => o.id === "irish-HHD-DUB|2026-11-20|19:30"); // crossing ends 23:00, arrive Borris 00:40
  assert.equal(late.overnightCrossing, false);
  assert.equal(late.overnight, true);
  const day = all.find(o => o.id === "irish-PEM-RSL|2026-11-20|14:45"); // 09:05 → 20:26
  assert.equal(day.overnight, false);
});

test("preference filters only on explicit choice; Either keeps everything", () => {
  const all = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const day = byPreference(all, "day"), night = byPreference(all, "overnight");
  assert.ok(day.length > 0 && night.length > 0);
  assert.equal(day.length + night.length, all.length);
  assert.equal(byPreference(all, "any").length, all.length);
  assert.ok(day.every(o => !o.overnight) && night.every(o => o.overnight));
});

test("rank by time: shortest door to door first", () => {
  const r = rankByTime(options(data, { dir: "out", date: "2026-11-20", drive: est, settings }));
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].totalMin <= r[i].totalMin);
});

test("rank by cost: real prices first (cheapest), then typical prices (cheapest), then unpriced by time; none dropped", () => {
  const typ = { "PEM-RSL": 150, "HHD-DUB": 170 };
  const typical = (rk) => (typ[rk] ? { amount: typ[rk], basis: "test" } : null);
  const noStatic = { ...data, routes: data.routes.map(r => ({ ...r, typicalFare: undefined })) };
  const all = options(noStatic, { dir: "out", date: "2026-11-20", drive: est, settings });
  const hhd = all.find(o => o.id.startsWith("irish-HHD-DUB")), fgd = all.find(o => o.id.startsWith("stena-FGD-RSL"));
  const fares = { [hhd.id]: { amount: 210 }, [fgd.id]: { amount: 140 } };
  const r = rankByCost(options(noStatic, { dir: "out", date: "2026-11-20", drive: est, fares, typical, settings }));
  assert.equal(r.length, all.length);
  assert.deepEqual(r.slice(0, 2).map(o => o.id), [fgd.id, hhd.id]);           // tier 1: real prices
  const tiers = r.map(o => (o.fare ? 0 : o.typicalFare ? 1 : 2));
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i - 1] <= tiers[i]);
  const t1 = r.filter(o => !o.fare && o.typicalFare);
  assert.ok(t1.length && t1[0].typicalFare.amount === 150);                  // Pembroke typical before Holyhead
  for (let i = 1; i < t1.length; i++) assert.ok(t1[i - 1].typicalFare.amount <= t1[i].typicalFare.amount);
  const t2 = r.filter(o => !o.fare && !o.typicalFare);                        // Fishguard (no typical) by time
  assert.ok(t2.length);
  for (let i = 1; i < t2.length; i++) assert.ok(t2[i - 1].totalMin <= t2[i].totalMin);
});

test("Google drive time replaces the estimate and is requested at the right departure time", () => {
  const asked = [];
  const drive = makeDrive(data, (from, to, m) => { asked.push([from, to, fmt(m).time]); return { min: 260, source: "google" }; });
  const o = options(data, { dir: "out", date: "2026-11-20", drive, settings }).find(x => x.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(o.leave, T("2026-11-20", "09:40"));       // 14:00 − 260
  assert.ok(asked.some(([f, t, h]) => f === "home" && t === "PEM" && h === "09:05")); // asked at estimated leave time
  assert.ok(asked.some(([f, t, h]) => f === "RSL" && t === "dest" && h === "19:06")); // after getting off
  assert.ok(!o.flags.includes("drive time estimated"));
});

test("round-trip summary: fastest pair and cheapest fully priced pair", () => {
  const out = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const back = options(data, { dir: "back", date: "2026-11-27", drive: est, settings });
  const s0 = summary(out, back);
  assert.equal(s0.cheapest, null);
  assert.equal(s0.fastest.totalMin, rankByTime(out)[0].totalMin + rankByTime(back)[0].totalMin);
  const fares = { [out[2].id]: { amount: 100 }, [back[0].id]: { amount: 90 } };
  const s = summary(options(data, { dir: "out", date: "2026-11-20", drive: est, fares, settings }), options(data, { dir: "back", date: "2026-11-27", drive: est, fares, settings }));
  assert.equal(s.cheapest.amount, 190);
});

test("data integrity: every route references known ports/operators, has sources, and estimates exist", () => {
  for (const r of data.routes) {
    assert.ok(data.ports[r.from] && data.ports[r.to] && data.operators[r.operator], r.id);
    assert.ok(r.sources?.length, `${r.id} needs a source`);
    const [s, e] = data.ports[r.from].country === "UK" ? ["home", "dest"] : ["dest", "home"];
    assert.ok(data.driveEstimatesMin[`${s}>${r.from}`] && data.driveEstimatesMin[`${r.to}>${e}`], r.id);
    for (const x of r.sailings) assert.match(x.dep, /^\d\d:\d\d$/);
  }
});

// ---- 3 Nov (second request): questions, stops, fast ferry, fastest-by-traffic
import { answer, countdown, AROUND_WINDOW } from "../src/core/plan.js";

test("stops add minutes to the UK drive only (out: before the ferry; back: after)", () => {
  const s = { ...settings, stops: 2, stopMin: 25 };
  const out = options(data, { dir: "out", date: "2026-11-20", drive: est, settings: s }).find(x => x.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(out.driveTo.min, 295 + 50); assert.equal(out.driveTo.stops, 2); assert.equal(out.driveFrom.min, 80);
  assert.equal(out.leave, T("2026-11-20", "08:15"));
  const back = options(data, { dir: "back", date: "2026-11-27", drive: est, settings: s }).find(x => x.id === "irish-RSL-PEM|2026-11-27|08:45");
  assert.equal(back.driveTo.min, 80); assert.equal(back.driveFrom.min, 295 + 50);
});

test("fast ferry: off by default, included only when on and in season", () => {
  const june = (ff) => sailingsOn(data, "out", ["2026-06-12"], { fastFerry: ff }).filter(s => s.fast);
  assert.equal(june(false).length, 0);
  const on = june(true);
  assert.equal(on.length, 1); assert.equal(on[0].durMin, 135);
  assert.equal(sailingsOn(data, "out", ["2026-11-20"], { fastFerry: true }).filter(s => s.fast).length, 0, "out of season in November");
  const o = options(data, { dir: "out", date: "2026-06-12", drive: est, settings: { ...settings, fastFerry: true } }).find(x => x.fast);
  assert.ok(o.flags.includes("Dublin Swift times and season from memory, not seen on any timetable (4 Nov 2026)"));
  assert.ok(o.flags.includes("timetable unverified"), "a route checked with the operator does not vouch for the remembered Swift sailing");
});

test("Leave now: only options you can still leave for, earliest arrival first, with countdown", () => {
  const nowMin = T("2026-11-03", "10:00");
  const a = answer(data, { question: "now", dir: "out", nowMin, drive: est, settings });
  assert.ok(a.list.length > 2);
  assert.ok(a.list.every(o => o.leave >= nowMin));
  for (let i = 1; i < a.list.length; i++) assert.ok(a.list[i - 1].arrive <= a.list[i].arrive);
  assert.equal(a.label, "Arrives first");
  assert.equal(a.best.leaveInMin, a.best.leave - nowMin);
  // Boundary: Stena 16:00 means at Holyhead by 14:45 and leaving at exactly 10:00 (no stops here): still makeable.
  assert.equal(a.best.id, "stena-HHD-DUB|2026-11-03|16:00");
  assert.equal(a.best.leaveInMin, 0);
  const later = answer(data, { question: "now", dir: "out", nowMin: nowMin + 1, drive: est, settings });
  assert.ok(!later.list.some(o => o.id === "stena-HHD-DUB|2026-11-03|16:00"), "one minute later it has gone");
});

test("Arrive by: arrive no later than the target, latest leave first; impossible target gives Least late", () => {
  const a = answer(data, { question: "arrive", dir: "out", date: "2026-11-20", time: "18:00", drive: est, settings });
  assert.ok(a.list.length > 1);
  assert.ok(a.list.every(o => o.arrive <= T("2026-11-20", "18:00")));
  for (let i = 1; i < a.list.length; i++) assert.ok(a.list[i - 1].leave >= a.list[i].leave);
  assert.equal(a.label, "Latest for 18:00"); assert.equal(a.leastLate, false);
  // Only a Friday 14:45 sailing exists: nothing can arrive by Fri 10:00, so show the least late.
  const pemFri = { ...data, routes: [{ ...data.routes.find(r => r.id === "irish-PEM-RSL"), sailings: [{ dep: "14:45", durMin: 241, days: [5] }] }] };
  const late = answer(pemFri, { question: "arrive", dir: "out", date: "2026-11-20", time: "10:00", drive: est, settings });
  assert.equal(late.leastLate, true); assert.equal(late.label, "Least late");
  assert.ok(late.list.length > 0);
  for (let i = 1; i < late.list.length; i++) assert.ok(late.list[i - 1].arrive <= late.list[i].arrive);
});

test("Leave around: leave within −60/+180 min of the chosen time", () => {
  const target = T("2026-11-20", "08:00");
  const a = answer(data, { question: "around", dir: "out", date: "2026-11-20", time: "08:00", drive: est, settings });
  assert.ok(a.list.length > 0);
  assert.ok(a.list.every(o => o.leave >= target - AROUND_WINDOW.before && o.leave <= target + AROUND_WINDOW.after));
});

test("Fastest: traffic at each leave time decides; avoiding rush hour can win over a shorter crossing", () => {
  // Rush hour 06:30–09:30 makes the UK drive 400 min, otherwise 280; Irish legs as estimated.
  const rush = (from, to, m) => {
    if (from !== "home") return null;
    const hm = m % 1440;
    return { min: hm >= 390 && hm <= 570 ? 400 : 280, source: "google" };
  };
  const drive = makeDrive(data, rush);
  const a = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", drive, settings });
  for (let i = 1; i < a.list.length; i++) assert.ok(a.list[i - 1].totalMin <= a.list[i].totalMin);
  const hm = a.best.leave % 1440;
  assert.ok(!(hm >= 390 && hm <= 570), `fastest leaves at ${fmt(a.best.leave).time}, in rush hour`);
  assert.equal(a.label, "Fastest");
});

test("Cheapest within a question re-ranks the eligible set by price, keeps unpriced", () => {
  const base = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", drive: est, settings });
  const fares = { [base.list[4].id]: { amount: 120 } };
  const a = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", sort: "cost", drive: est, fares, settings });
  assert.equal(a.best.id, base.list[4].id); assert.equal(a.label, "Cheapest");
  const none = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", sort: "cost", drive: est, settings });
  assert.equal(none.label, "Cheapest typical price"); // no quotes: best is ordered by typical price, and says so
  assert.equal(a.list.length, base.list.length);
});

test("countdown wording", () => {
  assert.equal(countdown(212), "leave in 3h 32m");
  assert.equal(countdown(7), "leave in 7 min");
  assert.equal(countdown(1440 + 61), "leave in 1 day 1h 01m");
  assert.equal(countdown(-5), "leave time passed 5 min ago");
});

test("timetable provenance flags: aggregator-only times, unconfirmed day patterns, unverified fast ferry", () => {
  const fri = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const stena = fri.find(o => o.id === "stena-HHD-DUB|2026-11-20|16:00");
  assert.equal(stena.verifiedBy, "aggregator"); assert.ok(stena.flags.includes("times via AFerry, not the operator"));
  const pem245 = fri.find(o => o.id === "irish-PEM-RSL|2026-11-21|02:45");
  assert.ok(pem245.flags.includes("days of operation not confirmed"));
  const swift = options(data, { dir: "out", date: "2026-06-12", drive: est, settings: { ...settings, fastFerry: true } }).find(o => o.fast);
  assert.equal(swift.verified, false); assert.ok(swift.flags.includes("timetable unverified"));
});

test("Irish Ferries Dublin→Holyhead matches its own status page (3 Nov 2026): 01:15, 07:30, 13:45, 19:45, 3h30", () => {
  const r = data.routes.find(x => x.id === "irish-DUB-HHD");
  const std = r.sailings.filter(s => s.vessel !== "Dublin Swift");
  assert.deepEqual(std.map(s => s.dep), ["01:15", "07:30", "13:45", "19:45"]);
  assert.ok(std.every(s => s.durMin === 210));
});

// ---- 4 Nov: sleep on board, night driving, roads, ship type
import { sleepOnBoard, overlapDaily, rankBySleep, SLEEP } from "../src/core/plan.js";

test("sleep on board: crossing time inside 22:00–07:00, after 20 min settling, stopping 30 min before arrival", () => {
  assert.equal(sleepOnBoard(T("2026-11-20", "02:45"), T("2026-11-20", "06:46")), 191);      // 03:05–06:16
  assert.equal(sleepOnBoard(T("2026-11-20", "22:15"), T("2026-11-21", "01:45")), 160);      // 22:35–01:15
  assert.equal(sleepOnBoard(T("2026-11-20", "20:45"), T("2026-11-21", "00:46")), 136);      // 22:00–00:16
  assert.equal(sleepOnBoard(T("2026-11-20", "14:45"), T("2026-11-20", "18:46")), 0);        // daytime
  assert.equal(sleepOnBoard(T("2026-11-20", "05:30"), T("2026-11-20", "09:00")), 70);       // 05:50–07:00
  assert.equal(sleepOnBoard(T("2026-11-20", "06:50"), T("2026-11-20", "07:30")), 0);        // too short once settled
  assert.equal(SLEEP.nightStart, 22 * 60);
});

test("overlapDaily handles windows that wrap midnight and spans of several days", () => {
  assert.equal(overlapDaily(T("2026-11-20", "21:00"), T("2026-11-21", "08:00"), 22 * 60, 7 * 60), 9 * 60);
  assert.equal(overlapDaily(T("2026-11-20", "00:00"), T("2026-11-22", "00:00"), 0, 5 * 60), 10 * 60);
  assert.equal(overlapDaily(T("2026-11-20", "10:00"), T("2026-11-20", "09:00"), 0, 5 * 60), 0);
});

test("options carry sleep, night driving (drive time between 00:00 and 05:00), ship type and roads", () => {
  const all = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const pem = all.find(o => o.id === "irish-PEM-RSL|2026-11-21|02:45");
  assert.equal(pem.sleepMin, 191);
  // leave 21:20 Fri, at Pembroke by 02:00 Sat: 2h of night driving; off at 07:06, so none after.
  assert.equal(pem.nightDriveMin, 120);
  assert.equal(pem.shipType, "Standard ferry"); assert.equal(pem.vessel, "Isle of Innisfree");
  assert.deepEqual(pem.driveTo.roads, { list: ["A1(M)", "M25", "M4", "A48", "A477"], source: "typical" });
  assert.equal(pem.driveFrom.country, "IE");
  const day = all.find(o => o.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(day.sleepMin, 0); assert.equal(day.nightDriveMin, 0);
  const g = makeDrive(data, (f, t) => ({ min: 200, source: "google", roads: ["M6", "A55"] }));
  const o = options(data, { dir: "out", date: "2026-11-20", drive: g, settings }).find(x => x.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.deepEqual(o.driveTo.roads, { list: ["M6", "A55"], source: "google" });
  const fast = options(data, { dir: "out", date: "2026-06-12", drive: est, settings: { ...settings, fastFerry: true } }).find(x => x.fast);
  assert.equal(fast.shipType, "Fast ferry"); assert.equal(fast.vessel, "Dublin Swift");
});

test("Best sleep: most sleep (15-min bands) first; ties go to less night driving, then shorter journey", () => {
  const a = answer(data, { question: "fastest", dir: "out", date: "2026-11-20", sort: "sleep", drive: est, settings });
  assert.equal(a.label, "Most sleep");
  for (let i = 1; i < a.list.length; i++) assert.ok(Math.floor(a.list[i - 1].sleepMin / 15) >= Math.floor(a.list[i].sleepMin / 15));
  // Fishguard 01:30 (3h10 sleep) and Pembroke 02:45 (3h11) share a band; Fishguard needs less night driving.
  assert.equal(a.best.id, "stena-FGD-RSL|2026-11-21|01:30");
  assert.ok(a.best.nightDriveMin < a.list.find(o => o.id === "irish-PEM-RSL|2026-11-21|02:45").nightDriveMin);
  const mk = (id, sleepMin, nightDriveMin, totalMin) => ({ id, sleepMin, nightDriveMin, totalMin });
  assert.deepEqual(rankBySleep([mk("a", 100, 0, 600), mk("b", 200, 90, 700), mk("c", 200, 30, 800), mk("d", 205, 30, 700)]).map(o => o.id), ["d", "c", "b", "a"]);
});

import { mainRoads, MAIN_ROAD_KM } from "../src/google.js";
test("mainRoads: road numbers from Google steps, first road per step, ≥15 km total, order of first use, A1(M) kept whole", () => {
  const st = (km, text) => ({ distanceMeters: km * 1000, navigationInstruction: { instructions: text } });
  const legs = [{ steps: [st(3, "Head north on Hitchin Road"), st(20, "Merge onto A1(M) toward M25"), st(10, "Continue on A1(M)"),
    st(14, "Turn right onto A505"), st(60, "Keep left onto M25"), st(15, "Take the N25 exit"), st(2, "Turn left onto R729")] }];
  assert.equal(MAIN_ROAD_KM, 15);
  assert.deepEqual(mainRoads(legs), ["A1(M)", "M25", "N25"]);
  assert.deepEqual(mainRoads([]), []);
});

test("fast ferry is identified by the ship on the timetable: any Dublin Swift sailing is fast; others are standard", () => {
  assert.deepEqual(data.fastShips, ["Dublin Swift"]);
  assert.ok(data.routes.every(r => r.fast === undefined), "no route-level fast flag");
  const swiftDay = { ...data, routes: data.routes.map(r => r.id !== "irish-HHD-DUB" ? r
    : { ...r, sailings: r.sailings.map(s => s.dep === "13:15" ? { ...s, vessel: "Dublin Swift", durMin: 135 } : s) }) };
  const on = sailingsOn(swiftDay, "out", ["2026-11-20"], { fastFerry: true });
  assert.equal(on.find(s => s.id === "irish-HHD-DUB|2026-11-20|13:15").fast, true);
  assert.equal(on.find(s => s.id === "irish-HHD-DUB|2026-11-20|07:30").fast, false); // James Joyce
  const off = sailingsOn(swiftDay, "out", ["2026-11-20"], { fastFerry: false });
  assert.ok(!off.some(s => s.id === "irish-HHD-DUB|2026-11-20|13:15"), "fast sailings hidden only when the switch is off");
});

test("observed ships: the ship Irish Ferries' status page showed for a sailing time replaces the stored name; a Swift sighting makes it fast", () => {
  const ships = { "irish-HHD-DUB|13:15": { ship: "Dublin Swift", seenOn: "2026-11-04" }, "irish-PEM-RSL|14:45": { ship: "Oscar Wilde", seenOn: "2026-11-04" } };
  const all = options(data, { dir: "out", date: "2026-11-20", drive: est, ships, settings: { ...settings, fastFerry: true } });
  const swift = all.find(o => o.id === "irish-HHD-DUB|2026-11-20|13:15");
  assert.equal(swift.vessel, "Dublin Swift"); assert.equal(swift.fast, true); assert.equal(swift.vesselSeen, true);
  assert.equal(swift.shipType, "Fast ferry");
  const pem = all.find(o => o.id === "irish-PEM-RSL|2026-11-20|14:45");
  assert.equal(pem.vessel, "Oscar Wilde"); assert.equal(pem.fast, false);
  const other = all.find(o => o.id === "irish-HHD-DUB|2026-11-20|07:30");
  assert.equal(other.vessel, "James Joyce"); assert.equal(other.vesselSeen, false);
});
