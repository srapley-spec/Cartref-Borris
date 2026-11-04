import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceVersion, versionFile } from "../tools/build-worker.mjs";
import { WORKER_VERSION } from "../proxy/version.mjs";
import { handle } from "../proxy/worker-src.mjs";
import { readFileSync } from "node:fs";

test("proxy/version.mjs is the fingerprint of the current Worker source (stale file fails here)", () => {
  assert.equal(WORKER_VERSION, sourceVersion());
  assert.equal(readFileSync(new URL("../proxy/version.mjs", import.meta.url), "utf8"), versionFile());
});

test("worker /version reports the fingerprint, works without an Origin (monitoring), never cached", async () => {
  const r = await handle(new Request("https://w.example/version"), { ALLOW_ORIGIN: "https://srapley-spec.github.io" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { version: WORKER_VERSION, configured: true });
  const c = await handle(new Request("https://w.example/version", { headers: { Origin: "https://srapley-spec.github.io" } }), { ALLOW_ORIGIN: "https://srapley-spec.github.io" });
  assert.equal(c.headers.get("access-control-allow-origin"), "https://srapley-spec.github.io");
});
