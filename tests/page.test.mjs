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

async function openPage({ google } = {}) {
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
  await page.goto(base);
  await page.waitForSelector(".opt");
  return { page, ctx, calls };
}

test("UTC conversion uses the London offset (GMT in Nov, BST in Jul)", () => {
  const m = (iso) => Date.parse(iso + "Z") / 60000;
  assert.equal(localToUtcIso(m("2026-11-20T09:00")), "2026-11-20T09:00:00.000Z");
  assert.equal(localToUtcIso(m("2026-07-20T09:00")), "2026-07-20T08:00:00.000Z");
});

test("shows outbound and return options with leave/arrive/door-to-door and the unverified banner", async () => {
  const { page, ctx } = await openPage();
  assert.equal(await page.inputValue("#out"), "2026-11-10");
  assert.equal(await page.inputValue("#back"), "2026-11-17");
  assert.match(await page.textContent("#banner"), /not yet verified/);
  const out = await page.$$("#outList .opt"), back = await page.$$("#backList .opt");
  assert.ok(out.length >= 6 && back.length >= 6, `${out.length}/${back.length}`);
  const first = await page.textContent("#outList .opt");
  assert.match(first, /Leave home\s*\d\d:\d\d/); assert.match(first, /Arrive Borris/); assert.match(first, /Door to door\s*\d+h\d\d/);
  assert.match(await page.textContent("#status"), /No Google key/);
  await ctx.close();
});

test("Day/Night filter and cost ranking with entered fares (re-ranks, persists, unpriced kept)", async () => {
  const { page, ctx } = await openPage();
  const total = (await page.$$("#outList .opt")).length;
  await page.click('.seg[data-k="outPref"] button[data-v="overnight"]');
  const night = await page.$$eval("#outList .opt", els => els.map(e => e.textContent));
  assert.ok(night.length > 0 && night.every(t => t.includes("Overnight")));
  await page.click('.seg[data-k="outPref"] button[data-v="day"]');
  const day = await page.$$eval("#outList .opt", els => els.map(e => e.textContent));
  assert.ok(day.every(t => !t.includes("Overnight")));
  assert.equal(night.length + day.length, total);

  await page.click('.seg[data-k="outPref"] button[data-v="any"]');
  await page.click('.seg[data-k="sort"] button[data-v="cost"]');
  const ids = await page.$$eval("#outList .opt", els => els.map(e => e.dataset.id));
  await page.fill(`input.fare[data-id="${ids[3]}"]`, "149"); await page.press(`input.fare[data-id="${ids[3]}"]`, "Enter");
  await page.locator(`input.fare[data-id="${ids[3]}"]`).blur();
  await page.fill(`input.fare[data-id="${ids[1]}"]`, "99.50"); await page.locator(`input.fare[data-id="${ids[1]}"]`).blur();
  const after = await page.$$eval("#outList .opt", els => els.map(e => e.dataset.id));
  assert.deepEqual(after.slice(0, 2), [ids[1], ids[3]]);
  assert.equal(after.length, total);
  assert.match(await page.textContent("#outList .opt"), /£99\.50/);
  await page.reload(); await page.waitForSelector(".opt");
  assert.deepEqual((await page.$$eval("#outList .opt", els => els.map(e => e.dataset.id))).slice(0, 2), [ids[1], ids[3]]);
  await ctx.close();
});

test("with a Google key: legs requested with key header, future departure time, and results replace estimates", async () => {
  const { page, ctx, calls } = await openPage({ google: () => ({ status: 200, contentType: "application/json", body: JSON.stringify({ routes: [{ duration: "15600s" }] }) }) });
  await page.click("details summary");
  await page.fill("#key", "test-key-not-real");
  await page.click("#saveSettings");
  await page.waitForFunction(() => !document.querySelector("#outList").textContent.includes("*"));
  assert.ok(calls.length > 0);
  assert.equal(calls[0].headers["x-goog-api-key"], "test-key-not-real");
  assert.match(calls[0].headers["x-goog-fieldmask"], /routes\.duration/);
  assert.ok(calls.every(c => Date.parse(c.body.departureTime) > NOW));
  assert.ok(calls.some(c => /SG6 3LT/.test(c.body.origin.address)));
  assert.match(await page.textContent("#outList .legs"), /Drive 4h20 /);
  await ctx.close();
});

test("Google failure is reported and estimates are used (nothing hidden)", async () => {
  const { page, ctx } = await openPage({ google: () => ({ status: 403, body: "API key not valid" }) });
  const before = (await page.$$("#outList .opt")).length;
  await page.click("details summary"); await page.fill("#key", "bad"); await page.click("#saveSettings");
  await page.waitForFunction(() => /failed/.test(document.querySelector("#status").textContent));
  assert.match(await page.textContent("#status"), /403/);
  assert.equal((await page.$$("#outList .opt")).length, before);
  await ctx.close();
});
