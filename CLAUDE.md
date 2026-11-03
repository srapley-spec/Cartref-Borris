# Cartref Borris: working rules

Read this first, every session. The context for this project lives in this repo, not in any chat.

**Purpose (Sam, 3 Nov 2026):** get Sam (car, 2 adults) from 20 Hitchin Road, Letchworth SG6 3LT to his father's
house in Borris, Co. Carlow and back, by car and ferry. For any outbound and return dates: every option
door to door, ranked **by time** and **by cost**, with a **day / overnight** choice for each direction.

## Where the context is
1. `docs/architecture.md`: layers, data sources, what is verified and what isn't, decisions log, known gaps.
2. `docs/stories/`: one file per capability, with acceptance criteria and the tests that prove it.
3. The tests (`tests/`): the exact behaviour.
A behaviour change updates its story in the same commit. If a chat disagrees with these files, the files win
until they are updated; say so.

## Principles
- **Never hide an option.** Filters apply only on Sam's explicit choice (Day/Night). Unpriced options stay in the
  cost ranking, after the priced ones, flagged "no price yet".
- **Never present unverified data as fact.** `data/sailings.json` has `verified: false` until each route has been
  checked against the operator's own timetable; the page shows a banner while it is false. Drive times from the
  fallback estimates are marked `*`. Fares are only ever ones Sam entered or ones actually fetched, never guessed.
- **Answer the real questions:** when to leave home, which crossing, when you arrive, what it costs.
- `src/core` is pure: no DOM, network or clock reads; data and drive times are injected.
- Every time on screen comes from `options()` in `src/core/plan.js`; no timing arithmetic in the page.

## Keys
Never ask for or handle a raw API key in chat, the repo, tests or logs. The Google key lives in the phone's
Settings (localStorage) and, for verification in cloud sessions, the environment secret `GOOGLE_MAPS_KEY`.

## Build, test, release
- No build step: `index.html` loads `src/app.js` as an ES module. GitHub Pages serves `main` from the root.
- `npm ci` once (CI), `npm test` runs the engine and browser tests (Playwright/Chromium, `TZ=Europe/London`,
  virtual clock Tue 3 Nov 2026 10:00).
- `main` is live. Work on a branch, run `npm test`, merge, then check the GitHub **Tests** run for that commit.
