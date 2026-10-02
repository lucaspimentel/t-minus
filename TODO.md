# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, and trip tracking (see `DESIGN.md`).

## Deferred

- "Near me" / GPS features (sorting stops by distance from the phone).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
- Leave-time push notifications. iOS only wakes a Home Screen PWA (iOS 16.4+) with Web Push
  from a server (no scheduled local notifications; timers stop in the background). Plan: a small
  always-on Node service on Railway (sleep disabled) that imports `core.js` and sends with the
  `web-push` package. Tapping "Notify me" on a row asks for permission (needs a tap on iOS) and
  sends the push subscription, trip, and ride; a 15–30 s loop polls that ride's predictions
  (author's API key, server-side), recomputes leave-by, pushes at leave-by, then deletes the
  reminder. Reminders persist across restarts (Railway volume or small Postgres/Redis). Needs
  VAPID keys, CORS for `lucaspimentel.github.io`, and `push` / `notificationclick` handlers in
  `sw.js`. Breaks "no backend".
