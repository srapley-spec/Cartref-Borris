// Fetch pages from GitHub's runner and save them under raw/ (uploaded as a workflow artifact) for building parser
// fixtures. Also prints each page gzip+base64 in 60 KB chunks so the content can be recovered from the job log alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const urls = (process.env.RAW_URLS || "").split(/\s+/).filter(Boolean);
const UA = "Mozilla/5.0 (compatible; cartref-borris personal trip planner; a few requests a day)";
mkdirSync("raw", { recursive: true });
let n = 0;
for (const url of urls) {
  n++;
  const name = `${String(n).padStart(2, "0")}-${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_").slice(0, 80)}.html`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-GB" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    writeFileSync(`raw/${name}`, body);
    console.log(`=== ${name}\nurl ${url}\nstatus ${res.status} final ${res.url} bytes ${body.length} content-type ${res.headers.get("content-type")} last-modified ${res.headers.get("last-modified")} date ${res.headers.get("date")}`);
    const b64 = gzipSync(body).toString("base64");
    for (let i = 0; i < b64.length; i += 60000) console.log(`B64 ${name} ${i / 60000 + 1}/${Math.ceil(b64.length / 60000)} ${b64.slice(i, i + 60000)}`);
  } catch (e) {
    console.log(`=== ${name}\nurl ${url}\nERROR ${e.name}: ${e.message}`);
  }
}
