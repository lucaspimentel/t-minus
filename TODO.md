# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including no direction step, nearby-only next legs,
rail connections in the drop-off list, multi-route legs (`also`), return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, a sticky picker search, boxed legs in the trip editor, stop names in the timeline, trip tracking, service worker fallbacks (5xx, 3 s
timeout, "Saved copy", reload banner), and UI affordances: loading indicators, the old-data
age, Retry / backoff / rate-limit countdown, expand hints, pressed states, Undo toasts on
the main screen and in setup, pull-to-refresh, "Tracking ✕", the ride stop list with the stop before the drop-off, and browser tests in CI against a fake MBTA API, and leave-time push reminders ("Notify me", `server/`) deployed on Railway, and accessibility (row buttons, focus kept across redraws, screen-reader announcements; see `DESIGN.md`).

## UI


## Notifications

- Look into caching MBTA data in the push server's database (SQLite), e.g. route/stop lists and
  schedules shared across users, to cut API calls and the nearby-search payloads.
- Serve the app from the Railway service too (one origin; reinstall the Home Screen app).

## Rename

- Rename the repo to match "T-Minus" (the app name changed; the repo, Pages URL, storage keys
  and `sw.js` cache name still say mbta-leave-by). The Pages URL changes: reinstall the Home
  Screen app, carry trips over with Export/Import, and update Railway's `ALLOWED_ORIGINS` and
  source repo.

## Deferred

- "Near me" on the main screen (setup's first-leg picker has "Show nearby"; see `DESIGN.md`).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
