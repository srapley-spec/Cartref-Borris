// One-off probe (run by .github/workflows/probe-sources.yml on GitHub's runners, which have open internet):
// which operator / aggregator pages can be read without a browser, and what times and prices they expose.
// Prints a short report to the job log. Fetches each URL once; no retries, no crawling.

const URLS = (process.env.PROBE_URLS || `
https://www.stenaline.co.uk/ferries-to-ireland
https://www.stenaline.co.uk/ferry-to-ireland/holyhead-dublin
https://www.stenaline.co.uk/ferry-to-ireland/fishguard-rosslare
https://www.irishferries.com/uk-en/sailing-updates/dublin-holyhead
https://www.irishferries.com/uk-en/sailing-updates/rosslare-pembroke/
https://www.irishferries.com/uk-en/ferry-routes/pembroke-rosslare/
https://www.directferries.co.uk/holyhead_dublin_ferry.htm
https://www.directferries.co.uk/dublin_holyhead_ferry.htm
https://www.directferries.co.uk/fishguard_rosslare_ferry.htm
https://www.directferries.co.uk/rosslare_fishguard_ferry.htm
https://www.directferries.co.uk/pembroke_rosslare_ferry.htm
https://www.directferries.co.uk/rosslare_pembroke_ferry.htm
https://www.directferries.co.uk/irish_ferries_dublin_swift.htm
https://www.aferry.com/en-gb/holyhead-dublin/
https://www.aferry.com/en-gb/fishguard-rosslare/
https://www.aferry.com/en-gb/pembroke-rosslare/
https://www.ferryhopper.com/en/ferry-routes/direct/holyhead-dublin
https://www.ferryscanner.com/en/ferry-routes/ferry-pembroke-rosslare
`).split(/\s+/).filter(Boolean);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const BLOCK = /just a moment|cf-chl|access denied|captcha|request unsuccessful|incapsula|akamai|perimeterx|are you a robot/i;

function text(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&pound;/g, "£").replace(/\s+/g, " ");
}
function around(s, re, n) {
  const out = []; let m; const r = new RegExp(re.source, "g");
  while ((m = r.exec(s)) && out.length < n) out.push(s.slice(Math.max(0, m.index - 70), m.index + 70).trim());
  return out;
}

for (const url of URLS) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9", Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const s = text(html);
    const times = [...new Set(s.match(/\b([01]\d|2[0-3]):[0-5]\d\b/g) || [])];
    const prices = around(s, /£\s?\d{2,4}(\.\d\d)?/, 6);
    const json = (html.match(/application\/ld\+json|__NEXT_DATA__|window\.__INITIAL_STATE__|apollo/gi) || []).slice(0, 4);
    console.log(`\n=== ${url}\nstatus ${res.status} final ${res.url} bytes ${html.length} in ${Date.now() - t0}ms${BLOCK.test(html.slice(0, 20000)) ? "  ** BOT CHALLENGE / BLOCK MARKERS **" : ""}`);
    console.log(`title: ${(html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim().slice(0, 120)}`);
    console.log(`embedded data markers: ${json.join(", ") || "none"}`);
    console.log(`distinct HH:MM (${times.length}): ${times.slice(0, 40).join(" ")}`);
    for (const c of around(s, /\b([01]\d|2[0-3]):[0-5]\d\b/, 6)) console.log(`  time ctx: …${c}…`);
    for (const p of prices) console.log(`  price ctx: …${p}…`);
    // Operator status tables: "Dublin - Holyhead 07:30 11:00 Ulysses On Time"
    const rows = [...s.matchAll(/([A-Z][a-z]+(?: [A-Z][a-z]+)?) - ([A-Z][a-z]+(?: [A-Z][a-z]+)?) (\d\d:\d\d) (\d\d:\d\d) ((?:[A-Z][a-z]+ ?){1,4}?) (On Time|Arrived|Departed|Delayed|Cancelled|Scheduled|Not Operating|[A-Z][a-z]+(?: [A-Z][a-z]+)?)/g)];
    for (const r of rows.slice(0, 20)) console.log(`  row: ${r[1]} → ${r[2]} dep ${r[3]} arr ${r[4]} ship ${r[5].trim()} status ${r[6]}`);
    const links = [...new Set([...html.matchAll(/href="([^"]*(?:timetable|holyhead|fishguard|rosslare|pembroke|dublin)[^"]*)"/gi)].map(m => m[1]))];
    if (links.length) console.log(`  route links: ${links.slice(0, 25).join(" ")}`);
    const apis = [...new Set([...html.matchAll(/["'](\/?(?:api|search|ajax|graphql)[^"'\s]{0,80}|https?:\/\/[^"'\s]*(?:api|search|price|fare)[^"'\s]{0,60})["']/gi)].map(m => m[1]))];
    if (apis.length) console.log(`  api-like urls: ${apis.slice(0, 20).join(" ")}`);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
      const j = m[1]; if (/price|offer|departure|trip/i.test(j)) console.log(`  ld+json: ${j.replace(/\s+/g, " ").slice(0, 600)}`);
    }
  } catch (e) {
    console.log(`\n=== ${url}\nERROR ${e.name}: ${e.message}`);
  }
}
