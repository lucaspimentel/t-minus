# DESIGN.md — mbta-leave-by

Status: N-leg engine and setup UI implemented; remaining setup extras in `TODO.md`. API
verified against live data (2026-09-30).

## Problem

For a recurring multi-leg MBTA trip (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute (`examples/bus-orange.json`):

- **Home → office**: 132 bus inbound at `Main St @ South St` → Oak Grove → Orange Line → State
- **Office → home**: Orange Line from State → Oak Grove → 132 bus outbound → `Main St @ South St`

The 132 (Redstone Shopping Center ↔ Malden Center) passes Oak Grove mid-route on
Washington St; Oak Grove is not a terminal or busway stop for it. Weekday headways
(2026-09-30 schedule):

| Service | Headway |
|---|---|
| 132 inbound at `Main St @ South St` | 18-34 min AM peak, ~60 min midday, 30-45 min PM, ~60 min evening; first 06:03, last 23:32 |
| 132 outbound at Oak Grove | 30-49 min AM, ~60 min midday, 28-42 min PM; first 05:32, last 23:03 |
| Orange Line (peak) | 3-5 min (avg ~4.6) |

The infrequent leg (here the bus) constrains the trip; the app detects it automatically.

## Decisions

| Topic | Decision |
|---|---|
| Form factor | Static files, no build step, no backend, no dependencies: `index.html` (markup, CSS, UI/fetch/timers), `setup.js` (setup view), `core.js` (pure logic ES module, unit tested), PWA `manifest.json` + `sw.js` |
| Target device | Phone first; installable PWA (add to home screen) |
| Hosting | GitHub Pages (HTTPS; required for service worker, enables Notifications API later) |
| API calls | Direct from browser to `api-v3.mbta.com` (CORS verified: `access-control-allow-origin: *`) |
| API key | Keyless by default; optional key field in settings, sent as the `api_key` query parameter (a custom header would add a CORS preflight). Stored in `localStorage` on the shared `lucaspimentel.github.io` origin; accepted (low-value key) |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Default config | None: first run opens the setup view. The author's commute is `examples/bus-orange.json` (importable) |
| Trips | Any number of named trips, each with any number of transit legs; optional time window per trip picks the trip shown |
| Refresh | Adaptive: fetch every 60s when the next `leave_by` is ≤ 15 min away, else every 120s. Local 1s countdown tick. Manual refresh button. Paused while hidden; refetch on `visibilitychange` to visible |
| Departures shown | Next `departureCount` departures (config, 1-8, default 4) |
| Config editing | Full-screen setup view (gear button) with route/direction/stop pickers; JSON only via Export/Import |
| Extras | Service-impacting alerts; live data on every leg; schedule fallback for missing predictions; next-service-day fill |
| Deferred | Setup extras (see `TODO.md`), notifications |

## Data sources and fallback

Each leg time shown carries a source badge:

| Badge | Meaning |
|---|---|
| live | From `/predictions` |
| scheduled | From `/schedules`; no prediction exists for that trip yet |

- **Per leg**: merge predictions and schedules per vehicle `trip` id; the prediction wins
  when present. A leg's badge is its board stop's source (the time the rider must catch).
  Bus predictions exist only for trips in progress or about to start, so with 30-60 min
  headways later buses are usually scheduled. Observed Orange prediction horizon: ~65 min
  (late evening sample).
- **Next service day**: when today's schedule window reaches the end of the service day
  and today's data yields fewer than `departureCount` rows (late evening, after the last
  vehicle), fetch the next service day's schedules (03:00-12:00) for every leg and fill the
  remaining rows from them. Next-day data is cached separately from today's because GTFS
  trip IDs repeat across days. Times on a different calendar date than now show the weekday
  ("Thu 6:03 AM").

## Leave-by computation

A trip is walk/transfer minutes around one or more transit legs (`tripShape`):
`walkBefore` (before the first transit leg), `transfers[i]` (between transit legs `i` and
`i+1`; a missing transfer leg counts as 0), `walkAfter` (after the last transit leg).

### Timing leg

The transit leg leave-by is based on (`pickTimingLeg`), recomputed whenever schedules are
fetched:

1. A per-trip `timingLeg` override wins.
2. Otherwise the leg with the longest average headway in the loaded schedule window
   (`averageHeadway`; fewer than 2 departures = Infinity, i.e. the leg barely runs).
3. Hysteresis: the previous choice is kept unless the new candidate's headway is at least
   1.5× the previous leg's, so the timing leg doesn't flip between refreshes.

Schedules only (not predictions) feed this, so live data can't make it flicker. For the
example commute the 132 is the timing leg in both directions.

### Chaining (`tripRows`)

For each timing-leg vehicle in departure order (up to `departureCount` rows):

1. **Legs before it**, working backwards: the **latest** vehicle whose arrival is at or
   before the next leg's departure minus the transfer time (minimal waiting).
2. **First leg reachability**: if the timing leg is the first leg, the row stays until the
   vehicle leaves (red "Hurry" state); otherwise the first vehicle must depart at or after
   `now + walkBefore`.
3. **Legs after it**, working forwards: the **earliest** vehicle departing at or after the
   previous leg's arrival plus the transfer time.
4. If any leg has no feasible vehicle, the departure is skipped (e.g. the first bus of the
   day, which leaves before the first train arrives).

```
leave_by = first_leg.departure - walkBefore - (stop_slack if the timing leg is the first leg)
eta      = last_leg.arrival + walkAfter
```

Stop slack (`stopSlackMinutes`, default 1) applies only when the first leg is the timing
leg, as in the original bus-first rule; transfer times cover the waiting otherwise.

Example (office → home, 17:00, walk 10, transfer 5): for the 17:40 bus, the latest train
arriving at Oak Grove by 17:35 is the 17:16 from State, so `leave_by = 17:06`.

### Trip selection (`pickTrip`)

1. A manual switch (`{ index, setAt }` in `localStorage`) holds until the next time any
   trip's window starts after it was set (forever if no trip has a window).
2. Otherwise the first trip whose `window` contains now (`to < from` crosses midnight;
   `from == to` is the whole day; overlapping windows: first in the list wins).
3. Otherwise the last trip used.

### Countdown states

| State | Condition | Display |
|---|---|---|
| Green | `now < leave_by - 2 min` | Countdown to `leave_by` |
| Amber | `leave_by - 2 min <= now < leave_by` | "Leave now" + countdown |
| Red | `leave_by <= now < first_leg.departure` | "Hurry" (stop slack may still save it) |
| Hidden | `now >= first_leg.departure` | Row removed; next departure promoted |

### Display

- Per departure: countdown/state; "Leave 8:04 · arrive ~8:56"; one line per leg
  ("132 8:10 → 8:24") with its own source badge; the timing leg in bold. (Phase 2 collapses
  this to one line with tap-to-expand.)
- Trip switcher: one button per trip, hidden with a single trip.
- Alerts above the list: only alerts active now whose `informed_entity` matches a
  configured route **and** (stop, or no stop given), with service-impacting effects
  (e.g. `DELAY`, `DETOUR`, `SUSPENSION`, `SHUTTLE`, `STOP_CLOSURE`, `STATION_CLOSURE`,
  `CANCELLATION`, `SERVICE_CHANGE`). Excludes `STATION_ISSUE`, `ELEVATOR_CLOSURE`,
  `ESCALATOR_CLOSURE`, and future-dated alerts. Stop matching matters: route-level
  queries return line-wide Orange alerts (e.g. Jackson Square platform work).
- Timestamp of last successful fetch; stale indicator if fetch fails.

## Configuration schema

```json
{
  "departureCount": 4,
  "stopSlackMinutes": 1,
  "apiKey": "",
  "trips": [
    {
      "name": "Home to office",
      "window": { "from": "00:00", "to": "12:00" },
      "timingLeg": 0,
      "legs": [
        { "kind": "walk", "minutes": 5 },
        { "kind": "transit", "route": "132", "direction_id": 1, "stop": "25996", "alight": "5991" },
        { "kind": "transfer", "minutes": 5 },
        { "kind": "transit", "route": "Orange", "direction_id": 0, "stop": "place-ogmnl", "alight": "place-state" },
        { "kind": "walk", "minutes": 10 }
      ]
    }
  ]
}
```

- `departureCount`, `stopSlackMinutes`, `apiKey`: optional, app-wide.
- `trips[].window`: optional `HH:MM` range; `to` may be `24:00`.
- `trips[].timingLeg`: optional, 0-based index among the trip's **transit** legs; pins the
  timing leg.
- Transit legs: `route`, `direction_id` (0/1), board `stop`, `alight` stop (both required;
  parent station IDs such as `place-state` or child platform IDs both work).
- Old configs (two `commutes` with `bottleneck`/`connection`/`filler` roles and
  `directionCutoff`) fail validation and are ignored; they must be rebuilt.

### Setup view (`setup.js`)

- Opened from the gear button, and automatically on first run (no valid config; Cancel is
  hidden then). Polling pauses while it is open.
- App-wide fields (departures shown, minutes early at the stop, API key); one card per trip
  (name, optional time window, walk before/after, transit legs with a transfer time between
  them, move/delete); "Add trip".
- The editor works on a form model (`tripToForm` / `formToTrip` in `core.js`) and writes
  canonical legs back, omitting zero-minute walks and transfers.
- Transit leg picker: route (search over bus, subway, light rail) → direction ("toward
  <direction_destinations>") → board stop (trip order, search) → drop-off stop (only stops
  after the board stop, `stopsAfter`). A new leg's transfer time defaults to 3 min within the
  same station, else 5 (`defaultTransferMinutes`).
- Existing legs show stop names from the per-route/direction `/stops` docs, which Save then
  reuses for `checkStops`.
- Save errors appear on the trip they belong to; nothing is saved until they're fixed.
- Export copies the config JSON to the clipboard (falls back to a read-only textarea);
  Import loads pasted JSON into the form after `validateConfig` (saved only on Save).

### Save-time check against the API

Saving the config first checks its shape (`validateConfig`), then its stops against the
API (`checkStops`). For each route/direction pair, `/stops?filter[route]&filter[direction_id]&include=child_stops`
returns the stops in trip order. The check fails when:

- the pair has no stops (unknown route or invalid `direction_id`);
- a `stop` or `alight` ID is neither a listed stop nor a child platform of one;
- `stop` is not before `alight` (usually a wrong `direction_id`).

Failures block the save. If the API can't be reached, the config is saved with a
"couldn't verify stops" warning.

### Verified IDs

| Entity | ID | Notes |
|---|---|---|
| Route 132 | `132` | Redstone Shopping Center ↔ Malden Center Station |
| 132 direction 0 | Outbound | toward Redstone Shopping Center |
| 132 direction 1 | Inbound | toward Malden Center Station |
| `Main St @ South St`, inbound | `25996` | Stop IDs differ per side of street |
| `Main St @ South St`, outbound | `15982` | |
| Oak Grove, 132 inbound | `5991` | "Washington St opp Oak Grove Sta" |
| Oak Grove, 132 outbound | `9326` | "Washington St @ Oak Grove Station" |
| Orange direction 0 | South | toward Forest Hills |
| Orange direction 1 | North | toward Oak Grove |
| Oak Grove station | `place-ogmnl` | Parent station; child `70036` |
| State station | `place-state` | Parent station; children `70022` (southbound), `70023` (northbound) |

Route 132 has exactly one route pattern per direction (typicality 1): every trip serves
every stop, so no headsign or short-turn filter is needed.

## MBTA API usage

Base: `https://api-v3.mbta.com` (V3 API, JSON:API format, GTFS/GTFS-Realtime based).

- Per transit leg, predictions / schedules for its board and alight stops:
  `/predictions?filter[route]=R&filter[direction_id]=D&filter[stop]=<stop>,<alight>&include=stop`
  `/schedules?...same...&filter[date]=YYYY-MM-DD&filter[min_time]=HH:MM&filter[max_time]=HH:MM`
  Pair rows by `relationships.trip.data.id`.
- Parent-station filters work, but rows come back with **child** stop IDs; map them
  via `include=stop` → `relationships.parent_station`.
- At a terminal (e.g. Oak Grove for the Orange Line) predictions carry `arrival_time` only;
  `departure_time` is null. Arrival is used at the alight stop, departure at the board stop.
- Alerts: `/alerts?filter[route]=<trip routes>&filter[datetime]=NOW`, then filter
  client-side by effect and `informed_entity` stop.
- Stops (save-time check): `/stops?filter[route]=R&filter[direction_id]=D&include=child_stops`.
- Query strings contain literal `[` `]`; `curl` needs `-g` to test them.

### Rate limits and request budget

Keyless limit is **20 requests/minute** (`x-ratelimit-limit: 20`, reset window 60s).
To stay well inside it:

- Per poll: one `/predictions` request per transit leg of the shown trip.
- Schedules: one request per transit leg on load, on trip change, and every 15 min.
- Alerts: one request every 5 min.
- Schedule window: from now to max(6 h, 90 min × `departureCount`) ahead; once it reaches
  22:00 it is extended to the end of the service day (28:00).
- Next service day schedules: one request per transit leg, only when today has fewer than
  `departureCount` rows; at most once an hour.
- Setup: one `/routes` request per session, one `/stops` request per route/direction pair
  (cached for the session, 4 for the example); Save reuses them.

A 2-leg trip polls at ≤ 2 req/min (60s) plus a load burst of about 5-7 requests; a 4-leg trip
≤ 4 req/min. Rapid reloads can still hit the limit (seen in testing with ~8 fresh loads in a
minute). A key raises the limit to 1,000 req/min (per MBTA docs, not tested).

## PWA

- `manifest.json`: name, icons, `display: standalone`, start URL.
- `sw.js`: network-first for same-origin files, revalidating with the server
  (`cache: 'no-cache'`) rather than trusting GitHub Pages' 10-minute HTTP cache; cache as
  offline fallback; precaches the app shell. `api-v3.mbta.com` is never cached.
- `index.html` imports `core.js?v=<content hash>` and `setup.js?v=<content hash>`, and
  `setup.js` imports `core.js?v=<content hash>` (`npm run stamp`; a unit test enforces all
  three), so a new page can never run against a stale cached module. Mixing the two once left the
  app stuck on "Loading…" (missing export → module never ran). The hash is computed with
  LF line endings so Windows checkouts and CI agree.
- If the module has not started within 5 s, the page shows "The app failed to start" with a
  Reload button instead of staying on "Loading…".
- Polling pauses while the page is hidden (browsers throttle background timers
  anyway); the `visibilitychange` refetch covers returning to the app.

## Remaining unknowns

- Daytime Orange prediction horizon (only a late-evening sample was taken). The schedule
  fallback covers any gap.
- Weekend/holiday 132 schedules were not inspected; the app reads them from the API.

## Development

- Unit tests: `npm test` (runs `node --test`; Node 22+, no dependencies).
- Local run: `python3 -m http.server` in the repo root, open `http://localhost:8000/`.
- Deploy: GitHub Pages from `main`, repository root.
- Icons: `icons/icon.svg` is the source; PNGs are rendered from it.

## Future extensions

- Setup extras (see `TODO.md`).
- "Leave now" notifications via the Notifications API.
- Arrive-by target (highlight the latest departure that makes a target time).
- Possibly a backend later, only if shared profiles or push reminders are wanted.
