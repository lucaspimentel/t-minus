# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, and short
route labels with MBTA color dots (see `DESIGN.md`).

## Deferred

- "Near me" / GPS features (sorting stops by distance from the phone).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
- Leave-time push notifications. iOS only wakes a Home Screen PWA with Web Push from a server
  (no scheduled local notifications; timers stop in the background). Plan: a Cloudflare Worker
  (free tier, 1-min cron + KV) that imports `core.js`; tapping "Notify me" on a row sends the
  push subscription, trip, and ride; the worker polls that ride's predictions, recomputes
  leave-by, pushes at leave-by, then deletes the reminder. Needs VAPID keys, payload
  encryption, a `push` handler in `sw.js`, and a permission step. Breaks "no backend".
