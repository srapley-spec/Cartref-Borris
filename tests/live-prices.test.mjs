import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseResults, searchAferry, searchBody, ROUTES, UA } from "../tools/aferry-search.mjs";
import { handle, validPricesQuery } from "../proxy/worker-src.mjs";
import { priceSearches, mapLiveRows, SEARCH_PLAN } from "../src/core/prices.js";
import { SOURCES } from "../tools/status-core.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/aferry-results-HHD-DUB-2026-11-20.html", import.meta.url), "utf8");
const data = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url)));

test("AFerry results parser: real page slice -> 8 sailings with date, times, duration and price", () => {
  const r = parseResults(FIXTURE, "2026-11-20");
  assert.equal(r.rows.length, 8);
  assert.deepEqual(r.rows[0], { from: "HHD", to: "DUB", dep: "13:15", date: "2026-11-19", arr: "16:45", arrDate: "2026-11-19", durMin: 210, amount: 195 });
  assert.deepEqual(r.rows.find(x => x.dep === "22:15"), { from: "HHD", to: "DUB", dep: "22:15", date: "2026-11-19", arr: "01:45", arrDate: "2026-11-20", durMin: 210, amount: 205 });
  assert.deepEqual(r.searching, ["Stena Line"]); // a placeholder that stays on the finished page
});

test("parser: year rolls over for a January sailing searched in December", () => {
  const html = "<div>Holyhead</div><div>Dublin</div><div>01:30</div><div>Fri 01 Jan</div><div>3h 30m</div><div>05:00</div><div>Fri 01 Jan</div><div>Details</div><div>£150.50</div>";
  assert.deepEqual(parseResults(html, "2026-12-31").rows[0].date, "2027-01-01");
});

test("search request: one way, 2 adults, standard car, route code and requested time", () => {
  const b = searchBody("PEM-RSL", "2026-11-20", "1200");
  assert.equal(b.IsDiffRet, "N"); assert.equal(b.legs.length, 1);
  assert.deepEqual(b.legs[0].passengers, { adults: 2, children: 0, childAges: [], dogs: 0, cats: 0 });
  assert.deepEqual(b.legs[0].vehicle, { type: "STD", trailer: {} });
  assert.equal(b.legs[0].routeCode, ROUTES["PEM-RSL"].code); assert.equal(b.legs[0].time, "1200");
  assert.throws(() => searchBody("XXX", "2026-11-20"));
});

test("searchAferry: posts the search, polls the results page until two polls agree, identifies itself honestly", async () => {
  const calls = [];
  const fetchFn = async (url, opt = {}) => {
    calls.push({ url, method: opt.method || "GET", ua: opt.headers?.["User-Agent"] });
    if (opt.method === "POST") return new Response(JSON.stringify({ location: "https://www.aferry.com/en-gb/search/123456789012/" }), { status: 200 });
    return new Response(calls.length === 2 ? "<p>Searching Irish Ferries...</p>" : FIXTURE, { status: 200 });
  };
  const r = await searchAferry("HHD-DUB", "2026-11-20", { fetchFn, sleep: async () => {} });
  assert.equal(r.rows.length, 8); assert.equal(r.stable, true);
  assert.deepEqual(calls.map(c => c.method), ["POST", "GET", "GET", "GET"]); // empty, rows, same rows -> stop
  assert.ok(calls.every(c => c.ua === UA) && /cartref-borris personal trip planner/.test(UA));
  const bad = async () => new Response(JSON.stringify({ location: "https://evil.example/x" }), { status: 200 });
  await assert.rejects(searchAferry("HHD-DUB", "2026-11-20", { fetchFn: bad, sleep: async () => {} }), /unexpected location/);
});

test("worker: only the configured origin; validates route/date/time; caches successful searches for an hour", async () => {
  const env = { ALLOW_ORIGIN: "https://srapley-spec.github.io" };
  const req = (path, origin = env.ALLOW_ORIGIN) => new Request(`https://w.example${path}`, { headers: { Origin: origin } });
  const store = new Map();
  const cache = { match: async (k) => store.get(k.url)?.clone(), put: async (k, v) => { store.set(k.url, v); } };
  let searches = 0;
  const fetchFn = async (url, opt = {}) => { if (opt.method === "POST") { searches++; return new Response(JSON.stringify({ location: "https://www.aferry.com/en-gb/search/1234567890/" })); } return new Response(FIXTURE); };
  const deps = { fetchFn, cache, sleep: async () => {}, now: () => Date.parse("2026-11-04T10:00:00Z") };
  assert.equal((await handle(req("/prices?route=HHD-DUB&date=2026-11-20", "https://evil.example"), env, deps)).status, 403);
  assert.equal((await handle(req("/prices?route=HHD-DUB&date=2026-11-20"), {}, deps)).status, 500);
  for (const q of ["route=XXX&date=2026-11-20", "route=HHD-DUB&date=2026-11-03", "route=HHD-DUB&date=2026-11-20&time=2500"]) assert.equal((await handle(req(`/prices?${q}`), env, deps)).status, 400, q);
  const r1 = await handle(req("/prices?route=HHD-DUB&date=2026-11-20&time=0600"), env, deps);
  assert.equal(r1.status, 200); assert.equal(r1.headers.get("access-control-allow-origin"), env.ALLOW_ORIGIN);
  const j1 = await r1.json(); assert.equal(j1.rows.length, 8); assert.equal(j1.checkedAt, "2026-11-04T10:00:00.000Z");
  const j2 = await (await handle(req("/prices?route=HHD-DUB&date=2026-11-20&time=0600"), env, deps)).json();
  assert.equal(j2.cached, true); assert.equal(searches, 1);
  assert.deepEqual(validPricesQuery(new URLSearchParams("route=FGD-RSL&date=2026-11-20"), "2026-11-04"), { route: "FGD-RSL", date: "2026-11-20", time: "0000" });
});

test("paste-ready proxy/worker.js is up to date with its sources", () => {
  execFileSync(process.execPath, [new URL("../tools/build-worker.mjs", import.meta.url).pathname, "--check"]);
});

test("price searches: three Holyhead windows, one Rosslare search, plus next morning's Holyhead window", () => {
  assert.deepEqual(priceSearches("out", ["2026-11-20"]).map(q => `${q.route} ${q.date} ${q.time}`), [
    "HHD-DUB 2026-11-20 0600", "HHD-DUB 2026-11-20 0900", "HHD-DUB 2026-11-20 1800", "FGD-RSL 2026-11-20 1200", "HHD-DUB 2026-11-21 0600"]);
  assert.equal(priceSearches("back", ["2026-11-27"])[3].route, "RSL-FGD");
  assert.equal(SEARCH_PLAN.out.length, 4);
});

test("live rows map to our sailings by ports and departure time (operator inferred); unknown sailings kept aside", () => {
  const rows = [{ from: "HHD", to: "DUB", dep: "13:15", date: "2026-11-20", amount: 195 }, { from: "HHD", to: "DUB", dep: "16:00", date: "2026-11-20", amount: 201 },
    { from: "PEM", to: "RSL", dep: "02:45", date: "2026-11-21", amount: 209 }, { from: "HHD", to: "DUB", dep: "11:11", date: "2026-11-20", amount: 99 }];
  const { prices, unmatched } = mapLiveRows(data, rows, "2026-11-04T10:00:00Z");
  assert.deepEqual(Object.keys(prices), ["irish-HHD-DUB|2026-11-20|13:15", "stena-HHD-DUB|2026-11-20|16:00", "irish-PEM-RSL|2026-11-21|02:45"]);
  assert.equal(prices["stena-HHD-DUB|2026-11-20|16:00"].amount, 201);
  assert.deepEqual(unmatched.map(r => r.dep), ["11:11"]);
});

test("worker /status: reads the operator pages now, same shape as the collected file, cached 3 minutes, partial results still served", async () => {
  const env = { ALLOW_ORIGIN: "https://srapley-spec.github.io" };
  const req = (path) => new Request(`https://w.example${path}`, { headers: { Origin: env.ALLOW_ORIGIN } });
  const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
  const pages = { "id=6": fx("stena-ferrycheck-holyhead-dublin-2026-11-04.html"), "id=5": fx("stena-ferrycheck-dublin-holyhead-2026-11-04.html"), "id=8": fx("stena-ferrycheck-fishguard-rosslare-2026-11-04.html"), "id=7": fx("stena-ferrycheck-rosslare-fishguard-2026-11-04.html"), "dublin-holyhead": fx("irish-status-dublin-holyhead-2026-11-04.html") };
  let fetches = 0;
  const fetchFn = async (url) => { fetches++; const k = Object.keys(pages).find(k => url.includes(k)); return k ? new Response(pages[k]) : new Response("down", { status: 503 }); };
  const store = new Map();
  const cache = { match: async (k) => store.get(k.url)?.clone(), put: async (k, v) => { store.set(k.url, v); } };
  const deps = { fetchFn, cache, now: () => Date.parse("2026-11-04T10:30:00Z") };
  const r1 = await handle(req("/status"), env, deps);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.via, "proxy"); assert.equal(j1.complete, false); assert.equal(fetches, SOURCES.length);
  assert.equal(j1.sources["irish-rosslare-pembroke"].ok, false); assert.match(j1.sources["irish-rosslare-pembroke"].error, /503/);
  assert.equal(Object.keys(j1.sailings).length, 24 + 32); assert.ok(j1.coverage["stena-HHD-DUB|2026-11-05"]);
  const j2 = await (await handle(req("/status"), env, deps)).json();
  assert.equal(j2.cached, true); assert.equal(fetches, SOURCES.length, "served from cache");
  assert.equal((await handle(new Request("https://w.example/status", { headers: { Origin: "https://evil.example" } }), env, deps)).status, 403);
});
