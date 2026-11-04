# Questions, Signal UI, stops and fast ferry

**Who:** Sam. **When:** 3 Nov 2026, second request: "The UI should be almost identical to the Signal UI in
Cartref Commute… What's the latest time you can leave to make a planned arrival? If I left now, what would it
be? … when's the absolute fastest journey time … toggle the fast ferry … configurable number of stops."

## Acceptance criteria
1. **Signal layout** (Cartref Commute `docs/design-system.md`, approved 2 Nov): direction segmented control
   (To Borris / To Letchworth) with Settings and Refresh icons; question row Leave now / Arrive by / Leave around /
   Fastest; a context disclosure summarising date, day/night, ranking, stops and fast ferry. Each recommendation:
   **Leave by → At Borris/home** clocks (36/32 px), centred **Total journey** lozenge with the crossing-duration
   caption, countdown, best label, **Next: HH:MM operator from port**, a ferry leg panel with fixed
   **Timetable departure / Expected departure ("Not live") / At [arrival port]** columns, operator badge,
   check-in time, drive chips, fare, Journey steps and an action. Both best and Next best are complete cards;
   other options follow as compact rows. → `tests/page.test.mjs` "Leave now (default): Signal card…"
2. **Leave now:** options you can still leave for (leave ≥ now, today or tomorrow), earliest arrival first,
   labelled "Arrives first"; at exactly the leave time it still counts, one minute later it is gone.
   → `tests/plan.test.mjs` "Leave now: only options you can still leave for…"
3. **Arrive by:** arrive ≤ target (leaving that day or the day before), latest leave first, "Latest for HH:MM";
   if none, every option by earliest arrival, "Least late". → "Arrive by: arrive no later…", page "Arrive by…"
4. **Leave around:** leave within 60 min before to 180 min after the time. → "Leave around…"
5. **Fastest:** all options leaving on the date, shortest door to door first, with traffic at each leave time
   (Google). Rush hour can make a shorter crossing lose. → "Fastest: traffic at each leave time decides…"
6. **Cheapest** re-ranks within any question; unpriced kept after. → "Cheapest within a question…", page
   "Day/Overnight partition…"
7. **Stops:** count (0–6, default 1) × minutes per stop (Settings, default 30) added to the UK drive only.
   → "stops add minutes to the UK drive only…", page "Stops move the leave time…"
8. **Fast ferry:** off by default; when on, sailings run by a fast ship (Dublin Swift) are included and labelled. Fast
   is identified by the ship, not by a separate route. The Dublin Swift has not been seen on any timetable (4 Nov:
   Irish Ferries status pages show only Ulysses/James Joyce; no source gives 2026 Swift times; sources disagree
   on whether it still sails). Its 14:30/08:45 sailings stay as remembered, seasonal (27 Mar–30 Sep), flagged
   unverified, and the switch shows whether the daily job has seen it. → "fast ferry: off by default…",
   "fast ferry is identified by the ship…", page "Ship sightings…"
9. Google is not asked for legs already in the past (options nobody can take). → page "with a Google key…"
10. Each ferry panel shows the operator's logo (supplied by Sam, `assets/`) on a white chip, with the operator name as
    its accessible text. → page "Leave now (default)…"

## Status
Built 3 Nov 2026. Not independently reviewed. Data caveats as in `door-to-door-options.md`.
