# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Order: phase 1 (engine) ships first with the current JSON editor still working; phase 2
(setup UI) builds on it.

## Phase 1: N-leg engine

- [ ] **New config format** (breaking; old saved configs are dropped and must be rebuilt):
  - App-wide: `departureCount` (default 4), `stopSlackMinutes` (default 1), `apiKey`.
  - `trips[]`: `name`, optional `window` (`{ from: "HH:MM", to: "HH:MM" }`), optional
    `timingLeg` override, and ordered `legs`:
    - walk: minutes (to the first stop / from the last stop);
    - transit: `route`, `direction_id`, board `stop`, `alight` stop;
    - transfer: minutes between consecutive transit legs (default 5, or 3 within the
      same parent station).
  - Remove roles (`bottleneck` / `connection` / `filler`), `rideMinutes` and
    `directionCutoff`.
  - Remove the built-in `DEFAULT_CONFIG` commute; first run starts empty.
- [ ] **Live data on every transit leg:** predictions + schedules per leg, merged per trip as
  today (prediction beats schedule).
- [ ] **Timing leg, recomputed on every refresh:** the leg with the longest average headway in
  the loaded schedule window. Hysteresis: switch only when another leg's headway is at least
  1.5x the current one. A per-trip `timingLeg` override wins.
- [ ] **Chaining around the timing leg:**
  - Legs before it: working backwards, the **latest** vehicle that still makes the next leg
    with its transfer time.
  - Legs after it: the **earliest** vehicle after arrival + transfer; the last leg's
    arrival + final walk gives the ETA.
  - If any leg has no feasible vehicle, hide that departure.
  - `leave_by` = first leg's departure - walk before it (- stop slack when the first transit
    leg is the timing leg).
- [ ] **Live/scheduled badge per leg** (a row carries every leg's source).
- [ ] **Polling:** 60s when the next `leave_by` is 15 min away or less, otherwise 120s
  (was 30s / 60s). Update the request budget in `DESIGN.md` for N legs.
- [ ] **Keep existing behavior:** next-service-day fill, alerts (all legs' routes and stops),
  save-time `checkStops` (adapt to the new format; check every transit leg).
- [ ] **Trip selection:**
  - The trip whose `window` contains now; if windows overlap, the first in the list wins.
  - No match: the last trip used.
  - A manual switch holds until the next window starts.
- [ ] **Example config:** `examples/bus-orange.json` with the author's commute (two trips with
  windows 00:00-12:00 and 12:00-24:00), importable on a new device.
- [ ] Unit tests for all of the above in `core.js`; update `DESIGN.md`.

## Phase 2: Setup UI (replaces the JSON editor)

- [ ] **`setup.js`** ES module for the form. Add it to the `sw.js` shell list (bump `CACHE`),
  stamp its import like `core.js`, and put pure helpers in `core.js` with tests.
- [ ] **Full-screen setup view:** opened from a Settings button, Save/Cancel; shown
  automatically on first run when no config is saved.
- [ ] **Trip list:** add, rename, delete, reorder; optional time window per trip; manual trip
  switch in the main view.
- [ ] **Leg editor:** ordered legs; add/remove/reorder transit legs; walk and transfer minutes
  entered manually.
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
