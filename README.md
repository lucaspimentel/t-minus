# T-Minus

A phone-first web app that answers one question for a recurring MBTA trip: **when do I need to
leave?** It combines live predictions and schedules for every leg (bus, subway, light rail),
your walking and transfer times, and shows the next departures you can still catch, with a
countdown to each leave time.

Live at **https://t-minus.lucasp.net/**. Add it to your Home Screen to get notifications.

## Features

- **Leave times** for trips with any number of legs, from live predictions (schedules as a
  fallback), timed around the trip's least frequent leg.
- **Setup without GTFS ids:** pick routes and stops, or let auto-route plan a trip between
  stations, stops, addresses or your current location.
- **While riding:** the vehicle's position, the stops left, connection outlook, and picks for a
  different train or bus.
- **Notifications** (Web Push): heads-ups 10 and 5 min before leave time and "Leave now";
  stop alerts before each drop-off and when a connection is missed.
- **Offline-tolerant:** a service worker keeps the app shell; the server caches MBTA data and
  serves stale copies when the MBTA is down.

No build step and no runtime dependencies in the app: plain HTML, CSS and ES modules
(`index.html`, `core.js`, `setup.js`, `sw.js`).

## Running locally

Node 22.13+.

```
npm --prefix server ci
npx web-push generate-vapid-keys   # once
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
  DRY_RUN=1 DATA_DIR=./server/data PORT=8790 node server/main.mjs
```

Then open http://localhost:8790/. `DRY_RUN=1` logs pushes instead of sending them. Without
`MBTA_API_KEY` the MBTA's keyless limit (20 requests/min) applies; a free key
(https://api-v3.mbta.com/register) raises it to 1,000.

## Self-hosting

The server (`server/`) serves the app and its API from one origin. `server/README.md` covers a
Railway deployment: VAPID keys, the MBTA key, a volume for the SQLite database, and
`PUBLIC_URL`.

## Tests

```
npm test               # unit and server tests (node --test)
npm ci && npm run test:browser   # Playwright, against a fake MBTA API (no key or network)
```

CI runs both on every push.

## Docs

- `DESIGN.md`: decisions, verified MBTA API facts, the request budget.
- `TODO.md`: pending work.
- `CLAUDE.md`: conventions for coding agents (and humans).

## License

MIT, see `LICENSE`. Not affiliated with the MBTA. Transit data from the
[MBTA V3 API](https://www.mbta.com/developers/v3-api).
