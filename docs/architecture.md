# Architecture

## What it is for
One journey, both ways: home (20 Hitchin Road, Letchworth SG6 3LT) ⇄ Borris, Co. Carlow, by car and ferry,
car + 2 adults. For chosen dates it lists every crossing as a door-to-door option, ranked by total time or by
cost, filtered on request to day or overnight travel.

## Layers
| Layer | File | Does |
|---|---|---|
| Data | `data/sailings.json` | Ports, operators, routes, sailing times/durations/days, check-in, fallback drive estimates, sources |
| Engine (pure) | `src/core/plan.js`, `src/core/dated.js` | Builds options from dated operator records (within coverage) or the timetable pattern; status views; overnight, sleep, filtering, ranking |
| Status collector | `tools/collect-status.mjs` (+ `irish-status-parse.mjs`, `stena-status-parse.mjs`), Action `status.yml` twice hourly | Operator sailing-status pages → `data/sailing-status.json` with per-route/date coverage and failure retention |
| Adapter | `src/google.js` | Google Routes API `computeRoutes` from the browser (traffic-aware, future departure time) |
| Page | `src/app.js`, `index.html` | Signal layout (from Cartref Commute), questions, settings, fares entry, drive-time fetch + cache, drawing |
| Ships seen | `data/ships.json`, written daily by `tools/fetch-fares.mjs` | Ship per Irish Ferries sailing time; Dublin Swift last seen |
| Fares | `data/fares.json`, written daily by `tools/fetch-fares.mjs` (GitHub Action `fares.yml`) | AFerry dated quotes, monthly and operator averages; see [fares story](stories/fares.md) |
| Proxy (Cloudflare Worker) | `proxy/worker-src.mjs` + `tools/aferry-search.mjs`, `tools/status-core.mjs` and parsers; `wrangler.toml` | Live AFerry prices (`/prices`), live operator status (`/status`), code fingerprint (`/version`); see [Proxy](#proxy-cloudflare-worker-deployment-and-verification) |

## Runtime topology
```
 Phone (GitHub Pages: index.html, src/, data/*.json)
   │ same origin: data/sailing-status.json, fares.json, ships.json, sailings.json, proxy/version.mjs
   │ Google Routes API (key in phone Settings)
   └─▶ Proxy: https://cartref-borris.s-rapley.workers.dev  (only for Origin https://srapley-spec.github.io)
         /status  ─▶ Stena FerryCheck ×4, Irish Ferries sailing updates ×2   (cached 3 min)
         /prices  ─▶ AFerry search (2 requests + polls per search)          (cached 1 h)
         /version ─▶ WORKER_VERSION (no upstream)
 GitHub Actions (repo srapley-spec/Cartref-Borris)
   Tests (every push) · status.yml (:09/:39, collected status file) · fares.yml (daily) · worker-check.yml (see below)
   Bot commits to main redeploy Pages; Worker-relevant commits redeploy the Worker via Cloudflare Workers Builds.
```

## Proxy (Cloudflare Worker): deployment and verification
**Where it runs.** `https://cartref-borris.s-rapley.workers.dev` (Sam's Cloudflare account). Sam enters it in the app's
Settings → Proxy URL (stored on the phone; the app has no default). Without it the app falls back to the collected
status file and typical prices, and says so.

**How it is deployed.** The Worker is connected to this GitHub repo in Cloudflare (Workers Builds). Cloudflare runs
`npx wrangler deploy` on every push to `main`; `wrangler.toml` names the entry (`proxy/worker-src.mjs`, imports bundled
by wrangler) and the only setting, `ALLOW_ORIGIN` (not secret). Nothing is pasted by hand. `proxy/worker.js` remains as
a single-file bundle for a hand-made Worker only.

**How we know it isn't stale.**
1. `proxy/version.mjs` holds `WORKER_VERSION`, a SHA-256 fingerprint (12 hex) of the Worker's source: `worker-src.mjs`
   and every module it imports. `node tools/build-worker.mjs` regenerates it; `tests/worker-version.test.mjs` and the
   `--check` test fail if it doesn't match the source, so a code change can't be merged with an old fingerprint.
2. The Worker reports it at `GET /version` (no Origin needed, `no-store`).
3. **Check Worker** (`.github/workflows/worker-check.yml`, `tools/check-worker.mjs`) runs after every push to `main` that
   touches Worker code, and daily at 06:17 UTC. It polls `/version` for up to 15 minutes until it equals the repo's
   fingerprint (Cloudflare normally redeploys in 1–2 minutes), then checks `/status` returns operator sailings and
   `/prices` returns AFerry prices for a date two weeks out. Any failure fails the run, and GitHub emails the repo owner.
4. The app reads the expected fingerprint (as text, from `proxy/version.mjs` on Pages) and the Worker's `/version`;
   Data sources shows "Proxy: running the app's code (…)" or, in amber, "Proxy running older code".

**After changing Worker code (for whoever edits it).** Run `node tools/build-worker.mjs` (updates the fingerprint and the
paste bundle) and `npx wrangler deploy --dry-run` (proves Cloudflare can build it); `npm test`; push to `main`; watch
the Check Worker run go green. A red run means Cloudflare didn't deploy (check the Worker's Builds tab in Cloudflare)
or the Worker can't reach a source.

**Limits.** Free Cloudflare plan: 100,000 requests/day, ample (each app open is ≈2–7 Worker requests). Worker caches are
per Cloudflare location. Upstream terms for automated reading are not confirmed; the Worker identifies itself.

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

## Primary source: the operators' own sailing updates (4 Nov 2026)
Stena Line's FerryCheck boards (`stenalineferrycheck.azurewebsites.net/RouteInfo/details?id=6/5/8/7`, today and
tomorrow) and Irish Ferries' sailing-updates pages (`ie-en/sailing-updates/dublin-holyhead`, `rosslare-pembroke`,
yesterday to day after tomorrow) are read by `tools/collect-status.mjs` on GitHub's runner (all six return 200 to a
plain fetch; no CAPTCHA observed; nothing is disguised). Within their coverage the dated records are the sailings the
planner uses; outside it the timetable pattern below is a labelled estimate. See [operator status](stories/operator-status.md).

## Timetable pattern and how verified it is (3 Nov 2026)
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

- **4 Nov 2026** Main roads from Google steps (field mask adds `routes.legs.steps.distanceMeters` and
  `…navigationInstruction.instructions`); typical roads in data as a labelled fallback. Ship type/name per sailing.
  Sleep-on-board and night-driving model and a Best sleep ranking ([story](stories/roads-ship-sleep.md)).
- **4 Nov 2026** Fares bot fixed: it compared with `git diff`, which ignores a new untracked file, so the first run
  saved nothing; it now uses `git status --porcelain`.

- **4 Nov 2026** Fast ferry identified by ship (`fastShips`), not by a route flag (Sam). The daily job also reads Irish
  Ferries' Dublin–Holyhead and Rosslare–Pembroke status tables into `data/ships.json` (ship per sailing time, Swift
  sightings, sailings not in our timetable). The engine prefers the observed ship.

- **4 Nov 2026** Data freshness shown at the top and in a Data sources section (pure `src/core/freshness.js`);
  drive-time cache entries carry a timestamp and expire after 7 days ([story](stories/data-freshness.md)).

- **4 Nov 2026** Live AFerry prices via a Cloudflare Worker (Sam approved trying the booking search). Plain requests,
  honest client identity; Stena's Turnstile-protected site is not touched ([fares story](stories/fares.md)).

- **4 Nov 2026** Operators are the primary source for date-specific sailings and status (Sam's brief). Dated records
  keyed by route|date|original time; coverage per route/date; failed reads keep previous data with its own timestamp;
  cancelled sailings visible but unavailable; delay estimates move the arrival, never check-in; moved sailings take the
  replacement port/time/check-in. Status colours per Sam: on time green, <1 h yellow, ≥1 h or no estimate amber,
  cancelled red; stale (>2 h) or missing status is neutral. Operator check-in rules replace the assumed 60 min
  (Stena vehicles 30/30/60/30). Irish Ferries Dublin–Holyhead notices show its ticketed times are 02:40/08:15/14:10/20:15
  and 02:00/08:05/14:30/20:55 with daily "Early Sailing" to the displayed times; records keep both.
- **4 Nov 2026** The Thursday 02:45 Pembroke sailing is on Irish Ferries' page though the weekday pattern (from Direct
  Ferries) omits it: dated records override; the collector lists such cases under `unscheduled` for data maintenance.

- **4 Nov 2026, 10:32 UTC** First live status collection on GitHub's runner: all six operator sources returned 200 and
  parsed (72 records, 24 route-days). The scheduled job runs at :09 and :39.

- **4 Nov 2026** Sam: the timetable rarely changes; status accuracy is what matters. Status is therefore read live
  through the Worker (`/status`, 3-minute cache) when the app opens and every 5 minutes while open, merged over the
  collected file; the GitHub schedule is the fallback. The collector core (`tools/status-core.mjs`) is shared by the
  Action and the Worker; the bundler now refuses duplicate top-level names.

- **4 Nov 2026** Worker deploys from the repo (Sam: "connect to GitHub so we can update things in one go"):
  `wrangler.toml` (main `proxy/worker-src.mjs`, `ALLOW_ORIGIN` as a plain var). Sam connects the repo once in Cloudflare;
  pushes to `main` then redeploy it. Validated with `wrangler deploy --dry-run` (24 KB bundle, responds correctly).

- **4 Nov 2026** Proxy URL `cartref-borris.s-rapley.workers.dev` connected to the repo by Sam. Stale-code protection:
  source fingerprint (`proxy/version.mjs`) reported at `/version`, enforced by tests, verified after each deploy and
  daily by the Check Worker workflow, and shown in the app. First direct check from a cloud session (with the host
  allowed): `/status` 6/6 sources, 72 records in 2.7 s; `/prices` 8 live rows; other origins refused (403);
  `/version` absent, i.e. running the pre-fingerprint code, as expected before this change was pushed.

## Known gaps / next
1. Timetable pattern (future dates): confirm Stena's pattern from Stena; fix day-of-week patterns using `unscheduled` from the collector.
1b. Without the Worker, status is GitHub-scheduled (best effort). Confirm the operators' permitted automated use before relying on this for a wider audience.
2. Measure the fallback drive estimates with Google (needs `GOOGLE_MAPS_KEY` in the environment).
3. Live any-date fares (booking-engine automation) only if Sam agrees; return-fare vs two-singles pricing; cabin costs on overnight sailings.
4. Booking links go to operator home pages; deep links with dates are unverified.
5. Verify whether Dublin Swift runs in 2026 and its times; add Stena fast craft if any.
6. Without a Google key, Fastest cannot see traffic and several options tie.
7. Confirm the typical road lists with Google and Stena's ship names.
