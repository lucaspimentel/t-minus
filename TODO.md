# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, and short
route labels with MBTA color dots (see `DESIGN.md`).

## Small

- Import errors name trips by index (`trips[1] 132: stop "99999" ...`); use the trip name.

## Deferred

- "Near me" / GPS features (sorting stops by distance from the phone).
- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
