// Live AFerry search: one way, 2 adults, standard car. Shared by the daily job, the optional price proxy and tests.
// Flow (found 4 Nov 2026): POST /mfe/search/v2/ with the legs -> { location: /en-gb/search/<id>/ }; GET that page until it
// no longer says "Searching <operator>..."; parse the server-rendered result blocks. Identifies itself honestly.
// Network and waiting are injected so the parser and flow are testable offline.

export const UA = "Mozilla/5.0 (compatible; cartref-borris personal trip planner; a few searches a day)";
// AFerry route codes and names. Codes for Fishguard/Pembroke are confirmed by tests/aferry-search.test.mjs fixtures only
// once a live run has returned results for them (see docs/stories/fares.md).
export const ROUTES = {
  "HHD-DUB": { code: "ISFE-HOLY-DUBL", name: "Holyhead - Dublin" },
  "DUB-HHD": { code: "ISFE-DUBL-HOLY", name: "Dublin - Holyhead" },
  "FGD-RSL": { code: "STEN-FISH-ROSS", name: "Fishguard - Rosslare" },
  "RSL-FGD": { code: "STEN-ROSS-FISH", name: "Rosslare - Fishguard" },
  "PEM-RSL": { code: "ISFE-PEMB-ROSS", name: "Pembroke - Rosslare" },
  "RSL-PEM": { code: "ISFE-ROSS-PEMB", name: "Rosslare - Pembroke" },
};
const PORT = { Holyhead: "HHD", Dublin: "DUB", Fishguard: "FGD", Rosslare: "RSL", Pembroke: "PEM" };
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

export function searchBody(routeKey, date, time = "0000") {
  const r = ROUTES[routeKey];
  if (!r) throw new Error(`unknown route ${routeKey}`);
  return { Currency: "GBP", FaExtra: "", FaTag: "", HomeUrl: "", Language: "en", LargeFamilyDiscount: "", automobileClubChosed: "", LoyaltyOfferId: "",
    OrigPrice: "", ReferCode: "SCUK01", ResidentDiscountZone: "", sid: "", T: "", UrlRfc: "GBP,SCUK01,EUR,SCUK02,USD,SCUKUS", Version: "9876.1",
    vouchercode: "", IsDiffRet: "N", legs: [{ route: r.name, routeCode: r.code, date, time, standardVehicleHeight: 179, standardVehicleLength: 469,
      passengers: { adults: 2, children: 0, childAges: [], dogs: 0, cats: 0 }, vehicle: { type: "STD", trailer: {} } }] };
}

/** Results HTML -> { complete, rows: [{ from, to, dep, date, arr, arrDate, durMin, amount }] }. year from the search date. */
export function parseResults(htmlText, searchDate) {
  const t = htmlText.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " | ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").replace(/(\s*\|\s*)+/g, " | ");
  const y = +searchDate.slice(0, 4), sm = +searchDate.slice(5, 7);
  const iso = (d) => { const [, dd, mon] = d.split(" "); const m = MON[mon]; const yr = m < sm - 6 ? y + 1 : m > sm + 6 ? y - 1 : y; return `${yr}-${String(m).padStart(2, "0")}-${dd.padStart(2, "0")}`; };
  const re = /\b(Holyhead|Dublin|Fishguard|Rosslare|Pembroke) \| (Holyhead|Dublin|Fishguard|Rosslare|Pembroke) \| (\d\d:\d\d) \| ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d? [A-Z][a-z]{2}) \| (\d+)h(?: (\d+)m)? \| (\d\d:\d\d) \| ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d? [A-Z][a-z]{2})(?: \| [^£|]{0,40})*? \| £([\d,]+(?:\.\d\d)?)/g;
  const rows = [];
  for (const m of t.matchAll(re)) rows.push({ from: PORT[m[1]], to: PORT[m[2]], dep: m[3], date: iso(m[4]), arr: m[7], arrDate: iso(m[8]),
    durMin: +m[5] * 60 + +(m[6] || 0), amount: +m[9].replace(/,/g, "") });
  const searching = (t.match(/Searching ([A-Za-z ]+?)\.\.\./g) || []).map(s => s.replace(/^Searching |\.\.\.$/g, ""));
  return { complete: searching.length === 0, searching, rows };
}

/** Run one search. fetchFn/sleep injected. Returns { rows, complete, searching, url } (rows may be partial if time runs out). */
export async function searchAferry(routeKey, date, { time = "0000", fetchFn = fetch, sleep = (ms) => new Promise(r => setTimeout(r, ms)), maxWaitMs = 30000 } = {}) {
  const res = await fetchFn("https://www.aferry.com/mfe/search/v2/", { method: "POST", body: JSON.stringify(searchBody(routeKey, date, time)),
    headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json, text/plain, */*", Origin: "https://www.aferry.com", Referer: "https://www.aferry.com/en-gb/" } });
  if (!res.ok) throw new Error(`AFerry search HTTP ${res.status}`);
  const { location } = await res.json();
  if (!location || !/^https:\/\/www\.aferry\.com\/en-gb\/search\/\d+\/$/.test(location)) throw new Error(`AFerry search: unexpected location ${location}`);
  // The page keeps a "Searching <operator>..." placeholder even when finished, so stop once two polls agree.
  let last = { rows: [], complete: false, searching: [] }, prevKey = null;
  for (let waited = 0; waited <= maxWaitMs; waited += 4000) {
    await sleep(waited === 0 ? 3000 : 4000);
    const page = await fetchFn(location, { headers: { "User-Agent": UA, Accept: "text/html" } });
    if (!page.ok) throw new Error(`AFerry results HTTP ${page.status}`);
    last = parseResults(await page.text(), date);
    const key = JSON.stringify(last.rows);
    if (last.rows.length && key === prevKey) { last.stable = true; break; }
    prevKey = key;
  }
  return { ...last, url: location };
}
