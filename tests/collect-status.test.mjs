import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collect, SOURCES, parseSource } from "../tools/collect-status.mjs";
import { parseStenaStatusPage, parseCheckIn } from "../tools/stena-status-parse.mjs";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const PAGES = {
  "https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=6": fx("stena-ferrycheck-holyhead-dublin-2026-11-04.html"),
  "https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=5": fx("stena-ferrycheck-dublin-holyhead-2026-11-04.html"),
  "https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=8": fx("stena-ferrycheck-fishguard-rosslare-2026-11-04.html"),
  "https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=7": fx("stena-ferrycheck-rosslare-fishguard-2026-11-04.html"),
  "https://www.irishferries.com/ie-en/sailing-updates/dublin-holyhead/": fx("irish-status-dublin-holyhead-2026-11-04.html"),
  "https://www.irishferries.com/ie-en/sailing-updates/rosslare-pembroke/": fx("irish-status-rosslare-pembroke-2026-11-04.html"),
};
const NOW = Date.parse("2026-11-04T10:15:00Z");
const okFetch = async (url) => new Response(PAGES[url], { status: 200 });
const timetable = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url)));

test("Stena FerryCheck: two dated tabs per route, vessel/times/status per row, vehicle check-in from the notes", () => {
  const r = parseStenaStatusPage(PAGES["https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=6"], 6);
  assert.equal(r.routeId, "stena-HHD-DUB"); assert.deepEqual(r.dates, ["2026-11-04", "2026-11-05"]); assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.sailings.map(s => [s.date, s.dep, s.arr, s.arrDate, s.ship, s.status]).slice(0, 4), [
    ["2026-11-04", "04:00", "07:30", "2026-11-04", "Stena Adventurer", "departed"], ["2026-11-04", "10:00", "13:30", "2026-11-04", "Stena Estrid", "on-time"],
    ["2026-11-04", "16:00", "19:30", "2026-11-04", "Stena Adventurer", "on-time"], ["2026-11-04", "22:15", "01:45", "2026-11-05", "Stena Estrid", "on-time"]]);
  assert.equal(r.checkInMin, 30); assert.match(r.checkInNote, /Vehicles: the latest check-in time/);
  const f = parseStenaStatusPage(PAGES["https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=8"], 8);
  assert.equal(f.routeId, "stena-FGD-RSL"); assert.equal(f.sailings.length, 4); assert.equal(f.sailings[0].ship, "Stena Nordica");
  assert.equal(parseCheckIn("Foot passengers: no later than 40 minutes. Vehicles: the latest check-in time for all sailings is no later that 30 minutes before"), 30);
  assert.equal(parseStenaStatusPage("<html><body><h1 class='page-title'>24HR SAILING UPDATES FOR HOLYHEAD - DUBLIN</h1></body></html>", 6).warnings.join(), "no date tabs found,no sailing rows parsed");
});

test("collect: all sources ok -> complete file with dated records, coverage per route and date, unscheduled list", async () => {
  const { file, report } = await collect({ prev: null, fetchFn: okFetch, now: () => NOW, timetable });
  assert.equal(file.complete, true); assert.equal(file.collectedOn, "2026-11-04");
  assert.equal(Object.keys(file.sources).length, SOURCES.length);
  assert.ok(Object.values(file.sources).every(s => s.ok && s.fetchedAt === "2026-11-04T10:15:00.000Z"));
  // Stena: today + tomorrow; Irish Ferries: yesterday … day after tomorrow.
  assert.ok(file.coverage["stena-HHD-DUB|2026-11-05"] && !file.coverage["stena-HHD-DUB|2026-11-06"]);
  assert.ok(file.coverage["irish-PEM-RSL|2026-11-06"] && file.coverage["irish-PEM-RSL|2026-11-03"]);
  assert.equal(Object.keys(file.sailings).length, 24 + 48);
  const thu = file.sailings["irish-PEM-RSL|2026-11-05|02:45"];
  assert.ok(thu && thu.ship === "Isle of Innisfree" && thu.source === "irish-rosslare-pembroke" && thu.checkInMin === 60);
  // Rescheduled Irish sailings are keyed by their original time and carry both times.
  const early = file.sailings["irish-HHD-DUB|2026-11-05|02:40"]; assert.equal(early.dep, "01:30"); assert.equal(early.originalDep, "02:40");
  // The Thursday 02:45 Pembroke sailing is not in our weekday pattern: reported, not invented into the timetable.
  assert.ok(file.unscheduled.some(u => u.routeId === "irish-PEM-RSL" && u.date === "2026-11-05" && u.dep === "02:45"));
  assert.ok(report.every(l => /: ok, \d+ sailings/.test(l)), report.join("\n"));
  assert.ok(Object.values(file.sources).every(s => s.operatorUpdatedAt === undefined || s.operatorUpdatedAt === null));
});

test("collect: a failed fetch keeps that source's previous records and coverage with their original timestamp; marked failed, not fresh", async () => {
  const first = (await collect({ prev: null, fetchFn: okFetch, now: () => NOW, timetable })).file;
  const LATER = NOW + 30 * 60000;
  const flaky = async (url) => /id=8/.test(url) ? new Response("Service Unavailable", { status: 503 }) : /rosslare-pembroke/.test(url) ? new Response("<html><body>maintenance</body></html>", { status: 200 }) : okFetch(url);
  const { file, report } = await collect({ prev: first, fetchFn: flaky, now: () => LATER, timetable });
  assert.equal(file.complete, false);
  const s8 = file.sources["stena-ferrycheck-8"], rp = file.sources["irish-rosslare-pembroke"];
  assert.equal(s8.ok, false); assert.match(s8.error, /HTTP 503/); assert.equal(s8.fetchedAt, "2026-11-04T10:15:00.000Z"); assert.equal(s8.lastGoodAt, "2026-11-04T10:15:00.000Z");
  assert.equal(rp.ok, false); assert.match(rp.error, /parsed no sailings/); // an empty page is not "no sailings"
  assert.equal(file.coverage["stena-FGD-RSL|2026-11-05"].fetchedAt, "2026-11-04T10:15:00.000Z", "coverage keeps the original timestamp");
  assert.equal(file.sailings["irish-PEM-RSL|2026-11-05|02:45"].fetchedAt, "2026-11-04T10:15:00.000Z");
  assert.equal(file.coverage["stena-HHD-DUB|2026-11-05"].fetchedAt, new Date(LATER).toISOString(), "healthy sources refresh");
  assert.ok(report.some(l => /stena-ferrycheck-8: FAILED \(HTTP 503\); kept previous data from 2026-11-04T10:15/.test(l)));
  // A network error (not an HTTP status) is reported too.
  const down = await collect({ prev: first, fetchFn: async () => { throw new TypeError("fetch failed"); }, now: () => LATER, timetable });
  assert.ok(Object.values(down.file.sources).every(s => !s.ok && s.error === "fetch failed"));
  assert.equal(Object.keys(down.file.sailings).length, Object.keys(first.sailings).length);
});

test("collect: a changed departure time replaces the old record (same original time), no duplicate; old dates are purged", async () => {
  const first = (await collect({ prev: null, fetchFn: okFetch, now: () => NOW, timetable })).file;
  const changed = PAGES["https://stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=6"].replace('name="departure-20261105-1"><label class="mobile-label-details">Departure:</label><span class="middle">10:00</span>', 'name="departure-20261105-1"><label class="mobile-label-details">Departure:</label><span class="middle">10:30</span>');
  const f2 = async (url) => /id=6/.test(url) ? new Response(changed) : okFetch(url);
  const { file } = await collect({ prev: first, fetchFn: f2, now: () => NOW + 60000, timetable });
  const hhd5 = Object.values(file.sailings).filter(r => r.routeId === "stena-HHD-DUB" && r.date === "2026-11-05").map(r => r.dep).sort();
  assert.deepEqual(hhd5, ["04:00", "10:30", "16:00", "22:15"]); // 10:00 gone, 10:30 in, four sailings not five
  // Two days later, yesterday's and today's records from the first run are purged.
  const later = (await collect({ prev: first, fetchFn: async () => new Response("", { status: 500 }), now: () => NOW + 2 * 86400000, timetable })).file;
  assert.ok(Object.values(later.sailings).every(r => r.date >= "2026-11-05"));
  assert.ok(Object.keys(later.coverage).every(k => k.split("|")[1] >= "2026-11-05"));
});

test("parseSource routes each source to its parser and Irish Ferries check-in defaults to the page's 30 minutes", () => {
  const irish = parseSource(SOURCES.find(s => s.key === "irish-dublin-holyhead"), PAGES["https://www.irishferries.com/ie-en/sailing-updates/dublin-holyhead/"], "2026-11-04");
  assert.equal(irish.sailings.length, 32); assert.equal(irish.checkInMin, 30); assert.equal(irish.dates.length, 4);
});
