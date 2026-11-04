# When was the data last updated?

**Who:** Sam. **When:** 4 Nov 2026: "The app needs to be clear when the data sources were last updated."

## Acceptance criteria
1. A one-line summary at the top, always visible: "Ferry times checked today · Prices updated yesterday · Ships updated
   today · Drive times: estimates". Any out-of-date source is shown in amber (status colour: a problem) and the line
   ends "Check before booking."
2. A "Data sources" section lists each source with its date, age and where it comes from:
   - **Ferry times**: the oldest `verified.on` across routes (the timetable is only as fresh as its oldest check).
     Out of date after 30 days.
   - **Prices**: `data/fares.json` `fetchedOn` (daily AFerry job). Out of date after 2 days.
   - **Ships**: `data/ships.json` `updatedOn` (daily Irish Ferries status job). Out of date after 2 days.
   - **Drive times**: newest Google result in the phone's cache; "estimates" without a key (not flagged).
   A source that has never been fetched says "never updated" and counts as out of date (except drive times).
3. Google drive results are timestamped; cached results older than 7 days, and old untimestamped ones, are dropped.
4. Per-option dates stay where they are: "Times checked with Irish Ferries Tue 3 Nov", "AFerry price … seen …".

→ `tests/plan.test.mjs` "freshness: age in days…"; `tests/page.test.mjs` "Data sources: each source shows…",
"Leave now (default)…"

## Status
Built 4 Nov 2026.
