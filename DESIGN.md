# DESIGN.md — T-Minus (repo: t-minus)

Status: N-leg engine and setup UI implemented. API verified against live data (2026-09-30).

## Problem

For a recurring multi-leg MBTA trip (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute (also the unit tests' fixture, `test/fixtures/bus-orange.json`):

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
| Form factor | Static files, no build step, no dependencies (the optional push server in `server/` is the only backend; see Notifications): `index.html` (markup, CSS, UI/fetch/timers), `setup.js` (setup view), `core.js` (pure logic ES module, unit tested), PWA `manifest.json` + `sw.js` |
| Target device | Phone first; installable PWA (add to home screen) |
| Hosting | The Railway service (`server/`) at `https://t-minus.lucasp.net/`: the app's files and its API under `/api/` on one origin (see Hosting) |
| API calls | Direct from browser to `api-v3.mbta.com` (CORS verified: `access-control-allow-origin: *`) |
| API key | Keyless by default; optional key field in settings, sent as the `api_key` query parameter (a custom header would add a CORS preflight). Stored in `localStorage` on the app's own origin (`t-minus.lucasp.net`; on GitHub Pages it was the shared `lucaspimentel.github.io` origin) |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Default config | None: first run opens the setup view |
| Trips | Any number of named trips, each with any number of transit legs; optional time window per trip picks the trip shown |
| Refresh | Adaptive: fetch every 60s when the next `leave_by` is ≤ 15 min away, else every 120s. Local 1s countdown tick. Manual refresh button. Paused while hidden; refetch on `visibilitychange` to visible |
| Departures shown | Next `departureCount` departures (config, 1-8, default 4) |
| Config editing | Full-screen setup view (gear button) with route and stop pickers (no direction step); JSON only via Export/Import |
| Extras | Service-impacting alerts; live data on every leg; schedule fallback for missing predictions; next-service-day fill |
| Deferred | See `TODO.md` (GPS "near me", default times estimated from stop coordinates, commuter rail/ferry) |

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
  ("Thu 6:03am").

## Leave-by computation

A trip is walk/transfer minutes around one or more transit legs (`tripShape`):
`walkBefore` (before the first transit leg), `transfers[i]` (between transit legs `i` and
`i+1`; a missing transfer leg counts as 0), `walkAfter` (after the last transit leg).
Despite the name, a `walk` leg is any time spent getting to or from the stops (walking, a
ride, etc.); setup labels them "Minutes to first stop" and "Minutes from last stop" (and a
transfer leg "Minutes to transfer").

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
2. **First leg reachability**: the first vehicle's `last_chance` (below) must be after `now`;
   this is the same for every trip, whichever leg is the timing leg. Otherwise the departure
   is **missed** while `now < first_leg.departure + 10 min`; only the most recent missed
   departure is kept. It leads the list and counts toward `departureCount` (1 missed + 3
   upcoming at 4); with `departureCount` 1 there is no missed row.
3. **Legs after it**, working forwards: the **earliest** vehicle departing at or after the
   previous leg's arrival plus the transfer time.
4. If any leg has no feasible vehicle, the departure is skipped (e.g. the first bus of the
   day, which leaves before the first train arrives).

```
last_chance = first_leg.departure - walkBefore      (arrive at the stop as it leaves)
leave_by    = last_chance - stop_slack
eta         = last_leg.arrival + walkAfter
```

Stop slack (`stopSlackMinutes`, default 1) applies to the first leg of every trip, whichever
leg is the timing leg, so every trip gets the same green/amber/red sequence. With 0 slack,
`leave_by == last_chance` and there is no red phase.

Example (office → home, 17:00, walk 10, transfer 5): for the 17:40 bus, the latest train
arriving at Oak Grove by 17:35 is the 17:16 from State, so `leave_by = 17:05`
(17:16 - 10 walk - 1 slack).

### Trip selection (`pickTrip`)

1. A manual switch (`{ index, setAt }` in `localStorage`) holds until the next time any
   trip's window starts after it was set (forever if no trip has a window).
2. Otherwise a location match (`pickByLocation`): among trips with `near: true` and stored
   first-stop coordinates, the nearest first stop within 1 km of the phone that is at least 2×
   closer than any such trip with a different first stop (shared first stop: list order).
3. Otherwise the first trip whose `window` contains now (`to < from` crosses midnight;
   `from == to` is the whole day; overlapping windows: first in the list wins).
4. Otherwise the last trip used (so a location pick sticks after walking away).

Location is requested only when some trip has `near` (choosing "When I'm near its first
stop" in the trip screen triggers the permission prompt): `getCurrentPosition` (low accuracy,
fix up to 5 min old, 10 s timeout) on launch and on return to the foreground, not while the
app stays open. The fallback trip shows first and the app switches when the fix arrives; it
never switches away from a trip with an active "Leaving now" / "At the stop". Denied or
unavailable: fallback, and the status line adds "Location off".

### Countdown states

| State | Condition | Display |
|---|---|---|
| Green | `now < leave_by - 3 min` | "Leave in 12 min", leave-by time on the right |
| Amber | `leave_by - 3 min <= now < leave_by` | "Leave in 2 min" (the color carries the urgency) |
| Red | `leave_by <= now < last_chance` | "Hurry · <1 min" (to `last_chance`), last-chance time on the right |
| Missed | `last_chance <= now < first_leg.departure + 10 min` | Gray "Missed · leaves in 2 min", then "Missed · 3 min ago"; first-leg departure on the right |
| Hidden | `now >= first_leg.departure + 10 min` | Row removed |

A missed row's collapsed line shows the first leg (the one missed) instead of the timing leg.
Live predictions disappear once a vehicle leaves its stop, so the last live times seen while
the app is open are kept per trip (`rememberLive`/`withRemembered`, in memory, dropped 30 min
after departure); after a fresh open, a missed row falls back to the schedule.

### En route ("Leaving now" / "At the stop")

For leaving earlier or later than leave-by. A bar under the status line always offers
[Leaving now] [At the stop]; while active it reads "Walking · at the stop ~9:25am"
[At the stop] [Cancel] or "At the stop since 9:23am" [Cancel].

- At-stop time: tap + `walkBefore` ("Leaving now"), or the tap ("At the stop"; replaces the
  estimate when tapped while walking).
- Today's rows: a ride is reachable if its first vehicle departs at or after the at-stop time
  (no stop slack). Reachable rows read "Bus 132 in 6 min" (to the first leg's departure,
  shown on the right, collapsed line shows the first leg); the first is highlighted green
  (the one being headed for), later ones neutral. No leave-by. Unreachable rides follow the
  missed rules (one gray row, missed immediately if the at-stop time is after it leaves).
  Next-day rows are not shown (the list may be shorter than `departureCount`).
- The highlighted ride is the target, re-taken every tick while it's reachable
  (`advanceEnRoute`). Before boarding the mode ends 30 min after the first tap, or on Cancel.
- "Track this trip" (expanded rows, except next-day rows and rides already gone) pins that
  departure as the target (`pinTarget`): it's never re-taken, boards when its first vehicle
  departs even if the at-stop estimate says it's unreachable, and has no 30-min cap. From the
  normal list it starts `kind: 'track'`: rows keep their leave-by countdowns, the pinned row
  has a green outline and a "Tracking ✕" button, and the bar reads "Tracking Bus 132
  7:40am" [Leaving now] [At the stop] [Cancel] (both keep the pin). While en route, the pinned
  row is highlighted instead of the first reachable one. "Tracking ✕" drops only the pin
  (`unpinTarget`): plain tracking ends; "Leaving now" / "At the stop" stays and the highlight
  goes back to the first reachable ride. Either way: "Tracking cancelled · Undo" toast.
- Boarding is assumed when the target's first vehicle departs (live or scheduled time) while
  it was reachable: its legs (trip id + times) become the ride, and a trip card replaces the
  list and the bar:
  - Headline by phase (`ridePhase`, `rideHeadline`): "On Bus 132 · off at 7:26am", "Transfer ·
    Orange 7:31am" (before leg i departs), "Walking · arrive 7:56am" (after the last arrival),
    "Arrived ~7:56am" (5 min, with Done), then back to the list.
  - Badge (the last leg's arrival source) and "arrive 7:56am"; the timeline (no first walk)
    with the current step bold.
  - Riding: "Next: State · 9 stops to go" (or "At Downtown Crossing", when stopped there), then
    the stops left to the drop-off with predicted times: all of them up to 6, else the next 3,
    "… N more", the stop before the drop-off (the cue to get ready), and the drop-off in bold
    (`rideStops`, `shownStops`). Tapping "… N more" lists every stop ("Show fewer" collapses)
    for the rest of that leg. From `/predictions?filter[trip]=<id>&include=stop,vehicle`
    (only remaining stops are returned; the drop-off matches the leg's `alight` or a child
    platform of it). Fetched on every poll while riding, and right away when a ride starts; no
    data (trip id changed, request failed) just hides the section.
  - Leg times refresh every tick by trip id from the per-leg predictions already polled
    (`trackLegs`): live entry, then remembered live times, then schedules, then the stored
    plan. A departed vehicle has no board entry and keeps its stored departure. No extra
    requests.
  - Next connection (riding leg i, or in the transfer before leg i+1): needed = leg i's
    arrival + transfer, margin = leg i+1's departure − needed (`transferOutlook`,
    `outlookText`): "Then Orange Line toward Forest Hills 7:31am · 4 min to spare", "· tight" (under 2 min, amber).
    A negative margin re-plans legs i+1… to the earliest feasible chain after `needed` (never
    an earlier vehicle) and reads "Then Orange 7:36am (missed 7:31am)" until that leg is
    boarded (`ride.missed`); no chain: "No connection after 7:26am", plan kept. No extra
    requests (the per-leg vehicles already polled).
  - A working connection still switches to a catchable vehicle leaving 2+ min sooner
    (`EARLIER_MIN`; not one that already left), e.g. the planned train fell behind a delayed
    earlier one: legs i+1… are re-planned from it, silently ("Then Orange 7:31am · 4 min to
    spare", or "· tight"). The 2-min gain keeps jittery predictions from flipping the plan; once
    switched, it only moves later again through the missed-connection path.
  - "Later one?" (riding): the leg's vehicles that left after the assumed one and by now (up
    to 3); picking one moves the leg to it and re-plans the later legs (`switchLeg`).
  - "Missed it" for 2 min after each boarding: on the first leg, back to "At the stop" now; on
    a later leg, that leg's next vehicle (not the missed one) and the earliest connections
    after it (`replanFrom`), or "No later connection." Cancel ends tracking.
- Cancel (the bar or the trip card) ends the mode at once (the list returns) and shows a
  bottom toast "Tracking cancelled · Undo" for 5 s (a tap elsewhere on it dismisses it); Undo restores the saved state (switching
  back to its trip if needed). "Done" after arrival has no undo.
- Stored per trip index in `localStorage` (`t-minus:en-route`, with the trip name; a
  renamed trip drops it; cleared when setup saves). Polls every 60 s while active.

Screen stays on (Screen Wake Lock, `keepAwake`) while the app is open and any upcoming row is
within `wakeMinutes` (default 10, 0 = off) of its leave-by, until its last chance. While a
ride is tracked (`keepAwakeRiding`): the last 2 min before the drop-off of the leg being
ridden, and the last 2 min before the next leg's departure during a transfer (fixed; off when
`wakeMinutes` is 0). The OS
releases the lock while the page is hidden; it is re-requested on the next render (and on a
tap, for browsers that want a gesture). Nothing happens where the API is missing or refused.

### Display

- Per departure: countdown/state with the leave-by time right-aligned ("Leave in 12 min   8:04am"),
  then, collapsed, a leg strip (the timeline's gray rail laid out horizontally: short stubs
  for the walks at both ends, evenly spaced colored dots with short labels, "─● Bus 132 ──●
  Orange ─"), then the source badge (LIVE/SCHEDULED, of the timing leg; the first leg on missed
  and en-route rows) and "arrive 8:56am" right-aligned under the time; routes and departures
  only when expanded. All times use the compact "8:04am" form (`formatTime`), with the weekday prefixed
  across dates. Tapping a row replaces the summary with a timeline under a divider:
  "Walk 5 min · 1 min early at the stop" (the slack part only when > 0; no first walk on
  en-route rows), each leg's stops and ride, "9 min to transfer" (the actual gap: next
  departure − previous arrival), and "Walk 10 min" (`timelineSteps`), between "Leave 8:04am"
  and "Arrive 8:56am" lines (gray nodes; no Leave on en-route rows, which have no leave-by);
  tap again to collapse. Layout
  (`renderTimeline`, shared with the ride card): Leave, each stop once, and Arrive as nodes on
  the rail with their times in one right-aligned column; each stop a hollow node ("Main St @ South St 7:08am"); each ride as a bar in its route's
  color from its first node to its last (drawn in pieces, so it ends at the node even when a
  name wraps), with "Orange Line · 15 min SCHEDULED" between the two stops (`lineLabel`: the
  vehicle's label, `vehicleLabel` for legs on several routes, plus "Line" for subway lines,
  "Green Line B") and "toward Forest Hills" below it (`toward`: the trip's headsign, from
  `include=trip`; left out without one); walks and transfers on a dotted gray rail with a walking figure
  (walks over 0 min, every transfer) and short text ("10 min to transfer"). Stop names come
  from the `include=stop` records the schedule and prediction responses already carry
  (`stopNames`, `fields[stop]=name,parent_station`; a parent station takes its platform's
  name; no extra requests); until known they show "—". Long names are cut with "…"; tapping a
  stop shows it in full (kept across re-renders) without collapsing the row. On the ride
  card, what's done is dimmed (muted text; faded nodes, bars and walking figures) and the current step is bold (riding: the ride and its
  drop-off; transfer: the transfer and the next boarding stop; walking: the last walk and
  Arrive). The ride card shows Arrive but no Leave.
  A muted ▾ at the bottom-right of a collapsed row
  (after the arrival) hints at this; expanded rows show ▴ in the same corner, on the "Track
  this trip" line. Expanded rows are remembered
  by the timing vehicle's trip id while the page is open.
- Pressed feedback: buttons darken and shrink to 97% while pressed; rows only darken (an
  inset overlay, `--press`). iOS's gray tap highlight is off.
- Status line (per trip): "Loading…" until that trip's first fetch completes ("Still
  loading… (MBTA is slow)" after 5 s; the list stays empty, "No upcoming departures found."
  only after a completed fetch), then "Updated 8:04pm" ("Updated 8:04pm (25 min ago)" in
  amber once older than two poll intervals, e.g. back in the app before the refresh lands;
  rows unchanged), or "Stale (…) · last updated …" /
  "Error: …" from that trip's own last fetch, followed by an underlined "Retry" (hidden while a
  fetch runs). After a failure the next attempt is automatic in 10 s, 20 s, 40 s, … up to the
  normal poll interval (`retryDelayMs`). A 429 shows "Rate limited · retry in 40 s" instead,
  counting down to the next whole minute + 1 s (`rateLimitDelayMs`; the keyless limit resets
  on whole minutes, and `x-ratelimit-reset` isn't exposed to the page), then retries. The ↻ icon spins during every fetch (polls
  included), stopping at the end of a full turn (0.8 s); with reduced motion it dims instead.
- Pull-to-refresh (the Home Screen app has no browser pull): a downward drag that starts with
  the main list scrolled to the top moves the list down at half the finger's speed (`pullOffset`,
  up to 110 px), revealing a thin ↓ arrow and "Pull down to refresh"; past 64 px the arrow turns
  to ↑ (150 ms rotation, instant with reduced motion) and reads "Release to refresh". Released
  there, it runs the same forced refresh as ↻ and holds a 48 px gap with a spinning ring and
  "Refreshing…" until the header ↻ stops (`whenIdle`; a pull during a refresh joins it). Upward
  or sideways drags, drags that start scrolled down, and setup are left as ordinary scrolling.
  `overscroll-behavior-y: none` on `html` turns off iOS's rubber-band bounce everywhere, so the
  two don't move at once.
- Route labels are short: rail by line ("Orange", "Green B", "Mattapan"), Silver Line as
  "Silver SL1", other buses as "Bus 132" / "Bus CT3". The dot is the route's MBTA color
  (yellow for buses, gray for the Silver Line). Setup uses the same labels and dots in the
  trip list, leg summaries, and route picker; the timing dropdown keeps full names.
  The route picker follows each label with the route's ends: a bus's long name, or a rail line's
  `direction_destinations` ("Forest Hills - Oak Grove"); search matches the ends too.
- Trip switcher: two buttons for two trips, a dropdown for three or more, hidden with a
  single trip.
- Alerts above the list: only alerts active now whose `informed_entity` matches a
  configured route **and** (stop, or no stop given), with service-impacting effects
  (e.g. `DELAY`, `DETOUR`, `SUSPENSION`, `SHUTTLE`, `STOP_CLOSURE`, `STATION_CLOSURE`,
  `CANCELLATION`, `SERVICE_CHANGE`). Excludes `STATION_ISSUE`, `ELEVATOR_CLOSURE`,
  `ESCALATOR_CLOSURE`, and future-dated alerts. Stop matching matters: route-level
  queries return line-wide Orange alerts (e.g. Jackson Square platform work).
- Timestamp of last successful fetch; stale indicator if fetch fails.

### Accessibility (VoiceOver and keyboard)

- **Rows:** each row's head (with the collapsed summary) is a `<button class="row-toggle"
  aria-expanded>`, named by `rowAriaLabel` ("Leave in 5 min, 7:04am, arrive 7:50am", plus
  ", reminder set"). A tap anywhere on the row still toggles it (the button's click bubbles to
  the row). Track, Notify, and the ride card's controls are buttons of their own.
- **Focus across the redraw:** the rows are rebuilt every second, so focusable controls carry
  `data-focus` (`row:<key>`, `track:<key>`, `notify:<key>`, `ride:<label>`, `bar:<label>`) and
  `setRows` refocuses the same one after the rebuild. Keyboard focus shows a 2 px ring
  (`:focus-visible`, the text color).
- **Announcements** (`#announce`, a visually hidden polite `role=status`):
  - status problems, once each as they appear (`statusProblem`: error, Stale, Rate limited,
    the save notice, Location off, Saved copy); not "Updated …" nor the retry countdown;
  - the first row's leave state changing (green → amber → red → missed), e.g. "Hurry · <1 min ·
    7:03am"; a new first row (one left, another trip) only resets the baseline.
  - The "New version available" card is a `role=status` too; toasts already were.
- A visually hidden `<h1>T-Minus</h1>` names the page.
- `test/browser/a11y.spec.js` runs axe (`@axe-core/playwright`) on the main list, an expanded
  row, setup (list, editor, picker) in both themes, the ride card, and the no-trips screen, and
  checks the row buttons, focus, and announcements. One rule is off: `meta-viewport` (iOS
  ignores `user-scalable=no` for pinch zoom, and `maximum-scale=1` stops its zoom when focusing
  an input).
- Contrast: text passes WCAG AA 4.5:1 in both themes. The light theme's green (`#1b7f45`) and
  amber (`#a35f00`) are darker than the dark theme's; the accent as text uses `--accent-text`
  (`#a85a00` in light), while `#ed8b00` fills (with dark text) stay.

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
        { "kind": "transit", "route": "132", "direction_id": 1, "stop": "25996", "alight": "5991",
          "label": "Bus 132", "color": "FFC72C" },
        { "kind": "transfer", "minutes": 5 },
        { "kind": "transit", "route": "Orange", "direction_id": 0, "stop": "place-ogmnl", "alight": "place-state",
          "label": "Orange", "color": "ED8B00" },
        { "kind": "walk", "minutes": 10 }
      ]
    }
  ]
}
```

- `departureCount`, `stopSlackMinutes`, `wakeMinutes`, `apiKey`: optional, app-wide.
- `trips[].window`: optional `HH:MM` range; `to` may be `24:00`.
- `trips[].near`: optional `true` (show when near the first stop); exclusive with `window`.
  Neither: shown only when chosen (or as the last used trip).
- `legs[].lat`, `legs[].lon` (transit): board stop coordinates, set by setup at save time
  (`locateLegs`; only the first leg's are used).
- `trips[].timingLeg`: optional, 0-based index among the trip's **transit** legs; pins the
  timing leg.
- Transit legs: `route`, `direction_id` (0/1), board `stop`, `alight` stop (both required;
  parent station IDs such as `place-state` or child platform IDs both work). Optional `label`
  and `color` (6-digit hex) are written by setup on every save from `/routes`
  (`labelLegs`/`shortRouteLabel`); without them rows show the route ID and no dot.
- Optional `also`: other route ids that make the same ride (same `direction_id`, same stops),
  e.g. `"route": "Green-B", "also": ["Green-C", "Green-D", "Green-E"]` from Government Center
  to Park Street. Any of them counts: schedules and predictions are fetched with
  `filter[route]=Green-B,Green-C,…` (no extra requests), alerts and the stop check cover them
  all. `label` is what the routes share ("Green"; "Bus 136/137" for buses, `commonLabel`) and
  `routeLabels` maps each route to its own label; each vehicle keeps its route
  (`relationships.route`, `vehicleRoute`), so the timeline, ride card, and bar say "Green D"
  (`vehicleLabel`) while the row strip says "Green".
- Old configs (two `commutes` with `bottleneck`/`connection`/`filler` roles and
  `directionCutoff`) fail validation and are ignored; they must be rebuilt.

### Setup view (`setup.js`)

- Opened from the gear button, and automatically on first run (no valid config). Polling
  pauses while it is open.
- List screen: one row per saved trip (name, time window, route chain like
  "● Bus 132 → ● Orange") with ↑/↓ to reorder, "Add trip", then a Settings card (departures
  shown, minutes early at the stop, minutes to keep the screen on before leave-by, API key), Export/Import, and "Reload app" (reloads the
  page, e.g. to pick up a new version in the installed PWA). Done saves changed app-wide
  fields and closes setup; it is disabled until a trip has been saved.
- Trip screen (tap a row, or "Add trip"): name, "Show automatically" (During a time window,
  with from/until fields / When I'm near its first stop / Never (only when chosen)), time to the first stop
  and from the last stop, transit legs with a transfer time between them, "Add return trip",
  "Delete trip" (also for the only trip: the config keeps `trips: []` and the settings). Cancel
  discards the edits; Save checks and stores the whole config right away, then returns to the
  list.
- No trips (none saved, or the last one deleted): one home base, the main screen's empty state:
  "No trips set up yet", the help line (`NO_TRIPS_HELP`: "Add the bus and train legs you take,
  and T-Minus tells you when to leave."), a full-width "Set up a trip" (44 px) and "Import trips";
  no en-route bar, ↻ or pull-to-refresh.

  | Path | Lands on |
  |---|---|
  | First launch; launch with `trips: []`; Reset | the empty main screen |
  | "Set up a trip" | a new trip; its Cancel returns to the empty main screen |
  | "Import trips" | the setup list with the import box open |
  | Deleting the last trip (in setup) | the setup list: "No trips yet. " + the help line, an orange "+ Add trip" |
  | Done with no trips | the empty main screen (settings alone are saved as `trips: []`) |
- Reordering and deleting trips also save right away.
- Reset (last section of setup): "Delete all trips and settings" asks to confirm ("Delete all
  trips and settings?", no Undo), cancels pending reminders on the push server, removes every
  `t-minus:*` key except the API key (kept as `{ trips: [], apiKey }`), and reloads to
  the empty main screen.
- Undo toasts (the main screen's bottom toast, 5 s): Cancel with edits → "Edits discarded ·
  Undo" (reopens the editor with the form; messages and pickers not restored; a generated
  return trip counts as edited); Delete trip (no confirm dialog) → "Trip deleted · Undo";
  ✕ on a leg → "Leg removed · Undo" (while that editor is open); Import over existing trips →
  "Trips replaced · Undo" (trips and settings). Any later save, and leaving setup, hides the
  toast. Undo restores trips and settings, not a cleared "Leaving now" / tracking state.
- Trip editor order: name, time to first stop, the legs, "+ Add transit leg", time from last
  stop, then a "More: when to show, leave-by time" group (`<details>`, closed for a new trip,
  open when the trip has a window, `near`, or a pinned timing leg) with "Show automatically"
  and "Leave-by time is based on". A trip with no legs shows a dashed box "No legs yet. Add
  the bus or train you take first." with a filled accent "+ Add transit leg", and Save is
  disabled until a leg exists; with legs, the add button has an accent outline. A new trip's
  name is suggested from its stops ("Oak Grove → State", first board stop → last drop-off)
  until one is typed; an empty name saves as "Trip N".
- Trips and legs share one pattern: tap the item (a muted › hints at it) to edit it, ↑↓ on
  its right (dimmed on the first and last). Deleting is inside: "Delete trip" in the trip
  editor, "Remove leg" in a leg's "Change leg" screen (both with Undo). In the trip editor
  each transit leg is its own box ("Leg 1", summary); a leg on several routes has its route
  checkboxes under the box; transfer times sit between the boxes and the walk times before
  the first and after the last.
- The editor works on a form model (`tripToForm` / `formToTrip` in `core.js`) and writes
  canonical legs back, omitting zero-minute walks and transfers.
- Leg picker: the header, context line, and search box stick together at the top while the
  list scrolls under them (so iOS's scroll for the keyboard can't slide the search under the
  header). One search box ("Search stations or routes") finds rail stations
  (`searchStations`, each with its lines) and routes (`searchRoutes`). Without typing, a first
  leg lists the rail lines and "Show all routes"; a later leg lists the stations (within 300 m)
  and routes near the previous drop-off (see next-leg suggestions).
- Station-first (subway and light rail): From station → To station. The To list
  (`reachableFrom`) holds the stations reachable without a transfer, under "● Orange toward
  Forest Hills" headings (one per line color and direction; "Green toward Boston College /
  Cleveland Circle / …"), from the canonical route patterns, so branches never mix (no Ashmont →
  Quincy); on a line with branches each station says which stop there ("Kenmore · Green
  B/C/D", "Copley · Green (any)"). The pick
  makes the leg with every route that passes both stations in order (`legBetween`): Government
  Center → Park Street is Green-B plus `also` C, D, E, with no extra step. Stop ids are parent
  stations. A later leg whose previous leg ended at a rail station opens on the To list from it
  ("From Downtown Crossing · Change"; Change leads to the search) when another line leaves from
  there; otherwise (Oak Grove after the Orange Line) on the nearby stations and routes, so the
  buses there show (without the line just ridden, or a station served only by it). The To list
  ends with "Buses near <station>" when buses stop within ~300 m (`NEARBY_RADIUS`). A new leg leaves out the
  routes of the leg before it (`withoutArrived`: a group goes only when all its routes were
  ridden, so Green-B to Kenmore still lists C and D), with "Hidden: the line you arrived on." and
  "Show Blue Line" at the end; typing a search lists everything. The "Near …" routes after a bus
  leg leave out that bus ("Show all routes" lists it). In the trip editor, a leg on
  several routes has a checkbox per route; unchecking drops it (`trimRoutes`; one always stays,
  re-pick the leg to restore one).
- Route-first (buses, or a rail line picked from the search): route → board stop → drop-off stop;
  no direction step (both directions' stop lists are loaded). The board list (`boardGroups`)
  has the stops served both ways first (most subway stations, direction 0's order), then each
  direction's own stops under "toward <direction_destinations>" (the two sides of a bus
  street). A direction's last stop can't be boarded, so a terminus is listed only under the
  direction leaving from it (Malden Center: "toward Redstone"). The drop-off list (`alightGroups`) has, per direction serving the board stop, the
  stops after it under "toward …"; at the end of a line there is one group. The drop-off pick
  sets `direction_id`. Then other routes that also go from the board stop to the drop-off in
  that direction (`findAlso`: `/routes?filter[stop]` at both stops, then each candidate's stop
  list in order, `servesInOrder`) are offered as "Also take" checkboxes, all checked; checked
  ones are saved as `also`. Without candidates the leg is done right away. For a rail route the
  drop-off list keeps only stations the network says are reachable on that route (its
  per-direction stop list merges the Red Line's branches).
- Connections in the drop-off list: each stop is followed by the rail lines (route types 0
  and 1: Red, Mattapan, Orange, Blue, Green B–E) at it: for a rail station, the lines listing
  that station (State and Government Center are ~155 m apart but separate stations); for
  other stops (street bus stops have no parent station), each station within 200 m tags only
  the list's nearest stop to it, and none when the station itself is in the list
  (`stopConnections`, `CONNECTION_METERS`, per direction list): "Washington St opp Oak Grove Sta
  ● Orange", but not Glen Rock Rd or 14 Summer St a block away. The leg's own route is left out; branches of a line (same color) merge as "Green
  D/E" (`commonLabel`).
- Rail network (`railNetwork`): one `/route_patterns?filter[route]=<rail routes>&filter[canonical]=true
  &include=representative_trip.stops` request (~100 KB; 18 patterns, each branch and direction,
  stations in order via the platforms' `parent_station`), cached in `localStorage`
  (`t-minus:rail-network`; `keptCopy`: used at once, refreshed in the background after 7 days). It drives station search, station-first legs, and the
  connections (`railStopsFrom`). If it fails, the search shows routes only and no connections. A new leg's transfer time defaults to 3 min within the
  same station, else 5 (`defaultTransferMinutes`).
- Next-leg suggestions: adding a leg after another lists only the routes serving stops within
  ~300 m of the previous drop-off (`/stops?filter[latitude]&filter[longitude]&filter[radius]=0.003`,
  then `/routes?filter[stop]=...`). This uses the stop's location because street bus stops have
  no parent station (bus stop `5991` at Oak Grove is not linked to `place-ogmnl`). After the
  route is chosen, the board stop nearest the previous drop-off (`nearestStop`, either
  direction) is preselected and the picker goes straight to the drop-off step; Back reaches the full list.
  Without a search, the route list holds only those nearby routes ("Finding routes nearby…"
  while loading) and a "Show all routes" button; a search covers every route, and a failed or
  empty lookup shows the full list.
- "Show nearby" (the first leg only; opt-in, asked each time, nothing remembered): a tap asks
  for the position (`getCurrentPosition`, the permission prompt on first use), then lists
  what is within ~800 m (`NEARBY_ME_METERS`; `filter[radius]=0.0072`): stations (from the rail
  network) and routes, each nearest first with its distance (`formatDistance`). The API's
  `/routes?filter[stop]` doesn't say which stop a route uses, so route distances come from the
  next hour's `/schedules?filter[stop]=<nearby stops>` (`routeDistances`; verified 2026-10-05:
  Malden ~200 records / ~50 KB, downtown ~780 / ~210 KB). The push server does that work
  (`GET /nearby?lat&lon` → `{ routes: [{ id, meters }] }`, a few KB, with the server's key; the
  nearby stop list is cached a day per ~50 m cell, a stop set's routes and schedules for the
  hour, in memory); setup asks it first (3 s timeout) and on any failure, or without a push
  server, makes the 3 requests itself. A rail line falls back to its nearest
  station, and a route with no trip in that hour shows "—" at the end. Choosing a route then
  sorts its boarding stops nearest first with distances (`byDistance`); the direction
  sections stay, ordered by their nearest stop (at Malden Center the 101's busway stop is in
  one direction's own section). A station leads to the usual drop-off list. Denied or
  unavailable location shows "Location is off for this app." / "Couldn't get your location."
  under the button and leaves the list as is. Back from the nearby list returns to the plain
  first-leg list.
- "Leave-by time is based on": per trip with 2+ legs, "Automatic (currently <route>)" (the
  app's live choice) or a pinned leg (`timingLeg`). Moving or removing legs keeps the pin on
  the same leg.
- "Add return trip" (`reverseTrip`): opens a new trip, saved after the original, with legs
  reversed, directions flipped, board/drop-off and the times to/from the stops swapped,
  transfers kept between the same legs, no window. A reversed stop not served in the new
  direction (a bus stop across the street) is replaced by the nearest stop that is, and the
  replacements are listed for review. For the example commute this reproduces the real
  return trip (`5991 → 9326`, `25996 → 15982`).
- Existing legs show stop names from the per-route/direction `/stops` docs, which Save then
  reuses for `checkStops` (only the edited trip's stops are checked).
- Save errors appear on the trip screen; nothing is saved until they're fixed.
- Export copies the saved config JSON to the clipboard (falls back to a read-only textarea);
  Import replaces all trips after the same checks as Save (`validateConfig`, `checkStops`),
  keeping the typed API key when the pasted JSON has none.

### Save-time check against the API

Saving the config first checks its shape (`validateConfig`), then its stops against the
API (`checkStops`). For each route/direction pair, `/stops?filter[route]&filter[direction_id]&include=child_stops`
returns the stops in trip order. The check fails when:

- the pair has no stops (unknown route or invalid `direction_id`);
- a `stop` or `alight` ID is neither a listed stop nor a child platform of one;
- `stop` is not before `alight` (usually a wrong `direction_id`).

Failures block the save. If the API can't be reached, the config is saved with a
"couldn't verify stops" warning.

Errors (from both checks) name the trip (`tripLabel`): `Trip "Office to home": route 132:
stop "99999" is not served ...`, with the 1-based position added when the name is missing
(`Trip 2`) or shared (`Trip 2 "Home"`). Leg references stay JSON-style (`legs[1].stop`). The
trip screen drops the edited trip's own label.

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
  `/predictions?filter[route]=R&filter[direction_id]=D&filter[stop]=<stop>,<alight>&include=stop,trip`
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
- Sparse fieldsets (`fields[schedule]=…`) limit attributes only; `relationships` (route, trip,
  stop) still come back. Multi-route legs rely on `relationships.route`.
- Platform (child) stops carry their station's name ("70036" → "Oak Grove"), so the timeline's
  stop names come from `include=stop` with `fields[stop]=name,parent_station`.
- Directions come from `include=trip` with `fields[trip]=headsign` on the same predictions and
  schedules (verified 2026-10-04: 132 "Malden" / "Redstone", Orange "Forest Hills" / "Oak
  Grove"; schedules carry it too). One small included record per trip; no extra requests.
- Rail station order per branch: `/route_patterns?filter[route]=<rail>&filter[canonical]=true
  &include=representative_trip.stops` (18 patterns; one per branch and direction). The
  per-direction `/stops` lists merge branches (Red: Ashmont and Braintree).

### Rate limits and request budget

Keyless limit is **20 requests/minute** (`x-ratelimit-limit: 20`, reset window 60s).
To stay well inside it:

- Per poll: one `/predictions` request per transit leg of the shown trip.
- Schedules: one request per transit leg on load, on trip change, and every 15 min.
- Alerts: one request every 5 min.
- While riding a tracked trip: one `/predictions?filter[trip]=…` request per poll (60 s).
- Schedule window: from 30 min ago (for missed rows, with the 15-min refresh) to
  max(6 h, 90 min × `departureCount`) ahead; once it reaches
  22:00 it is extended to the end of the service day (28:00).
- Next service day schedules: one request per transit leg, only when today has fewer than
  `departureCount` rows; at most once an hour.
- Setup: one `/routes` request (also the source of the stored route labels and colors), one
  `/stops` request per route/direction pair (choosing a route loads both directions; 4 for the
  example); Save and "Add return trip" reuse them. Both are kept on the phone (`keptCopy`,
  localStorage `{ at, data }` under `t-minus:routes` and `t-minus:stops:<route>/<dir>`)
  like the rail network: a later session uses the copy and makes no request; past 7 days it
  still uses the copy at once and fetches a fresh one in the background for next time; with
  the API down, setup works from the copies. Stop lists are kept trimmed (`trimStopsDoc`: ids,
  names, coordinates, child ids; no `included` records): Orange 321 → 27 KB, Red 422 → 35 KB,
  132 23 → 6 KB (measured 2026-10-06). Adding a leg after another costs 2 more (nearby stops, their routes); "Show nearby" costs 1
  request to the push server (which makes the 3 below with its key, fewer when cached), or 3
  without it (nearby stops, their routes, the next hour's schedules there). The drop-off
  list's connections and station-first legs use the rail network: one `/route_patterns`
  request, kept on the phone the same way. A station-first leg costs nothing more. Choosing a drop-off costs 2 (`/routes` at both stops) plus one
  `/stops` per other route serving both (e.g. 3 for the Green branches).

A 2-leg trip polls at ≤ 2 req/min (60s) plus a load burst of about 5-7 requests; a 4-leg trip
≤ 4 req/min. Rapid reloads can still hit the limit (seen in testing with ~8 fresh loads in a
minute). A key raises the limit to 1,000 req/min (per MBTA docs, not tested).

## Notifications (leave-time reminders)

iOS wakes a Home Screen app only with Web Push from a server (no scheduled local
notifications; page timers stop in the background), so reminders come from a small Node
service on Railway (`server/`), which also serves the app (see Hosting).

- **App:** "Notify me" sits next to "Track this trip" in an expanded row, shown only once
  `SERVER_API` is set in `index.html` (`/api`, same origin), for today's rows
  whose leave-by is ahead.
  - Tapping it asks for notification permission, subscribes the service worker
    (`pushManager.subscribe` with the server's VAPID key from `GET /vapid`), and posts the ride.
  - Set, the button shows the heads-up and leave times ("6:57am · 7:02am ✕", from the current
    row) and a bell sits before the row's leave time. Tapping the button again cancels it
    (`DELETE`).
  - Reminders are kept in `localStorage` (`t-minus:reminders`, keyed by trip and row) and
    stop showing once leave-by passes.
  - Without the Push API (iOS outside the Home Screen app), the button is disabled with "Add
    to Home Screen to get notifications."
  - Errors show a toast with Retry.
- **Push:**
  - The service worker shows `{ title, body, tag }`. The body names the first vehicle, its
    direction and time: "Bus 132 toward Malden at 7:08am" (`reminderText`). The tag is the row key, so a later push
    for the same ride replaces the earlier one.
  - Tapping a notification focuses or opens the app.
- **Test notification:** setup ends with a "Notifications" section and one button, "Send test
  notification in 10 s" (hidden without `SERVER_API`; disabled with the Home Screen hint
  without push). It subscribes like "Notify me", posts to `POST /test-push`, and toasts "Test
  notification in 10 s. Lock the phone to check." The server sends "Test notification" / "Push
  works. Sent 7:41am." from its loop (so up to 5 s late); it keeps pending tests in memory only
  (lost on restart), one per subscription, at most 100.
- **Server (`server/app.mjs`):**
  - **Endpoints** (under `/api/`; `GET /health` also at the root, for Railway's health check):
    `GET /vapid`, `GET /health`, `POST /reminders`, `DELETE /reminders/:id`,
    `POST /test-push`, and `GET /nearby` (setup's "Show nearby").
  - **What a reminder holds:** the subscription, the trip (checked with `validateConfig`), its
    slack, the timing leg, the row key (the timing-leg vehicle's trip id) and leave-by. Leave-by
    must be ahead and within 12 h.
  - **Polling:** each reminder polls `/predictions` (and `/schedules`, cached 15 min) for its
    legs with the same `legQuery` as the page. It rebuilds rows (`rowsFromDocs`) and finds its
    key.
  - **Decisions (`reminderStep`):**
    - A heads-up goes out 5 min before leave-by (`HEADS_UP_MIN`), unless the reminder was set
      inside that window.
    - "Leave now" goes out at leave-by. Both times follow the row as predictions change.
    - A row missing 3 polls in a row (cancelled, or the connection no longer works) sends "Ride
      cancelled" and ends the reminder. MBTA errors don't count; they retry in 20 s.
    - A reminder 10 min past leave-by with no row just expires.
  - **Poll timing:** every 60 s while leave-by is more than 20 min away, then every 20 s, and
    always at the heads-up and leave times (`reminderPollMs`). The loop runs every 5 s.
  - **Request budget (author's key, 1,000 req/min):** about 3 requests/min per leg per
    reminder, plus schedules every 15 min.
  - **Limits:**
    - Same origin only: a request whose `Origin` isn't this host gets 403 (no CORS).
    - 30 API requests/min per IP (the app's files don't count).
    - 5 active reminders per push subscription.
    - A 16 KB body.
    - A 404/410 from the push service drops the reminder.
- **Storage:** `server/store.mjs` keeps the reminders in SQLite (`node:sqlite`, no dependency) at
  `$DATA_DIR/reminders.db` on a Railway volume: columns for what the server queries (`id`,
  `endpoint`, `next_poll_at`) and the whole reminder as JSON (`body`), so its shape can change
  without a migration. Writes are per row; a tick's update never inserts, so a reminder deleted
  while the tick waited on the MBTA stays deleted. The old `reminders.json` was not imported.
- **Deployment:** Railway service sourced from `lucaspimentel/t-minus` @ `main`. Deploy
  settings (build `npm ci --prefix server`, start `node server/main.mjs`, health check
  `/health`, watch paths `server/**`, `core.js`, `index.html`, `setup.js`, `sw.js`,
  `manifest.json` and `icons/**`) live in the service's Railway settings, not
  the repo. Setup steps are in `server/README.md`. `web-push` is the only dependency, in
  `server/package.json`; the app has none.

## Hosting

- **One origin:** the Railway service serves the app at `https://t-minus.lucasp.net/` (a custom
  domain) and its API under `/api/`, so the app's requests to its server are same-origin.
- **The app's files:** an allowlist from the repo root (`/` → `index.html`, `core.js`,
  `setup.js`, `sw.js`, `manifest.json`, the three icons); anything else is a 404. Read once
  per process and kept in memory, with a content-hash `ETag` (304 on `If-None-Match`).
- **`Cache-Control`:** `no-cache` for the page, `sw.js` and `manifest.json` (revalidated each
  time); `public, max-age=31536000, immutable` for `?v=<hash>` modules; a day for icons. The
  page also gets `nosniff`, `no-referrer` and `x-frame-options: DENY`.
- **History:** the app was on GitHub Pages (`lucaspimentel.github.io/mbta-leave-by/`) until
  2026-10-06; it moved here in two steps (a "moved" banner on the Pages copy, then the repo
  rename to `t-minus` and Pages off). Storage is per origin, so trips moved by Export/Import,
  and the key prefix changed from `mbta-leave-by:` to `t-minus:`.

## MBTA data caching (investigation, 2026-10-06)

The question: should the push server cache MBTA data in its SQLite database for the app? Goals:
fewer keyless rate-limit hits (the server has a key, 1,000 req/min), faster setup, smaller
payloads, and resilience when the MBTA API is slow or down. Constraints if built: open to
anyone using the app (per-IP limits, an allowlist of paths and parameters so the key serves
nothing else), static data revalidated daily, stale copies served with their age when the MBTA
fails (predictions never older than ~2 min), and the app falls back to the MBTA directly when
the server fails.

**Measured** (live, keyless, 2026-10-06 ~11pm ET; sizes uncompressed, the wire is gzip at
~1/10; latency is the median from the sandbox):

| Request (class) | Size | Latency | Notes |
|---|---|---|---|
| `/predictions` leg, 132 / Orange (realtime) | 1.8 / 10.7 KB | ~50 ms | every 60–120 s per leg while open |
| `/predictions?filter[trip]` riding (realtime) | 14 KB | ~55 ms | every 60 s while riding |
| `/schedules` leg, 6.5 h, 132 / Orange (service day) | 2.7 / 24 KB | 50–75 ms | every 15 min per leg |
| `/alerts` (minutes) | 1.4 KB | ~45 ms | every 5 min |
| `/routes`, setup (static) | 65 KB (6 KB gz) | ~50 ms | once per setup session |
| `/stops` route+direction, 132 / Orange (static) | 23 / 321 KB (2 / 26 KB gz) | 50 / 150 ms | Orange is big: `include=child_stops` brings every entrance and node |
| `/route_patterns`, rail network (static) | 112 KB (10 KB gz) | ~280 ms | already kept in `localStorage` for 7 days |
| nearby `/stops` 300 m / 800 m Malden / 800 m downtown (static) | 3 / 11 / 22 KB | ~50 ms | |
| `/routes?filter[stop]` near Malden / downtown (static) | 2.7 / 6 KB | ~50 ms | |
| `/schedules` next hour near Malden / downtown ("Show nearby") | 62 / 227 KB | 255 / 920 ms | the only slow request |

- **Conditional requests:** no `ETag`; every response has `Last-Modified` and
  `cache-control: max-age=0, private, must-revalidate`. `If-Modified-Since` returns 304 only
  sometimes: the API runs several instances whose `Last-Modified` differs by up to ~30 s for
  the same data (13:58:22 / :47 / :51), and an instance that loaded later answers 200. Static
  data's `Last-Modified` was 2026-10-05 ~9:58am ET while the GTFS zip
  (`cdn.mbta.com/MBTA_GTFS.zip`, 25 MB) was last released 2026-10-02: the API reloads its data
  daily. So daily revalidation matches the source, and a revalidation costs a full response
  about half the time (cheap at these sizes).
- **Rate limit:** keyless responses carry `x-ratelimit-limit: 20`; the API root answers 406
  (no feed version endpoint).

**Volume** (from the code's cadence: a 2-leg trip open ~2 h a day, two ~30-min rides
tracked, two reminders): app ~290 requests/day (predictions ~160, riding ~60, alerts ~24,
schedules ~16, load bursts ~30); server ~145 per reminder (legs polled every 60 s, every 20 s
in the last 20 min, plus schedules), ~290/day. About 85% is realtime, which a cache can only
share when two clients ask the same thing within seconds (the app and its own reminder do).
Steady use is ~1–2 requests/min; only bursts (several reloads, setup) approach the keyless 20/min.

**Options:**

- **(A) Read-through proxy, `GET /mbta/<allowlisted path>?…`** on the push server: SQLite
  rows keyed by path and query; TTL by class (static: revalidate daily with
  `If-Modified-Since`; schedules: until the 15-min refresh; alerts: 60 s; predictions: 10 s);
  on MBTA failure, the last copy with an `X-Data-Age` header. The app calls it first and falls
  back to the MBTA after an error or ~2 s. Gains: keyless users stop hitting 20/min (the
  server's 1,000/min covers ~400 concurrently open apps at ~2 req/min, more with sharing);
  the app and its reminder share predictions; outages show old data instead of errors. Costs:
  the server becomes part of every poll (an extra hop to Railway; not measured), abuse handling for a
  public proxy, the service worker and the app's own cache layered on top, and every new query
  needs an allowlist entry. Size: tiny (hundreds of rows, a few MB).
- **(B) Digest endpoints:** `GET /nearby?lat&lon` (stations and routes with distances, ~2 KB
  instead of up to 227 KB and 920 ms), `GET /network` (the built rail network). The biggest
  payload and latency win, for an action used a few times per setup.
- **(C) No server:** keep static data in `localStorage` like the rail network: route list and
  each route's stop lists for 7 days (or until the API's `Last-Modified` moves), so a setup
  session after the first costs only the requests it has never made. Covers "faster setup"
  for repeat use; does nothing for rate limits or outages of realtime data.

**Status:** steps 1 (C) and 2 (B, `/nearby` only; see "Show nearby") are done: route and
stop lists kept on the phone, trimmed, refreshed in the background, and the server's nearby
digest.

**Recommendation:** not worth a general cache for one user with a key: realtime dominates and
the setup data is small on the wire. In order, if more people use the app keyless:
1. (C) client-side caching of `/routes` and `/stops` (an hour of work, no server).
2. (B) `/nearby` on the server (removes the one slow, large request).
3. (A) the proxy, for keyless users' polls and outage resilience, once there are users
   without a key; start with schedules and predictions (the rate-limit cost), then static.

## PWA

- `manifest.json`: name, icons, `display: standalone`, start URL.
- `sw.js`: network-first for same-origin files, revalidating with the server
  (`cache: 'no-cache'`) rather than trusting the browser's HTTP cache; precaches the
  app shell. `api-v3.mbta.com` is never cached. The cache is the fallback when the server
  answers 5xx (4xx is shown as is), takes over 3 s (the request keeps running and still
  updates the cache), or is unreachable. The 5xx and timeout fallbacks match exactly (with the
  `?v=` query) so a new page never gets an old module; offline ignores the query. Versioned
  modules (`?v=<content hash>`) are immutable, so a cached exact match is served without a
  request (a slow server delays only the page, not each module).
- When the page itself came from the cache, the status line adds "Saved copy". If the late
  network page then differs from it, the "New version available" card appears (above the footer version, with a full-width 44 px
  orange Reload button; neutral text, since it is not an error); if it's
  the same, "Saved copy" clears. The page asks the service worker (`nav-status` message) on
  load; the service worker also posts to open pages when the late response arrives.
- Update check: a Home Screen app resumed from the background keeps running the page it
  loaded. On each return to the app (`visibilitychange`, at most once a minute) and every 30
  min while it is open, the page fetches `./` (`cache: 'no-store'`; the service worker saves
  it, so Reload is quick) and compares its footer version (`pageVersion`, `isNewerPage`). A
  different one shows the same "New version available" card; no automatic reload.
  One request to the app's host, none to the MBTA; offline or the 3-s cache fallback reads as
  no update.
- `index.html` imports `core.js?v=<content hash>` and `setup.js?v=<content hash>`, and
  `setup.js` imports `core.js?v=<content hash>` (`npm run stamp`; a unit test enforces all
  three), so a new page can never run against a stale cached module. Mixing the two once left the
  app stuck on "Loading…" (missing export → module never ran). The hash is computed with
  LF line endings so Windows checkouts and CI agree.
- The main screen's footer shows "Version <date> · <hash>": a hash of the shell files
  (`index.html` without the version, `core.js`, `setup.js`, `sw.js`, `manifest.json`) and the
  date `npm run stamp` last changed it (a unit test enforces the hash), to tell whether the
  installed app has updated.
- If the module has not started within 5 s, the page shows "The app failed to start" with a
  Reload button instead of staying on "Loading…".
- Polling pauses while the page is hidden (browsers throttle background timers
  anyway); the `visibilitychange` refetch covers returning to the app.

## Remaining unknowns

- Daytime Orange prediction horizon (only a late-evening sample was taken). The schedule
  fallback covers any gap.
- Weekend/holiday 132 schedules were not inspected; the app reads them from the API.

## Development

- Unit tests: `npm test` (runs `node --test test/*.test.js`; Node 22+): the pure logic in
  `core.js`.
- Browser tests: `npm run test:browser` (Playwright, Chromium, phone viewport, New York time):
  `test/browser/*.spec.js` cover the main list, en route / ride card, setup, notifications,
  pull-to-refresh, the update check, accessibility (axe), and the service worker fallbacks. The app runs as is, served by `test/browser/server.mjs` (which can also
  fail, stall, or go down on purpose); MBTA requests are answered by a fake API
  (`fake-mbta.js`) from scenarios (trips with stop times, optional live delays, alerts) plus
  recorded route/stop lists for setup (`test/browser/fixtures/`, refreshed by
  `scripts/record-fixtures.mjs`). The page clock is faked; specs move it with `tick` /
  `tickTo`. The devDependencies are `@playwright/test` and `@axe-core/playwright`; the app itself has none.
- Push server: `test/server.test.js` (part of `npm test`) runs `server/app.mjs` against a fake
  MBTA, a recording sender, a temp store, and a fake clock. Locally:
  `npm --prefix server ci`, then `node server/main.mjs` with the env vars from
  `server/README.md` (`DRY_RUN=1` logs pushes instead of sending them).
- Local run: the push server (`node server/main.mjs` with the env vars from `server/README.md`)
  serves the app and `/api`; open `http://localhost:8790/`.
- Deploy: Railway redeploys on pushes to `main` that touch its watch paths.
- Icons: `icons/icon.svg` is the source; PNGs are rendered from it.

## Future extensions

- Deferred items in `TODO.md`.
- Arrive-by target (highlight the latest departure that makes a target time).
