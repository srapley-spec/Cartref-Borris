// CLI for the sailing-status collector (GitHub Action status.yml): reads/writes data/sailing-status.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { collect } from "./status-core.mjs";
export { collect, SOURCES, parseSource, STATUS_UA, KEEP_DAYS_BACK, recordKey } from "./status-core.mjs";

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const OUT = new URL("../data/sailing-status.json", import.meta.url);
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const timetable = JSON.parse(readFileSync(new URL("../data/sailings.json", import.meta.url), "utf8"));
  const { file, report } = await collect({ prev, timetable });
  writeFileSync(OUT, JSON.stringify(file, null, 1) + "\n");
  console.log(report.join("\n"));
  console.log(`complete: ${file.complete}; records: ${Object.keys(file.sailings).length}; coverage: ${Object.keys(file.coverage).length}; unscheduled: ${file.unscheduled.length}`);
  for (const u of file.unscheduled) console.log(`  not in timetable: ${u.routeId} ${u.date} ${u.dep} ${u.ship} (${u.status})`);
  if (!file.complete) process.exitCode = 0; // partial data is still published; the file records which sources failed
}
