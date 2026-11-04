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

## Not done (Sam to decide)
Live prices for any date need AFerry's booking search (`book.aferry.com`) or the operators' booking engines run by a
headless browser: fragile, likely against their terms, and possibly blocked. Not built without Sam's say-so.

## Status
Built 4 Nov 2026.
