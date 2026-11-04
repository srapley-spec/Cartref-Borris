# Operator-sourced sailings and status

**Who:** Sam. **When:** 4 Nov 2026. "Pull details from the current sailing updates from both Irish Ferries and Stena and
flag if the ferry is on time, delayed or cancelled … on time green; delayed under an hour yellow; delayed more than an
hour amber; cancelled red", then the fuller brief: use the operators as the primary source for date-specific sailing
times, changes, cancellations and vessels, and plan journeys from those records; AFerry stays a price source and a
labelled timetable fallback.

## Sources (verified from GitHub's runner, 4 Nov 2026: plain `fetch`, HTTP 200, no challenge)
| Source | Covers | Gives |
|---|---|---|
| Stena Line FerryCheck `RouteInfo/details?id=6/5/8/7` (the board embedded in stenaline.co.uk sailing updates) | Holyhead⇄Dublin, Fishguard⇄Rosslare; today and tomorrow | vessel, departure, arrival, status label, remarks, vehicle check-in rule |
| Irish Ferries `ie-en/sailing-updates/dublin-holyhead` and `rosslare-pembroke` | both directions; yesterday to day after tomorrow | ship, departure, arrival, status label, per-sailing notice with original/revised times, replacement sailings, check-in |

Neither page carries a machine-readable "operator updated at" (Stena's "Last updated" is filled by script), so the app
shows when *we* read the page and says so. `tools/fetch-raw.mjs` + the "Fetch raw pages" workflow keep fixtures current.

## Pipeline
Operator pages → `tools/collect-status.mjs` (GitHub Action `status.yml`, twice an hour, manual too) → `data/sailing-status.json`
(same origin) → pure engine (`src/core/dated.js`, `src/core/plan.js`) → page.

`data/sailing-status.json`: `sources` (per source: ok, fetchedAt = last good read, attemptedAt, error, warnings, check-in
rule), `coverage["routeId|date"]` (that route's list for that date was retrieved in full), `sailings["routeId|date|originalDep"]`
(one record per operator sailing per date: displayed dep/arr, original and revised times where the operator states
them, estimated times only when stated, ship, status label and normalised status, verbatim notice, replacement
sailing, check-in minutes, source, fetchedAt), `unscheduled` (dated sailings our timetable pattern does not predict),
`complete`.

## Acceptance criteria
1. **Per-date parsing.** Each operator page yields one record per sailing per date, with arrival dates rolled over
   midnight; identical departure times on different dates are separate records with their own status.
   → `tests/operator-status.test.mjs` (Irish Ferries, real fixtures), `tests/collect-status.test.mjs` "Stena FerryCheck…"
2. **Wording preserved.** The operator's status label and notice are stored verbatim beside the normalised status
   (on-time, early, delayed, cancelled, departed, arrived, boarding, other). Explicit facts are extracted from notices:
   original departure ("your 05/11/2026 02:40 … will depart at earlier time of 01:30"), revised time, cancellation,
   replacement sailing ("will now be on the StenaLine sailing to Fishguard"), check-in. Nothing is inferred from "On
   Time". → "Early sailings…", "A sailing moved onto the other operator…", "notice parsing…"
3. **Stable identity.** Records are keyed by route, date and the operator's original time, so a rescheduled sailing is
   one record; a later run with a changed time replaces it rather than adding a second. → `collect-status` "a changed
   departure time replaces…"; `tests/dated.test.mjs` "a rescheduled sailing is one record…"
4. **Coverage and failure.** Coverage is recorded per route and date from successful reads only. A failed fetch, a
   non-200, a network error or an empty parse keeps that source's previous records and coverage with their original
   `fetchedAt`, marks the source failed with the reason, and never means "no sailings". Records older than yesterday
   are purged. The collector running does not make retained data fresh. → "a failed fetch keeps…"
5. **Dated records drive the plan.** Within coverage the operator's list is the set of sailings for that date (the
   Thursday 02:45 Pembroke sailing that our weekday pattern omitted is offered; a sailing missing from the operator's
   list is not). Outside coverage the timetable pattern is used and shown as "Timetable estimate". → `dated.test.mjs`
   "within coverage…"
6. **Recalculation.** Leave-home time uses the effective departure and the route's (or notice's) check-in. An operator
   estimate of a delayed departure moves the arrival home ("At Borris (expected) 02:30 · timetable 01:00") but never
   the check-in deadline. A sailing moved onto the other operator departs from the replacement port at the revised
   time with that operator's check-in and crossing (its own dated record if held, else its timetable duration), with
   the notice shown. → "delay with an estimate…", "a sailing moved onto the other operator…"
7. **Cancelled** sailings stay visible, are struck through, carry a red "Cancelled" lozenge and flag, rank last in
   every ordering and are never the recommendation or Next best. → "cancelled: visible, flagged…"; `tests/page.test.mjs`
   "Operator status lozenges…"
8. **Lozenges** (status colours, Sam's bands): On time green; Early sailing green with the original time; Delayed under
   an hour yellow ("Delayed 40 min"); an hour or more, or delayed with no estimate, amber; Cancelled red; moved
   sailings yellow with the destination operator/port/time; Departed/Arrived neutral; "Timetable estimate" neutral when
   there is no record; "Status unavailable · last …" neutral when the record is older than 2 hours
   (`STATUS_STALE_MIN`). The Expected departure column shows the estimate in colour, else On time / Cancelled /
   Not live. Each lozenge says which operator and when we read it. → `dated.test.mjs` "status views…", page test above
9. **Check-in rules** come from the operators' pages per route (Stena vehicles: 30 min Holyhead and Rosslare→Fishguard,
   60 min Fishguard→Rosslare; Irish Ferries 30 min; 60 min when a notice says so). Foot-passenger rules are not used.
10. **Data sources** lists "Sailing status · collected <when>", which sources failed and their last good read, and
    that status older than two hours is shown as unavailable. → page "Data sources…" (banner), lozenge test
11. Prices, bookable capacity and operational status remain separate facts; "On time" never implies availability.

## Refresh and limits
GitHub Actions cron `9,39 * * * *`: best-effort, often minutes late. Not a real-time feed; the app says when data was
collected and degrades to "Status unavailable" after two hours. Coverage is today/tomorrow (Stena) and ±2 days (Irish
Ferries) only; future dates use the timetable pattern. Delay estimates depend on the operator publishing an expected
time; in the 4 Nov fixtures neither did. The operators' terms for automated reading have not been confirmed; the
collector identifies itself and makes six requests per run.

## Status
Built 4 Nov 2026. First live collection from GitHub's runner at 10:32 UTC the same day: all six sources ok, 72 dated
records, coverage for 24 route-days, one `unscheduled` (Thu 5 Nov 02:45 Pembroke → Rosslare, which the weekday pattern
omits). Verified from the deployment runtime, not only from a browser.
