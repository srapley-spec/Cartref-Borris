// Page in a real browser (Playwright/Chromium), Google mocked, virtual clock Tue 3 Nov 2026 10:00 London.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
// require() so a globally installed Playwright (cloud sessions) and the devDependency (CI) both resolve.
const { chromium } = createRequire(import.meta.url)("playwright");
import { localToUtcIso } from "../src/google.js";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png" };
let server, base, browser;
const NOW = Date.parse("2026-11-03T10:00:00Z");

before(async () => {
  server = createServer(async (req, res) => {
    const p = normalize(join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try { const f = p.endsWith("/") ? join(p, "index.html") : p; const body = await readFile(f); res.writeHead(200, { "content-type": TYPES[extname(f)] || "text/plain" }).end(body); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function openPage({ google, fares, ships, status } = {}) {
  const ctx = await browser.newContext({ timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.error("pageerror:", e.message));
  await page.clock.setFixedTime(NOW);
  const calls = [];
  await page.route("https://routes.googleapis.com/**", async (route) => {
    const req = route.request();
    calls.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    await route.fulfill(google ? google(calls.at(-1)) : { status: 500, body: "no" });
  });
  // data/fares.json is refreshed daily by a bot; tests never read the live file.
  await page.route("**/data/sailing-status.json", (route) => route.fulfill(status ? { status: 200, contentType: "application/json", body: JSON.stringify(status) } : { status: 404, body: "" }));
  await page.route("**/data/ships.json", (route) => route.fulfill(ships ? { status: 200, contentType: "application/json", body: JSON.stringify(ships) } : { status: 404, body: "" }));
  await page.route("**/data/fares.json", (route) => route.fulfill(fares ? { status: 200, contentType: "application/json", body: JSON.stringify(fares) } : { status: 404, body: "" }));
  await page.goto(base);
  await page.waitForSelector("#hero .opt");
  return { page, ctx, calls };
}

test("UTC conversion uses the London offset (GMT in Nov, BST in Jul)", () => {
  const m = (iso) => Date.parse(iso + "Z") / 60000;
  assert.equal(localToUtcIso(m("2026-11-20T09:00")), "2026-11-20T09:00:00.000Z");
  assert.equal(localToUtcIso(m("2026-07-20T09:00")), "2026-07-20T08:00:00.000Z");
});

const ids = (page, sel = "#hero .opt, #list .opt") => page.$$eval(sel, els => els.map(e => e.dataset.id));
const seg = (page, group, v) => page.click(`#${group} button[data-v="${v}"]`);

test("Leave now (default): Signal card with Leave by → At Borris, Total journey, countdown, next sailing and ferry panel", async () => {
  const { page, ctx } = await openPage();
  assert.equal(await page.getAttribute('#questionSeg button[data-v="now"]', "aria-pressed"), "true");
  assert.equal(await page.isVisible("#timeRow"), false);
  assert.match(await page.textContent("#hero .hero-cap"), /If you leave now · 10:00/);
  const best = page.locator("#hero > .opt").first();
  const text = await best.textContent();
  // Stena 16:00: 16:00 − 30 check-in (Stena's page) − 15 margin = 15:15; − 285 drive − 30 (1 stop, the default) = 10:00 = now.
  assert.match(text, /Leave by\s*10:00/); assert.match(text, /At Borris/);
  assert.match(text, /Total journey \d+h \d\dm/); assert.match(text, /leave now/);
  assert.match(text, /Arrives first/);
  assert.match(text, /Next: 16:00 Stena Line from Holyhead/);
  assert.match(text, /Timetable departure\s*16:00/); assert.match(text, /Expected departure\s*Not live/); assert.match(text, /At Dublin Port\s*19:30/);
  assert.match(text, /Timetable estimate/); // no operator status file in this test
  assert.equal(await best.locator(".op img").getAttribute("alt"), "Stena Line");
  assert.ok(await best.locator(".op img").evaluate(i => i.complete && i.naturalWidth > 0), "logo loads");
  assert.match(await page.textContent("#hero .next-best"), /Next best[\s\S]*Leave by/);
  // No fares/ships files in this test: those sources say "never updated" and the banner asks for a check.
  assert.equal((await page.textContent("#banner")).replace(/\s+/g, " ").trim(), "Ferry times checked today · Prices never updated · Ships never updated · Sailing status never updated · Drive times: estimates Check before booking.");
  assert.match(text, /Times via AFerry Tue 3 Nov/);
  assert.match(text, /~£174\s*typical, not a quote \(AFerry operator average, 3 Nov\)/);
  assert.match(await page.textContent("#status"), /No Google key/);
  await ctx.close();
});

test("Arrive by: time box appears; options arrive in time, latest leave labelled", async () => {
  const { page, ctx } = await openPage();
  await seg(page, "questionSeg", "arrive");
  assert.equal(await page.isVisible("#timeRow"), true);
  await page.fill("#time", "18:00"); await page.locator("#time").dispatchEvent("change");
  assert.match(await page.textContent("#hero .hero-cap"), /Arrive Borris by 18:00 · Tue 10 Nov/);
  assert.match(await page.textContent("#hero .tag.best"), /Latest for 18:00/);
  await ctx.close();
});

test("Direction toggle answers the return journey (At home), using the Leave Borris date", async () => {
  const { page, ctx } = await openPage();
  await seg(page, "dirSeg", "back"); await seg(page, "questionSeg", "fastest");
  assert.match(await page.textContent("#hero .hero-cap"), /leaving Tue 17 Nov/);
  assert.match(await page.textContent("#hero .opt"), /At home/);
  assert.ok((await ids(page)).every(id => /-(DUB|RSL)-/.test(id)));
  await ctx.close();
});

test("Day/Overnight partition the options; cost ranking with entered fares re-ranks, persists, keeps unpriced", async () => {
  const { page, ctx } = await openPage();
  await seg(page, "questionSeg", "fastest");
  const total = (await ids(page)).length;
  await page.click("#ctx summary");
  await seg(page, "prefSeg", "overnight");
  const night = await page.$$eval("#hero .opt, #list .opt", els => els.map(e => e.textContent));
  assert.ok(night.length > 0 && night.every(t => t.includes("Overnight")));
  await seg(page, "prefSeg", "day");
  const day = await page.$$eval("#hero .opt, #list .opt", els => els.map(e => e.textContent));
  assert.ok(day.every(t => !t.includes("Overnight")));
  assert.equal(night.length + day.length, total);
  await seg(page, "prefSeg", "any"); await seg(page, "sortSeg", "cost");
  const before = await ids(page);
  await page.fill(`input.fare-in[data-id="${before[3]}"]`, "149"); await page.locator(`input.fare-in[data-id="${before[3]}"]`).dispatchEvent("change");
  await page.fill(`input.fare-in[data-id="${before[1]}"]`, "99.50"); await page.locator(`input.fare-in[data-id="${before[1]}"]`).dispatchEvent("change");
  const after = await ids(page);
  assert.deepEqual(after.slice(0, 2), [before[1], before[3]]);
  assert.equal(after.length, total);
  assert.match(await page.textContent("#hero .opt"), /£99\.50/);
  assert.match(await page.textContent("#hero .tag.best"), /Cheapest/);
  await page.reload(); await page.waitForSelector("#hero .opt");
  assert.deepEqual((await ids(page)).slice(0, 2), [before[1], before[3]]);
  await ctx.close();
});

test("Stops move the leave time by minutes-per-stop; fast ferry toggle is explicit and remembered", async () => {
  const { page, ctx } = await openPage();
  await seg(page, "questionSeg", "fastest");
  await page.click("#ctx summary");
  const leaveOf = async () => page.$eval("#hero .opt .optbig", e => e.textContent);
  const id0 = (await ids(page))[0];
  const t1 = await leaveOf();
  await page.click("#stopsUp");
  assert.equal((await ids(page))[0], id0);
  const t2 = await leaveOf();
  const mins = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
  assert.equal(mins(t1) - mins(t2), 30);
  assert.match(await page.textContent("#contextSummary"), /2 stops/);
  assert.equal(await page.getAttribute("#fastFerry", "aria-pressed"), "false");
  await page.click("#fastFerry");
  assert.equal(await page.getAttribute("#fastFerry", "aria-pressed"), "true");
  assert.match(await page.textContent("#contextSummary"), /Fast ferry on/);
  await page.reload(); await page.waitForSelector("#hero .opt");
  assert.equal(await page.getAttribute("#fastFerry", "aria-pressed"), "true");
  await ctx.close();
});

test("with a Google key: legs requested with key header and future departure times; results replace estimates", async () => {
  const steps = [
    { distanceMeters: 2000, navigationInstruction: { instructions: "Head north on Hitchin Rd" } },
    { distanceMeters: 40000, navigationInstruction: { instructions: "Merge onto A1(M)" } },
    { distanceMeters: 90000, navigationInstruction: { instructions: "Take the exit onto A14 toward M6" } },
    { distanceMeters: 5000, navigationInstruction: { instructions: "Turn left onto A505" } },
    { distanceMeters: 120000, navigationInstruction: { instructions: "Continue onto M6" } },
  ];
  const { page, ctx, calls } = await openPage({ google: () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ routes: [{ duration: "15600s", legs: [{ steps }] }] }) }) });
  await page.click("#settingsBtn");
  await page.fill("#key", "test-key-not-real");
  await page.click("#saveSettings");
  await page.waitForFunction(() => !document.querySelector("#hero").textContent.includes("(estimate)"));
  assert.ok(calls.length > 0);
  assert.equal(calls[0].headers["x-goog-api-key"], "test-key-not-real");
  assert.match(calls[0].headers["x-goog-fieldmask"], /routes\.duration/);
  assert.ok(calls.every(c => !c.body.departureTime || Date.parse(c.body.departureTime) > NOW)); assert.ok(calls.some(c => c.body.departureTime));
  assert.ok(calls.some(c => /SG6 3LT/.test(c.body.origin.address)));
  assert.match(await page.textContent("#hero .drive-leg"), /Drive 4h 50m incl\. 1 stop \(30 min\) to/);
  assert.match(calls[0].headers["x-goog-fieldmask"], /navigationInstruction/);
  // Main roads (≥15 km) in order of use, as sign lozenges; the 5 km A505 is left out.
  const leg = page.locator("#hero > .opt .drive-leg").first();
  assert.deepEqual(await leg.locator(".road").allTextContents(), ["A1(M)", "A14", "M6"]);
  assert.deepEqual(await leg.locator(".road").evaluateAll(els => els.map(e => e.className)), ["road road-m", "road road-a", "road road-m"]);
  assert.equal(await leg.locator(".roads-src").count(), 0);
  await ctx.close();
});

test("Google failure is reported and estimates are used (nothing hidden)", async () => {
  const { page, ctx } = await openPage({ google: () => ({ status: 403, body: "API key not valid" }) });
  const before = (await ids(page)).length;
  await page.click("#settingsBtn"); await page.fill("#key", "bad"); await page.click("#saveSettings");
  await page.waitForFunction(() => /failed/.test(document.querySelector("#status").textContent));
  assert.match(await page.textContent("#status"), /403/);
  assert.equal((await ids(page)).length, before);
  await ctx.close();
});

test("Fetched fares: an AFerry quote prices its exact sailing; others show the month's route average; Cheapest ranks quotes first", async () => {
  const fares = {
    fetchedOn: "2026-11-03",
    routes: { "PEM-RSL": { fetchedOn: "2026-11-03", monthly: { 11: { amount: 180, season: "Mid-Season" } }, operatorAvg: { irish: { amount: 172 } } } },
    quotes: { "irish-HHD-DUB|2026-11-10|19:30": { amount: 99, currency: "GBP", date: "2026-11-10", seenOn: "2026-11-03", source: "AFerry latest ticket price" } },
  };
  const { page, ctx } = await openPage({ fares });
  await seg(page, "questionSeg", "fastest");
  await page.click("#ctx summary"); await seg(page, "sortSeg", "cost");
  const first = page.locator("#hero > .opt").first();
  assert.equal(await first.getAttribute("data-id"), "irish-HHD-DUB|2026-11-10|19:30");
  assert.match(await first.textContent(), /£99\s*AFerry price for this sailing, seen Tue 3 Nov/);
  assert.match(await first.locator(".tag.best").textContent(), /^Cheapest$/);
  const pem = page.locator('.opt[data-id="irish-PEM-RSL|2026-11-10|14:45"]');
  assert.match(await pem.textContent(), /~£180\s*typical, not a quote \(AFerry route average for Nov\)/);
  await ctx.close();
});

test("Without Google, each drive shows typical roads (labelled unchecked) in sign colours; ship type and name shown", async () => {
  const { page, ctx } = await openPage();
  const best = page.locator("#hero > .opt").first(); // Stena 16:00 Holyhead
  const irish = page.locator('.opt[data-id="irish-HHD-DUB|2026-11-03|19:30"]'); // James Joyce
  const out = best.locator(".drive-leg").nth(0), irl = best.locator(".drive-leg").nth(1);
  assert.deepEqual(await out.locator(".road").allTextContents(), ["A1(M)", "A14", "M6", "M56", "A55"]);
  assert.match(await out.textContent(), /typical roads, unchecked/);
  assert.deepEqual(await irl.locator(".road").evaluateAll(els => els.map(e => e.className)), ["road road-m ie", "road road-m ie"]);
  assert.match(await irish.locator(".ship").textContent(), /Standard ferry · James Joyce/);
  assert.match(await best.locator(".tags").textContent(), /Standard ferry/);
  await ctx.close();
});

test("Best sleep ranking: most sleep on board first, with sleep and night-driving shown", async () => {
  const { page, ctx } = await openPage();
  await seg(page, "questionSeg", "fastest");
  await page.click("#ctx summary"); await seg(page, "sortSeg", "sleep");
  const best = page.locator("#hero > .opt").first();
  assert.match(await best.locator(".tag.best").textContent(), /Most sleep/);
  assert.match(await best.textContent(), /Sleep ~3h \d\dm on board/);
  assert.match(await page.textContent("#contextSummary"), /Best sleep/);
  await ctx.close();
});

test("Ship sightings: the observed ship is shown; the fast-ferry note says whether the Dublin Swift has been seen", async () => {
  const ships = { watchingSince: "2026-11-04", fastShipsSeen: { "Dublin Swift": null },
    sailings: { "irish-HHD-DUB|19:30": { ship: "Ulysses", seenOn: "2026-11-04" } } };
  const { page, ctx } = await openPage({ ships });
  assert.match(await page.locator('.opt[data-id="irish-HHD-DUB|2026-11-03|19:30"] .ship').textContent(), /Standard ferry · Ulysses/); // stored: James Joyce
  assert.match(await page.textContent("#fastNote"), /Dublin Swift not seen on Irish Ferries' status pages since Wed 4 Nov; its times here are from memory\./);
  await ctx.close();
  const seen = await openPage({ ships: { ...ships, fastShipsSeen: { "Dublin Swift": "2026-11-02" } } });
  assert.match(await seen.page.textContent("#fastNote"), /Dublin Swift last seen sailing on Irish Ferries' status page Mon 2 Nov\./);
  await seen.ctx.close();
});

test("Data sources: each source shows when it was last updated; out-of-date ones are flagged", async () => {
  const fares = { fetchedOn: "2026-10-30", routes: {}, quotes: {} };               // 4 days old: stale (limit 2)
  const ships = { updatedOn: "2026-11-02", sailings: {}, fastShipsSeen: {} };      // yesterday: fresh
  const { page, ctx } = await openPage({ fares, ships });
  const banner = (await page.textContent("#banner")).replace(/\s+/g, " ").trim();
  assert.equal(banner, "Ferry times checked today · Prices updated 4 days ago · Ships updated yesterday · Sailing status never updated · Drive times: estimates Check before booking.");
  assert.deepEqual(await page.locator("#banner .stale").allTextContents(), ["Prices updated 4 days ago", "Sailing status never updated", "Check before booking."]);
  const rows = await page.locator("#sources .src-row").allTextContents();
  assert.equal(rows.length, 5);
  assert.match(rows[0], /Ferry times\s*checked Tue 3 Nov \(today\)/);
  assert.match(rows[1], /Prices\s*updated Fri 30 Oct \(4 days ago\) · out of date/);
  assert.match(rows[2], /Ships\s*updated Mon 2 Nov \(yesterday\)/);
  assert.match(rows[3], /Sailing status\s*never updated · out of date[\s\S]*No operator status collected yet/);
  assert.match(rows[4], /Drive times\s*never updated[\s\S]*No Google key/);
  assert.equal(await page.locator("#sources .src-row.stale").count(), 2);
  await ctx.close();
});

test("Live prices via the proxy: searches for the date on screen; live prices beat daily ones and show their check time", async () => {
  const { page, ctx } = await openPage({ fares: { fetchedOn: "2026-11-03", routes: {}, quotes: { "irish-HHD-DUB|2026-11-10|19:30": { amount: 99, date: "2026-11-10", seenOn: "2026-11-03" } } } });
  const asked = [];
  await page.route("https://proxy.test/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/status") return route.fulfill({ status: 502, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "upstream" }) });
    if (u.pathname === "/version") return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ version: "000000000000" }) });
    asked.push(`${u.pathname}?${u.searchParams}`);
    const rows = u.searchParams.get("route") === "HHD-DUB" && u.searchParams.get("date") === "2026-11-10"
      ? [{ from: "HHD", to: "DUB", dep: "19:30", date: "2026-11-10", arr: "23:00", arrDate: "2026-11-10", durMin: 210, amount: 185 },
         { from: "HHD", to: "DUB", dep: "16:00", date: "2026-11-10", arr: "19:30", arrDate: "2026-11-10", durMin: 210, amount: 150 }] : [];
    route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ checkedAt: "2026-11-03T10:00:00.000Z", rows }) });
  });
  await seg(page, "questionSeg", "fastest");
  await page.click("#ctx summary"); await seg(page, "sortSeg", "cost"); await page.click("#ctx summary");
  await page.click("#settingsBtn"); await page.fill("#proxy", "https://proxy.test/"); await page.click("#saveSettings");
  await page.waitForFunction(() => /live price/.test(document.querySelector("#hero").textContent));
  assert.ok(asked.includes("/prices?route=HHD-DUB&date=2026-11-10&time=0600") && asked.includes("/prices?route=FGD-RSL&date=2026-11-10&time=1200"), asked.join(" "));
  const first = page.locator("#hero > .opt").first();
  assert.equal(await first.getAttribute("data-id"), "stena-HHD-DUB|2026-11-10|16:00");
  assert.match(await first.textContent(), /£150\s*AFerry live price, checked 10:00/);
  const ij = page.locator('.opt[data-id="irish-HHD-DUB|2026-11-10|19:30"]');
  assert.match(await ij.textContent(), /£185\s*AFerry live price/);                 // live £185 replaces daily £99
  assert.match(await page.textContent("#sources"), /Live AFerry searches/);
  const n = asked.length;
  await page.reload(); await page.waitForSelector("#hero .opt"); await page.waitForTimeout(300);
  assert.equal(asked.length, n, "cached for an hour: no new searches on reload");
  await ctx.close();
});

test("Operator status lozenges: on time green, short delay yellow, long delay amber, cancelled red (visible, last, struck through), moved sailing, stale and no-record states", async () => {
  const rec = (routeId, date, dep, arr, extra = {}) => { const [op, from, to] = routeId.split("-"); return { operator: op, routeId, from, to, date, dep, arr, arrDate: date, ship: "Test Ship",
    statusLabel: "On Time", status: "on-time", notice: null, originalDep: null, revisedDep: null, estimatedDep: null, replacement: null, checkInMin: null, source: "t", fetchedAt: "2026-11-03T09:30:00.000Z", ...extra }; };
  const recs = [
    rec("stena-HHD-DUB", "2026-11-10", "16:00", "19:30"),
    rec("irish-HHD-DUB", "2026-11-10", "13:15", "16:45", { status: "delayed", statusLabel: "Delayed", estimatedDep: "13:55" }),
    rec("irish-HHD-DUB", "2026-11-10", "19:30", "23:00", { status: "delayed", statusLabel: "Delayed", estimatedDep: "21:00", notice: "Delayed by weather. Latest check-in time is 30 minutes before departure." }),
    rec("irish-HHD-DUB", "2026-11-10", "07:30", "11:00", { status: "cancelled", statusLabel: "Cancelled", notice: "Cancelled due to adverse weather." }),
    rec("irish-PEM-RSL", "2026-11-10", "14:45", "18:46", { replacement: { operator: "stena", port: "Fishguard" }, revisedDep: "14:00", checkInMin: 60, notice: "Will now be on the StenaLine sailing from Fishguard at the earlier departure time of 14:00." }),
    rec("stena-FGD-RSL", "2026-11-10", "14:00", "17:30", { fetchedAt: "2026-11-03T06:00:00.000Z" }),
  ];
  const cov = (k, at = "2026-11-03T09:30:00.000Z") => [k, { fetchedAt: at, source: "t" }];
  const status = { schema: 1, collectedAt: "2026-11-03T09:30:00.000Z", complete: true,
    sources: { t: { ok: true, fetchedAt: "2026-11-03T09:30:00.000Z", operator: "stena", routeIds: ["x"], lastGoodAt: "2026-11-03T09:30:00.000Z" } },
    coverage: Object.fromEntries([cov("stena-HHD-DUB|2026-11-10"), cov("irish-HHD-DUB|2026-11-10"), cov("irish-PEM-RSL|2026-11-10"), cov("stena-FGD-RSL|2026-11-10", "2026-11-03T06:00:00.000Z")]),
    sailings: Object.fromEntries(recs.map(r => [`${r.routeId}|${r.date}|${r.dep}`, r])) };
  const { page, ctx } = await openPage({ status });
  await seg(page, "questionSeg", "fastest");
  const lz = async (id) => { const el = page.locator(`.opt[data-id="${id}"] .status-lz`); return [await el.textContent(), (await el.getAttribute("class")).replace("status-lz ", "")]; };
  assert.deepEqual(await lz("stena-HHD-DUB|2026-11-10|16:00"), ["On time", "lvl-ok"]);
  assert.deepEqual(await lz("irish-HHD-DUB|2026-11-10|13:15"), ["Delayed 40 min", "lvl-caution"]);
  assert.deepEqual(await lz("irish-HHD-DUB|2026-11-10|19:30"), ["Delayed 1h 30m", "lvl-warn"]);
  assert.deepEqual(await lz("irish-HHD-DUB|2026-11-10|07:30"), ["Cancelled", "lvl-bad"]);
  assert.match((await lz("irish-PEM-RSL|2026-11-10|14:45"))[0], /moved to Stena Line from Fishguard 14:00/);
  assert.equal((await lz("irish-PEM-RSL|2026-11-10|14:45"))[1], "lvl-caution");
  assert.match((await lz("stena-FGD-RSL|2026-11-10|14:00"))[0], /^Status unavailable/); // read 06:00, now 10:00: older than 2 h
  // Expected column: estimate in colour when delayed; "On time"; "Cancelled"; "Not live" for a timetable estimate.
  const expected = async (id) => page.locator(`.opt[data-id="${id}"] .leg-cols > div:nth-child(2) .legbig`).textContent();
  assert.equal(await expected("irish-HHD-DUB|2026-11-10|19:30"), "21:00");
  assert.equal(await expected("stena-HHD-DUB|2026-11-10|16:00"), "On time");
  assert.equal(await expected("irish-HHD-DUB|2026-11-10|07:30"), "Cancelled");
  assert.equal(await expected("stena-HHD-DUB|2026-11-11|04:00"), "Not live"); // next day: no coverage -> timetable estimate
  assert.match(await page.locator('.opt[data-id="stena-HHD-DUB|2026-11-11|04:00"] .leg-status').textContent(), /Timetable estimate/);
  // Delay recalculates the arrival home and shows the timetable arrival; check-in time unchanged.
  const late = page.locator('.opt[data-id="irish-HHD-DUB|2026-11-10|19:30"]');
  assert.match(await late.textContent(), /At Borris \(expected\)\s*02:30[\s\S]*timetable 01:00/); // 21:00+3h30 = 00:30, +20 off, +1h40 drive
  assert.match(await late.textContent(), /Check-in closes 19:00/);
  // Cancelled: still listed, never best, struck through, last.
  const ids = await page.$$eval("#hero .opt, #list .opt", els => els.map(e => e.dataset.id));
  assert.ok(ids.includes("irish-HHD-DUB|2026-11-10|07:30")); assert.notEqual(ids[0], "irish-HHD-DUB|2026-11-10|07:30"); assert.equal(ids.at(-1), "irish-HHD-DUB|2026-11-10|07:30");
  assert.ok(await page.locator('.opt[data-id="irish-HHD-DUB|2026-11-10|07:30"]').evaluate(e => e.classList.contains("unavailable")));
  // Moved sailing: leaves from Fishguard at 14:00 with Stena's crossing and a 60-minute check-in.
  const moved = page.locator('.opt[data-id="irish-PEM-RSL|2026-11-10|14:45"]');
  assert.match(await moved.textContent(), /Ferry from Fishguard → Rosslare Europort[\s\S]*Timetable departure\s*14:00[\s\S]*Check-in closes 13:00/);
  // Data sources row says when status was collected.
  assert.match(await page.textContent("#sources"), /Sailing status\s*collected Tue 3 Nov \(today\)/);
  await ctx.close();
});

test("Live status via the proxy: operator pages read on open replace the collected file per source; failed sources keep the older data", async () => {
  const rec = (routeId, date, dep, arr, extra = {}) => { const [op, from, to] = routeId.split("-"); return { operator: op, routeId, from, to, date, dep, arr, arrDate: date, ship: "S", statusLabel: "On Time", status: "on-time", notice: null, originalDep: null, revisedDep: null, estimatedDep: null, replacement: null, checkInMin: null, ...extra }; };
  const OLD = "2026-11-03T08:00:00.000Z", NEW = "2026-11-03T09:58:00.000Z";
  const file = { schema: 1, collectedAt: OLD, complete: true,
    sources: { s6: { ok: true, fetchedAt: OLD, operator: "stena", routeIds: ["stena-HHD-DUB"], lastGoodAt: OLD }, i1: { ok: true, fetchedAt: OLD, operator: "irish", routeIds: ["irish-HHD-DUB"], lastGoodAt: OLD } },
    coverage: { "stena-HHD-DUB|2026-11-10": { source: "s6", fetchedAt: OLD }, "irish-HHD-DUB|2026-11-10": { source: "i1", fetchedAt: OLD } },
    sailings: { "stena-HHD-DUB|2026-11-10|16:00": rec("stena-HHD-DUB", "2026-11-10", "16:00", "19:30", { source: "s6", fetchedAt: OLD }),
                "irish-HHD-DUB|2026-11-10|19:30": rec("irish-HHD-DUB", "2026-11-10", "19:30", "23:00", { source: "i1", fetchedAt: OLD }) } };
  const live = { schema: 1, collectedAt: NEW, complete: false, via: "proxy",
    sources: { s6: { ok: true, fetchedAt: NEW, operator: "stena", routeIds: ["stena-HHD-DUB"], lastGoodAt: NEW }, i1: { ok: false, fetchedAt: null, error: "HTTP 503", operator: "irish", routeIds: ["irish-HHD-DUB"] } },
    coverage: { "stena-HHD-DUB|2026-11-10": { source: "s6", fetchedAt: NEW } },
    sailings: { "stena-HHD-DUB|2026-11-10|16:00": rec("stena-HHD-DUB", "2026-11-10", "16:00", "19:30", { source: "s6", fetchedAt: NEW, status: "delayed", statusLabel: "Delayed", estimatedDep: "16:40" }) } };
  const { page, ctx } = await openPage({ status: file });
  let statusCalls = 0;
  await page.route("https://proxy.test/**", (route) => { const u = new URL(route.request().url());
    if (u.pathname === "/status") { statusCalls++; return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(live) }); }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ checkedAt: NEW, rows: [] }) }); });
  await seg(page, "questionSeg", "fastest");
  const lz = (id) => page.locator(`.opt[data-id="${id}"] .status-lz`).textContent();
  assert.equal(await lz("stena-HHD-DUB|2026-11-10|16:00"), "On time"); // from the file, before the proxy is set
  await page.click("#settingsBtn"); await page.fill("#proxy", "https://proxy.test"); await page.click("#saveSettings");
  await page.waitForFunction(() => /Delayed 40 min/.test(document.querySelector("#hero, #list") && document.body.textContent));
  assert.equal(await lz("stena-HHD-DUB|2026-11-10|16:00"), "Delayed 40 min");             // live Stena read replaced the file
  assert.equal(await lz("irish-HHD-DUB|2026-11-10|19:30"), "On time");                   // Irish read failed live: older data kept
  assert.match(await page.locator('.opt[data-id="irish-HHD-DUB|2026-11-10|19:30"] .leg-status').textContent(), /read 08:00/);
  assert.match(await page.locator('.opt[data-id="stena-HHD-DUB|2026-11-10|16:00"] .leg-status').textContent(), /read 09:58/);
  assert.match(await page.textContent("#banner"), /Sailing status read live 09:58/);
  assert.match(await page.textContent("#sources"), /read live through your proxy[\s\S]*incomplete; older collected data fills in/);
  assert.equal(statusCalls, 1);
  await ctx.close();
});

test("Proxy version: the app compares the Worker's fingerprint with its own and flags a Worker running older code", async () => {
  const expected = (readFileSync(new URL("../proxy/version.mjs", import.meta.url), "utf8").match(/WORKER_VERSION = "([0-9a-f]+)"/) || [])[1];
  assert.match(expected, /^[0-9a-f]{12}$/);
  for (const [live, stale] of [[expected, false], ["0123456789ab", true]]) {
    const { page, ctx } = await openPage();
    await page.route("https://proxy.test/**", (route) => { const u = new URL(route.request().url());
      if (u.pathname === "/version") return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ version: live }) });
      return route.fulfill({ status: 502, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "x" }) }); });
    await page.click("#settingsBtn"); await page.fill("#proxy", "https://proxy.test"); await page.click("#saveSettings");
    await page.waitForFunction(() => /Proxy/.test(document.querySelector("#sources").textContent) && !/Checking/.test(document.querySelector("#sources").textContent));
    const row = await page.locator("#sources .src-row", { hasText: "Proxy" }).textContent();
    if (stale) {
      assert.match(row, new RegExp(`Running older code \\(0123456789ab; the app expects ${expected}\\)`));
      assert.match(await page.textContent("#banner"), /Proxy running older code/);
    } else {
      assert.match(row, new RegExp(`Running the app's code \\(${expected}\\)`));
      assert.doesNotMatch(await page.textContent("#banner"), /Proxy/);
    }
    await ctx.close();
  }
});
