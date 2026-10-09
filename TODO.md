# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including no direction step, nearby-only next legs,
rail connections in the drop-off list, multi-route legs (`also`), return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, a sticky picker search, boxed legs in the trip editor, stop names in the timeline, trip tracking, service worker fallbacks (5xx, 3 s
timeout, "Saved copy", reload banner), and UI affordances: loading indicators, the old-data
age, Retry / backoff / rate-limit countdown, expand hints, pressed states, Undo toasts on
the main screen and in setup, pull-to-refresh, "Tracking ✕", the ride stop list with the stop before the drop-off, and browser tests in CI against a fake MBTA API, and leave-time push reminders ("Notify me", `server/`) deployed on Railway, and accessibility (row buttons, focus kept across redraws, screen-reader announcements; see `DESIGN.md`), and the move to Railway at t-minus.lucasp.net (one origin; repo renamed to `t-minus`), and previous rides ("I got on"), "Show more rides" and "Different train?", and stop alerts while riding (pushes before each drop-off, missed connections), and the MBTA proxy (`/api/mbta/*`: the server's key, a shared cache, stale copies when the MBTA is down), and notification updates (re-sent with "(was …)" when a time moves 2+ min), and starting a trip cancels its reminders, and the ride headline with stops and minutes left, and the ride's stops on the timeline with the vehicle, and connections: tight instead of missed while catchable, with "I'm at the stop" / "Different connection?" picks, and "I got on" in the expanded missed row (missed rows kept 5 min after leaving), and previous rides drawn like upcoming rows ("Missed · left 3 min ago", set apart by a gap).

## Deferred

- "Near me" on the main screen (setup's first-leg picker has "Show nearby"; see `DESIGN.md`).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
