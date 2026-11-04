import { test } from "node:test";
import assert from "node:assert/strict";
import { pageText, parseAferry, resolveDate } from "../tools/aferry-parse.mjs";

// Text shapes copied from the probe of https://www.aferry.com/en-gb/pembroke-rosslare/ on 4 Nov 2026.
const TEXT = [
  "Popular Ferry Companies for Pembroke to Rosslare | Ferry Operator | Average price | Duration | Weekly Sailings | Irish Ferries | £172 | 4h 1min | 14 sailings | Get Price | *Average price based on ferry bookings",
  "Average Pembroke–Rosslare crossing price by month, GBP, based on the last 12 months of crossings | Month | Avg. price (GBP) | Season | January | £192 | Peak Period | February | £187 | Mid-Season | March | £171 | Off-Peak | April | £187 | Peak Period | May | £187 | Peak Period | June | £179 | Mid-Season | July | £192 | Peak Period | August | £174 | Off-Peak | September | £176 | Mid-Season | October | £167 | Off-Peak | November | £180 | Mid-Season | December | £167 | Off-Peak | Price trend | £192 | Jan",
  "All the best ferry deals to Ireland with Stena Line, Irish Ferries & P&O Ferries – from £27 | Posted | : | 24 Aug 2026",
  "Latest Ticket Prices for Pembroke-Rosslare | Great Deal! | Pembroke | → | Rosslare | Fri 6 Nov, 14:45 | Irish Ferries | Search | £192.00 | Pembroke | → | Rosslare | Sat 2 Jan, 02:45 | Irish Ferries | Search | £151.50 | Frequently Asked Questions",
].join(" | ");

test("AFerry parser: dated latest quotes become sailing-keyed prices (year inferred from weekday)", () => {
  const r = parseAferry(TEXT, "2026-11-04");
  assert.deepEqual(r.quotes.map(q => [q.sailingId, q.amount]), [
    ["irish-PEM-RSL|2026-11-06|14:45", 192],
    ["irish-PEM-RSL|2027-01-02|02:45", 151.5],
  ]);
});

test("AFerry parser: monthly averages (12 months) and per-operator average; marketing 'from £27' ignored", () => {
  const r = parseAferry(TEXT, "2026-11-04");
  assert.equal(Object.keys(r.monthly).length, 12);
  assert.deepEqual(r.monthly[11], { amount: 180, season: "Mid-Season" });
  assert.deepEqual(r.monthly[1], { amount: 192, season: "Peak Period" });
  assert.deepEqual(r.operatorAvg, { irish: { amount: 172, duration: "4h 1min", weeklySailings: 14 } });
  assert.ok(!r.quotes.some(q => q.amount === 27));
});

test("resolveDate: weekday decides the year; a mismatched weekday gives null", () => {
  assert.equal(resolveDate("Fri", "6", "Nov", "2026-11-04"), "2026-11-06");
  assert.equal(resolveDate("Sat", "2", "Jan", "2026-11-04"), "2027-01-02");
  assert.equal(resolveDate("Mon", "6", "Nov", "2026-11-04"), null);
});

test("pageText: tags become separators, entities decoded", () => {
  assert.equal(pageText("<div>Irish Ferries</div><span>£172</span><p>A &amp; B</p>").trim(), "| Irish Ferries | £172 | A & B |");
});

import { parseIrishStatus } from "../tools/irish-status-parse.mjs";
test("Irish Ferries status rows: route, times, ship and status, whatever the cell separators", () => {
  const plain = "Scheduled Departure Scheduled Arrival Ship Status Dublin - Holyhead 07:30 11:00 Ulysses Arrived More Information. Sailing Update We wish to advise… Rosslare - Pembroke 20:45 00:46 Isle of Innisfree On Time More Information";
  const piped = "| Holyhead - Dublin | 14:30 | 16:45 | Dublin Swift | Early Sailing | More Information |";
  assert.deepEqual(parseIrishStatus(plain), [
    { routeId: "irish-DUB-HHD", from: "DUB", to: "HHD", dep: "07:30", arr: "11:00", ship: "Ulysses", status: "Arrived" },
    { routeId: "irish-RSL-PEM", from: "RSL", to: "PEM", dep: "20:45", arr: "00:46", ship: "Isle of Innisfree", status: "On Time" },
  ]);
  assert.deepEqual(parseIrishStatus(piped).map(r => [r.routeId, r.dep, r.ship]), [["irish-HHD-DUB", "14:30", "Dublin Swift"]]);
});
