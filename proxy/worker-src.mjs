// Cloudflare Worker for Cartref Borris (source; `node tools/build-worker.mjs` writes the paste-ready proxy/worker.js).
// GET /prices?route=HHD-DUB&date=2026-11-20&time=0600  -> live AFerry prices (car + 2 adults, one way), cached 1 hour.
// GET /status  -> the operators' sailing status read now (same shape as data/sailing-status.json), cached 3 minutes.
// Only fixed upstream hosts; only requests from ALLOW_ORIGIN (e.g. https://srapley-spec.github.io).
//
// Setup (Cloudflare dashboard → Workers & Pages → Create → Worker → paste proxy/worker.js):
//   Settings → Variables: ALLOW_ORIGIN (Text) = https://srapley-spec.github.io
//   Then in the app: Settings → Proxy URL = the worker's https://… address.
import { ROUTES, searchAferry } from "../tools/aferry-search.mjs";
import { collect } from "../tools/status-core.mjs";

const PRICE_TTL_S = 3600;
const STATUS_TTL_S = 180;

export function validPricesQuery(q, todayISO) {
  const route = q.get("route"), date = q.get("date"), time = q.get("time") || "0000";
  if (!ROUTES[route]) return { error: "unknown route" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || date < todayISO) return { error: "bad date" };
  if (!/^([01]\d|2[0-3])[0-5]\d$/.test(time)) return { error: "bad time" };
  return { route, date, time };
}

export async function handle(request, env, { fetchFn = fetch, cache = null, sleep, now = () => Date.now() } = {}) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOW_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return new Response("Proxy not configured: set ALLOW_ORIGIN.", { status: 500 });
  if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });
  const cors = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
  const url = new URL(request.url);
  const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

  if (url.pathname === "/prices") {
    const q = validPricesQuery(url.searchParams, new Date(now()).toISOString().slice(0, 10));
    if (q.error) return json({ error: q.error }, 400);
    const key = new Request(`https://cache.cartref-borris/prices/${q.route}/${q.date}/${q.time}`);
    const hit = cache && await cache.match(key);
    if (hit) { const body = await hit.json(); return json({ ...body, cached: true }); }
    try {
      const r = await searchAferry(q.route, q.date, { time: q.time, fetchFn, ...(sleep ? { sleep } : {}) });
      const body = { ...q, checkedAt: new Date(now()).toISOString(), rows: r.rows, source: "AFerry live search", url: r.url };
      if (cache && r.rows.length) await cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${PRICE_TTL_S}` } }));
      return json(body);
    } catch (e) {
      return json({ error: `upstream: ${e.message}` }, 502);
    }
  }
  if (url.pathname === "/status") {
    const key = new Request("https://cache.cartref-borris/status");
    const hit = cache && await cache.match(key);
    if (hit) { const body = await hit.json(); return json({ ...body, cached: true }); }
    const { file } = await collect({ prev: null, fetchFn, now });
    file.via = "proxy";
    // Cache even a partial result (its sources say what failed) so a flapping operator page is not hammered.
    if (cache) await cache.put(key, new Response(JSON.stringify(file), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${STATUS_TTL_S}` } }));
    return json(file);
  }
  return new Response("Not found", { status: 404, headers: cors });
}

export default { fetch: (request, env, ctx) => handle(request, env, { cache: typeof caches !== "undefined" ? caches.default : null }) };
