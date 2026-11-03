# Door-to-door ferry options, ranked by time or cost, day or overnight

**Who:** Sam, driving with one other adult from Letchworth to his father's house in Borris, Co. Carlow, and back.
**Why (3 Nov 2026):** comparing Stena Line and Irish Ferries across Holyhead, Fishguard and Pembroke, including
the drives either side and the price, is hard to do by hand.

## Acceptance criteria
1. Choose a leave-home date and optionally a leave-Borris date; each direction lists every crossing that means
   leaving the start point on that date, including early-hours sailings next day.
   → `tests/plan.test.mjs` "leaving date means leaving the house…"
2. Each option shows leave time, door-to-door duration, arrival time, operator, ports, sailing times, drive legs and
   the time to be at the port. Timing: at port by = dep − check-in − margin(15); arrive = arr + disembark(20) + drive.
   → "door-to-door timing…", `tests/page.test.mjs` "shows outbound and return options…"
3. Day / Night / Either per direction. Overnight = any of the door-to-door journey between 00:00 and 05:00.
   Day and Night partition Either exactly. → "overnight is judged door to door…", "overnight interval check…",
   "preference filters only on explicit choice…", page "Day/Night filter…"
4. Rank by Fastest (door-to-door minutes) or Cheapest (priced first, cheapest first; unpriced kept after, by time).
   → "rank by time…", "rank by cost…", page "Day/Night filter and cost ranking…"
5. Sam can enter the fare he was quoted per sailing; it is saved on the phone, labelled "you entered" and re-ranks.
   → page "Day/Night filter and cost ranking…"
6. With a Google key, drive legs use Google Routes (traffic-aware, at the actual departure time); on failure the
   error is shown and estimates are used, marked `*`; nothing disappears.
   → "Google drive time replaces the estimate…", page "with a Google key…", "Google failure is reported…"
7. Round-trip summary: fastest pair, cheapest fully priced pair (two singles).
   → "round-trip summary…"
8. Every option says where its times came from: checked with the operator, via AFerry, or unverified (fast ferry);
   unconfirmed day patterns are flagged; the banner summarises. Typical fares (AFerry averages) are shown but never
   ranked on. → "timetable provenance flags…", "Irish Ferries Dublin→Holyhead matches…", page "Leave now (default)…"

## Status
Built 3 Nov 2026. Timetable checked 3 Nov (see architecture); drive estimates **unmeasured**; live fares not yet fetched (see architecture
"Known gaps").
