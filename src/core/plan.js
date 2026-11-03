// Pure planning engine: no DOM, no network, no clock reads. Everything is injected.
//
// Time model: UK and Ireland always share the same UTC offset (GMT/BST = GMT/IST), so all times are
// wall-clock minutes since 1970-01-01 00:00 local ("local minutes"). A night when the clocks change is
// out by an hour for sailings that cross 01:00–02:00; that is accepted and noted in docs/architecture.md.

// A journey is overnight if any of it, door to door (driving or at sea), falls between 00:00 and 05:00.
// (Sam, 3 Nov: "travel overnight or during the day"; leaving home at 02:00 for a morning boat is overnight travel.)
export const OVERNIGHT_WINDOW = { start: 0, end: 5 * 60 };

const DAY = 24 * 60;

/** "2026-11-20" -> local minutes at 00:00 that day. */
export function dayStart(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!m) throw new Error(`bad date ${dateISO}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 60000;
}

/** local minutes -> { date: "YYYY-MM-DD", time: "HH:MM", dow } */
export function fmt(min) {
  const d = new Date(min * 60000);
  const p = n => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
    dow: d.getUTCDay(),
  };
}

export function addDays(dateISO, n) { return fmt(dayStart(dateISO) + n * DAY).date; }

function hhmm(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }

/** True if the interval [from, to] overlaps 00:00–05:00 on any day it spans. */
export function isOvernight(dep, arr) {
  for (let d = Math.floor(dep / DAY) * DAY; d <= arr; d += DAY) {
    const s = d + OVERNIGHT_WINDOW.start, e = d + OVERNIGHT_WINDOW.end;
    if (dep < e && arr > s) return true;
  }
  return false;
}

/** All concrete sailings in a direction departing on the given dates. dir: "out" (UK->IE) | "back". */
export function sailingsOn(data, dir, dates) {
  const out = [];
  for (const route of data.routes) {
    const ukFirst = data.ports[route.from].country === "UK";
    if ((dir === "out") !== ukFirst) continue;
    for (const date of dates) {
      const base = dayStart(date), dow = fmt(base).dow;
      for (const s of route.sailings) {
        if (s.days && !s.days.includes(dow)) continue;
        const dep = base + hhmm(s.dep);
        out.push({ id: `${route.id}|${date}|${s.dep}`, route, dep, arr: dep + s.durMin, durMin: s.durMin });
      }
    }
  }
  return out;
}

/**
 * Door-to-door options for leaving the start point on `date`.
 * drive(fromKey, toKey, departMin) -> { min, source } is injected (Google, cache or estimate).
 * fares: { [sailingId]: { amount, currency, source } }.
 * settings: { marginMin, disembarkMin }.
 */
export function options(data, { dir, date, drive, fares = {}, settings }) {
  const start = dir === "out" ? "home" : "dest", end = dir === "out" ? "dest" : "home";
  const day0 = dayStart(date);
  // A sailing early on the next day can still mean leaving on `date` (evening drive, night crossing).
  const cands = sailingsOn(data, dir, [date, addDays(date, 1)]);
  const result = [];
  for (const s of cands) {
    const r = s.route;
    const atPortBy = s.dep - r.checkInMin - settings.marginMin;
    // First guess the drive with an estimate-based departure, then ask for the drive at that time.
    const guess = drive(start, r.from, null);
    const toPort = drive(start, r.from, atPortBy - guess.min);
    const leave = atPortBy - toPort.min;
    if (leave < day0 || leave >= day0 + DAY) continue;
    const offAt = s.arr + settings.disembarkMin;
    const fromPort = drive(r.to, end, offAt);
    const arrive = offAt + fromPort.min;
    const fare = fares[s.id] || null;
    result.push({
      id: s.id,
      operator: data.operators[r.operator].name,
      bookingUrl: data.operators[r.operator].bookingUrl,
      fromPort: data.ports[r.from].name,
      toPort: data.ports[r.to].name,
      leave, atPortBy, dep: s.dep, arr: s.arr, arrive,
      totalMin: arrive - leave,
      crossingMin: s.durMin,
      driveTo: toPort, driveFrom: fromPort,
      overnight: isOvernight(leave, arrive),
      overnightCrossing: isOvernight(s.dep, s.arr),
      fare,
      flags: [
        ...(data.verified ? [] : ["timetable unverified"]),
        ...(toPort.source === "estimate" || fromPort.source === "estimate" ? ["drive time estimated"] : []),
        ...(fare ? [] : ["no price yet"]),
      ],
    });
  }
  return result;
}

/** pref: "day" | "overnight" | "any". Filtering only by explicit choice; nothing else is hidden. */
export function byPreference(opts, pref) {
  if (pref === "day") return opts.filter(o => !o.overnight);
  if (pref === "overnight") return opts.filter(o => o.overnight);
  return opts.slice();
}

export function rankByTime(opts) {
  return opts.slice().sort((a, b) => a.totalMin - b.totalMin || a.arrive - b.arrive || a.id.localeCompare(b.id));
}

/** Priced options first, cheapest first; unpriced follow (by time), never dropped. */
export function rankByCost(opts) {
  return opts.slice().sort((a, b) => {
    if (!!a.fare !== !!b.fare) return a.fare ? -1 : 1;
    if (a.fare && b.fare && a.fare.amount !== b.fare.amount) return a.fare.amount - b.fare.amount;
    return a.totalMin - b.totalMin || a.id.localeCompare(b.id);
  });
}

/** Headline for a round trip: fastest pair and cheapest fully-priced pair. */
export function summary(outOpts, backOpts) {
  const fastest = (o) => rankByTime(o)[0] || null;
  const cheapest = (o) => rankByCost(o).find(x => x.fare) || null;
  const pair = (a, b, key) => (a && b ? { out: a, back: b, [key]: key === "totalMin" ? a.totalMin + b.totalMin : a.fare.amount + b.fare.amount } : null);
  return {
    fastest: pair(fastest(outOpts), fastest(backOpts), "totalMin"),
    cheapest: pair(cheapest(outOpts), cheapest(backOpts), "amount"),
  };
}

/** Drive-time resolver: injected lookup first, else data estimate. */
export function makeDrive(data, lookup) {
  return (from, to, departMin) => {
    const hit = departMin != null && lookup ? lookup(from, to, departMin) : null;
    if (hit) return hit;
    const est = data.driveEstimatesMin[`${from}>${to}`];
    if (est == null) throw new Error(`no drive estimate for ${from}>${to}`);
    return { min: est, source: "estimate" };
  };
}

export function duration(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`; }
