// Probe (GitHub runner, real browser): what does AFerry's search do, and where do per-sailing prices come from?
// Opens a route page, presses the search button with the page's defaults, follows to the results, and logs requests,
// price-bearing responses, the final URL and visible prices. Screenshots go to probe-out/ (uploaded as an artifact).
// Read-only: never selects a sailing or enters personal details.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PAGE = process.env.AFERRY_PAGE || "https://www.aferry.com/en-gb/holyhead-dublin/";
mkdirSync("probe-out", { recursive: true });
const SKIP = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css)(\?|$)|google|doubleclick|facebook|snowplow|hotjar|clarity|sentry|cookiebot|onetrust|tiktok|bing|trustpilot|cloudimg|contentstack|graphassets/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "en-GB", timezoneId: "Europe/London", viewport: { width: 1280, height: 900 },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
const log = (...a) => console.log(...a);

page.on("response", async (res) => {
  const url = res.url(), req = res.request();
  if (SKIP.test(url)) return;
  const type = res.headers()["content-type"] || "";
  if (!/json|html|text\/plain|javascript/.test(type) || /\.js(\?|$)/.test(url)) { if (req.resourceType() === "document") log(`DOC ${res.status()} ${url}`); return; }
  let body = ""; try { body = await res.text(); } catch { return; }
  const pricey = /"?(price|fare|amount|total)"?\s*[:=]/i.test(body) || /£\s?\d/.test(body);
  log(`${req.method()} ${res.status()} ${req.resourceType()} ${url.slice(0, 220)} ${type.split(";")[0]} ${body.length}B${pricey ? " PRICES?" : ""}`);
  if (req.method() === "POST") log(`   post: ${(req.postData() || "").slice(0, 600)}`);
  if (pricey && /json/.test(type)) log(`   body: ${body.replace(/\s+/g, " ").slice(0, 1500)}`);
});

async function snap(name) { await page.screenshot({ path: `probe-out/${name}.png`, fullPage: false }).catch(() => {}); }
async function visiblePrices(tag) {
  const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
  const hits = [...txt.matchAll(/£\s?\d[\d,]*(\.\d\d)?/g)].slice(0, 40).map(m => txt.slice(Math.max(0, m.index - 90), m.index + 20).replace(/\s+/g, " "));
  log(`\n[${tag}] url ${page.url()}\n[${tag}] title ${await page.title().catch(() => "?")}\n[${tag}] bot-check: ${/just a moment|verify you are human|captcha|access denied/i.test(txt)}`);
  for (const h of hits) log(`  £ ${h}`);
  log(`[${tag}] text head: ${txt.replace(/\s+/g, " ").slice(0, 800)}`);
}

log(`open ${PAGE}`);
await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
for (const sel of ['button:has-text("Accept")', 'button:has-text("Accept all")', "#onetrust-accept-btn-handler", 'button:has-text("Allow all")']) {
  if (await page.locator(sel).first().isVisible().catch(() => false)) { await page.locator(sel).first().click().catch(() => {}); log(`clicked ${sel}`); break; }
}
await snap("1-route-page");
const buttons = await page.$$eval("button, a", els => els.map(e => (e.innerText || e.getAttribute("aria-label") || "").trim()).filter(t => /search|get ticket|get price|find/i.test(t)).slice(0, 15));
log(`search-like buttons: ${JSON.stringify(buttons)}`);
const forms = await page.$$eval("form", fs => fs.map(f => ({ action: f.action, method: f.method, fields: [...f.elements].map(e => `${e.name || e.id}=${(e.value || "").slice(0, 30)}`).slice(0, 30) })));
log(`forms: ${JSON.stringify(forms).slice(0, 2500)}`);

const btn = page.locator('[data-testid*="search" i] button, button.searchButton, #searchButton, button:has-text("Get Tickets"), button:has-text("Search")').first();
if (await btn.isVisible().catch(() => false)) {
  log("pressing search");
  const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null), btn.click().catch(e => log(`click failed ${e.message}`))]);
  const p2 = popup || page;
  if (popup) log(`search opened a new tab`);
  await p2.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 9; i++) { await p2.waitForTimeout(5000); if (/£\s?\d/.test(await p2.evaluate(() => document.body.innerText).catch(() => ""))) break; }
  if (popup) { await popup.screenshot({ path: "probe-out/2-results.png" }).catch(() => {}); }
  else await snap("2-results");
  if (!popup) await visiblePrices("results");
  else { const txt = await popup.evaluate(() => document.body.innerText).catch(() => ""); log(`[popup] ${popup.url()}\n${txt.replace(/\s+/g, " ").slice(0, 2500)}`); }
} else {
  log("no search button found");
  await visiblePrices("route-page");
}
await browser.close();
