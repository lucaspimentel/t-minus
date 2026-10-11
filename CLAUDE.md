# CLAUDE.md

T-Minus (repo `t-minus`): a phone-first PWA that answers "when do I leave?" for a bus + Orange Line commute.
Read `DESIGN.md` for decisions and verified MBTA API facts; `TODO.md` for pending work.

## Conventions

- No build step, no runtime dependencies. Static files served by the Railway service
  (`server/`) from `main`'s root, with its API under `/api/`: https://t-minus.lucasp.net/
  (same origin only, no CORS). Storage keys use the `t-minus:` prefix.
- `core.js`: pure logic only (no DOM, no fetch); every change there gets a unit test.
- After changing any shell file (`index.html`, `core.js`, `setup.js`, `sw.js`, `manifest.json`),
  run `npm run stamp` (updates the footer version and the `?v=<hash>`
  imports in `index.html` and `setup.js`; a test fails otherwise). Bump `CACHE` in `sw.js` when
  the shell file list changes.
- `setup.js`: the setup view (DOM + setup-time requests); pure helpers belong in `core.js`.
- `index.html`: UI, fetch, timers. Keep the request budget in `DESIGN.md` (keyless limit is 20 req/min).
- Update `DESIGN.md` when behavior changes; move finished items out of `TODO.md`.
- After pushing to `main`, tell the user the footer version (`Version <date> · <hash>` in
  `index.html`) so they can check that the installed app has updated.

## Working with the author

- Features go grill (AskUserQuestion rounds) → plan → "proceed" → implement and push.
- For UI changes, show mockups before planning: write HTML in the app's style (both themes) to
  the scratchpad, screenshot it with Playwright, and send the images. Mockups settle choices
  faster than descriptions.
- When several items are reported to be handled "one by one", add them all to `TODO.md` first,
  then grill, plan, implement, and push each separately.

## Commands

- Unit tests: `npm test` (Node 22+, `node --test test/*.test.js`). CI runs the same on push.
- Browser tests: `npm run test:browser` (`@playwright/test`, specs in `test/browser/*.spec.js`;
  `npm ci` first). MBTA calls go to a fake API built from scenarios (`test/browser/fake-mbta.js`,
  `helpers.js`), so they need no key, relay, or network; CI runs them on every push. Add or
  update a spec when UI behavior changes. For a new spec, briefly break the feature (comment out
  its key line) and confirm the spec fails, then restore it. `a11y.spec.js` runs axe on each
  screen: new UI must pass it (buttons for anything tappable, a `data-focus` key on controls
  inside the once-a-second redraw).
- The page clock from `page.clock.install` keeps running in real time; before asserting on short
  timers (the ↻ spin, the pull-to-refresh hold), call `page.clock.pauseAt(...)` or test latency
  makes them flaky.
- `node scripts/record-fixtures.mjs` refreshes the recorded route/stop lists and rail network
  (`NODE_USE_ENV_PROXY=1`; paced for the keyless limit, ~2 min). Add a route there when a spec
  needs its stop lists.
- Local run: the push server serves the app and `/api` on one port (see `server/README.md`,
  `DRY_RUN=1`), open `http://localhost:8790/`.
- Push server (`server/`, the only backend and the only runtime dependency, `web-push`; it also
  serves the app's files, answers setup's "Show nearby", `GET /api/nearby`, auto-route's `GET /api/plan`, and proxies the app's MBTA
  requests, `GET /api/mbta/*`):
  `npm --prefix server ci`, then see `server/README.md` (env vars, `DRY_RUN=1`). `server/app.mjs`
  has no npm imports so `test/server.test.js` runs in `npm test`. The MBTA key goes only into
  Railway variables or a process env, never into a file. The Railway deploy config (build/start
  commands, healthcheck, watch paths) lives in the service's Railway settings, not the repo.
  `SERVER_API` in `index.html` is `/api` (same origin; empty hides "Notify me").
- Icons: `icons/icon.svg` is the source; re-render the PNGs (192, 512) from it with Playwright.

## Local testing with an MBTA API key

- The author's key (1,000 req/min instead of 20) is in 1Password:
  `op item get ai4cbcfsnlhcflmjczne6wipey --fields label=api-key --reveal`.
- Read it at runtime and inject it into the test page's saved config (`apiKey`); never write
  the key to the repo, a file, or command output.

## Browser testing in the Claude Code cloud sandbox

This section applies only to Claude Code in the cloud (the sandbox hosted by Anthropic:
claude.ai/code, or a session started from the app). Locally, run `npx playwright install chromium`
once and ignore it; CI installs its own browser.

- `@playwright/test` (1.63.0) is newer than the sandbox's preinstalled Playwright (1.56.1, whose
  Chromium is in `/opt/pw-browsers`), so its own browser build is missing there. Don't run
  `playwright install`; point the config at the preinstalled Chromium instead:
  `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser` (verified with 1.63.0 and
  Chromium 141: the full suite passes).
- The rest of this section is for ad-hoc checks against the live API (the browser tests use a
  fake API and need none of it).
- Playwright is global (`/opt/node22/lib/node_modules/playwright`); launch with `{ channel: 'chromium' }`.
- The sandbox browser does not trust the egress proxy CA, so HTTPS requests fail with
  `ERR_CERT_AUTHORITY_INVALID`. Relay them through Node instead of disabling TLS checks:
  `context.route(/^https:\/\//, ...)` → Node `fetch` (run with `NODE_USE_ENV_PROXY=1`) →
  `route.fulfill`. For MBTA calls, send an `Origin` header and pass back
  `access-control-allow-origin`.
- `page.route` does not cover service worker fetches: test the service worker on localhost
  (plain HTTP is allowed there), not through the relay.
- Use `page.clock.setSystemTime(...)` to test other times of day; rows will come from
  schedules only, since live predictions exist only for the real current time.
- Don't `pkill -f` (or `ps | grep pattern | xargs kill`) a pattern that also appears in the same
  shell command line; it kills the shell. Start servers with `run_in_background` and stop them
  by PID.
- An empty live result can be a service change, not a bug: check `/alerts` for a SUSPENSION
  first (the Green Line was suspended downtown through 2026-10-04).
