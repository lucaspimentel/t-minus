# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including next-leg suggestions, return trips, the
timing-leg override, and collapsed rows (see `DESIGN.md`).

## Deferred

- "Near me" / GPS features (sorting stops by distance from the phone).
- Walk-time defaults estimated from stop coordinates.
- Commuter rail and ferry.
