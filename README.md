# Cartref Borris

Letchworth → Borris (Co. Carlow) by car and ferry. Pick dates, choose day or overnight each way, and see
every Stena Line / Irish Ferries option door to door, ranked by time or by cost.

- Live page (once GitHub Pages is on): https://srapley-spec.github.io/Cartref-Borris/
- Google key: Settings (bottom of the page). Stored only on the phone. Needs **Routes API** enabled.
- Sailing times and status for the next day or two come from Stena Line's and Irish Ferries' own sailing-updates pages
  (collected twice an hour by a GitHub Action); further ahead the app uses a timetable pattern and says so.

Start with `CLAUDE.md`. Tests: `npm test`.

## Live prices and live sailing status (optional, one-off setup; strongly recommended for status)
The app needs a small helper on the internet (a free Cloudflare Worker) to read AFerry, Stena and Irish Ferries for it.
Connect it to this repo once and Cloudflare redeploys it automatically on every push to `main`; nothing to paste.
1. Create a free account at dash.cloudflare.com.
2. Workers & Pages → Create → **Import a repository** → connect GitHub → choose `srapley-spec/Cartref-Borris`.
   Leave the build command empty; the deploy command is `npx wrangler deploy` (the default). Production branch: `main`.
   `wrangler.toml` in the repo tells Cloudflare everything else, including `ALLOW_ORIGIN`.
3. Copy the Worker's `https://….workers.dev` address into the app: Settings → Proxy URL → Save.
With it set, the app reads sailing status the moment you open it (and every 5 minutes) and shows live prices for your
dates. Without it, the app uses the twice-hourly collected status and typical prices, and says so.

(Fallback if you'd rather not connect GitHub: create a Worker by hand and paste the whole of `proxy/worker.js`, plus a
variable `ALLOW_ORIGIN` = `https://srapley-spec.github.io`. That copy does not update itself.)
