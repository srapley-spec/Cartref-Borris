// Daily fare harvest (run by .github/workflows/fares.yml on GitHub's runner).
// Reads the six public AFerry route pages once each, parses them, and merges into data/fares.json:
//   quotes:  dated per-sailing prices AFerry shows under "Latest Ticket Prices" (kept until the sailing date passes)
//   routes:  12-month monthly averages per route and average per operator
// Never invents a price; a page that fails or changes shape leaves the previous data in place and is reported.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pageText, parseAferry } from "./aferry-parse.mjs";

const ROUTES = ["holyhead-dublin", "dublin-holyhead", "fishguard-rosslare", "rosslare-fishguard", "pembroke-rosslare", "rosslare-pembroke"];
const CODE = { holyhead: "HHD", dublin: "DUB", fishguard: "FGD", rosslare: "RSL", pembroke: "PEM" };
const UA = "Mozilla/5.0 (compatible; cartref-borris personal trip planner; once daily)";
const OUT = new URL("../data/fares.json", import.meta.url);
const today = (process.env.FETCH_DATE || new Date().toISOString()).slice(0, 10);

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { quotes: {}, routes: {} };
const quotes = Object.fromEntries(Object.entries(prev.quotes || {}).filter(([, q]) => q.date >= today));
const routes = { ...(prev.routes || {}) };
const report = [];

for (const slug of ROUTES) {
  const url = `https://www.aferry.com/en-gb/${slug}/`;
  const key = slug.split("-").map(p => CODE[p]).join("-");
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-GB" }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = parseAferry(pageText(await res.text()), today);
    const months = Object.keys(r.monthly).length;
    if (months === 12 || Object.keys(r.operatorAvg).length) routes[key] = { url, fetchedOn: today, monthly: r.monthly, operatorAvg: r.operatorAvg };
    for (const q of r.quotes) if (q.date >= today) quotes[q.sailingId] = { amount: q.amount, currency: "GBP", date: q.date, seenOn: today, source: "AFerry latest ticket price", url };
    report.push(`${slug}: ${r.quotes.length} quotes, ${months} months, operators ${Object.keys(r.operatorAvg).join("/") || "none"}`);
    if (months !== 12) report.push(`  WARNING ${slug}: monthly table not found (page shape changed?)`);
  } catch (e) {
    report.push(`${slug}: FAILED ${e.message} (kept previous data)`);
  }
}

const out = { fetchedAt: new Date().toISOString(), fetchedOn: today, source: "AFerry public route pages (www.aferry.com/en-gb/<route>/)", routes, quotes };
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(report.join("\n"));
console.log(`quotes kept: ${Object.keys(quotes).length}`);
for (const [id, q] of Object.entries(quotes)) console.log(`  ${id} £${q.amount} (seen ${q.seenOn})`);
