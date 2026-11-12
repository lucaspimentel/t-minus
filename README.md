# T-Minus

A phone-first web app that answers one question for a recurring MBTA trip: **when do I need to
leave?** It combines live predictions and schedules for every leg (bus, subway, light rail, commuter rail),
your walking and transfer times, and shows the next departures you can still catch, with a
countdown to each leave time.

Live at **https://t-minus.lucasp.net/**. See [Web, Home Screen or iOS app](#web-home-screen-or-ios-app)
for what each way of running it adds.

## Features

- **Leave times** for trips with any number of legs, from live predictions (schedules as a
  fallback), timed around the trip's least frequent leg.
- **Setup without GTFS ids:** pick routes and stops, or let auto-route plan a trip between
  stations, stops, addresses or your current location.
- **While riding:** the vehicle's position, the stops left, connection outlook, and picks for a
  different train or bus.
- **Notifications** (Web Push, or APNs in the iOS app): heads-ups before leave time and
  "Leave now"; stop alerts before each drop-off and when a connection is missed.
- **Auto-bell:** pick days and an arrive-by time for a trip, and the server sets the reminder
  for the ride that gets you there.
- **Route map:** the trip's lines, stops, vehicles and your location over a base map of Boston
  and commuter rail's reach.
- **Offline-tolerant:** a service worker keeps the app shell; the server caches MBTA data and
  serves stale copies when the MBTA is down.

No build step and no runtime dependencies in the app: plain HTML, CSS and ES modules
(`index.html`, `core.js`, `setup.js`, `sw.js`).

## Web, Home Screen or iOS app

The same app runs three ways; each adds to the one before.

**In the browser** (any phone or desktop browser):

- Leave times, previous and more rides, setup, auto-route and the planner, the route map.
- En route: "Leaving now", "I got on", the ride's stops and connections, the screen kept on
  near leave time and while riding (Screen Wake Lock).
- The bell pins a ride. Notifications and auto-bell work where the browser has Web Push
  (Chrome, Firefox, desktop Safari, Android); on iOS, Safari has it only for Home Screen apps.
- Offline: the service worker serves a saved copy when the server is slow or unreachable.

**Added to the Home Screen** (iOS: Share → Add to Home Screen):

- Full screen, with its own pull-to-refresh, and a "New version available" card when the app
  resumes after a deploy.
- On iOS, notifications through Web Push: heads-ups before leave time, "Leave now", stop alerts
  before each drop-off and when a connection is missed; the bell sends them and auto-bell
  becomes available.

**The iOS app** (TestFlight; loads the live site in a native shell, so web changes need no new
build):

- Notifications through APNs instead of Web Push, including time-sensitive ones.
- Live Activities on the Lock Screen and Dynamic Island: the leave card before leave time,
  the walk card on the way to the stop, the ride card on board, kept current by pushes.
- A Home Screen widget (small, medium) with the next leave times, following the belled ride.
- Boarding from location: with Location on, it tells which vehicle you got on, a missed one,
  and getting off, without tapping "I got on".
- Permissions (notifications, Live Activities, location) in setup.

Use either the Home Screen app or the iOS app on a phone, not both: with two subscriptions every
reminder arrives twice.

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
- `IOS.md`: the iOS app's remaining plan.
- `server/README.md`: the server's API, Railway setup and variables.
- `CLAUDE.md`: conventions for coding agents (and humans).

## License

MIT, see `LICENSE`. Not affiliated with the MBTA. Transit data from the
[MBTA V3 API](https://www.mbta.com/developers/v3-api). Route map base map: MassGIS (Bureau of Geographic
Information), Commonwealth of Massachusetts EOTSS (towns, water, open space); City of Boston (BPDA neighborhoods); US Census
Bureau (TIGERweb).
