# Cartref Borris

Letchworth → Borris (Co. Carlow) by car and ferry. Pick dates, choose day or overnight each way, and see
every Stena Line / Irish Ferries option door to door, ranked by time or by cost.

- Live page (once GitHub Pages is on): https://srapley-spec.github.io/Cartref-Borris/
- Google key: Settings (bottom of the page). Stored only on the phone. Needs **Routes API** enabled.
- Timetable is **not yet verified** against the operators; see `docs/architecture.md`.

Start with `CLAUDE.md`. Tests: `npm test`.

## Live prices and sailing updates (optional, one-off setup)
1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste the whole of `proxy/worker.js` → Deploy.
2. Worker → Settings → Variables: add `ALLOW_ORIGIN` = `https://srapley-spec.github.io`.
3. In the app: Settings → Proxy URL = the worker's `https://….workers.dev` address → Save.
After changing `proxy/worker-src.mjs` or `tools/aferry-search.mjs`, run `node tools/build-worker.mjs` and re-paste.
