// Page in a real browser (Playwright/Chromium), Google mocked, virtual clock Tue 3 Nov 2026 10:00 London.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";
// require() so a globally installed Playwright (cloud sessions) and the devDependency (CI) both resolve.
const { chromium } = createRequire(import.meta.url)("playwright");
import { localToUtcIso } from "../src/google.js";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
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

async function openPage({ google, fares, ships } = {}) {
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
  // 19:30 − 30 check-in − 15 margin = 18:45; − 285 drive − 30 (1 stop, the default) = 13:30.
  assert.match(text, /Leave by\s*13:30/); assert.match(text, /At Borris/);
  assert.match(text, /Total journey \d+h \d\dm/); assert.match(text, /leave in 3h 30m/);
  assert.match(text, /Arrives first/);
  assert.match(text, /Next: 19:30 Irish Ferries from Holyhead/);
  assert.match(text, /Timetable departure\s*19:30/); assert.match(text, /Expected departure\s*Not live/); assert.match(text, /At Dublin Port\s*23:00/);
  assert.equal(await best.locator(".op img").getAttribute("alt"), "Irish Ferries");
  assert.ok(await best.locator(".op img").evaluate(i => i.complete && i.naturalWidth > 0), "logo loads");
  assert.match(await page.textContent("#hero .next-best"), /Next best[\s\S]*Leave by/);
  // No fares/ships files in this test: those sources say "never updated" and the banner asks for a check.
  assert.equal((await page.textContent("#banner")).replace(/\s+/g, " ").trim(), "Ferry times checked today · Prices never updated · Ships never updated · Drive times: estimates Check before booking.");
  assert.match(text, /Times checked with Irish Ferries Tue 3 Nov/);
  assert.match(text, /~£163\s*typical, not a quote \(AFerry operator average, 3 Nov\)/);
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
  assert.ok(calls.every(c => Date.parse(c.body.departureTime) > NOW));
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
  const best = page.locator("#hero > .opt").first(); // Irish Ferries 19:30 Holyhead (James Joyce)
  const out = best.locator(".drive-leg").nth(0), irl = best.locator(".drive-leg").nth(1);
  assert.deepEqual(await out.locator(".road").allTextContents(), ["A1(M)", "A14", "M6", "M56", "A55"]);
  assert.match(await out.textContent(), /typical roads, unchecked/);
  assert.deepEqual(await irl.locator(".road").evaluateAll(els => els.map(e => e.className)), ["road road-m ie", "road road-m ie"]);
  assert.match(await best.locator(".ship").textContent(), /Standard ferry · James Joyce/);
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
  assert.match(await page.locator("#hero > .opt .ship").first().textContent(), /Standard ferry · Ulysses/); // stored: James Joyce
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
  assert.equal(banner, "Ferry times checked today · Prices updated 4 days ago · Ships updated yesterday · Drive times: estimates Check before booking.");
  assert.deepEqual(await page.locator("#banner .stale").allTextContents(), ["Prices updated 4 days ago", "Check before booking."]);
  const rows = await page.locator("#sources .src-row").allTextContents();
  assert.equal(rows.length, 4);
  assert.match(rows[0], /Ferry times\s*checked Tue 3 Nov \(today\)/);
  assert.match(rows[1], /Prices\s*updated Fri 30 Oct \(4 days ago\) · out of date/);
  assert.match(rows[2], /Ships\s*updated Mon 2 Nov \(yesterday\)/);
  assert.match(rows[3], /Drive times\s*never updated[\s\S]*No Google key/);
  assert.equal(await page.locator("#sources .src-row.stale").count(), 1);
  await ctx.close();
});
