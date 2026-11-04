// Pure parser for AFerry route pages (text after tag stripping). No network. Tested in tests/aferry-parse.test.mjs.
// Extracts: dated "Latest Ticket Prices" quotes, the monthly average table and the per-operator average table.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = MONTHS.map(m => m.slice(0, 3));
const DOW3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const OPERATORS = { "Irish Ferries": "irish", "Stena Line": "stena" };
export const PORTS = { Holyhead: "HHD", Dublin: "DUB", Fishguard: "FGD", Rosslare: "RSL", Pembroke: "PEM" };

/** HTML -> " | "-separated visible text. */
export function pageText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " | ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/[ \t\r\n]+/g, " ").replace(/(\s*\|\s*)+/g, " | ");
}

/** "Fri 6 Nov" seen on fetchDate (YYYY-MM-DD) -> YYYY-MM-DD in the next year that matches the weekday (within ±1 year). */
export function resolveDate(dow, day, mon, fetchDate) {
  const y0 = +fetchDate.slice(0, 4), m = MON3.indexOf(mon), d = +day;
  const fetchMs = Date.UTC(y0, +fetchDate.slice(5, 7) - 1, +fetchDate.slice(8, 10));
  for (const y of [y0, y0 + 1, y0 - 1]) {
    const ms = Date.UTC(y, m, d);
    if (new Date(ms).getUTCDay() !== DOW3.indexOf(dow)) continue;
    if (ms < fetchMs - 3 * 86400000 && y === y0 - 1) continue;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

export function parseAferry(text, fetchDate) {
  const quotes = [];
  const qre = /\b([A-Z][a-z]+) \| → \| ([A-Z][a-z]+) \| (Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), (\d\d:\d\d) \| ([A-Za-z&; ]+?) \| (?:Search \| )?£\s?(\d+(?:\.\d\d)?)/g;
  for (const m of text.matchAll(qre)) {
    const [, from, to, dow, day, mon, dep, opName, amount] = m;
    const op = OPERATORS[opName.trim()], f = PORTS[from], t = PORTS[to];
    const date = resolveDate(dow, day, mon, fetchDate);
    if (!op || !f || !t || !date) continue;
    quotes.push({ sailingId: `${op}-${f}-${t}|${date}|${dep}`, operator: op, from: f, to: t, date, dep, amount: +amount });
  }
  const monthly = {};
  const mre = new RegExp(`\\b(${MONTHS.join("|")}) \\| £(\\d+) \\| (Peak Period|Mid-Season|Off-Peak)`, "g");
  for (const m of text.matchAll(mre)) monthly[MONTHS.indexOf(m[1]) + 1] = { amount: +m[2], season: m[3] };
  const operatorAvg = {};
  const ore = /\b(Irish Ferries|Stena Line) \| £(\d+) \| (\d+h(?: \d+min)?) \| (\d+) sailings/g;
  for (const m of text.matchAll(ore)) operatorAvg[OPERATORS[m[1]]] = { amount: +m[2], duration: m[3], weeklySailings: +m[4] };
  return { quotes, monthly, operatorAvg };
}
