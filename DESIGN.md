# DESIGN.md — mbta-leave-by

Status: design settled, pre-implementation. Unverified assumptions are marked **[unverified]**.

## Problem

For a recurring multi-leg MBTA commute (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute:

- **Home → office**: 132 bus inbound at `Main St @ South St` → Oak Grove → Orange Line → State
- **Office → home**: Orange Line from State → Oak Grove → 132 bus outbound → `Main St @ South St`

The 132 runs far less often than the Orange Line (~20-30 min headways vs ~5-10 min,
**[unverified]**). The bus is therefore the scheduling bottleneck.

## Decisions

| Topic | Decision |
|---|---|
| Form factor | Single `index.html`, inline JS/CSS, no build step, no backend; plus PWA `manifest.json` + `sw.js` |
| Target device | Phone first; installable PWA (add to home screen) |
| Hosting | GitHub Pages (HTTPS; required for service worker, enables Notifications API later) |
| API calls | Direct from browser to `api-v3.mbta.com`; local proxy only if CORS blocks |
| API key | Keyless by default; optional key field in settings, sent as `x-api-key` header |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Default config | Author's commute ships as the default (revisit before sharing widely); overridable via JSON panel |
| Refresh | Auto-fetch every ~30s + local 1s countdown tick + manual refresh button; refetch on `visibilitychange` to visible |
| Direction | Auto by time of day (default cutoff 12:00, every day) + manual toggle |
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

- **Bottleneck bus**: fetch predictions and schedules for the stop; for each upcoming
  trip use the prediction if present, else the schedule. Take the next 3. Needed
  because first-stop predictions (e.g. 132 at Oak Grove) are often absent until a
  bus is assigned **[unverified]**.
- **Orange connection (office → home)**: same per-trip rule; Orange predictions only
  cover the near term **[unverified]**, so later buses match against scheduled trains.
- A connection is labeled by its weakest input (live bus + scheduled train = scheduled).

## Leave-by computation

Commute parameters (all per-config; defaults are the author's):

| Parameter | Example |
|---|---|
| Walk home ↔ `Main St @ South St` | 5 min (both directions) |
| Walk office → State platform | 10 min |
| Transfer buffer at Oak Grove | 5 min |
| Stop slack (arrive before bus) | 1 min |
| Orange ride Oak Grove → State (ETA only) | ~20 min **[unverified]** |

### Home → office

```
leave_by = bus_departure - walk_home_to_stop - stop_slack
eta      = bus_arrival_at_oak_grove + transfer_buffer + orange_ride_minutes + ...
```

For each of the next 3 inbound 132 departures at `Main St @ South St`. `bus_arrival_at_oak_grove`
comes from the bus trip's prediction/schedule at Oak Grove; the Orange leg uses the
fixed `orange_ride_minutes`. ETA is shown as "arrive State ~HH:MM" per bus.

### Office → home

The binding constraint is the outbound 132 from Oak Grove. For each of the next 3
outbound 132 departures from Oak Grove:

1. Take Orange Line trips from State toward Oak Grove (live or scheduled per the
   fallback rules; trip-level pairing of `place-state` departure with `place-ogmnl` arrival).
2. A train is **viable** if
   `state_departure >= now + walk_office_to_state` and
   `oak_grove_arrival <= bus_departure - transfer_buffer`.
3. Pick the **latest** viable train (minimal waiting at Oak Grove).
4. `leave_by = that_train.state_departure - walk_office_to_state`.
5. If no viable train exists, mark the bus "no connection".

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
- Alerts above the list: only alerts active now, for the configured routes/stops,
  with service-impacting effects (e.g. `DELAY`, `DETOUR`, `SUSPENSION`, `SHUTTLE`,
  `STOP_CLOSURE`, `STATION_CLOSURE`, `CANCELLATION`, `SERVICE_CHANGE`). Excludes
  facility alerts (elevator/escalator) and future-dated alerts.
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
          "stop": "<stop-id: Main St @ South St>",
          "alight": "<oak-grove-busway-stop-id>",
          "direction_id": 0,
          "role": "bottleneck"
        },
        { "kind": "transfer", "minutes": 5 },
        {
          "kind": "transit",
          "route": "Orange",
          "from": "place-ogmnl",
          "to": "place-state",
          "rideMinutes": 20,
          "role": "filler"
        }
      ]
    },
    {
      "name": "Office to home",
      "legs": [
        { "kind": "walk", "minutes": 10 },
        { "kind": "transit", "route": "Orange", "from": "place-state", "to": "place-ogmnl", "role": "connection" },
        { "kind": "transfer", "minutes": 5 },
        {
          "kind": "transit",
          "route": "132",
          "stop": "<oak-grove-busway-stop-id>",
          "direction_id": 1,
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

## MBTA API usage

Base: `https://api-v3.mbta.com` (V3 API, JSON:API format, GTFS/GTFS-Realtime based).

- Bus predictions / schedules:
  `/predictions?filter[route]=132&filter[stop]=<id>&filter[direction_id]=<0|1>`
  `/schedules?filter[route]=132&filter[stop]=<id>&filter[direction_id]=<0|1>&filter[min_time]=HH:MM`
- Bus arrival at Oak Grove (home → office ETA): include the `alight` stop in the stop
  filter and pair by `trip`.
- Orange predictions / schedules (connection check):
  same endpoints with `filter[route]=Orange&filter[stop]=place-state,place-ogmnl`,
  grouped by `trip` to pair State departure with Oak Grove arrival.
- Alerts: `/alerts?filter[route]=132,Orange&filter[datetime]=NOW`, filtered client-side
  by effect and stop.
- Stops (manual setup): `/stops?filter[route]=132`, `/stops/<id>`.

Rate limits: ~6 requests per 30s cycle for one user; keyless should suffice
**[unverified]**. A key raises the limit to 1,000 req/min **[unverified, per docs]**.

## PWA

- `manifest.json`: name, icons, `display: standalone`, start URL.
- `sw.js`: cache-first for the app shell (`index.html`, manifest, icons);
  network-only for `api-v3.mbta.com` (never serve cached predictions).
- Browsers throttle timers in background tabs; the `visibilitychange` refetch
  covers returning to the app.

## Unverified assumptions (verify at start of build)

No network access was available during design; none of these are confirmed.

1. Stop IDs for `Main St @ South St` and the Oak Grove 132 busway stop.
2. Orange Line ids `place-ogmnl` (Oak Grove), `place-state` (State), and which
   `direction_id` is toward Oak Grove.
3. 132 direction ids: inbound (toward Oak Grove) = 0?
4. Whether every outbound 132 trip serves `Main St @ South St`, or short-turns need a
   headsign filter.
5. Whether first-stop predictions at Oak Grove are missing until bus assignment.
6. Orange prediction horizon.
7. `filter[datetime]=NOW` and effect values on `/alerts`.
8. CORS: `curl -i -H "Origin: https://lucaspimentel.github.io" https://api-v3.mbta.com/routes/132`
   and check `access-control-allow-origin`.
9. Headways (~20-30 min for 132, ~5-10 min for Orange) and Orange ride time (~20 min).

## Build plan

1. Verify API assumptions above with curl; update this doc to remove `[unverified]` marks.
2. Build v1 `index.html`, `manifest.json`, `sw.js` per this design.
3. Enable GitHub Pages on `main`.
4. User smoke-tests against live data.

## Future extensions

- Stop-search typeahead and form-based config editor.
- Multiple saved commutes / profiles per user, switchable.
- "Leave now" notifications via the Notifications API.
- Arrive-by target (highlight latest bus that makes a target time).
- Weekday-aware direction switching.
- Possibly a backend later, only if shared profiles or push reminders are wanted.
