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
  assert.deepEqual(o.flags, ["timetable unverified", "drive time estimated", "no price yet"]);
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

test("rank by cost: priced cheapest first, unpriced kept after (never hidden)", () => {
  const all = options(data, { dir: "out", date: "2026-11-20", drive: est, settings });
  const fares = { [all[0].id]: { amount: 210 }, [all[1].id]: { amount: 140 } };
  const r = rankByCost(options(data, { dir: "out", date: "2026-11-20", drive: est, fares, settings }));
  assert.equal(r.length, all.length);
  assert.equal(r[0].id, all[1].id); assert.equal(r[1].id, all[0].id);
  assert.ok(r.slice(2).every(o => !o.fare));
  for (let i = 3; i < r.length; i++) assert.ok(r[i - 1].totalMin <= r[i].totalMin);
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
  assert.ok(o.flags.includes("fast-ferry times from memory"));
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
  assert.equal(a.list.length, base.list.length);
});

test("countdown wording", () => {
  assert.equal(countdown(212), "leave in 3h 32m");
  assert.equal(countdown(7), "leave in 7 min");
  assert.equal(countdown(1440 + 61), "leave in 1 day 1h 01m");
  assert.equal(countdown(-5), "leave time passed 5 min ago");
});
