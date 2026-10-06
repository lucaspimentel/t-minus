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

- MBTA data caching (investigated 2026-10-06, see `DESIGN.md`; route and stop lists are kept on
  the phone, and the server answers "Show nearby"), next: a read-through `/mbta/*` proxy
  (server key, shared cache, stale copies with their age), once the app has keyless users.

## Move to t-minus.lucasp.net, phase 2

Phase 1 is done: Railway serves the app at https://t-minus.lucasp.net/ with its API under
`/api/`, and the GitHub Pages copy shows a "moved" banner (see `DESIGN.md`, Hosting). After the
author has moved (Export → open the new address → Home Screen → Import → test notification):

- Rename the repo to `t-minus`, update Railway's source repo, and turn GitHub Pages off.
- Remove the root API paths, CORS / `ALLOWED_ORIGINS` and the `OPTIONS` handler, the banner,
  the `github.io` branch of `SERVER_API`, and the old-key copy (with `moved.spec.js`).
- Rename the packages (`t-minus`, `t-minus-server`) and the remaining `mbta-leave-by`
  mentions; point the local git remote at the new name.

## Deferred

- "Near me" on the main screen (setup's first-leg picker has "Show nearby"; see `DESIGN.md`).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
