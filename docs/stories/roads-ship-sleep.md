# Main roads, ship type and best sleep

**Who:** Sam. **When:** 4 Nov 2026: "show the main roads on the route, e.g. A14 M6 M62, in little lozenges that match
the standard road signs of the country — A roads in the UK green and motorways blue … The type of ship needs to be
called out: fast boat or standard … call out the best route for getting a long sleep. A slightly longer journey with
more of it asleep would mean you'd be better off by the time you get to your destination."

## Acceptance criteria
1. **Roads.** Each drive leg lists its main roads in order of use as sign lozenges: motorways and A(M) roads blue with
   white numbers (UK and Ireland); UK A roads green with yellow numbers; Irish N roads green with yellow numbers; Irish
   R roads white with black. With Google, roads come from the route's turn-by-turn steps (`mainRoads` in
   `src/google.js`): the first road named in each step, kept if used for ≥ 15 km in total, at most 7. Without Google,
   a typical list from `data/sailings.json` is shown, labelled "typical roads, unchecked".
   → `tests/plan.test.mjs` "mainRoads: road numbers…", "options carry sleep…"; `tests/page.test.mjs` "with a Google
   key…", "Without Google, each drive shows typical roads…"
2. **Ship.** Every ferry panel says **Standard ferry** or **Fast ferry**, with the ship's name. A sailing is a fast ferry
   when its ship is on `fastShips` (Dublin Swift) (Sam, 4 Nov: "you should be able to identify it from the timetable").
   The ship comes from what Irish Ferries' status pages showed for that sailing time (`data/ships.json`, refreshed
   daily, kept 21 days), else the stored name. Stena names are not yet confirmed.
   → "options carry sleep…", "fast ferry is identified by the ship…", "observed ships…"; page "Ship sightings…"
3. **Sleep on board.** Crossing time inside 22:00–07:00, after 20 min settling and stopping 30 min before arrival.
   Driving never counts (the driver can't sleep). Shown as "Sleep ~3h 10m on board". → "sleep on board…",
   "overlapDaily handles…"
4. **Night driving.** Drive time between 00:00 and 05:00, shown as a caution ("Driving 2h 00m between midnight and 5am").
   → "options carry sleep…"
5. **Best sleep** ranking (beside Fastest / Cheapest): most sleep first in 15-minute bands, then least night driving, then
   shortest door to door; labelled "Most sleep". Nothing filtered. → "Best sleep: most sleep…", page "Best sleep ranking…"

## Notes
On 20 Nov the best-sleep outbound is Stena Fishguard 01:30 (3h10 asleep, 15 min night driving), ahead of Pembroke
02:45 (3h11, but 2h of night driving). The thresholds are a model, not a measurement; tell me if they feel wrong.

## Status
Built 4 Nov 2026.
