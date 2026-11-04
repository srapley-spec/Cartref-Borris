// Pure parser for Irish Ferries sailing-updates status tables.
// Row shape seen 3–4 Nov 2026 (tags stripped): "Dublin - Holyhead 07:30 11:00 Ulysses Arrived More Information".
// Cell separators are unknown/unstable, so " | " separators are flattened to spaces before matching.
import { PORTS } from "./aferry-parse.mjs";

const STATUS = "On Time|Arrived|Departed|Delayed|Cancelled|Early Sailing|Late Sailing|Rescheduled|Scheduled|Boarding|Not Operating";
const ROW = new RegExp(`\\b(Dublin|Holyhead|Rosslare|Pembroke) - (Dublin|Holyhead|Rosslare|Pembroke) (\\d\\d:\\d\\d) (\\d\\d:\\d\\d) ([A-Z][A-Za-z.' ]{1,30}?) (${STATUS})\\b`, "g");

/** -> unique rows { routeId, from, to, dep, arr, ship, status } (last occurrence wins). */
export function parseIrishStatus(text) {
  const flat = text.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ");
  const seen = new Map();
  for (const m of flat.matchAll(ROW)) {
    const [, fromName, toName, dep, arr, ship, status] = m;
    const routeId = `irish-${PORTS[fromName]}-${PORTS[toName]}`;
    seen.set(`${routeId}|${dep}`, { routeId, from: PORTS[fromName], to: PORTS[toName], dep, arr, ship: ship.trim(), status });
  }
  return [...seen.values()];
}
