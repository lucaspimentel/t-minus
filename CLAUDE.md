# CLAUDE.md

T-Minus (repo `t-minus`): a phone-first PWA that answers "when do I leave?" for a bus + Orange Line commute.
Read `DESIGN.md` for decisions and verified MBTA API facts; `TODO.md` for pending work;
`IOS.md` for the iOS app's next phases (Live Activities, widget).

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
- After pushing to `main`: check that CI passed and that Railway deployed the commit, then tell
  the user the footer version (`Version <date> · <hash>` in `index.html`) so they can check that
  the installed app has updated, together with the latest iOS build number (TestFlight "1.0 (N)":
  N is the `ios` workflow's run number of the last successful run with `upload` on; say whether
  the change needs that build or a newer one). Put both at the very end of the summary, each on
  its own line (`Version 2026-10-24 · 4430fa3647`, `iOS build: 1.0 (18)`), so they're easy to
  find. Railway skips a commit whose CI failed, and a push that touches
  none of its watch paths (tests, docs) doesn't deploy, so the live footer stays on the previous
  version. Deploy a skipped commit that's still wanted by hand (Railway tools or dashboard), or bump
  `server/deploy-trigger` and push.

## Working with the author

- Features go grill (AskUserQuestion rounds) → plan → "proceed" → implement and push.
- For UI changes, show mockups before planning: write HTML in the app's style (both themes) to
  the scratchpad, screenshot it with Playwright, and send the images. Mockups settle choices
  faster than descriptions.
- When several items are reported to be handled "one by one", add them all to `TODO.md` first,
  then grill, plan, implement, and push each separately.

## UI rules

Surfaces: the app's cards and rows, the leave and walk cards (Live Activity, Dynamic Island),
the widget's sizes, notifications. Check a UI change against every surface that shows the same
ride, and against these rules:

- One answer: every surface shows the app's current answer for the ride. A surface that can lag
  (widget, leave card) is refreshed when that answer changes.
- One time per phase: the leave-by while there's time to walk; the vehicle's departure once past
  the leave-by or walking. Every surface switches at the same moment.
- Each fact once per surface: a time, vehicle or arrival appears once in a given card or widget.
- A countdown and the time beside it name the same moment.
- One wording and format: "2:18pm", "in 6 min" (rounded down), "~" for a headway estimate,
  "arrive 3:03pm". Vehicles in two forms: full text lines (notifications, the leave card, the ride
  bar, the expanded row) say "Bus 132 toward Malden" / "Orange Line"; tight ones (the card's leg
  strip, every widget size, the Dynamic Island) say "Bus 132" / "Orange", with "→ Malden" only on
  the Home Screen widgets. The headsign goes with the first leg only.
  DESIGN.md "Surface wording" lists each surface.
- Color carries state: amber/red mean late or at risk, at the same thresholds on every surface;
  the color and the time say it, without a separate warning line.

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
- Push server (`server/`, the only backend; its runtime dependencies are `web-push` and `dd-trace`,
  the latter loaded only by the Railway start command; it also
  serves the app's files, answers setup's "Show nearby", `GET /api/nearby`, auto-route's `GET /api/plan` and `GET /api/places` (Photon / Nominatim), the iOS widget's `POST /api/widget`, and proxies the app's MBTA
  requests, `GET /api/mbta/*`):
  `npm --prefix server ci`, then see `server/README.md` (env vars, `DRY_RUN=1`). `server/app.mjs`
  has no npm imports so `test/server.test.js` runs in `npm test`. The MBTA key goes only into
  Railway variables or a process env, never into a file. The Railway deploy config (build/start
  commands, healthcheck, watch paths) lives in the service's Railway settings, not the repo.
  `SERVER_API` in `index.html` is `/api` (same origin; empty: the bell pins without notifications).
  Datadog (DESIGN.md "Observability"): RUM is off unless `/api/config` has the RUM IDs (so it is
  off locally and in the browser tests); the iOS app's native RUM caches `rum.ios` on the device,
  so turning it off on the server takes effect from the app's next launch. Never put the MBTA key
  in a URL (it would reach RUM and traces).
- Icons: `icons/icon.svg` is the source; re-render the PNGs (192, 512) from it with Playwright
  (and the iOS app icon, `ios/App/App/Assets.xcassets/AppIcon.appiconset/`, 1024 px, no alpha).
- iOS app (`ios/`, Capacitor; behavior in `DESIGN.md` "iOS app", next phases in `IOS.md`): it loads the live site, so web and server
  changes need no build. Native changes: edit `ios/` or `capacitor.config.json`, run
  `npx cap sync ios` (generated files are gitignored), and add new files to the Xcode project with
  the `xcodeproj` gem (no Mac here). Builds: the `ios` workflow (manual) uploads to TestFlight;
  every run renders the Live Activity views to PNGs (`live-activity-previews` artifact; `upload`
  off: previews only), the way to check native UI.
  APNs variables are in `server/README.md`.

## Local testing with an MBTA API key

- An MBTA API key (free at https://api-v3.mbta.com/register; 1,000 req/min instead of 20)
  comes from your own secret store or environment.
- Read it at runtime and inject it into the test page's saved config (`apiKey`); never write
  the key to the repo, a file, or command output.

## Browser testing in the Claude Code cloud sandbox

This section applies only to Claude Code in the cloud (the sandbox hosted by Anthropic:
claude.ai/code, or a session started from the app). Locally, run `npx playwright install chromium`
once and ignore it; CI installs its own browser.

- `@playwright/test` (`package.json`) is usually newer than the sandbox's preinstalled Playwright
  (whose Chromium is in `/opt/pw-browsers`), so its own browser build is missing there. Don't run
  `playwright install`; point the config at the preinstalled Chromium instead:
  `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser`.
- CI runs the headless shell, not full Chromium, so a spec can fail only in CI (the headless
  shell keeps no notifications, for example). Reproduce it here with
  `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`.
- Only `gh api` is available and job log downloads are blocked; read a CI failure from its
  check-run annotations: `gh api repos/lucaspimentel/t-minus/check-runs/<id>/annotations`.
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
