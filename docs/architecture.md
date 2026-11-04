# Architecture

## What it is for
One journey, both ways: home (20 Hitchin Road, Letchworth SG6 3LT) ⇄ Borris, Co. Carlow, by car and ferry,
car + 2 adults. For chosen dates it lists every crossing as a door-to-door option, ranked by total time or by
cost, filtered on request to day or overnight travel.

## Layers
| Layer | File | Does |
|---|---|---|
| Data | `data/sailings.json` | Ports, operators, routes, sailing times/durations/days, check-in, fallback drive estimates, sources |
| Engine (pure) | `src/core/plan.js` | Builds options, overnight classification, filtering, ranking, round-trip summary |
| Adapter | `src/google.js` | Google Routes API `computeRoutes` from the browser (traffic-aware, future departure time) |
| Page | `src/app.js`, `index.html` | Signal layout (from Cartref Commute), questions, settings, fares entry, drive-time fetch + cache, drawing |
| Fares | `data/fares.json`, written daily by `tools/fetch-fares.mjs` (GitHub Action `fares.yml`) | AFerry dated quotes, monthly and operator averages; see [fares story](stories/fares.md) |

## Option model
For a sailing departing `dep` with crossing `durMin` and operator check-in `checkInMin`:
- at port by = `dep − checkInMin − margin` (margin: Settings, default 15)
- leave = at port by − drive(start → port, departing then)
- arrive = `dep + durMin + disembark` (Settings, default 20) + drive(port → end)
- Stops: `stops × stopMin` (default 1 × 30) added to the UK drive only.
- Questions (`answer()`): Leave now, Arrive by, Leave around (−60/+180), Fastest; see [questions story](stories/questions-and-signal-ui.md).
- "Leaving on date D" means **leaving the start point** on D, so a 02:45 sailing on D+1 is a D-evening option.
- **Overnight** = any part of the door-to-door journey falls between 00:00 and 05:00 (leaving home at 02:00 for
  a 07:30 boat is overnight travel even though the crossing is in daylight).

## Data sources and how verified they are (3 Nov 2026)
- **Sailings: checked 3 Nov 2026** by `tools/probe-sources.mjs`, run on GitHub's runner (manual workflow
  "Probe ferry sources"; the build session's network blocks these hosts). Irish Ferries routes match Irish Ferries'
  own sailing-updates status tables; all routes match AFerry's per-date departure lists. Stena's pages carry no times
  in HTML and its booking API is behind Cloudflare Turnstile, so Stena times are via AFerry only (flagged per option).
  Day-of-week patterns (Pembroke 02:45, Rosslare 20:45) are from Direct Ferries and unconfirmed (flagged). The probe
  corrected Irish Ferries Dublin→Holyhead to 01:15/07:30/13:45/19:45. Seasonal changes are not modelled.
- **What each source allows (probe, 3 Nov):** Irish Ferries status pages: readable HTML, today's scheduled times,
  ship, status. AFerry: readable, per-date departure list, average car fare per operator/route; per-sailing prices
  load in a JS micro-frontend (not yet investigated). Direct Ferries: Cloudflare 403. Ferryhopper/Ferryscanner:
  prose only. Stena: homepage "from" price only.
- **Fares:** AFerry dated quotes (per sailing) and monthly/operator averages, harvested daily; quotes rank first, typical
  prices order the unquoted options, both labelled. Live any-date prices need a booking engine: not built (Sam to decide).
- **Excluded:** Liverpool–Dublin (P&O may have ended it Dec 2023; conflicting evidence), Cairnryan–Belfast/Larne
  (not competitive for south Carlow).
- **Drive times:** Google Routes API when a key is in Settings (cached per leg per 30-minute departure bucket in
  localStorage); otherwise rough estimates in the data, marked `*`. The estimates are unmeasured.
- **Fares (per sailing): none fetched yet.** Neither operator publishes a fare API. Sam chose to investigate automated fetching
  (scraping); that needs the operator domains allowed in the environment and must run server-side (browsers
  block cross-site reads). Until then Sam types the quote he sees; it is saved on the phone and re-ranks.

## Decisions log
- **3 Nov 2026** Separate repo, not part of Cartref Commute (Sam). Car + 2 adults (Sam). Google key: env secret for
  verification, phone Settings for use (Sam). Try live fare scraping (Sam); entered fares are the fallback.
- **3 Nov 2026** Google Routes is called directly from the page: `routes.googleapis.com` returned
  `access-control-allow-origin` for `https://srapley-spec.github.io` on a preflight, so no proxy is needed.
- **3 Nov 2026** Overnight judged door to door, not by crossing (see Option model).
- **3 Nov 2026** UK and Ireland share a UTC offset year-round, so all times are one wall clock. A clock-change
  night is out by an hour for journeys spanning 01:00–02:00. Accepted.

- **3 Nov 2026** UI copies Cartref Commute's Signal design (Sam). The ferry panel keeps Signal's fixed three columns;
  "Expected departure" says "Not live" because no live ferry feed exists. Operator logos supplied by Sam (`assets/`).
- **3 Nov 2026** Fast ferry modelled as Dublin Swift only, seasonal, off by default; times from memory (low confidence).
- **3 Nov 2026** A Google key was pasted into chat. It was not used or stored (project rule); Sam asked to regenerate it.

- **4 Nov 2026** Fares from AFerry public route pages, daily (Sam: "we do need prices"). Typical (average) prices may
  order unquoted options in Cheapest, labelled as typical; this refines the earlier "never ranked on".

## Known gaps / next
1. Confirm Stena times from Stena itself and the day-of-week patterns; re-run the probe when timetables change.
2. Measure the fallback drive estimates with Google (needs `GOOGLE_MAPS_KEY` in the environment).
3. Live any-date fares (booking-engine automation) only if Sam agrees; return-fare vs two-singles pricing; cabin costs on overnight sailings.
4. Booking links go to operator home pages; deep links with dates are unverified.
5. Verify whether Dublin Swift runs in 2026 and its times; add Stena fast craft if any.
6. Without a Google key, Fastest cannot see traffic and several options tie.
