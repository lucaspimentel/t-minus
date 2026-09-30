# DESIGN.md — mbta-leave-by

Status: v1 implemented. API verified against live data (2026-09-30).

## Problem

For a recurring multi-leg MBTA commute (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute:

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

The bus is the scheduling bottleneck; the Orange Line is frequent enough to approximate.

## Decisions

| Topic | Decision |
|---|---|
| Form factor | Static files, no build step, no backend, no dependencies: `index.html` (markup, CSS, UI/fetch/timers), `core.js` (pure logic ES module, unit tested), PWA `manifest.json` + `sw.js` |
| Target device | Phone first; installable PWA (add to home screen) |
| Hosting | GitHub Pages (HTTPS; required for service worker, enables Notifications API later) |
| API calls | Direct from browser to `api-v3.mbta.com` (CORS verified: `access-control-allow-origin: *`) |
| API key | Keyless by default; optional key field in settings, sent as the `api_key` query parameter (a custom header would add a CORS preflight). Stored in `localStorage` on the shared `lucaspimentel.github.io` origin; accepted (low-value key) |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Default config | Author's commute ships as the default (revisit before sharing widely); overridable via JSON panel |
| Refresh | Adaptive: fetch every 30s when next `leave_by` ≤ 15 min away, else every 60s. Local 1s countdown tick. Manual refresh button. Paused while hidden; refetch on `visibilitychange` to visible |
| Direction | Auto by time of day (default cutoff 12:00, every day) + manual toggle for off days |
| Departures shown | Next 3 bottleneck-bus departures |
| Config editing | JSON panel (paste/edit) |
| v1 extras | Service-impacting alerts; Orange Line connection check (office → home); ETA per bus (home → office); schedule fallback for missing predictions |
| Deferred | Stop-search typeahead, form-based config editor, notifications |

## Data sources and fallback

Each time shown carries a source badge:

| Badge | Meaning |
|---|---|
| live | From `/predictions` |
| scheduled | From `/schedules`; no prediction exists for that trip yet |

Fallback rules:

- **Bottleneck bus**: merge predictions and schedules per `trip` id; use the prediction
  if present, else the schedule. Take the next 3. Bus predictions exist only for trips
  already in progress or about to start, so with 30-60 min headways the 2nd and 3rd
  buses are usually scheduled.
- **Orange connection (office → home)**: same per-trip rule. Observed Orange prediction
  horizon: ~65 min (late evening sample; daytime not measured). Later buses match
  against scheduled trains.
- A connection is labeled by its weakest input (live bus + scheduled train = scheduled).

## Leave-by computation

Commute parameters (all per-config; defaults are the author's):

| Parameter | Default |
|---|---|
| Walk home ↔ `Main St @ South St` | 5 min (both directions) |
| Walk office ↔ State platform | 10 min (both directions) |
| Transfer buffer at Oak Grove | 5 min (platform ↔ Washington St bus stop) |
| Stop slack (arrive before bus) | 1 min |
| Orange ride Oak Grove → State (ETA only) | 15 min (scheduled; State → Oak Grove is 16 min) |

Observed ride times on the 132 (schedule, for reference): `Main St @ South St` → Oak Grove
7-14 min; Oak Grove → `Main St @ South St` 7-11 min. The app uses per-trip times from the
API, not these ranges.

### Home → office

```
leave_by = bus_departure - walk_home_to_stop - stop_slack
eta      = bus_arrival_at_oak_grove + transfer_buffer + orange_ride_minutes + walk_state_to_office
```

For each of the next 3 inbound 132 departures at `Main St @ South St`. `bus_arrival_at_oak_grove`
comes from the same trip's prediction/schedule at the Oak Grove stop; the Orange leg uses
the fixed `rideMinutes`. ETA is shown as "arrive ~HH:MM" per bus.

### Office → home

The binding constraint is the outbound 132 at Oak Grove. For each of the next 3
outbound 132 departures at Oak Grove:

1. Take Orange Line trips toward Oak Grove (live or scheduled per the fallback rules),
   pairing each trip's State departure with its Oak Grove arrival by `trip` id.
2. A train is **viable** if
   `state_departure >= now + walk_office_to_state` and
   `oak_grove_arrival <= bus_departure - transfer_buffer`.
3. Pick the **latest** viable train (minimal waiting at Oak Grove).
4. `leave_by = that_train.state_departure - walk_office_to_state`.
5. If no viable train exists, mark the bus "no connection".

Buses that cannot be reached even with the shortest known train ride
(`bus_departure - transfer < now + walk + min_ride`) are skipped, not shown as "no connection".

`stop_slack` does not apply at Oak Grove; `transfer_buffer` covers it.

### Countdown states

| State | Condition | Display |
|---|---|---|
| Green | `now < leave_by - 2 min` | Countdown to `leave_by` |
| Amber | `leave_by - 2 min <= now < leave_by` | "Leave now" + countdown |
| Red | `leave_by <= now < bus_departure` | "Hurry" (stop slack may still save it) |
| Hidden | `now >= bus_departure` | Row removed; next bus promoted |

### Display

- Per departure: bus time, source badge, `leave_by`, countdown/state, ETA (home → office).
- Alerts above the list: only alerts active now whose `informed_entity` matches a
  configured route **and** (stop, or no stop given), with service-impacting effects
  (e.g. `DELAY`, `DETOUR`, `SUSPENSION`, `SHUTTLE`, `STOP_CLOSURE`, `STATION_CLOSURE`,
  `CANCELLATION`, `SERVICE_CHANGE`). Excludes `STATION_ISSUE`, `ELEVATOR_CLOSURE`,
  `ESCALATOR_CLOSURE`, and future-dated alerts. Stop matching matters: route-level
  queries return line-wide Orange alerts (e.g. Jackson Square platform work).
- Timestamp of last successful fetch; stale indicator if fetch fails.

## Configuration schema

Routes are data, not hardcoded constants. One commute per direction; exactly one leg
per commute has `role: "bottleneck"`. Shipped default (author's commute):

```json
{
  "directionCutoff": "12:00",
  "stopSlackMinutes": 1,
  "apiKey": "",
  "commutes": [
    {
      "name": "Home to office",
      "legs": [
        { "kind": "walk", "minutes": 5 },
        {
          "kind": "transit",
          "route": "132",
          "direction_id": 1,
          "stop": "25996",
          "alight": "5991",
          "role": "bottleneck"
        },
        { "kind": "transfer", "minutes": 5 },
        {
          "kind": "transit",
          "route": "Orange",
          "direction_id": 0,
          "from": "place-ogmnl",
          "to": "place-state",
          "rideMinutes": 15,
          "role": "filler"
        },
        { "kind": "walk", "minutes": 10 }
      ]
    },
    {
      "name": "Office to home",
      "legs": [
        { "kind": "walk", "minutes": 10 },
        {
          "kind": "transit",
          "route": "Orange",
          "direction_id": 1,
          "from": "place-state",
          "to": "place-ogmnl",
          "role": "connection"
        },
        { "kind": "transfer", "minutes": 5 },
        {
          "kind": "transit",
          "route": "132",
          "direction_id": 0,
          "stop": "9326",
          "role": "bottleneck"
        },
        { "kind": "walk", "minutes": 5 }
      ]
    }
  ]
}
```

Leg roles:

- `bottleneck`: drives `leave_by`; predictions + schedules fetched.
- `connection`: predictions + schedules fetched and matched against the bottleneck.
- `filler`: not fetched; fixed `rideMinutes` used for ETA only.

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

- Bus predictions / schedules:
  `/predictions?filter[route]=132&filter[direction_id]=<0|1>&filter[stop]=<stop>[,<alight>]`
  `/schedules?filter[route]=132&filter[direction_id]=<0|1>&filter[stop]=<stop>[,<alight>]&filter[date]=YYYY-MM-DD&filter[min_time]=HH:MM`
  Pair rows by `relationships.trip.data.id`.
- Orange predictions / schedules (connection check):
  same endpoints with `filter[route]=Orange&filter[direction_id]=1&filter[stop]=place-state,place-ogmnl&include=stop`.
  Parent-station filters work, but rows come back with **child** stop IDs; map them
  via `include=stop` → `relationships.parent_station`.
- At Oak Grove (Orange terminal) predictions carry `arrival_time` only;
  `departure_time` is null. Use arrival there, departure at State.
- Alerts: `/alerts?filter[route]=132,Orange&filter[datetime]=NOW`, then filter
  client-side by effect and `informed_entity` stop.
- Stops (manual setup): `/stops?filter[route]=132&filter[direction_id]=<0|1>`, `/stops/<id>`.
- Query strings contain literal `[` `]`; `curl` needs `-g` to test them.

### Rate limits and request budget

Keyless limit is **20 requests/minute** (`x-ratelimit-limit: 20`, reset window 60s).
To stay well inside it:

- Schedules are static per service day: fetch on load, on direction change, and every
  15 min; cache in memory.
- Per poll cycle: bottleneck predictions (1) + Orange predictions (1, office → home only).
- Alerts: every 5 min.

Worst case ≈ 4 req/min at 30s polling. A key raises the limit to 1,000 req/min (per MBTA docs,
not tested).

## PWA

- `manifest.json`: name, icons, `display: standalone`, start URL.
- `sw.js`: network-first for same-origin files (new deploys show immediately), cache as
  offline fallback; precaches the app shell. `api-v3.mbta.com` is never cached.
- Polling pauses while the page is hidden (browsers throttle background timers
  anyway); the `visibilitychange` refetch covers returning to the app.

## Remaining unknowns

- Daytime Orange prediction horizon (only a late-evening sample was taken). The schedule
  fallback covers any gap, so this does not block the build.
- Weekend/holiday 132 schedules were not inspected; the app reads them from the API.

## Development

- Unit tests: `npm test` (runs `node --test`; Node 22+, no dependencies).
- Local run: `python3 -m http.server` in the repo root, open `http://localhost:8000/`.
- Deploy: GitHub Pages from `main`, repository root.
- Icons: `icons/icon.svg` is the source; PNGs are rendered from it.

## Future extensions

- Stop-search typeahead and form-based config editor.
- Multiple saved commutes / profiles per user, switchable.
- "Leave now" notifications via the Notifications API.
- Arrive-by target (highlight latest bus that makes a target time).
- Weekday-aware direction switching.
- Possibly a backend later, only if shared profiles or push reminders are wanted.
