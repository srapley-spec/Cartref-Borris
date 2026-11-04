// Checks the deployed Cloudflare Worker (run by .github/workflows/worker-check.yml on GitHub's runner).
//  1. Version: polls /version until it reports the repo's WORKER_VERSION (Cloudflare redeploys a minute or two after a
//     push to main) or the wait runs out -> fails: the live Worker is running stale code.
//  2. Status: /status must return the operators' sailings (at least one source ok, records > 0).
//  3. Prices: /prices for a date two weeks out must return rows (one AFerry search).
// Exit code 1 on any failure, so GitHub marks the run failed and emails the repo owner.
import { WORKER_VERSION } from "../proxy/version.mjs";

const BASE = (process.env.WORKER_URL || "https://cartref-borris.s-rapley.workers.dev").replace(/\/+$/, "");
const ORIGIN = process.env.ALLOW_ORIGIN || "https://srapley-spec.github.io";
const WAIT_MS = +(process.env.WAIT_MS || 15 * 60000);
const SKIP_PRICES = process.env.SKIP_PRICES === "1";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = async (path, timeout = 60000) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Origin: ORIGIN, "User-Agent": "cartref-borris worker check" }, signal: AbortSignal.timeout(timeout) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const failures = [];

// 1. Version
const t0 = Date.now(); let live = null, attempts = 0;
while (true) {
  attempts++;
  try { const r = await get("/version", 20000); live = r.json?.version || `HTTP ${r.status}: ${r.text.slice(0, 80)}`; } catch (e) { live = `error: ${e.message}`; }
  if (live === WORKER_VERSION) break;
  if (Date.now() - t0 > WAIT_MS) break;
  await sleep(30000);
}
const waited = Math.round((Date.now() - t0) / 1000);
if (live === WORKER_VERSION) console.log(`version: ok ${live} (matched after ${waited}s, ${attempts} tries)`);
else { console.log(`version: STALE live=${live} repo=${WORKER_VERSION} after ${waited}s`); failures.push(`Worker at ${BASE} is not running the repo's code (live ${live}, repo ${WORKER_VERSION}). Check the Cloudflare build for this push.`); }

// 2. Status
try {
  const r = await get("/status", 90000);
  const srcs = Object.entries(r.json?.sources || {});
  const ok = srcs.filter(([, s]) => s.ok);
  console.log(`status: HTTP ${r.status}, ${ok.length}/${srcs.length} sources ok, ${Object.keys(r.json?.sailings || {}).length} records${r.json?.cached ? " (cached)" : ""}`);
  for (const [k, s] of srcs) console.log(`  ${k}: ${s.ok ? `ok ${s.sailingsSeen}` : `FAILED ${s.error}`}`);
  if (r.status !== 200 || !ok.length || !Object.keys(r.json?.sailings || {}).length) failures.push(`/status returned no operator sailings (HTTP ${r.status}).`);
} catch (e) { failures.push(`/status failed: ${e.message}`); }

// 3. Prices
if (!SKIP_PRICES) {
  const d = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  try {
    const r = await get(`/prices?route=HHD-DUB&date=${d}&time=1200`, 90000);
    const rows = r.json?.rows || [];
    console.log(`prices: HTTP ${r.status}, ${rows.length} rows for Holyhead→Dublin ${d}${r.json?.cached ? " (cached)" : ""}${rows[0] ? `, e.g. ${rows[0].dep} £${rows[0].amount}` : ""}`);
    if (r.status !== 200 || !rows.length) failures.push(`/prices returned no prices (HTTP ${r.status}${r.json?.error ? `: ${r.json.error}` : ""}).`);
  } catch (e) { failures.push(`/prices failed: ${e.message}`); }
}

if (failures.length) { console.log(`\nFAILED:\n- ${failures.join("\n- ")}`); process.exit(1); }
console.log("\nWorker OK: running the repo's code and answering with live data.");
