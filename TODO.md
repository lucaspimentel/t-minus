# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup view (see `DESIGN.md`). Remaining setup extras:

## Setup extras

- [ ] **Next-leg suggestions:** when adding a transit leg after another, list first the routes
  serving stops within ~300 m of the previous drop-off
  (`/stops?filter[latitude]&filter[longitude]&filter[radius]=0.003&filter[route_type]=0,1,3`,
  then `/routes?filter[stop]=...`), and preselect the board stop nearest the previous
  drop-off (e.g. bus stop `5991` → Oak Grove on the Orange Line).
- [ ] **Timing leg override:** show "Timing: Automatic (currently <route>)" per trip, with an
  option to pin a different leg (`timingLeg`).
- [ ] **"Add return trip":** reverse an existing trip (legs flipped, opposite directions,
  board/drop-off swapped, walks swapped) for review before saving.
- [ ] **Rows collapsed by default:** countdown, "Leave 8:04 · 132 8:10 · arrive ~9:02" with the
  timing leg's badge; tap to expand every leg with its own badge.

## Deferred

- "Near me" / GPS features (sorting stops by distance from the phone).
- Walk-time defaults estimated from stop coordinates.
- Commuter rail and ferry.
