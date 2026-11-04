// Pure: how fresh is each data source? No clock reads; today is injected.
import { dayStart } from "./plan.js";

// A source is stale once older than this many days (Sam, 4 Nov: "be clear when the data sources were last updated").
export const STALE_AFTER_DAYS = { times: 30, prices: 2, ships: 2, drive: 7 };

export function ageDays(updatedOn, today) {
  if (!updatedOn) return null;
  return Math.round((dayStart(today) - dayStart(updatedOn.slice(0, 10))) / 1440);
}
export function ageText(days) {
  if (days == null) return "never";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** sources: [{ key, label, updatedOn|null, detail }] -> adds ageDays, ageText, stale (missing counts as stale). */
export function freshness(sources, today) {
  return sources.map(s => {
    const days = ageDays(s.updatedOn, today);
    const limit = STALE_AFTER_DAYS[s.key];
    return { ...s, ageDays: days, ageText: ageText(days), stale: s.optional && days == null ? false : days == null || (limit != null && days > limit) };
  });
}

/** The oldest route check date in the timetable (the whole timetable is only as fresh as its oldest check). */
export function timetableCheckedOn(data) {
  const dates = data.routes.map(r => r.verified?.on).filter(Boolean).sort();
  return dates[0] || null;
}
