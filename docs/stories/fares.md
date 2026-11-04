# Fares: fetched quotes, typical prices, entered quotes

**Who:** Sam. **Why (3–4 Nov 2026):** "Ideally we do need prices." Stena Line and Irish Ferries publish no fare API;
Direct Ferries is Cloudflare-blocked; Stena's booking API is behind Cloudflare Turnstile. AFerry's public route pages
(probed from GitHub's runner, `tools/probe-aferry.mjs`, 4 Nov) carry two kinds of real price data.

## What the app uses
1. **AFerry "Latest Ticket Prices"**: dated prices for specific sailings (e.g. Pembroke → Rosslare, Fri 6 Nov 14:45,
   Irish Ferries, £192.00). Sparse: a few per route. Keyed to our sailing id; kept until the sailing date passes.
   Shown as "£192 · AFerry price for this sailing, seen <date>". Prices move, so the seen date is always shown.
2. **AFerry monthly averages** per route (12 months of crossings) and per operator. Shown as "~£180 · typical, not a
   quote (AFerry route average for Nov)". Holyhead–Dublin's monthly figure covers both operators.
3. **Sam's entered quote** always wins over both.

## Acceptance criteria
1. A daily GitHub Action (`.github/workflows/fares.yml`, 04:23 UTC, also manual) reads the six AFerry route pages once
   each, parses them (`tools/aferry-parse.mjs`), merges into `data/fares.json` and commits only if it changed. A failed
   or changed page keeps the previous data and is reported in the job log; no price is invented.
   → `tests/aferry-parse.test.mjs` (all four tests)
2. Cheapest ranks in three tiers, nothing dropped: real prices (entered or fetched quote) cheapest first; then typical
   prices cheapest first; then unpriced by time. The best label says "Cheapest" for a real price and "Cheapest typical
   price" otherwise. → `tests/plan.test.mjs` "rank by cost: real prices first…", "Cheapest within a question…"
3. The page shows which kind of price each option has. → `tests/page.test.mjs` "Fetched fares: an AFerry quote…",
   "Leave now (default)…"
4. Tests never read the live `data/fares.json` (it changes daily). → page tests route it.

## Live prices (Sam, 4 Nov: "Try the AFerry booking search for live prices")
AFerry's search works with two plain requests (no browser), found 4 Nov: `POST /mfe/search/v2/` with one leg (route code,
date, time, 2 adults, standard car) returns `{ location: /en-gb/search/<id>/ }`; that page, fetched a few seconds later,
lists the ~8 sailings nearest the requested time (±1 day, both operators, neighbouring Rosslare routes too) with prices.
A "Searching Stena Line..." placeholder stays on the finished page, so polling stops when two fetches agree. Requests
identify as "cartref-borris personal trip planner"; AFerry serves a 404 to a browser announcing itself as headless, and
we do not disguise the client. Stena's own site (Cloudflare Turnstile) is not touched: Stena prices come via AFerry.

5. A Cloudflare Worker (`proxy/worker-src.mjs`, bundled to paste-ready `proxy/worker.js` by `tools/build-worker.mjs`)
   serves `GET /prices?route=&date=&time=`, only to `ALLOW_ORIGIN`, validates input, caches results an hour.
   → `tests/live-prices.test.mjs` "worker…", "paste-ready proxy/worker.js is up to date…"
6. With Settings → Proxy URL set, the app searches the date on screen: Holyhead at 06:00, 09:00 and 18:00, Rosslare at
   12:00, plus the next morning's Holyhead window (5 searches, ~20 s, in parallel), caches them an hour on the phone, and
   maps rows to our sailings by ports and departure time. Live prices beat daily dated prices; Sam's entered quote beats
   both. Shown as "£150 · AFerry live price, checked 10:00". → "price searches…", "live rows map…", page "Live prices via
   the proxy…"
7. Parser and flow are tested against a real results-page slice (`tests/fixtures/aferry-results-HHD-DUB-2026-11-20.html`).
   → "AFerry results parser…", "searchAferry…"

## Status
Built 4 Nov 2026; live prices added the same day (needs the Worker deployed).
