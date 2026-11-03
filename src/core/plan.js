// Pure planning engine: no DOM, no network, no clock reads. Everything (data, drive times, fares, now) is injected.
//
// Time model: UK and Ireland always share the same UTC offset (GMT/BST = GMT/IST), so all times are
// wall-clock minutes since 1970-01-01 00:00 local ("local minutes"). A night when the clocks change is
// out by an hour for journeys spanning 01:00–02:00; accepted and noted in docs/architecture.md.

// A journey is overnight if any of it, door to door (driving or at sea), falls between 00:00 and 05:00.
// (Sam, 3 Nov: "travel overnight or during the day"; leaving home at 02:00 for a morning boat is overnight travel.)
export const OVERNIGHT_WINDOW = { start: 0, end: 5 * 60 };
// Leave around: options leaving from 60 min before to 180 min after the chosen time.
export const AROUND_WINDOW = { before: 60, after: 180 };

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
export function hhmm(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
export function at(dateISO, time) { return dayStart(dateISO) + hhmm(time); }

/** True if the interval [from, to] overlaps 00:00–05:00 on any day it spans. */
export function isOvernight(from, to) {
  for (let d = Math.floor(from / DAY) * DAY; d <= to; d += DAY) {
    const s = d + OVERNIGHT_WINDOW.start, e = d + OVERNIGHT_WINDOW.end;
    if (from < e && to > s) return true;
  }
  return false;
}

/** Season as "MM-DD" bounds, inclusive; wraps the year end if from > to. */
export function inSeason(season, dateISO) {
  if (!season) return true;
  const md = dateISO.slice(5);
  return season.from <= season.to ? md >= season.from && md <= season.to : md >= season.from || md <= season.to;
}

/** All concrete sailings in a direction departing on the given dates. dir: "out" (UK->IE) | "back". */
export function sailingsOn(data, dir, dates, { fastFerry = false } = {}) {
  const out = [];
  for (const route of data.routes) {
    const ukFirst = data.ports[route.from].country === "UK";
    if ((dir === "out") !== ukFirst) continue;
    for (const date of dates) {
      const base = dayStart(date), dow = fmt(base).dow;
      for (const s of route.sailings) {
        const fast = !!(s.fast ?? route.fast);
        if (fast && !fastFerry) continue;
        if (s.days && !s.days.includes(dow)) continue;
        if (!inSeason(s.season ?? route.season, date)) continue;
        const dep = base + hhmm(s.dep);
        out.push({ id: `${route.id}|${date}|${s.dep}`, route, sailing: s, fast, dep, arr: dep + s.durMin, durMin: s.durMin });
      }
    }
  }
  return out;
}

/**
 * Door-to-door options for leaving the start point on any of `dates`.
 * drive(fromKey, toKey, departMin) -> { min, source } is injected (Google, cache or estimate).
 * fares: { [sailingId]: { amount, currency, source } }.
 * settings: { marginMin, disembarkMin, stops, stopMin, fastFerry }. Stops apply to the long UK drive.
 */
export function options(data, { dir, date, dates, drive, fares = {}, settings }) {
  const leaveDates = dates || [date];
  const start = dir === "out" ? "home" : "dest", end = dir === "out" ? "dest" : "home";
  const stopTotal = (settings.stops || 0) * (settings.stopMin || 0);
  const sailDates = [...new Set(leaveDates.flatMap(d => [d, addDays(d, 1)]))];
  const days = leaveDates.map(dayStart);
  const result = [];
  for (const s of sailingsOn(data, dir, sailDates, settings)) {
    const r = s.route;
    const ukLeg = dir === "out" ? "to" : "from";
    const atPortBy = s.dep - r.checkInMin - settings.marginMin;
    const toStops = ukLeg === "to" ? stopTotal : 0, fromStops = ukLeg === "from" ? stopTotal : 0;
    // Guess the departure from the estimate, then ask for the drive at that time.
    const guess = drive(start, r.from, null);
    const toBase = drive(start, r.from, atPortBy - guess.min - toStops);
    const stops = settings.stops || 0;
    const driveTo = { min: toBase.min + toStops, baseMin: toBase.min, stopsMin: toStops, stops: toStops ? stops : 0, source: toBase.source };
    const leave = atPortBy - driveTo.min;
    if (!days.some(d => leave >= d && leave < d + DAY)) continue;
    const offAt = s.arr + settings.disembarkMin;
    const fromBase = drive(r.to, end, offAt);
    const driveFrom = { min: fromBase.min + fromStops, baseMin: fromBase.min, stopsMin: fromStops, stops: fromStops ? stops : 0, source: fromBase.source };
    const arrive = offAt + driveFrom.min;
    const fare = fares[s.id] || null;
    result.push({
      id: s.id, dir,
      operatorKey: r.operator,
      operator: data.operators[r.operator].name,
      bookingUrl: data.operators[r.operator].bookingUrl,
      logo: data.operators[r.operator].logo || null,
      fromKey: r.from, toKey: r.to,
      fromPort: data.ports[r.from].name,
      toPort: data.ports[r.to].name,
      vessel: s.sailing.vessel || null,
      fast: s.fast,
      leave, atPortBy, dep: s.dep, arr: s.arr, offAt, arrive,
      totalMin: arrive - leave,
      crossingMin: s.durMin,
      checkInMin: r.checkInMin,
      driveTo, driveFrom,
      overnight: isOvernight(leave, arrive),
      overnightCrossing: isOvernight(s.dep, s.arr),
      fare,
      verified: !!(data.verified || r.verified),
      flags: [
        ...(data.verified || r.verified ? [] : ["timetable unverified"]),
        ...(s.sailing.sourceNote ? [s.sailing.sourceNote] : []),
        ...(driveTo.source === "estimate" || driveFrom.source === "estimate" ? ["drive time estimated"] : []),
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

const byArrival = (a, b) => a.arrive - b.arrive || b.leave - a.leave || a.id.localeCompare(b.id);
const byLatestLeave = (a, b) => b.leave - a.leave || a.arrive - b.arrive || a.id.localeCompare(b.id);

/**
 * Answer a question, Cartref-style.
 *  question "now":     leave from now; best = earliest arrival.       (date ignored; uses nowMin)
 *  question "arrive":  arrive by target; best = latest leave ("Latest for"); none -> "Least late".
 *  question "around":  leave within AROUND_WINDOW of target; best = earliest arrival.
 *  question "fastest": leaving on date; best = shortest door to door (traffic at each leave time).
 * sort "cost" re-ranks the eligible set by price (priced first); nothing eligible is dropped.
 * Returns { list, best, next, label, leastLate, window }.
 */
export function answer(data, { question, dir, nowMin, date, time, pref = "any", sort = "time", drive, fares, settings }) {
  let list, label, leastLate = false, window = null;
  const make = (dates) => byPreference(options(data, { dir, dates, drive, fares, settings }), pref);
  if (question === "now") {
    const today = fmt(nowMin).date;
    list = make([today, addDays(today, 1)]).filter(o => o.leave >= nowMin).sort(byArrival);
    label = "Arrives first";
  } else if (question === "arrive") {
    const target = at(date, time);
    const all = make([addDays(date, -1), date]);
    list = all.filter(o => o.arrive <= target).sort(byLatestLeave);
    label = `Latest for ${time}`;
    if (!list.length) { list = all.sort(byArrival); leastLate = true; label = "Least late"; }
    window = { target };
  } else if (question === "around") {
    const target = at(date, time);
    const from = target - AROUND_WINDOW.before, to = target + AROUND_WINDOW.after;
    list = make([addDays(date, -1), date, addDays(date, 1)]).filter(o => o.leave >= from && o.leave <= to).sort(byArrival);
    label = "Arrives first";
    window = { from, to };
  } else if (question === "fastest") {
    list = rankByTime(make([date]));
    label = "Fastest";
  } else throw new Error(`unknown question ${question}`);
  if (nowMin != null) for (const o of list) o.leaveInMin = o.leave - nowMin;
  if (sort === "cost") { list = rankByCost(list); label = list[0]?.fare ? "Cheapest" : label; }
  return { list, best: list[0] || null, next: list[1] || null, label, leastLate, window };
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

export function duration(min) { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`; }
export function countdown(min) {
  if (min < 0) return `leave time passed ${duration(-min)} ago`;
  if (min >= DAY) { const d = Math.floor(min / DAY); return `leave in ${d} day${d > 1 ? "s" : ""} ${duration(min % DAY)}`; }
  return `leave in ${duration(min)}`;
}
