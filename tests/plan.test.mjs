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
