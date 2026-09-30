# DESIGN.md — mbta-leave-by

Status: design settled, pre-implementation. Unverified assumptions are marked **[unverified]**.

## Problem

For a recurring multi-leg MBTA commute (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute (the author's):

- **Home → office**: 132 bus inbound at `Main St @ South St` → Oak Grove → Orange Line → State
- **Office → home**: Orange Line from State → Oak Grove → 132 bus outbound → `Main St @ South St`

The 132 runs far less often than the Orange Line (~20-30 min headways vs ~5-10 min,
**[unverified]**). The bus is therefore the scheduling bottleneck.

## Decisions

| Topic | Decision |
|---|---|
| Form factor | Single `index.html`, inline JS/CSS, no build step, no backend |
| Hosting | GitHub Pages (HTTPS; enables Notifications API later) |
| API calls | Direct from browser to `api-v3.mbta.com`; local proxy only if CORS blocks |
| API key | Keyless by default; optional key field in settings, sent as `x-api-key` header |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Refresh | Auto-fetch every ~30s + local 1s countdown tick + manual refresh button |
| Direction | Auto by time of day (default cutoff 12:00, configurable) + manual toggle |
| Departures shown | Next 3 bottleneck-bus departures |
| Config | Preconfigured with the author's commute; editable via JSON panel |
| v1 extras | Service alerts; live Orange Line connection check (office → home) |
| Deferred | Schedule fallback, stop-search typeahead, form-based config editor |

## Leave-by computation

Commute parameters (defaults, all configurable):

| Parameter | Value |
|---|---|
| Walk home ↔ `Main St @ South St` | 5 min (both directions) |
| Walk office → State platform | 10 min |
| Transfer buffer at Oak Grove | 5 min |
| Stop slack (arrive before bus) | 1 min |

### Home → office

```
leave_by = bus_departure - walk_home_to_stop - stop_slack
         = bus_departure - 6 min
```

For each of the next 3 inbound 132 departures at `Main St @ South St`.
The Orange Line leg is not modeled (frequent enough); total ETA is not shown in v1.

### Office → home

The binding constraint is the outbound 132 from Oak Grove. For each of the next 3
outbound 132 departures from Oak Grove:

1. Take live Orange Line predictions for trips from State toward Oak Grove
   (trip-level: departure at `place-state`, arrival at `place-ogmnl`).
2. A train is **viable** if
   `state_departure >= now + walk_office_to_state` and
   `oak_grove_arrival <= bus_departure - transfer_buffer`.
3. Pick the **latest** viable train (minimal waiting at Oak Grove).
4. `leave_by = that_train.state_departure - walk_office_to_state`.
5. If no viable train has a prediction, mark the bus "no confirmed connection".

Orange ride time comes from the matched trip's predictions, not a fixed estimate.

### Display

- Per departure: bus time, `leave_by`, countdown to `leave_by`.
- Countdown turns red once `now > leave_by` ("missed; next bus at ...").
- Service alerts for the configured routes/stops shown above the list.
- Timestamp of last successful fetch; stale indicator if fetch fails.

## Configuration schema

Routes are data, not hardcoded constants, so the app can be reused by other users.
One commute per direction; exactly one leg per commute has `role: "bottleneck"`.

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
          "direction_id": 0,
          "role": "bottleneck"
        },
        { "kind": "transfer", "minutes": 5 },
        { "kind": "transit", "route": "Orange", "from": "place-ogmnl", "to": "place-state", "role": "filler" }
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
          "stop": "<stop-id: Oak Grove busway>",
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

- `bottleneck`: drives `leave_by`; live predictions fetched.
- `connection`: live predictions fetched and matched against the bottleneck (office → home Orange leg).
- `filler`: not fetched; assumed frequent.

## MBTA API usage

Base: `https://api-v3.mbta.com` (V3 API, JSON:API format, GTFS/GTFS-Realtime based).

- Bus predictions:
  `/predictions?filter[route]=132&filter[stop]=<id>&filter[direction_id]=<0|1>&sort=departure_time`
- Orange predictions (connection check):
  `/predictions?filter[route]=Orange&filter[stop]=place-state,place-ogmnl&filter[direction_id]=<id>`,
  grouped by `trip` relationship to pair State departure with Oak Grove arrival.
- Alerts: `/alerts?filter[route]=132,Orange&filter[activity]=BOARD,EXIT,RIDE`
  (optionally filtered by stop).
- Stops (manual setup, typeahead deferred): `/stops?filter[route]=132`, `/stops/<id>`.

Rate limits: keyless is sufficient for one user polling ~30s (3 requests/cycle);
a key raises the limit to 1,000 req/min **[unverified, per docs]**.

## Unverified assumptions (verify at start of build)

No network access was available during design; none of these are confirmed.

1. Stop ID for `Main St @ South St` (route 132) and for the Oak Grove 132 busway stop.
2. Orange Line ids `place-ogmnl` (Oak Grove), `place-state` (State), and which
   `direction_id` is toward Oak Grove.
3. 132 direction ids: inbound (toward Malden Center / Oak Grove) = 0?
4. Whether every outbound 132 trip serves `Main St @ South St`, or short-turns need
   a headsign filter.
5. Whether Oak Grove predictions for the 132 reflect terminal departures reliably.
6. CORS: `curl -i -H "Origin: https://lucaspimentel.github.io" https://api-v3.mbta.com/routes/132`
   and check `access-control-allow-origin`.
7. Headways (~20-30 min for 132, ~5-10 min for Orange).

## Open questions

1. Whether the Oak Grove transfer buffer (5 min) should also add `stopSlack` (1 min).

## Build plan

1. Verify API assumptions above with curl; update this doc to remove `[unverified]` marks.
2. Build v1 `index.html` per this design.
3. Enable GitHub Pages on `main`.
4. User smoke-tests against live data.

## Future extensions

- Schedule fallback with a clear "live data unavailable" indicator.
- Stop-search typeahead and form-based config editor.
- Multiple saved commutes / profiles per user, switchable.
- "Leave now" notifications via the Notifications API.
- Total ETA display (walk + wait + ride + transfer + ride).
- Possibly a backend later, only if shared profiles or push reminders are wanted.
