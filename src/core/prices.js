// Pure helpers for live prices (from the proxy's /prices). No network or clock reads.
import { addDays } from "./plan.js";

// Each AFerry search returns the ~8 sailings nearest the requested time (±1 day) on that route and its neighbours.
// Holyhead–Dublin has 8 sailings a day, so three times cover a day; the Rosslare routes (4 a day, Fishguard and
// Pembroke returned together) need one. Found by live runs on 4 Nov 2026.
export const SEARCH_PLAN = {
  out: [["HHD-DUB", "0600"], ["HHD-DUB", "0900"], ["HHD-DUB", "1800"], ["FGD-RSL", "1200"]],
  back: [["DUB-HHD", "0600"], ["DUB-HHD", "0900"], ["DUB-HHD", "1800"], ["RSL-FGD", "1200"]],
};

/** Searches needed to price leaving on `dates` (a leaving date can mean an early sailing the next day). */
export function priceSearches(dir, dates) {
  const all = new Map();
  const add = (route, date, time) => all.set(`${route}|${date}|${time}`, { route, date, time });
  for (const d of dates) {
    for (const [route, time] of SEARCH_PLAN[dir]) add(route, d, time);
    // Early sailings the next day: the Holyhead route's 06:00 window. (The Rosslare search already spans ±1 day.)
    const [hhd] = SEARCH_PLAN[dir][0]; add(hhd, addDays(d, 1), "0600");
  }
  return [...all.values()];
}

/** Proxy rows -> { [sailingId]: { amount, checkedAt } }, matching each row to our timetable by ports and departure time.
 *  Rows for sailings we don't know are returned separately (never invented into the timetable). */
export function mapLiveRows(data, rows, checkedAt) {
  const prices = {}, unmatched = [];
  for (const r of rows) {
    const route = data.routes.find(x => x.from === r.from && x.to === r.to && x.sailings.some(s => s.dep === r.dep));
    if (!route) { unmatched.push(r); continue; }
    prices[`${route.id}|${r.date}|${r.dep}`] = { amount: r.amount, currency: "GBP", checkedAt };
  }
  return { prices, unmatched };
}
