# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, trip tracking, service worker fallbacks (5xx, 3 s
timeout, "Saved copy", reload banner), and UI affordances: loading indicators, the old-data
age, Retry / backoff / rate-limit countdown, expand hints, pressed states, Undo toasts on
the main screen and in setup, pull-to-refresh, and browser tests in CI against a fake MBTA API (see `DESIGN.md`).

## UI

- Tracking a trip: tapping the "Tracking" button on the tracked row should cancel tracking
  (same as the bar's Cancel, with Undo).
- Ride card stop list: when stops are elided ("… 10 more"), always show the next stop and the
  stop before the drop-off, not only the drop-off.
- Accessibility: rows are not focusable or announced as buttons (`li` + click handler); the
  status line and countdown changes are not announced (`aria-live`).

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
  `sw.js`. Breaks "no backend". Option: also serve the app from the same Railway service (one
  origin, no CORS; reinstalling the Home Screen app is acceptable). The `sw.js` fallbacks
  (5xx, timeout) already cover a down or slow server.
