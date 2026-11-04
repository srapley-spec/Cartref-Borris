// One-off probe (GitHub runner): where does AFerry get per-sailing prices from?
// Fetches one route page, its embedded state and its timetable micro-frontend bundles, and logs endpoints and
// price-shaped data. Read-only; a handful of requests; no booking or search submission.

const PAGE = process.env.AFERRY_PAGE || "https://www.aferry.com/en-gb/pembroke-rosslare/";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const get = async (url, accept = "*/*") => {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-GB" }, signal: AbortSignal.timeout(20000) });
  return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
};
const uniq = (a) => [...new Set(a)];

const page = await get(PAGE, "text/html");
console.log(`page ${PAGE} status ${page.status} bytes ${page.body.length}`);
const base = new URL(PAGE);

// 1. Embedded state blocks
for (const m of page.body.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1], body = m[2];
  if (!/json|qwik|state|__/i.test(attrs + body.slice(0, 200))) continue;
  const prices = body.match(/"(?:price|amount|fare|total|from|minPrice|lowestPrice|cheapest)[A-Za-z]*"\s*:\s*"?[\d.]+/gi) || [];
  const dates = body.match(/20\d\d-\d\d-\d\dT?\d{0,2}:?\d{0,2}/g) || [];
  console.log(`\n-- script ${attrs.trim().slice(0, 80)} bytes ${body.length} priceKeys ${prices.length} dates ${dates.length}`);
  if (prices.length) console.log(`   price samples: ${uniq(prices).slice(0, 15).join(" | ")}`);
  if (dates.length) console.log(`   date samples: ${uniq(dates).slice(0, 10).join(" ")}`);
  const idx = body.search(/price|fare/i);
  if (idx >= 0) console.log(`   context: ${body.slice(Math.max(0, idx - 300), idx + 500).replace(/\s+/g, " ")}`);
}

// 2. Data attributes / inline JSON mentioning prices in the HTML
const priceAttrs = uniq(page.body.match(/data-[a-z-]*(?:price|fare|amount)[a-z-]*="[^"]{0,60}"/gi) || []);
console.log(`\nprice data-attributes: ${priceAttrs.slice(0, 20).join(" ")}`);
const pounds = page.body.match(/£\s?\d{2,4}/g) || [];
console.log(`£ amounts in HTML: ${pounds.length}: ${uniq(pounds).slice(0, 30).join(" ")}`);

// 3. Micro-frontend bundles: find endpoints
const scripts = uniq([...page.body.matchAll(/(?:src|href)="([^"]*\/mfe\/[^"]+\.(?:js|json))"/g)].map(m => new URL(m[1], base).href));
console.log(`\nmfe assets: ${scripts.length}`);
const endpoints = new Set();
const queue = [...scripts];
const seen = new Set();
while (queue.length && seen.size < 40) {
  const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
  let r; try { r = await get(u); } catch (e) { console.log(`  ${u} ERROR ${e.message}`); continue; }
  const b = r.body;
  for (const m of b.matchAll(/["'`](\/(?:api|mfe|ajax|svc|services?|bff|graphql|search|timetable|prices?|fares?|availability)[^"'`\s]{0,120})["'`]/gi)) endpoints.add(m[1]);
  for (const m of b.matchAll(/["'`](https?:\/\/[^"'`\s]{4,160})["'`]/g)) if (!/w3\.org|schema\.org|googletagmanager|facebook|sentry/i.test(m[1])) endpoints.add(m[1]);
  for (const m of b.matchAll(/["'`](\.{0,2}\/?q-[A-Za-z0-9_-]+\.js)["'`]/g)) queue.push(new URL(m[1], u).href);
  const hits = (b.match(/price|fare|availability|timetable|departure/gi) || []).length;
  console.log(`  ${u.split("/").slice(-1)[0]} ${r.status} ${b.length}B keywords ${hits}`);
  if (hits > 3) { const i = b.search(/fetch\(|\$fetch|axios|XMLHttpRequest/); if (i >= 0) console.log(`    fetch ctx: ${b.slice(Math.max(0, i - 200), i + 300).replace(/\s+/g, " ")}`); }
}
console.log(`\nendpoint-like strings (${endpoints.size}):\n  ${[...endpoints].slice(0, 80).join("\n  ")}`);
