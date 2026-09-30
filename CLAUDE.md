# CLAUDE.md

Phone-first PWA that answers "when do I leave?" for a bus + Orange Line commute.
Read `DESIGN.md` for decisions and verified MBTA API facts; `TODO.md` for pending work.

## Conventions

- No build step, no runtime dependencies. Static files served by GitHub Pages from `main` root:
  https://lucaspimentel.github.io/mbta-leave-by/
- `core.js`: pure logic only (no DOM, no fetch); every change there gets a unit test.
- After changing `core.js`, run `npm run stamp` (updates the `core.js?v=<hash>` import in
  `index.html`; a test fails otherwise). Bump `CACHE` in `sw.js` when the shell file list changes.
- `index.html`: UI, fetch, timers. Keep the request budget in `DESIGN.md` (keyless limit is 20 req/min).
- Update `DESIGN.md` when behavior changes; move finished items out of `TODO.md`.

## Commands

- Unit tests: `npm test` (Node 22+, `node --test`). CI runs the same on push.
- Local run: `python3 -m http.server 8765`, open `http://localhost:8765/`.
- Icons: `icons/icon.svg` is the source; re-render the PNGs (192, 512) from it with Playwright.

## Browser testing in the Claude Code cloud sandbox

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
- Don't `pkill -f` a pattern that also appears in the same shell command line; it kills the shell.
