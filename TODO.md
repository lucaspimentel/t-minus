# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, and short
route labels with MBTA color dots (see `DESIGN.md`).

## Trip tracking (next; design agreed, plan each phase before starting)

Continue the "Leaving now" / "At the stop" states through the whole trip:
walking → at stop → riding leg 1 → transfer → riding leg 2 → … → walking → arrived.

- Start from "Leaving now" / "At the stop" (the highlighted ride), or "Track this trip" on an
  expanded row.
- Hybrid advance: the tracked vehicle leaving the boarding stop = boarded (assumed, with a
  "Missed it" undo for ~2 min); reaching the drop-off = got off. Also "I'm on a later one".
- A trip card replaces the list: phase ("On Bus 132"), live final arrival, the timeline with
  the current step highlighted, remaining stops to the drop-off with predicted times.
- Transfer outlook while riding: the next-leg departure you'll make and the margin; if it's
  tight or missed, auto-switch to the next feasible one and say so.
- Ends at the estimated arrival ("Arrived ~11:07am" briefly), or Cancel. Persisted per trip.
  Screen on only within ~2 min of a drop-off or transfer departure.
- API (verified): `/predictions?filter[trip]=<id>&include=stop,vehicle` returns the remaining
  stops (passed ones drop out) with times, plus the vehicle's `current_status` and
  `current_stop_sequence`: one extra request per poll. Bus trip ids can change mid-route:
  fall back to the leg's predictions/schedule.
- Phases: (1) state machine + trip card + live arrival + "Missed it"/Cancel/persistence;
  (2) remaining-stops list; (3) transfer outlook + auto re-plan, "I'm on a later one";
  (4) "Track this trip" on rows, screen-on near events.

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
