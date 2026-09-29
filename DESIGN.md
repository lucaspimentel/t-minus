# DESIGN.md — mbta-leave-by (early draft)

Status: draft, pre-implementation. Unverified assumptions are marked **[unverified]**.

## Problem

For a recurring multi-leg MBTA commute (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute (the author's):

- **Home → office**: 132 bus inbound at `Main St @ South St` → Oak Grove → Orange Line → State
- **Office → home**: Orange Line from State → Oak Grove → 132 bus outbound → `Main St @ South St`

The 132 runs far less often than the Orange Line (~20-30 min headways vs ~5-10 min,
**[unverified]**). The bus is therefore the scheduling bottleneck; the T is treated as
"frequent enough" and approximated rather than fully optimized.

## Core idea

Optimize around bus departures:

- **Home → office**: fetch live predictions for the next 2-3 inbound 132 departures at
  `Main St @ South St`. Compute `leave_by = next_bus_departure - walk_time_to_stop`.
  Show a countdown; go red once `now > leave_by` ("missed it, next bus at ...").
- **Office → home**: the binding constraint is the outbound 132 from Oak Grove.
  Compute `leave_by = next_outbound_bus - (walk_to_State + T_ride + transfer_buffer)`,
  and confirm a departing-now Orange Line train still catches that bus.

Total ETA is shown as a secondary line (walk + wait + ride + transfer buffer + ride).
Transfer waits are folded into a fixed buffer rather than chained live predictions;
chaining live Orange Line predictions is an optional refinement.

## Form factor

**Single-file static web app** (`index.html` + inline JS/CSS, no build step):

- Calls `https://api-v3.mbta.com` directly from the browser. The MBTA V3 API is
  documented as JSON API over HTTPS; CORS support from browsers is expected but
  **[unverified]** in a sandbox without network. If CORS blocks direct calls, fall
  back to a tiny local proxy (option B), but direct-first is the design.
- No backend, no hosting requirement: open the file locally, or drop on GitHub Pages.
- Settings persist in `localStorage`.

## Configuration-first (for sharing later)

Routes are defined as data, not hardcoded constants, so the app can be reused by
other users with different commutes:

```json
{
  "name": "Home to office",
  "legs": [
    { "kind": "walk", "minutes": 8 },
    {
      "kind": "transit",
      "route": "132",
      "stop": "<stop-id: Main St @ South St>",
      "direction_id": 0,
      "headsign_filter": "Malden Center Station",
      "role": "bottleneck"
    },
    { "kind": "walk", "minutes": 2, "note": "bus -> Orange Line platform" },
    {
      "kind": "transit",
      "route": "Orange",
      "from": "place-ogmnl",
      "to": "place-state",
      "role": "filler"
    }
  ]
}
```

Design rules:

1. **One leg is the bottleneck** (the infrequent one). `leave_by` derives from its
   next departure; other legs contribute fixed offsets or loose live checks.
2. **Stop IDs resolved at setup time, not hardcoded**: a small stop-search helper
   (typeahead against `/stops?filter[route]=...` or `/stops?search=...`) lets a new
   user configure their commute without knowing GTFS IDs.
3. **Config editable in the UI** (form + paste-JSON), stored per-browser in
   `localStorage`. No accounts, no backend; sharing = telling someone the app URL
   and letting them configure their own commute.

## MBTA API usage

Base: `https://api-v3.mbta.com` (V3 API, JSON:API format, GTFS/GTFS-Realtime based).

- Predictions: `/predictions?filter[route]=132&filter[stop]=<id>&filter[direction_id]=0`
- Schedules (fallback when no live predictions exist, e.g. late night):
  `/schedules?filter[route]=132&filter[stop]=<id>&filter[direction_id]=0&filter[min_time]=...`
- Stops (setup helper): `/stops?filter[route]=132`, `/stops/<id>`
- Orange Line: route id `Orange`, stops `place-ogmnl` (Oak Grove), `place-state`
  (State) — **[unverified]** standard GTFS ids, to confirm at implementation time.

Auth/rate limits: works keyless for light use; free API key raises the limit to
1,000 req/min **[unverified, per docs]**. Polling every ~30s for one user is fine
keyless; a key field in settings is cheap insurance.

Refresh behavior: manual button + optional auto-refresh timer (~30s) — pending decision.

## Open questions (blocking build)

1. Walk times: home → bus stop; bus stop → home; office → State.
2. CORS check against `api-v3.mbta.com` from a real browser.
3. Hosting: local file vs GitHub Pages (or both).
4. API key: keyless first vs paste-in key field.
5. Extra displays: schedule fallback, service alerts, or keep minimal.

## Future extensions

- Multiple saved commutes / profiles per user, switchable.
- Schedule-fallback mode with a clear "live data unavailable" indicator.
- Service alerts inline for the configured routes.
- Notifications ("leave now") via the Notifications API when hosted over HTTPS.
- Possibly a backend later only if shared/persisted profiles or push reminders
  are wanted; not needed for v1.
