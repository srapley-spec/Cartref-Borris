// Daily fare harvest (run by .github/workflows/fares.yml on GitHub's runner).
// Reads the six public AFerry route pages once each, parses them, and merges into data/fares.json:
//   quotes:  dated per-sailing prices AFerry shows under "Latest Ticket Prices" (kept until the sailing date passes)
//   routes:  12-month monthly averages per route and average per operator
// Never invents a price; a page that fails or changes shape leaves the previous data in place and is reported.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pageText, parseAferry } from "./aferry-parse.mjs";
import { parseIrishStatus } from "./irish-status-parse.mjs";

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

// ---- Ships actually sailing (Irish Ferries status tables): which ship ran each sailing time; Dublin Swift sightings.
const SHIPS_OUT = new URL("../data/ships.json", import.meta.url);
const STATUS_PAGES = ["https://www.irishferries.com/uk-en/sailing-updates/dublin-holyhead/", "https://www.irishferries.com/uk-en/sailing-updates/rosslare-pembroke/"];
const timetable = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url), "utf8"));
const known = new Set(timetable.routes.flatMap(r => r.sailings.map(x => `${r.id}|${x.dep}`)));
const shipsPrev = existsSync(SHIPS_OUT) ? JSON.parse(readFileSync(SHIPS_OUT, "utf8")) : {};
const keepAfter = new Date(Date.parse(today) - 21 * 86400000).toISOString().slice(0, 10);
const sailings = Object.fromEntries(Object.entries(shipsPrev.sailings || {}).filter(([, v]) => v.seenOn >= keepAfter));
const fastSeen = { ...(shipsPrev.fastShipsSeen || {}) };
for (const ship of timetable.fastShips || []) if (!(ship in fastSeen)) fastSeen[ship] = null;
const unscheduled = [];
for (const url of STATUS_PAGES) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseIrishStatus(pageText(await res.text()));
    console.log(`${url}: ${rows.length} sailings`);
    for (const r of rows) {
      const key = `${r.routeId}|${r.dep}`;
      sailings[key] = { ship: r.ship, arr: r.arr, status: r.status, seenOn: today };
      if (r.ship in fastSeen) fastSeen[r.ship] = today;
      if (!known.has(key)) unscheduled.push({ key, ...r });
      console.log(`  ${key} ${r.ship} (${r.status})${known.has(key) ? "" : "  ** not in our timetable **"}`);
    }
  } catch (e) { console.log(`${url}: FAILED ${e.message} (kept previous data)`); }
}
writeFileSync(SHIPS_OUT, JSON.stringify({ updatedOn: today, watchingSince: shipsPrev.watchingSince || today,
  source: "Irish Ferries sailing-updates status tables", fastShipsSeen: fastSeen, sailings, unscheduled }, null, 2) + "\n");
