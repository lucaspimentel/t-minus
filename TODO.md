# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

The N-leg engine (phase 1) is done; see `DESIGN.md`. Remaining: the setup UI.

## Setup UI (replaces the JSON editor)

- [ ] **`setup.js`** ES module for the form. Add it to the `sw.js` shell list (bump `CACHE`),
  stamp its import like `core.js`, and put pure helpers in `core.js` with tests.
- [ ] **Full-screen setup view:** opened from a Settings button, Save/Cancel; shown
  automatically on first run when no config is saved.
- [ ] **Trip list:** add, rename, delete, reorder; optional time window per trip; manual trip
  switch in the main view.
- [ ] **Leg editor:** ordered legs; add/remove/reorder transit legs; walk and transfer minutes
  entered manually (transfer default 5, or 3 within the same parent station).
- [ ] **Transit leg pickers:**
  - Route: search over bus, subway and light rail (`/routes?filter[type]=0,1,3`).
  - Direction: "toward <direction_destinations>".
  - Board stop: the direction's stops in trip order, with search.
  - Alight stop: only stops after the board stop.
- [ ] **Next-leg suggestions:** when adding a transit leg after another, list routes serving
  the previous alight station first, and preselect that station as the board stop.
- [ ] **Timing leg override:** show "Timing is based on <route>" per trip, with an option to
  pin a different leg.
- [ ] **"Add return trip":** reverse an existing trip (legs flipped, opposite directions,
  board/alight swapped) for review before saving.
- [ ] **App-wide fields:** departure count, minutes early at the stop, API key.
- [ ] **Rows collapsed by default:** countdown, "Leave 8:04 · 132 8:10 · arrive ~9:02" with the
  timing leg's badge; tap to expand every leg with its own badge.
- [ ] **Replace the JSON editor with Export/Import:** Export copies the JSON to the clipboard;
  Import takes pasted JSON through `validateConfig` + `checkStops`.

## Deferred

- "Near me" / GPS features (sorting stops by distance).
- Walk-time defaults estimated from stop coordinates.
- Commuter rail and ferry.
