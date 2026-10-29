# DESIGN.md — T-Minus (repo: t-minus)

Status: N-leg engine and setup UI implemented. API verified against live data (2026-09-30).

## Problem

For a recurring multi-leg MBTA trip (bus + subway), the pain is not route planning.
It is answering one question at any moment:

> "When do I need to leave to catch the next viable transit departure, with minimal waiting?"

The motivating commute (also the unit tests' fixture, `test/fixtures/bus-orange.json`):

- **Home → office**: 132 bus inbound → Oak Grove → Orange Line → State
- **Office → home**: Orange Line from State → Oak Grove → 132 bus outbound

The 132 (Redstone Shopping Center ↔ Malden Center) passes Oak Grove mid-route on
Washington St; Oak Grove is not a terminal or busway stop for it. Weekday headways
(2026-09-30 schedule):

| Service | Headway |
|---|---|
| 132 inbound toward Oak Grove | 18-34 min AM peak, ~60 min midday, 30-45 min PM, ~60 min evening; first 06:03, last 23:32 |
| 132 outbound at Oak Grove | 30-49 min AM, ~60 min midday, 28-42 min PM; first 05:32, last 23:03 |
| Orange Line (peak) | 3-5 min (avg ~4.6) |

The infrequent leg (here the bus) constrains the trip; the app detects it automatically.

## Decisions

| Topic | Decision |
|---|---|
| Form factor | Static files, no build step, no dependencies (the optional push server in `server/` is the only backend; see Notifications): `index.html` (markup, CSS, UI/fetch/timers), `setup.js` (setup view), `core.js` (pure logic ES module, unit tested), PWA `manifest.json` + `sw.js` |
| Target device | Phone first; installable PWA (add to home screen) |
| Hosting | The Railway service (`server/`) at `https://t-minus.lucasp.net/`: the app's files and its API under `/api/` on one origin (see Hosting) |
| API calls | Through the server's MBTA proxy (`/api/mbta/*`, its key and a shared cache; see "MBTA data caching"), then direct from the browser to `api-v3.mbta.com` after an error or 2 s (CORS verified: `access-control-allow-origin: *`) |
| API key | Not needed: the proxy uses the server's key. The optional key field in settings is used only for direct calls (the proxy unreachable or refusing), sent as the `x-api-key` header, never in the URL (URLs end up in RUM and traces; the header costs a CORS preflight, which the MBTA allows, on this fallback path only). Stored in `localStorage` on the app's own origin (`t-minus.lucasp.net`; on GitHub Pages it was the shared `lucaspimentel.github.io` origin) |
| Persistence | `localStorage` per browser; sharing = app URL + self-serve config |
| Default config | None: first run opens the setup view |
| Trips | Any number of named trips, each with any number of transit legs; optional time window per trip picks the trip shown |
| Refresh | Adaptive: fetch every 60s when the next `leave_by` is ≤ 15 min away, else every 120s. Local 1s countdown tick. Manual refresh button. Paused while hidden; refetch on `visibilitychange` to visible |
| Departures shown | Next `departureCount` departures (config, 1-8, default 4) |
| Config editing | Full-screen setup view (gear button) with route and stop pickers (no direction step); JSON only via Export/Import |
| Extras | Service-impacting alerts; live data on every leg; schedule fallback for missing predictions; next-service-day fill |
| Deferred | See `TODO.md` (default times estimated from stop coordinates, commuter rail/ferry) |

## Surface wording (2026-10-27)

The same ride on every surface follows CLAUDE.md "UI rules". Which time each phase shows (done,
2026-10-27): the leave-by while there's time to walk; from the leave-by on, or once walking, the
first vehicle's departure, counted down to (the red row, the widget's "Leave now", the leave
card's "Leave now · departs in").

Vehicle names and headsigns (`lineLabel` + `toward` on full text lines, `vehicleArrow` on tight
ones):

| Surface | Vehicle | Headsign (first leg) |
|---|---|---|
| Notifications (reminders, ride alerts) | "Orange Line" | "toward Malden" |
| Leave and walk cards (Lock Screen lines) | "Orange Line" | "toward Malden" |
| Ride bar, the app's expanded row | "Orange Line" | "toward Malden" (as now) |
| App card leg strip | "Orange" | none (the expanded row has it) |
| Widget Home Screen (small, medium; 2026-10-29) | "Orange Line" | "toward Forest Hills" ("→" where it doesn't fit) |
| Widget Lock Screen (rectangular, inline, circular); Dynamic Island | "Orange" | none |

Later legs keep their headsign in the expanded row only; no headsign: the vehicle alone ("Bus
132"). Red, Blue and Green follow Orange ("Green Line B" / "Green B"). The Dynamic Island's
compact badge stays the route's short label ("132", "OL"). Widget times carry no weekday
("Leave 5:57am", "arrive 12:08am" late at night; 2026-10-29: "Thu" overflowed the medium rows);
the app's keep it.

Reminder notifications: the heads-ups (10 and 5 min) come before the leave-by, so their body is
the vehicle and the arrival, "Bus 132 toward Malden · arrive ~8:25am" (moved: "Bus 132 toward
Malden · leave by 7:36am (was 7:39am)"); "Leave now", sent at the leave-by, names the departure,
"Bus 132 toward Malden at 7:48am".

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
- **Subway: predictions first** (`predictionsFirst`, `tripVehicles`). The MBTA's Real-Time
  Display Guidelines take subway countdowns from predictions (headways, not scheduled times,
  when there are none). A running train the MBTA can't match to its scheduled trip is predicted
  under another trip id with `schedule_relationship: "ADDED"`, and its scheduled trip gets no
  prediction (see MBTA API usage), so merging by trip id showed the same train twice. On a leg
  whose routes are all subway (`isSubwayRoute`: Red, Orange, Blue, Mattapan, Green-B/C/D/E),
  scheduled vehicles from now (or the earliest live time) to the latest live time are dropped;
  schedules fill in before and after. Buses are unchanged (scheduled times are the guidelines'
  fallback there). The app (rows, previous rides, the ride card) and the server's stop alerts
  use the same rule.
- **Subway headways** (`subwayHeadway`, `tripVehicles`, `legTime`). When a subway leg's
  predictions were fetched but list no vehicle at all (an outage, before the first train), the
  guidelines show headways instead of scheduled times. Its vehicles are tagged with `every`:
  the smallest and largest gap between the scheduled departures at the boarding stop in the next
  60 min ("6", or "8–13"; 0-min gaps from branches at the same minute ignored). The badge reads
  "every 6 min" (scheduled style) in the timeline and, when it's the shown leg, the collapsed row.
  The leg's own times are marked "~", and so is everything computed from them: "Arrive" and
  "arrive ~" when it's the last transit leg, the outlook line, the transfer headline, "Walking ·
  arrive ~", "Tracking …", the ride card's train choices, reminder text, and stop alerts (the
  ride's legs carry `every` to the server, which also tags its own re-plans). The headline and
  "Leave" stay plain, as do predicted times on other legs. Not tagged (SCHEDULED, plain): fewer
  than two departures in the hour (the last trains; the next service day's rows), and legs
  whose predictions weren't fetched (offline). A single predicted train ends it (predictions
  first); a ride leg that becomes predicted drops `every` (`trackLegs`).
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
   is **missed** while `now < first_leg.departure + 5 min`; only the most recent missed
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

A one-off trip (below) comes before all of these while it exists, unless another trip was
picked by hand after it was made (`shownTrip`; the iOS widget uses it without step 2).

### One-off trip ("Plan a trip…" → "See departures")

- "Plan a trip…" (named "Go somewhere else…" until 2026-10-28) sits under the trip buttons (moved
  there from the end of the list, 2026-10-12), shown with the rows (not during a ride, nor without
  trips). It opens the planner (see Setup view); a timed option's "See departures" makes a one-off trip (`t-minus:one-off`,
  `{ trip, at }`), labeled from the route list like a saved trip but never written into the saved
  config. It is shown after the saved trips (`withOneOff`), so saved trips keep their indices,
  and works like any trip: rows, tracking, reminders, stop alerts.
- The trip dropdown names it "Oak Grove → State (one-off)" (with one saved trip the two side-by-side
  buttons stay). While it is shown, a banner under the trip buttons, above "Plan a trip…" (a
  bordered card, 2026-10-13, chosen from three mockups: the old plain line and the "Leaving
  now" bar below it didn't line up), reads "One-off trip: not saved" with Save and "✕" (Remove).
- Save: it becomes the last saved trip at once (same name, no time window; same index, so its
  state carries over), toast "Trip saved". ✕ (Remove): its reminders, en-route state and stop
  alerts are dropped, toast with Undo (restores them). A new plan replaces it. It is removed by
  itself when its ride is over (Done on the ride card, or the ride ending).

Location is requested only when some trip has `near` (choosing "When I'm near its first
stop" in the trip screen triggers the permission prompt): `getCurrentPosition` (low accuracy,
fix up to 5 min old, 10 s timeout) on launch and on return to the foreground, not while the
app stays open. The fallback trip shows first and the app switches when the fix arrives; it
never switches away from a trip with an active "Leaving now" / "At the stop". Denied or
unavailable: fallback, and the status line adds "Location off".

### Previous and more rides

- "Show previous rides ▾" (top of the list, when there are any): one row per first-leg vehicle
  that left in the last 15 min (`previousRides`, `PREVIOUS_MINUTES`), oldest first, drawn like
  upcoming rows (gray): "Missed · left 3 min ago 5:41pm" (the missed row's headline; the vehicle
  is in the leg strip), the first leg's badge and "arrive 6:43pm ▾", with a 22px gap after the
  last one. Expanded: the timeline from boarding (no Leave or walk to the stop)
  and [I got on] in the footer. Each has the earliest connections after it; a vehicle with no
  connection is left out. For a frequent first
  leg (Orange every ~5 min before the 132), the train actually taken is often not the row's.
  While open, the missed row is hidden once its first vehicle has left (it's listed here then);
  a missed ride still to leave ("Departs in 6 min") stays. Once its first vehicle has
  left, the expanded missed row also has "I got on" in its footer (the same ride as here).
- "I got on" starts tracking that ride as boarded at its departure (`{ kind: 'track', ride:
  { legs, boardedAt } }`; the card may open past the first leg), with "Tracking started · Undo".
- "Show more rides ▾" (bottom): 4 more rows per tap (`departureCount` + 4n), hidden when no
  more rows are in the fetched schedules. Both reset when the shown trip changes or the app
  reopens. Neither makes requests (the per-leg vehicles already polled).

### Countdown states

| State | Condition | Display |
|---|---|---|
| Green | `now < leave_by - 3 min` | "Leave in 12 min", leave-by time on the right |
| Amber | `leave_by - 3 min <= now < leave_by` | "Leave in 2 min" (the color carries the urgency) |
| Red | `leave_by <= now < last_chance` | "Hurry · 5 min" (to the first departure), first-leg departure on the right (2026-10-27: the leave-by, then the departure, on every surface; CLAUDE.md "UI rules") |
| Missed | `last_chance <= now < first_leg.departure + 5 min` | Amber "Departs in 2 min" at full size (can no longer be reached at your pace, still to leave; `.departs`, 2026-10-21, like the leave card; screen readers hear the same), then gray and smaller "Missed · left 3 min ago"; first-leg departure on the right |
| Hidden | `now >= first_leg.departure + 5 min` | Row removed |

A missed row's collapsed line shows the first leg (the one missed) instead of the timing leg.
Live predictions disappear once a vehicle leaves its stop, so the last live times seen while
the app is open are kept per trip (`rememberLive`/`withRemembered`, dropped 30 min after
departure) and saved across reloads (`t-minus:last-live`, `storeLive`/`loadLive`, 2026-10-13),
keyed by the trip's transit legs (routes, stop, drop-off) so a reordered or edited trip never
gets another's; a reload keeps a late bus's missed row on its live time. An ADDED train
(no schedule) that has left is added back from that memory, live, so its scheduled twin stays
out.

### En route ("Leaving now" / "At the stop")

For leaving earlier or later than leave-by. A bar under the trip buttons always offers
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
- **The bell (2026-10-22; tracking folded into it):** one button in expanded rows (except
  next-day rows and rides already gone), "🔔 Track", filled green "🔔 Tracking" when on
  (`aria-pressed`; tap again: off, no confirm). On, it pins that departure as the target
  (`pinTarget`, `bell: true`) and sets its reminders (see Notifications) where they work
  (`canNotify`: the server, push, permission not refused; else "Notifications are off: tracking
  in the app only." under the button, plus "Add to Home Screen to get them." without push). One
  bell at a time across all trips: a new one turns the other off (its pin, reminder and card).
  The pin is never re-taken and has no 30-min cap. From the normal list it starts
  `kind: 'track'`: rows keep their leave-by countdowns, the pinned row has a green outline (and,
  collapsed, a small bell when a reminder is set), and the bar reads "Tracking Bus 132 7:40am"
  [Leaving now] [At the stop] [Cancel] (both keep the pin; Cancel turns the bell off, with
  "Tracking cancelled · Undo"). While en route, the pinned row is highlighted instead of the
  first reachable one. Bell off drops only the pin (`unpinTarget`): plain tracking ends;
  "Leaving now" / "At the stop" stays and the highlight goes back to the first reachable ride.
- **Boarding question:** a pinned departure boards on its own only after "Leaving now" / "At the
  stop" with an at-stop time on or before it. Otherwise, at its departure (live, else scheduled)
  the state gets `asking: { dep }` and the bar reads "Did you get on the 7:40am Bus 132?" [Yes]
  [Missed it] (the departed row keeps its outline). Yes boards it from the departure
  (`answerBoarding`; stop alerts already passed are skipped); "Missed it" drops the pin (plain
  tracking ends). Unanswered, it closes `ASK_MINUTES` (30) after the departure
  (`enRouteActive`). The push at the departure asks the same (see Notifications). Saved pins
  from before the bell are dropped at load (`migrateEnRoute`).
- Boarding is assumed when the target's first vehicle departs (live or scheduled time) while
  it was reachable: its legs (trip id + times) become the ride, and a trip card replaces the
  list and the bar:
  - Headline by phase (`ridePhase`, `rideHeadline`): "Bus 132 · 9 stops · 4 min" (stops left once
    the vehicle's stop list is loaded, else "Bus 132 · 4 min"; minutes count down to the leg's
    live drop-off arrival, which the timeline shows); with only the drop-off left, "Next stop:
    get off", or "Get off here" while stopped there (`getOffText`); in the transfer (before
    leg i departs), a departure row's headline: "Orange in 9 min" with "7:31am" on the right
    (amber, with the card's edge, when the outlook below is a warning); "Walking · arrive 7:56am" (after the last arrival), "Arrived
    ~7:56am" (5 min, with Done), then back to the list.
  - The timeline (no first walk) with the current step bold; it ends with the arrival time
    (no separate "arrive" line under the headline).
  - Riding: on the ridden leg's bar, between its line and its drop-off row (`rideStopRows`):
    the vehicle, as a dot in the route's color, on an "At Downtown Crossing" row while stopped
    at a stop (which isn't listed), else just above the next stop (none while stopped at the
    drop-off); then the stops left with predicted times, small dots on the bar: all of them up
    to 5 (counting the drop-off), else the next 2, "… N more" (at least 2), and the stop before the drop-off
    (the cue to get ready; `shownStops`). The drop-off is the leg's own bold row. Tapping "… N
    more" lists every stop ("Show fewer" collapses) for the rest of that leg. From
    `/predictions?filter[trip]=<id>&include=stop,vehicle` (`rideStops`; only remaining stops
    are returned; the drop-off matches the leg's `alight` or a child platform of it). Fetched on
    every poll while riding, and right away when a ride starts; no data (trip id changed,
    request failed) shows no stops and no vehicle.
  - Leg times refresh every tick by trip id from the per-leg predictions already polled
    (`trackLegs`): live entry, then remembered live times, then the leg's own stored live
    time (the ride is saved with it; also on the server, which has no memory), then schedules,
    then the stored plan: a late bus that has left keeps its live times, LIVE, after a reload. A departed vehicle has no board entry and keeps its stored departure. No extra
    requests.
  - Next connection (riding leg i, or in the transfer before leg i+1): needed = leg i's
    arrival + transfer, margin = leg i+1's departure − needed (`transferOutlook`,
    `outlookText`): "Then Orange Line toward Forest Hills 7:31am · 4 min to spare", "· tight" (under 2 min, amber;
    also a negative margin: the transfer time is an estimate, and the rider may make it).
    Missed only when it's impossible: leg i+1 leaves before leg i arrives, or before now. That
    re-plans legs i+1… to the earliest feasible chain after `needed` (never an earlier
    vehicle) and reads "Then Orange 7:36am (missed 7:31am)" until that leg is boarded
    (`ride.missed`); no chain: "No connection after 7:26am", plan kept. No extra requests (the
    per-leg vehicles already polled). (Before 2026-10-08 a negative margin counted as missed:
    at Oak Grove with time to spare, the 6:40pm bus was dropped for the 7:06pm.)
    In the transfer the headline already names the vehicle and its time, so the line drops them:
    "Toward Forest Hills · 4 min to spare" / "· tight" / "(missed 7:31am)" (the line, "Orange
    Line", without a headsign); "No connection after …" as is.
  - A working connection still switches to a catchable vehicle leaving 2+ min sooner
    (`EARLIER_MIN`; not one that already left), e.g. the planned train fell behind a delayed
    earlier one: legs i+1… are re-planned from it, silently ("Then Orange 7:31am · 4 min to
    spare", or "· tight"). The 2-min gain keeps jittery predictions from flipping the plan; once
    switched, it only moves later again through the missed-connection path. Not for a vehicle
    the rider picked (`picked`, set by `switchLeg`, cleared by `onVehicle` on any other
    change): a pick is only replaced once it's impossible.
  - The next leg, picked by the rider (`connectionChoices`: up to 4 of its vehicles other than
    the planned one): while riding, "Different connection?" / "Keep this connection" lists
    those leaving from the current leg's arrival; in the transfer, "Different train?" /
    "Different bus?" lists those leaving from now, and "I'm at the stop" (only when one leaves
    before the planned one) takes the first. Picking re-plans the later legs (`switchLeg`);
    the new trip ids reach the server's stop alerts (`PUT /rides/:id`), which keep the pick
    the same way.
  - "On a different train?" ("On a different bus?" on a bus or Silver Line leg; riding; open:
    "I'm on this one", apart from the transfer's "Keep this train"): the leg's other
    vehicles that left in the last 15 min (`otherVehicles`, up to 4, earlier or later than the
    assumed one; on a later leg only those leaving after the previous leg's arrival, even under
    the transfer time, as a tight connection is kept; none: no button); picking one moves the leg to it and re-plans the later legs (`switchLeg`).
  - "Missed it" for 2 min after each boarding: on the first leg, back to "At the stop" now; on
    a later leg, that leg's next vehicle (not the missed one) and the earliest connections
    after it (`replanFrom`), or "No later connection." "Cancel trip" ends tracking.
- Cancel (the bar) or "Cancel trip" (the trip card; named apart from the connection choices) ends the mode at once (the list returns) and shows a
  bottom toast "Tracking cancelled · Undo" for 5 s (a tap elsewhere on it dismisses it); Undo restores the saved state (switching
  back to its trip if needed). "Done" after arrival has no undo.
- Stored per trip index in `localStorage` (`t-minus:en-route`, with the trip name; a
  renamed trip drops it; cleared when setup saves). Polls every 60 s while active.

Screen stays on (Screen Wake Lock, `keepAwake`) while the app is open and any upcoming row is
within `wakeMinutes` (default 10, 0 = off) of its leave-by, until its last chance. While a
ride is tracked (`keepAwakeRiding`, 2026-10-19): the whole time on a vehicle and during
transfers, not on the final walk; setup's "Keep screen on while riding" (`wakeRiding`, default
on) turns it off, independently of `wakeMinutes`. (Before: only the last 2 min before a drop-off
or a transfer departure, which rarely helped, since the screen had usually auto-locked by then
and a locked screen pauses the page.) The app must be on screen when the ride starts. The OS
releases the lock while the page is hidden; it is re-requested on the next render (and on a
tap, for browsers that want a gesture). Nothing happens where the API is missing or refused.

### Display

- Per departure: countdown/state with the leave-by time right-aligned ("Leave in 12 min   8:04am"),
  then, collapsed, a leg strip (the timeline's gray rail laid out horizontally: short stubs
  for the walks at both ends, evenly spaced colored dots with short labels, "─● Bus 132 ──●
  Orange ─"), then the source badge (LIVE/SCHEDULED, or "every 6 min" for a subway leg with no predictions; of the timing leg; the first leg on missed
  and en-route rows) and "arrive 8:56am" right-aligned under the time; routes and departures
  only when expanded. All times use the compact "8:04am" form (`formatTime`), with the weekday prefixed
  across dates. Tapping a row replaces the summary with a timeline under a divider:
  "Walk 5 min · 1 min early at the stop" (the slack part only when > 0; no first walk on
  en-route rows), each leg's stops and ride, "9 min to transfer" (the actual gap: next
  departure − previous arrival), and "Walk 10 min" (`timelineSteps`), between "Leave 8:04am"
  and "Arrive 8:56am" lines (gray nodes; no Leave on en-route rows, which have no leave-by);
  tap again to collapse. Layout
  (`renderTimeline`, shared with the ride card): Leave, each stop once, and Arrive as nodes on
  the rail with their times in one right-aligned column; each stop a hollow node ("Wyoming Ave @ Fellsway E 7:08am"); each ride as a bar in its route's
  color from its first node to its last (drawn in pieces, so it ends at the node even when a
  name wraps), with "Orange Line · 13 stops · 15 min SCHEDULED" between the two stops (`rideLine`; `lineLabel`: the
  vehicle's label, `vehicleLabel` for legs on several routes, plus "Line" for subway lines,
  "Green Line B") and "toward Forest Hills" below it (`toward`: the trip's headsign, from
  `include=trip`; left out without one). The stop count ("1 stop"; stops after boarding, the
  drop-off included) comes from the leg's trip stop list, `/schedules?filter[trip]=…&filter[date]=…`
  (`tripStopsQuery`), counted from the board stop to the drop-off with child platforms matched to
  their stations (`tripStopCount`). It is fetched only when a row is expanded, one request per leg,
  kept in memory per trip and service date (a failure retries after a minute, while expanded);
  until it lands, or without it, the line shows minutes only. A leg whose trip isn't in its
  schedules (an ADDED or prediction-only train) counts on the scheduled trip closest in time that
  serves both stops (`stopCountTrip`; none: minutes only). Auto-route options get theirs from the
  plan (legs' `stops`). Walks and transfers on a dotted gray rail with a walking figure
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
- Status line (per trip; at the bottom, centered just above the version since 2026-10-12, errors
  included): "Loading…" until that trip's first fetch completes ("Still
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
  aria-expanded>`, named by `rowAriaLabel` ("Leave in 5 min, 7:04am, Bus 132, Orange, scheduled, arrive 7:50am": the
  collapsed row's visible text in order, which axe 4.14's label-content-name-mismatch requires, with
  spaces between the spans so their words don't run together; plus
  ", reminder set"). A tap anywhere on the row still toggles it (the button's click bubbles to
  the row). Track, Notify, and the ride card's controls are buttons of their own. Setup's leg
  buttons likewise: "Change leg 1, Bus 132 toward Malden · Main St → Oak Grove" (the › hidden).
- **Focus across the redraw:** the rows are rebuilt every second, so focusable controls carry
  `data-focus` (`row:<key>`, `track:<key>`, `notify:<key>`, `ride:<label>`, `bar:<label>`) and
  `setRows` refocuses the same one after the rebuild. Keyboard focus shows a 2 px ring
  (`:focus-visible`, the text color).
- **Announcements** (`#announce`, a visually hidden polite `role=status`):
  - status problems, once each as they appear (`statusProblem`: error, Stale, Rate limited,
    the save notice, Location off, Saved copy); not "Updated …" nor the retry countdown;
  - the first row's leave state changing (green → amber → red → missed), e.g. "Hurry · 5 min ·
    7:08am" (the departure); a new first row (one left, another trip) only resets the baseline.
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
        { "kind": "transit", "route": "132", "direction_id": 1, "stop": "15999", "alight": "5991",
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

- `departureCount`, `stopSlackMinutes`, `wakeMinutes`, `wakeRiding` (boolean), `apiKey`: optional, app-wide.
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
  "● Bus 132 → ● Orange") with ↑/↓ to reorder, "+ Plan a trip", then a Settings card (departures
  shown, minutes early at the stop, minutes to keep the screen on before leave-by, API key), Export/Import, and "Reload app" (reloads the
  page, e.g. to pick up a new version in the installed PWA). Done saves changed app-wide
  fields and closes setup; it is disabled until a trip has been saved.
- One planner for every new trip (2026-10-28; before: "+ Add trip (auto-route)" and "+ Add trip
  (manual)" in setup, "Set up a trip" opening the manual editor on first run, and "Go somewhere
  else…" as a second, timed mode): titled "Plan a trip", opened from setup's "+ Plan a trip"
  (`origin: 'setup'`), the main screen's "Plan a trip…" and the empty main screen's "Plan a trip"
  (`origin: 'main'`). It always asks for live times (`now=1`, see "Live times"). A timed option
  has "See departures" (a one-off trip on the main screen, from either origin) and "Save trip"
  (the trip editor, prefilled); an untimed one (the rail-only fallback, or the server's `none` /
  `timedError` under "Nothing runs in the next 2 hours." / "Times unavailable.") only "Save trip".
  The prompt reads "Pick one to see its departures or save it" (any timed option) or "Pick one to
  save it". Under the options (or the no-way message), "No good way? Build it by hand" opens an
  empty trip editor. Cancel, and Save or Cancel in a trip it started, go back to where it was
  opened: the setup list, or the main screen (closed; a saved trip is shown there, as if picked).
- The planner's search: From and
  To (each picked in the leg picker: a station, or a route then its stop, see "Auto-route with buses"),
  minutes to the first and from the last stop (5 and 5), then up to 3 ways. Rail only, in the
  browser (phase 1, and the fallback without the server; `planRoutes`): "● Orange → ● Red",
  "1 transfer at Downtown Crossing · 12 stops". The search runs in the browser over the rail
  network (no requests beyond loading it): at most 2 transfers, each leg a `legBetween` (Green
  branches serving both stations in one leg), no route ridden twice in one direction, changes
  within one station, no station passed twice (no riding past a change and back). Ranked by
  transfers, then stops, then the change stations' names; an option with more transfers is shown
  only if it rides fewer stops than every option with fewer. None: "No way on the subway with 2
  transfers or fewer." (e.g. Mattapan to Wonderland needs 3). "Save trip" opens the trip
  editor (`planToForm`: "Oak Grove → Kendall/MIT", 3 min to change within a station, no time
  window) to review and save.
- Trip screen (tap a row, "Save trip" in the planner, or "Build it by hand"): name, "Show automatically" (During a time window,
  with from/until fields / When I'm near its first stop / Never (only when chosen)), time to the first stop
  and from the last stop, transit legs with a transfer time between them, "Add return trip",
  "Delete trip" (also for the only trip: the config keeps `trips: []` and the settings). Cancel
  discards the edits; Save checks and stores the whole config right away, then returns to the
  list (a new trip from a planner opened on the main screen: to the main screen).
- No trips (none saved, or the last one deleted): one home base, the main screen's empty state:
  "No trips set up yet", the help line (`NO_TRIPS_HELP`: "Plan your commute, and T-Minus tells
  you when to leave."), a full-width "Plan a trip" (44 px) and "Import trips" (a secondary button: the card
  background and border, like setup's buttons, in both themes);
  no en-route bar, ↻ or pull-to-refresh.

  | Path | Lands on |
  |---|---|
  | First launch; launch with `trips: []`; Reset | the empty main screen |
  | "Plan a trip" | the planner; its Cancel returns to the empty main screen |
  | "Import trips" | the setup list with the import box open |
  | Deleting the last trip (in setup) | the setup list: "No trips yet. " + the help line, an orange "+ Plan a trip" |
  | Done with no trips | the empty main screen (settings alone are saved as `trips: []`) |
- Reordering and deleting trips also save right away.
- Waiting lines (2026-10-29): setup's "…ing" status lines ("Finding ways…", "Loading stations…",
  "Searching places…", "Checking stops…" while saving, …) show the pull-to-refresh ring before the
  text (`waitLine`; hidden from screen readers; still and faded with reduced motion). Button labels
  ("Deleting…", "Finding your location…") and the main screen's status line stay plain.
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
  until one is typed; an empty name saves as "Trip N". Generated names all use " → " (this
  suggestion, and auto-route and one-off trips via `optionToForm`); saved names are not migrated.
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
  return trip (`5991 → 9326`, `15999 → 15979`).
  Its name: a name that is the stops' suggestion (or blank) is suggested again from the
  reversed stops; "A → B" or "A to B" (exactly one separator) becomes "B → A" (`returnName`);
  any other name gets " (return)".
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
| `Wyoming Ave @ Fellsway E`, inbound | `15999` | Stop IDs differ per side of street |
| `Wyoming Ave @ Fellsway E`, outbound | `15979` | |
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
- Bus route patterns (verified 2026-10-11): none is `canonical`; `typicality: 1` marks the
  typical ones (334 of 582, every bus route has at least one). Representative trips of bus
  patterns aren't in current schedules (`/schedules?filter[trip]=` returns nothing for them).
- `schedule_relationship` on predictions (API reference): `ADDED` is "an extra trip that was
  added in addition to a running schedule"; the best practices page adds that a prediction may
  have no `schedule` when "we know a vehicle is running on the route" but can't match it to a
  scheduled trip. Observed 2026-10-09 10:05pm at State toward Oak Grove: scheduled 77822004 at
  10:09pm had no prediction, `ADDED-1584988985` was predicted at 10:09:05pm (the same train);
  77822012 (scheduled 10:14pm) was predicted at 10:21pm under its own id.
- `stop_sequence` is not a stop count (checked 2026-10-25): Orange trips go 1, 10, 20, …; Red
  skips 110 → 130 at the branch; Green-E jumps (… 110, 580, …); buses are consecutive. Counts use
  positions in the trip's ordered stop list. `/schedules?filter[trip]=` needs the trip's own
  service date in `filter[date]` (another day's returns `[]`).
- Rail station order per branch: `/route_patterns?filter[route]=<rail>&filter[canonical]=true
  &include=representative_trip.stops` (18 patterns; one per branch and direction). The
  per-direction `/stops` lists merge branches (Red: Ashmont and Braintree).

### Rate limits and request budget

Keyless limit is **20 requests/minute** (`x-ratelimit-limit: 20`, reset window 60s). Through
the proxy, the app shares the server's key (1,000/min; the proxy allows 120/min per IP), so the
keyless limit applies only to direct calls when the proxy is unreachable. The budget below
still holds, to stay well inside it either way:

- Per poll: one `/predictions` request per transit leg of the shown trip.
- Schedules: one request per transit leg on load, on trip change, and every 15 min.
- Alerts: one request every 5 min.
- While riding a tracked trip: one `/predictions?filter[trip]=…` request per poll (60 s).
- Expanding a row: one `/schedules?filter[trip]=…` per transit leg for its stop counts, once per
  trip and service date (memory); collapsed rows cost nothing.
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
- Auto-route: the server's network costs 3 MBTA requests a day under its key (`/routes`,
  `/route_patterns`, the midday `/schedules` sample); stop searches and plans cost none. The
  phone sends one `/api/plan` per From/To pair; picking From/To costs what the manual leg
  picker does (setup's `/routes` and `/stops` copies, "Show nearby"). Without the server,
  the rail network only (above). Place search (`/api/places`) costs no MBTA requests: one per
  paused query to the server, which asks Photon (or Nominatim) unless cached. Timed options
  (the planner, `now=1`): `/predictions` and a 2-hour `/schedules` per distinct leg of
  up to 8 candidates under the server's key and cache (~20-40 requests, fewer when shared or
  cached), answers cached 30 s; the phone refreshes once a minute while the list is open.

A 2-leg trip polls at ≤ 2 req/min (60s) plus a load burst of about 5-7 requests; a 4-leg trip
≤ 4 req/min. Rapid reloads can still hit the limit (seen in testing with ~8 fresh loads in a
minute). A key raises the limit to 1,000 req/min (per MBTA docs, not tested).

## Notifications (leave-time reminders and stop alerts)

iOS wakes a Home Screen app only with Web Push from a server (no scheduled local
notifications; page timers stop in the background), so reminders come from a small Node
service on Railway (`server/`), which also serves the app (see Hosting).

- **App:** reminders come with the bell (see En route), shown only once `SERVER_API` is set in
  `index.html` (`/api`, same origin), for today's rows whose leave-by is ahead (a bell set later
  pins only).
  - Turning the bell on asks for notification permission, subscribes the service worker
    (`pushManager.subscribe` with the server's VAPID key from `GET /vapid`), and posts the ride.
  - Reminders are kept in `localStorage` (`t-minus:reminders`, keyed by trip and row, `bell:
    true`, with the departure `dep`) until the boarding question closes. Entries from before the
    bell ("Notify me", no `bell`) are deleted at load.
  - The bell going off (off, Cancel, an answer, the question closing, boarding) deletes the
    trip's reminders (`DELETE`, the card ends). "Leaving now" / "At the stop" with the bell on
    sends `PUT /reminders/:id { started: { atStop } }` instead: no more leave alerts, the card
    becomes the walk card, and the server asks at the departure only if the at-stop time misses
    it. Starting a trip without the bell (boarding, "I got on") cancels its reminders with
    `?reason=started`; Undo of "I got on" or Cancel posts them again (those still ahead).
  - Without the Push API (iOS outside the Home Screen app), the bell pins only, with the hint.
  - **In the iOS app (2026-10-18; see "iOS app"):** `native` (`window.Capacitor?.isNativePlatform()`)
    switches the push code to Capacitor's PushNotifications plugin: `requestPermissions()` and
    `register()` give the APNs device token (stored as `t-minus:apns-token`, lowercase hex), and
    the subscription posted everywhere is `{ endpoint: 'apns:<token>' }`. Each subscribe
    registers again (iOS may change the token); no device token within 10 s is an error. The
    permission state comes from `checkPermissions()` at start (`notifyPermission()` replaces
    `Notification.permission`). The screen stays on through the app's plugin
    (`TMinus.keepAwake({ on })`, called only when the wanted state changes) instead of the Screen
    Wake Lock. Registration, permission and plugin errors also go to the server's app log
    (`POST /log` with a random device id, `t-minus:device`); setup's "Pending notifications" adds
    "This app · last 24 h": the device token's last 8 characters and those lines. No service
    worker is registered in the app, and the Home Screen hints never show.
  - Errors show a toast with Retry.
- **Push:**
  - The service worker shows `{ title, body, tag, renotify }`. The body names the first vehicle and
    its direction, then the arrival before the leave-by ("Bus 132 toward Malden · arrive ~7:57am")
    or the departure at it ("Leave now": "Bus 132 toward Malden at 7:08am"; `reminderText`,
    "Surface wording"). The tag is the row key, so a later push
    for the same ride replaces the earlier one.
  - **Updates (`UPDATE_MIN` = 2):** a sent notification is re-sent with its tag when its time
    moves 2+ min from the one it showed (smaller moves are prediction jitter), with the old time:
    "(was 7:02am)". `renotify` is true for first sends and earlier times, false for later ones
    (Android replaces quietly). Safari/iOS shows a same-tag notification beside the old one
    (WebKit bug 258922), so there the service worker closes the old one first
    (`getNotifications({ tag })`); iOS has no quiet replacement, so later times may still buzz.
    No cap on updates.
  - Tapping a notification focuses or opens the app.
  - **Declarative Web Push (2026-10-15):** every push (reminders, stop alerts, test) is sent in
    the W3C declarative format (`declarativePush` in `server/app.mjs`):
    `{ web_push: 8030, mutable: true, notification: { title, body, tag, renotify, navigate, lang, data: { kind } } }`.
    Safari 18.4+ (iOS Home Screen apps) can show it without the service worker, so a worker that
    iOS kills or that fails no longer drops the push (or counts against the subscription).
    `mutable`: the worker still runs first (Safari passes `event.notification`, no data; other
    browsers deliver the JSON) and shows it as above, keeping the same-tag close; Safari shows
    the proposed notification only if the worker fails. `navigate` is `PUBLIC_URL`
    (default `https://t-minus.lucasp.net/`). The message also carries the plain
    `{ title, body, tag, renotify }` at the top level for workers installed before the change
    (removable once they've updated). The badge (`app_badge`) is not used.
  - **APNs (the iOS app, 2026-10-18; see "iOS app"):** a subscription `{ endpoint: 'apns:<hex
    device token>' }` is stored and capped like a Web Push one; its pushes are built by
    `apnsPush` (same fields): `aps.alert` `{ title, body }`, `apns-collapse-id` = the tag
    (tags over 64 bytes hashed, SHA-256 base64url), and `interruption-level: time-sensitive` with
    the default sound (priority 10), or `passive` without sound (priority 5) for quiet updates
    (`renotify: false`). `server/apns.mjs` sends them over one HTTP/2 session with an ES256
    provider token (reused 50 min, renewed on `ExpiredProviderToken`) and a 10-min expiration;
    410 `Unregistered` and 400 `BadDeviceToken` / `DeviceTokenNotForTopic` count as a 410 (the
    entry is dropped). Configured by `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`,
    `APNS_HOST` (`server/README.md`). Connections (2026-10-20): one idle for 4 min is replaced
    before use (a push 10 min after the last one hung on a connection dropped on the way); a push
    that times out (10 s) or whose stream closes unanswered drops the connection and is tried once
    more on a new one. Any push (APNs or Web Push) that hasn't finished in 30 s fails, so a stuck
    send can't stop the server's loop (that night it held all reminders for an hour, until a
    restart).
  - **Live Activity in the app (Phase 2; see "iOS app"):** each tracked ride starts one
    (`TMinus.liveActivityStart({ tripName, state })` → `{ id }`; stored as `t-minus:activity`);
    while the app is open, `liveActivityUpdate` when `liveActivityState` changes (never twice the
    same); Done, Cancel, a replaced or finished ride end it at once (`liveActivityEnd`). Its push
    token (the `activityToken` event) goes to the server with the ride (`syncRideAlert`, which now
    posts also when only the activity needs following: `alerts: false`, the device token
    registered without a permission prompt). iOS refusing (Live Activities off) or a plugin error
    goes to the app log, once per ride. A ride on another trip keeps its activity until that ride
    is gone.
  - **Live Activity pushes (Phase 2, server side):** a
    followed ride may carry `activity: { token }` (the activity's own APNs push token, hex; by
    `POST /rides` or later by `PUT /rides/:id`, whose fields are now each optional: `ride`,
    `activity`, `alerts`) and `alerts: false` (followed only for the activity: no notifications).
    Each poll builds the card with `liveActivityState` (`core.js`, shared with the app: phase,
    title, countdown end `until`, stops left, route color and island label, drop-off line, next
    connection line, `warn` for a missed or no connection, per-leg progress, `soon` for the
    countdown's last 80 s, shown as "<1 minute"; times in Unix seconds) and sends it (`apnsActivityPush`: `apns-push-type: liveactivity`, topic
    `<APNS_TOPIC>.push-type.liveactivity`, `event: update`, `stale-date` 2 min after the countdown's end) only when it
    changed. Priority 10 (iOS budgets these) only when it turns to "Next stop: get off" / "Get off
    here" or to a warning; else 5. When the ride is over: `event: end` with "Arrived ~<eta>" and a
    `dismissal-date` 5 min after the ETA. A failed send is retried next poll and shown in the
    push log; a dead token (410) drops the activity, and the ride too when its alerts are off.
    "Pending notifications" shows the activity's sends, title and last error (not the token).
  - **Leave cards (Phase 3a, server side; see "iOS app"):** a reminder may carry `startToken` (the
    app's push-to-start token, hex; `POST /reminders`, or `PUT /reminders/:id`, which also takes
    `activity: { token }`, the card's own token, sent by the app's native code; no Origin, 404 for
    a ride). At the reminder's first check (`leaveCardStarts`; `POST` sets `nextPollAt` now, the
    loop ticks every 5 s; 2026-10-24, before then at the 10-min heads-up), the server sends
    `event: start` to the start token (`attributes-type: RideAttributes`, `attributes: { tripName,
    reminderId }`, `input-push-token: 1`, priority 10), quietly: an `alert` without `sound`
    (push-to-start carries one), "Leave at 7:39am · Home to office" while early (below), else the
    heads-up's text. A reminder set more than 8 h before its leave-by (`LEAVE_CARD_MAX_MIN`, from
    `createdAt`; iOS ends a Live Activity after 8 h) starts at the 10-min heads-up instead, with
    the heads-up as its alert (and sound), instead of the notification. Existing reminders got
    theirs at their first check after the deploy. While a card exists, a check is scheduled at
    leave-by − 60 min (`LEAVE_CARD_EARLY_MIN`) for the quiet switch from "Leave at" to the
    countdown; a move of 2+ min while early is a quiet update (`rem.sent.quiet`), and a card
    without its token sends no "update" notification for a move only the card showed.
    "Pending notifications" lists alerting sends only, so the switch isn't listed. Once the card's token arrives, the 5-min
    heads-up, a moved leave-by and "Leave now" go to the card as updates with an `alert` (priority
    10), not as notifications; small changes ("<1 minute") as quiet updates. Past the leave-by the
    reminder stays: "Departs in" from the last chance (priority 10), then at the departure the
    boarding question (below) as a quiet update (`askActivityState`), ended unanswered. "Ride cancelled": an update with its alert, then an end dismissed 2
    min later. Fallbacks: no start token, a failed start (not retried), no card token yet, or a
    failed card send: the notification as before; a dead token (410) is dropped. Bell off
    (`DELETE /reminders/:id`) and "Clear all" end the card at once; `DELETE …?reason=started` (the
    trip started) keeps it for the app's walk card. The push log lists starts, alerts and ends
    ("Live Activity: …"); "Pending notifications" shows the card (sends, title, error, whether its
    token arrived) and, past the leave-by, "Did you get on?" at the departure, then "Question
    closes".
  - **Boarding question (2026-10-22):** a reminder is kept past "Leave now" (with or without a
    card) until the departure (`rem.seen`: the row as last seen), then sends `kind: 'board'`
    "Did you get on the 7:48am Bus 132?" / "Home to office · tap to answer" (same tag; APNs:
    `aps.category: 'board'` and `reminderId`), open `ASK_MINUTES` (30): then the card ends and the
    reminder is dropped. Answering in the app deletes it (`DELETE`, the card ends). With
    `started` (`PUT`): no leave alerts or card updates; at the departure, asked only if
    `atStop > firstDep`, else dropped quietly. The iOS app registers the `board` category with
    two foreground actions, `yes` ("Yes") and `missed` ("Missed it"); the PushNotifications
    plugin's `pushNotificationActionPerformed` applies the answer (switching to the bell's
    trip). Web push has no actions: tapping opens the app, where the bar asks.
- **Test notification:** setup ends with a "Notifications" section and one button, "Send test
  notification in 10 s" (hidden without `SERVER_API`; disabled with the Home Screen hint
  without push). It subscribes like the bell, posts to `POST /test-push`, and toasts "Test
  notification in 10 s. Lock the phone to check." The server sends "Test notification" / "Push
  works. Sent 7:41am." from its loop (so up to 5 s late); it keeps pending tests in memory only
  (lost on restart), one per subscription, at most 100.
- **Pending notifications (debug, 2026-10-13):** a second button in setup's Notifications section
  (no request until opened; disabled without push) opens a screen (Back, ↻; loaded on open and ↻
  only):
  - **On the server · checked 7:24am:** a card per reminder or followed ride for this phone
    (`POST /pending` with the current subscription; none: "No notifications set up on this
    phone."). Each card shows:
    - the kind ("Leave reminder", "Stop alerts · riding"), the trip and its vehicle;
    - each push already sent, with ✓ or "✕ failed: 410 gone", and the next one with its time
      (`nextPush`: the heads-up at leave-by − 5 min, then "Leave now"; a ride's heads-up "when
      3 stops are left", then "get off" ~2 min before the arrival; "Nothing more to send");
    - details: leave-by and the row key, or the legs' trip ids and times, and the last check;
    - "Not saved on this phone." when the app has no copy, and Delete.
  - **Only on this phone:** the app's copies the server doesn't have (saved reminders, the
    rides' alert ids), amber, with Delete for the local copy.
  - **Sent · last 24 h:** the phone's push log, newest first, failures included.
  - **Clear all pending** (after a confirm): `POST /pending/clear` and the local copies; the log
    stays.
  - Deleting a ride's alerts turns them off for that ride (`alert: { off: true }`, not posted
    again); the ride card offers "Turn on stop alerts" to post it again.
- **Server (`server/app.mjs`):**
  - **Endpoints** (under `/api/`; `GET /health` also at the root, for Railway's health check):
    `GET /vapid`, `GET /health`, `POST /reminders`, `DELETE /reminders/:id`,
    `POST /test-push`, `POST /rides`, `PUT /rides/:id`, `DELETE /rides/:id` (stop alerts and Live Activities),
    `POST /pending` and `POST /pending/clear` (setup's "Pending notifications": this phone's
    entries without the subscription keys, each with `nextPush`, and its push log; POST so the
    push endpoint stays out of URLs), `POST /log` and `POST /log/read` (the iOS app's
    diagnostics per device: 24 h, newest 200), and `GET /nearby` (setup's "Show nearby").
  - **What a reminder holds:** the subscription, the trip (checked with `validateConfig`), its
    slack, the timing leg, the row key (the timing-leg vehicle's trip id) and leave-by. Leave-by
    must be ahead and within 12 h.
  - **Polling:** each reminder polls `/predictions` (and `/schedules`, cached 15 min) for its
    legs with the same `legQuery` as the page. It rebuilds rows (`rowsFromDocs`) and finds its
    key.
  - **Decisions (`reminderStep`):**
    - Heads-ups go out 10 and 5 min before leave-by (`HEADS_UP_MINS`; 10 added 2026-10-15),
      except those whose time had passed when the reminder was set (`headsUps`, the ones still
      due). Heads-ups passed together (a late poll) send once. Reminders stored before then have
      `headsUp` (the 5-min one; `remHeadsUps`).
    - "Leave now" goes out at leave-by. All times follow the row as predictions change.
    - After the first heads-up, a leave-by moved 2+ min from the one last sent (`rem.sent`) sends
      an update with the same tag: "Leave in 7 min · Home to office" / "Bus 132 toward Malden ·
      leave by 7:07am (was 7:04am)". A heads-up due after such a move carries the same
      "· leave by … (was …)" instead of the arrival.
    - A row missing 3 polls in a row (cancelled, or the connection no longer works) sends "Ride
      cancelled" and ends the reminder. MBTA errors don't count; they retry in 20 s.
    - A reminder 5 min past leave-by with no row just expires (`MISSED_MINUTES`; never after
      its row is gone, since leave-by is before the first departure).
  - **Poll timing:** every 60 s while leave-by is more than 20 min away, then every 20 s, and
    always at each heads-up and the leave time (`reminderPollMs`). The loop runs every 5 s.
  - **Request budget (author's key, 1,000 req/min):** about 3 requests/min per leg per
    reminder, plus schedules every 15 min.
  - **Limits:**
    - Same origin only: a request whose `Origin` isn't this host gets 403 (no CORS).
    - 30 API requests/min per IP (the app's files don't count).
    - 5 active reminders per push subscription.
    - A 16 KB body.
    - A 404/410 from the push service drops the reminder.
- **Stop alerts (a tracked ride, followed by the server):**
  - **App:** every tracked ride (boarding detected, "I got on", a "Did you get on?" Yes) is posted
    (`POST /rides` with the trip, its legs and `boardedAt`) once notifications are allowed;
    the en-route state keeps `alert: { id, tripIds }`. New trip ids ("On a different train?",
    "Missed it", the app's own re-plan) send `PUT /rides/:id` (404: posted again); Cancel,
    Done, a replaced ride or the ride ending sends `DELETE`; Undo posts it again. Until
    permission is granted, the ride card shows "Turn on stop alerts" (hidden when denied,
    without the Push API or without `SERVER_API`); its tap is the permission prompt.
  - **Server (`checkFollowed`, every 20 s):** the legs' predictions and schedules →
    `trackLegs` → `ridePhase` → `transferOutlook` (a missed connection is re-planned and
    stored, as in the app); while riding leg i, the vehicle's remaining stops
    (`rideStopsQuery`, `rideStops`) → `rideAlertStep`.
  - **Pushes (`rideAlertText`), per leg, transfers included:** "3 stops to Oak Grove" /
    "Orange Line · arrive 5:56pm" when the stops left drop to 3 (skipped if the leg started
    with 3 or fewer); "Next stop: Oak Grove · get off" / "Then Bus 132 toward Redstone 6:26pm ·
    25 min to spare" (last leg: "Arrive ~6:43pm") with the drop-off next, or 2 min before the
    arrival without a stop list; "Missed the 6:26pm Bus 132" / "Next: Bus 132 6:54pm · arrive
    7:11pm" once per missed departure (an earlier-vehicle switch is silent); "No connection
    after 6:01pm" once. Tags `ride:<id>:<leg>` (get off replaces the heads-up) and
    `ride:<id>:plan`. Always shown, even with the app open.
  - **Updates (2+ min, see Push):** the heads-up's arrival ("· arrive 7:43am (was 7:41am)",
    until the get off); the get off's next departure (the outlook line plus "(was 7:31am)",
    until that leg is ridden; not after a missed connection on it); the missed alert's
    replacement departure ("Next: Orange 7:42am (was 7:39am) · arrive …", until another miss).
    `alert` keeps the values sent (`sent[leg].arr`, `sent[leg].nextDep`, `missedNext`).
  - **Ends:** walking or later, 3 h after boarding, `DELETE`, or a 404/410 from the push
    service. Rides share the reminders table (`kind: 'ride'`) and the 5-per-subscription cap;
    validation is `checkRide` (one leg per transit leg, the ride ending within 6 h).
  - **Budget:** (transit legs + 1) requests per 20 s per ride, about 9/min for a 2-leg trip.
- **Storage:** `server/store.mjs` keeps the reminders in SQLite (`node:sqlite`, no dependency) at
  `$DATA_DIR/reminders.db` on a Railway volume: columns for what the server queries (`id`,
  `endpoint`, `next_poll_at`) and the whole reminder as JSON (`body`), so its shape can change
  without a migration. Writes are per row; a tick's update never inserts, so a reminder deleted
  while the tick waited on the MBTA stays deleted. The old `reminders.json` was not imported.
  Every push sent (reminders, stop alerts, tests; failures with their status) is logged in
  `push_log` (endpoint, time, kind, ref, trip name, title, body, ok, error): kept 24 h, the
  newest 50 per phone. Each check also stores `lastCheckAt` on its entry.
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

## Observability (Datadog, 2026-10-24)

- **Server APM:** `dd-trace` (the server's second runtime dependency), loaded only by the Railway
  start command (`node --import ./server/node_modules/dd-trace/initialize.mjs`: the package is
  under `server/` and the command runs from the repo root), so local runs and `npm test` never
  load it and `app.mjs` keeps no npm imports. Service `t-minus-api`, env `prod`, version the
  deployed commit (`DD_VERSION=$RAILWAY_GIT_COMMIT_SHA`). Traces go to a Datadog agent in the same
  Railway project (`datadog-agent-rust`, the serverless-compat image) over private networking;
  Railway has none built in, and Node's tracer has no agentless mode.
- **Browser RUM:** off unless the server has the RUM IDs (`GET /api/config` → `rum.web`; the ID
  and client token are public by design). After the first render the app fetches the config,
  then loads `datadog-rum.js` (v7, US1) asynchronously from Datadog's CDN; the service worker
  ignores cross-origin requests, so it's never cached, and any failure leaves the app without
  RUM. Service `t-minus-web`, version the footer hash, 100% of sessions, no Session Replay,
  resources on, user interactions and long tasks off (`rumInitOptions` in `core.js`).
- **RUM ↔ APM:** same-origin `/api/` requests carry `datadog` and `tracecontext` headers
  (`allowedTracingUrls`), so a resource (an `/api/mbta/*` call, a reminder) links to its server
  trace.
- **The MBTA key:** never in a URL. The server and the app's direct fallback send it as
  `x-api-key`; RUM's `beforeSend` also strips `api_key` from resource and view URLs.
- **Budget:** `/api/config` is one same-origin request per page load, outside the MBTA budget;
  the iOS app adds one native request per launch.
- **Native iOS RUM** (`Observability.swift`, first in TestFlight build 21): `dd-sdk-ios` 3.20.0 (SPM, App target only: Core,
  RUM, CrashReporting, WebViewTracking), US1, service `t-minus-ios`, env `prod`, version
  `<marketing>-<build>` (e.g. `1.0-21`), 100% of sessions, consent granted. No native view or
  action tracking (the only native UI is the web view), no background events. Crash reporting
  without dSYM upload (unsymbolicated).
  - IDs: `/api/config`'s `rum.ios`, cached in UserDefaults. A cached pair starts RUM at launch;
    the fetch then saves a new pair (or, on the first launch, starts RUM); `ios` null clears the
    cache (off from the next launch); a failed fetch keeps it. A changed pair applies from the
    next launch.
  - WebView tracking for `t-minus.lucasp.net`, set up in `capacitorDidLoad` (before the first page
    load): the page's browser SDK (still started by `startRum` with `rum.web`) forwards its views,
    resources and errors to the native session over the bridge. On the first launch the page
    already on screen stays on the web app until it reloads.
  - Native `URLSession` requests to the site are tracked automatically with `datadog` and
    `tracecontext` headers, so they link to `t-minus-api` traces. Today that is the leave-card
    token `PUT` (`LiveActivityObserver`) and the `/api/config` fetch; the APNs and ride-card
    tokens go through the page.
  - Errors: APNs registration failure, a leave-card token given up after 3 tries (never the token
    itself), and a failed `liveActivityStart`. Background launches (a leave card's push-to-start)
    report nothing.

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

**Status:** all three are done: (C) route and stop lists kept on the phone, trimmed, refreshed
in the background; (B) the server's nearby digest (`/nearby` only; see "Show nearby"); (A) the
proxy (2026-10-08), below.

**The proxy, as built** (`GET /api/mbta/<path>?<params>`, `server/app.mjs`; the allowlist and
cache classes in `core.js`):

- **Who:** every phone, for every MBTA request (main screen and setup, `api()` in
  `index.html`). The app calls the MBTA directly, with its saved key if any, after any proxy
  error or 2 s; a 503 or 404 (kill switch, budget guard, an older server) also skips the proxy
  for 10 min.
- **Cache:** keyed by path and sorted parameters (`mbtaCacheKey`); concurrent requests share
  one MBTA call. The server's own requests (reminders, stop alerts, nearby) use the same cache
  with fresh copies only, so the app and a reminder for the same leg share predictions.

  | Class | Paths | Fresh | Stale copy served up to | Kept in |
  |---|---|---|---|---|
  | predictions | `/predictions` | 10 s | 2 min | memory |
  | alerts | `/alerts` | 60 s | 15 min | memory |
  | schedules | `/schedules` | 15 min | 24 h (the key holds `filter[date]`) | memory |
  | static | `/routes`, `/stops`, `/route_patterns` | a day, then revalidated (`If-Modified-Since`) | no limit | SQLite `mbta_cache` |

  Memory holds at most 2,000 copies (oldest dropped; past their stale limit, pruned each
  tick); SQLite the newest 2,000 rows.
- **MBTA failures** (error, timeout, 5xx, 429): a stale copy within its limit, with
  `x-data-age` (seconds); none: 502. An MBTA 4xx is passed through, not cached. The app sets
  the data's time back by the age (`Updated 5:41pm (3 min ago)`) and adds "MBTA down" (amber).
- **Abuse limits:** the allowlist (paths, parameter names, values ≤ 2,000 chars, no
  `api_key`; otherwise 400), same origin (`Sec-Fetch-Site` or `Origin` from elsewhere: 403),
  120 requests/min per IP (429 with `Retry-After`; the app goes direct), and a budget guard:
  past 800 MBTA calls in a minute, misses get 503 (copies are still served), keeping the rest
  of the key's 1,000/min for reminders and stop alerts.
- **Kill switch:** `MBTA_PROXY=off` (Railway variable): `/api/mbta/*` answers 503 and the app
  goes direct.

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
  app shell. `api-v3.mbta.com` and the server's `/api/` (reminders, the MBTA proxy) are never
  cached. The cache is the fallback when the server
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

## iOS app (Phase 1, 2026-10-19; Phase 2, Live Activities, 2026-10-20; Phase 3a, leave cards, 2026-10-20; Phase 3b, widget, 2026-10-26)

A native shell around the web app, for what a Home Screen PWA can't do (Live Activities,
widgets; APNs instead of Web Push). Plan for the later phases (leave-time Live Activity, widget): `IOS.md`.

- **Shape:** Capacitor 8 (WKWebView + plugins), project in `ios/`. The WebView loads the live site
  (`server.url` `https://t-minus.lucasp.net` in `capacitor.config.json`), so pushes to `main`
  update the app with no new build; `SERVER_API` stays `/api` (same origin, no CORS). The app has
  its own `localStorage`: trips move with setup's Export / Import. A bundled "Can't reach
  T-Minus" page with Retry (`ios/www/index.html`, `server.errorPath`) shows when the site doesn't
  load. The PWA stays supported (Android, browsers); on the author's iPhone the app replaces it
  (two subscriptions would send every reminder twice).
- **Native code (thin):** `AppDelegate` forwards the APNs registration to Capacitor's
  PushNotifications plugin (`presentationOptions` banner, sound, list: alerts show with the app
  open); `TMinusPlugin.keepAwake({ on })` sets `isIdleTimerDisabled`, registered by
  `MainViewController`; `Observability` starts Datadog RUM from `AppDelegate` and WebView
  tracking from `MainViewController` (see Observability). The web side of push, screen-on and the app log: Notifications, "In the iOS
  app"; the server side: Notifications, "APNs".
- **App:** "T-Minus" on the Home Screen; "T-Minus Boston Commute" in App Store Connect and
  TestFlight ("T-Minus" was taken; "MBTA" left out, since the MassDOT license bars using its
  trademarks). Bundle ID `net.lucasp.tminus` (App ID with Push Notifications and Time Sensitive
  Notifications), SKU `tminus`, iOS 18, iPhone only. Entitlements: `aps-environment` production,
  time-sensitive. Location text for nearby stops and "near" trips; `ITSAppUsesNonExemptEncryption`
  false (no export-compliance question per build). Icon: `icons/icon.svg` at 1024 px, no alpha
  channel. Launch screen in the app's background colors (light / dark).
- **Project without a Mac:** generated by `npx cap add ios --packagemanager SPM` (runs on Linux)
  and committed; `npx cap sync ios` regenerates the gitignored parts (`ios/App/App/public`, the
  copied config) and `CapApp-SPM/Package.swift`. New files and build settings go in with the
  `xcodeproj` Ruby gem. `experimental.ios.spm.swiftToolsVersion` is `6.0`: `cap sync` writes
  `.iOS(.v18)` from the deployment target, which the default 5.9 manifest can't declare.
- **Builds:** `.github/workflows/ios.yml`, manual (`workflow_dispatch`), `macos-15` with the latest
  stable Xcode; free (public repo). `xcodebuild archive` is signed ad hoc (it carries the
  entitlements; automatic signing at archive time needs a development profile, which needs a
  registered device); `-exportArchive` with automatic signing and an App Store Connect API key
  (Admin, so Xcode creates the distribution certificate and profile in Apple's cloud) re-signs
  it; a check fails the run if the signed app lacks `aps-environment`; a second export uploads to
  TestFlight. Build number: the run number. Secrets: `ASC_KEY_P8`, `ASC_KEY_ID`,
  `ASC_ISSUER_ID`, `APPLE_TEAM_ID` (GitHub); the APNs key: Railway variables. On failure the
  Xcode distribution logs are an artifact.
- **Distribution:** TestFlight, internal testing (the author). A build expires 90 days after
  upload (build 2: 2026-10-19), so run the workflow before then if nothing native changed.
- **Deploys:** Railway's watch paths are an allowlist (`server/**`, the shell files, `icons/**`),
  so `ios/` and `capacitor.config.json` never trigger a deploy.

### Live Activity for tracked rides (Phase 2, 2026-10-20)

- **What:** every tracked ride ("I got on", detected boarding, a "Did you get on?" Yes) shows on the Lock
  Screen and in the Dynamic Island while it lasts, stop alerts or not (iOS Settings → T-Minus →
  Live Activities is the only off switch). Notifications are unchanged, "3 stops to …" included.
- **Card** (`ios/App/TMinusWidgets/RideViews.swift`, in the app's light / dark colors with the
  route's color as the dot): the trip name; a headline like the ride card's ("Orange · 4 stops",
  "Next stop: get off", "Bus 132" in the transfer (sub line "Toward Malden · 8:02am · 3 min to
  spare", "· tight" in amber), "Missed the 8:02am · next 8:14am" in amber, "No
  connection after …", "Walking", "Arrived ~8:25am") with a countdown; the drop-off line with the
  time first ("Get off 8:24am at …", so a long stop name is cut, not the time); the next
  connection or "Arrive ~…"; a progress bar with one segment per leg, sized by its riding time (at
  least 8%), filling on its own while ridden.
- **Countdown:** whole minutes, counted down by iOS without updates ("12 minutes", rounded down;
  iOS 18's date offset format; iOS has no "12 mins"), then "<1 minute" from the last 80 s (`soon`
  in the content: iOS can't say "<1 minute" itself, and the times aren't accurate to the second;
  80 s leaves the server's 20-s poll time to deliver it before "0 minutes"; also shown past the
  time instead of "−1 minute").
- **Dynamic Island:** expanded content margins 24 pt at the sides, 14 top, 18 bottom (the
  defaults let the rounded corners clip the route label and the last line). Compact: the route's dot and label (`islandLabel`: "OL", "GL B", "132",
  "SL1"; 🚶 on the final walk), then the stops left, or the countdown when stops don't apply (no
  stop data, a transfer, the final walk); expanded: the card's content; minimal: the route's dot.
- **Content:** `liveActivityState` (`core.js`) builds it for both the app (local updates) and the
  server (pushes), so both show the same; `RideState` (`ios/App/Shared`) decodes it (Unix seconds:
  ActivityKit would read a pushed Date as seconds since 2001; fields added later are optional).
- **Lifecycle:** the app starts it (`TMinus.liveActivityStart`; one at a time), updates it while
  open when the content changes, and ends it at once on Done, Cancel or a replaced ride. Its push
  token goes to the server with the ride, which pushes updates while the app is closed and an end
  with "Arrived ~<eta>" dismissed 5 min after the ETA (details: Notifications, "Live Activity
  pushes"). iOS ends any Live Activity after 8 h; rides end at 3 h.
- **Native pieces:** the widget extension `TMinusWidgets` (`net.lucasp.tminus.widgets`, embedded
  in the app; added with the `xcodeproj` gem; Xcode's automatic signing registered its App ID);
  `RideAttributes` (ActivityKit, the trip name) in both targets; `TMinusPlugin`'s
  `liveActivityStart` / `Update` / `End` and the `activityToken` event; `Info.plist`:
  `NSSupportsLiveActivities` and frequent updates.
- **Previews without a Mac:** every `ios` workflow run compiles the views for macOS
  (`ios/Previews/Render.swift`, `swiftc`) and renders sample states (light, dark, the island) to
  the `live-activity-previews` artifact; `upload` off renders only these. macOS can't draw the
  timer progress in a still image, so the previews fill the ridden segment statically.
- **Builds:** first on TestFlight as build 6; build 14 has the minute countdown and the
  proportional segments. The export check also requires the embedded extension.

### Leave cards (Phase 3a, 2026-10-20)

- **What:** a reminder set in the app (the bell) becomes a Live Activity at once (quietly; at its
  10-min heads-up when set more than 8 h ahead; 2026-10-24, no new build: web and server only),
  started by the server's push (push-to-start, iOS 17.2+) even with the app closed, in
  the ride card's layout. One card per reminder. iOS Settings → T-Minus → Live Activities off:
  notifications as before. The 10-min / 5-min / "Leave now" and moved-time notifications go to the
  card (as its alerts) while it has its update token; otherwise they are sent as before.
- **Content** (`leaveActivityState`, `core.js`; mockup accepted 2026-10-20): more than 60 min
  before the leave-by (`'early'`), "Leave at 7:39am" with no countdown, the first vehicle, "Arrive
  8:25am"; moved then: amber "Leave at 7:36am" with "Moved (was 7:39am) · arrive 8:25am", a
  quiet update; at 60 min a quiet update to the countdown. Then "Leave in 9 minutes"
  (counting down to the leave-by, "<1 minute" at the end), the first vehicle ("Bus 132 toward
  Malden"; its departure time only from the leave-by on, 2026-10-27), "Leave by 7:39am · arrive
  8:25am"; a moved leave-by in amber with "Leave by 7:36am (was 7:39am)"; "Leave now · departs in
  7 minutes" (amber, to the departure) with "Bus 132 toward Malden at 7:48am" and "Arrive
  8:25am"; "Departs in 2 minutes" (amber, to the departure), the same two lines;
  at the departure "Did you get on?" / "Bus 132 toward Malden left at 7:48am" / "Tap to answer"
  (island "Got on?"; tap opens the app), ended when answered or after 30 min. "Ride cancelled"
  / "Open the app for the next one.", dismissed after 2 min. The legs bar shows the trip, empty.
- **Dynamic Island:** compact: the route's dot and label, then the countdown alone, "9 min"
  ("<1 min" in the last 80 s; amber when too late; the walk card's in white, amber when late: it
  counts down to the departure, not a walk), or the word when there's none ("Leave 7:39am" early,
  "Leave now", "Got on?"); expanded: the card. 2026-10-29: "Leave 28 minutes" stretched the
  island across the screen, hiding the clock, so the word moved to the expanded view and the
  countdown got a fixed width (sized for "59 min") so the island doesn't resize as it counts
  down. It ticks on its own (iOS 18's live date range in abbreviated minutes); it may differ
  by a minute from the other surfaces' (seen once: 40 vs 39), accepted.
  (Before 2026-10-24 the walk card showed a walking figure, which read as "walk 10 minutes".)
- **Walk card:** "Leaving now" / "At the stop" with the bell mark its reminder `started` (without
  the bell, a reminder is deleted with `?reason=started`) and the app takes over the card (`TMinus.liveActivityList`, by `reminderId`): "Bus 132 in 6
  minutes", "At the stop ~7:45am · 3 min to spare" ("since 7:45am" once there; "2 min late" in
  amber), "Arrive 8:25am" (`walkActivityState`; on both cards "~" only when a leg is a headway estimate), updated by the app while open, no alerts.
  A missed departure turns it into the boarding question (app and server). Boarding ends it just before the ride card starts; Cancel or the vehicle leaving end it. Known
  limit: with the app closed it isn't updated (stale 2 min after its countdown; ended at the next
  open).
- **Bell off** ends the card (the app and the server); cards whose reminder is gone are ended
  when the app opens (their token may never have reached the server).
- **Native pieces:** `RideAttributes.reminderId` (set on server-started cards; app-started ride
  cards have none, and starting a ride card ends only ride cards); `RideState.island` (the
  island's word) and `join` (" " in "Leave in 9 minutes"); `LiveActivityObserver` (App target,
  started at launch, also in the background launch after a start push): keeps the push-to-start
  token (`TMinus.liveActivityStartToken`, the `startToken` event) and sends each leave card's token
  to `PUT /api/reminders/<reminderId>` (`server.url` from the bundled Capacitor config, 3 tries).
  Builds without these methods: the app posts reminders without a start token, nothing logged.
- **Previews:** the `ios` workflow also renders `leave-card-<theme>.png` (every state, the early
  "Leave at" ones included, and the island; the compact islands are picked by name).
- **Build:** TestFlight build 15. Only the phone tests push-to-start and the background token
  send.

### Widget (Phase 3b, 2026-10-26)

- **What:** "Leave times", the shown trip's next leave-bys on the Home Screen (small, medium) and
  the Lock Screen (rectangular, inline, circular); mockups accepted 2026-10-26. Tap opens the app.
  A tracked ride doesn't change it (the Live Activity covers the ride).
- **Which trip:** the main screen's choice without the location match (`shownTrip`, `core.js`):
  the one-off trip unless another was picked by hand since, the manual pick until the next window
  start, the trip whose window contains now, else the last used.
- **Data:** the app writes the widget's request (`widgetRequest`: the trips with the one-off last,
  the stop slack, the one-off's time, the manual pick, the last used) to a shared keychain item
  (group `<team>.net.lucasp.tminus.shared`, `TMinus.widgetSave`) when it changes, which also reloads the
  widget. Each reload posts it to `POST /api/widget` (stateless; validated like reminders' trips),
  which picks the trip and times it with predictions and schedules through the shared cache (the
  timing leg from schedules, `scheduleTimingLeg`; 6 upcoming rows, missed ones left out; once
  today's service runs out, the next service day's first rows): 2 MBTA requests per transit leg
  (+1 per leg late at night), fresh copies only. The answer (`widgetView`) is text, not times to
  format: `rows` (one line each) and `entries`, each shown from its `at`.
- **Entries** (2026-10-27: the leave-by, then the departure, as everywhere; CLAUDE.md "UI
  rules"): per row, more than 60 min before the leave-by "Leave 5:12pm" with no countdown (a
  next-day row: "No more today" / "First 5:12am"); then "Leave 7:42am" / "in 9 min", one entry a
  minute (rounded down like the page's; iOS's own countdown formats can't say "9 min"); "Leave
  now" / "departs in 5 min" (amber) until the last chance; "Departs" / "in 2 min" (amber) until
  the departure; then the next row. Past the leave-by the vehicle line gets the departure ("Bus
  132 → Malden at 7:48am") and the medium's first row shows it in amber. Entries run 2 h ahead at most;
  past the last one (`end`), "Open T-Minus" / "for new times". No trips: "Plan a trip in
  T-Minus"; no rows: "No more today".
- **Sizes:** small: the trip name, the title and countdown, the first vehicle ("Bus 132 → Malden") and
  the arrival; medium: the countdown only (`head`: "Leave in 9 min", "Leave in 1h 06m" an hour+
  out, "Leave now · departs in 5 min", "Departs in 2 min"; the leave-by isn't repeated), then the
  entry's row and the next two in one format (leave-by, "Bus 132", "arrive 8:37am"; no headsign or
  weekday, 2026-10-29; "~" on a headway
  estimate; build 25 shows the small's title and count instead; only the route column gives way,
  shrinking then truncating, so long text can't widen the view and clip both sides, as late-night
  "Thu" times did on build 26); rectangular: the name, "Leave
  7:42am", "in 9 min · Bus 132" (past the leave-by: "Bus 132 at 7:48am"; no headsign); inline: "132 Leave 7:42am" (the time, not the
  countdown); circular (2026-10-26, after the phone showed a bare "38 / 132"): "38m" over "Bus
  132" ("Orange" for the Orange Line) in a ring, open at the bottom like the system's gauge, full
  an hour before the leave-by and empty at it (drawn by hand so the previews show it); the time
  with no ring more than an hour out; "now", then the minutes to the departure ("2m").
- **Reloads:** at the answer's `refresh` (10 min, or the next leave-by or last chance if sooner;
  iOS's budget is roughly 40-70 a day), and from the app: when it rewrites the request, when its
  shown next ride's leave-by, departure or arrival changes (to the minute), and on each return to
  the app, so the widget doesn't lag the app's live times. A failed request keeps the last
  answer (saved in the widget's own storage) and retries in 10 min.
- **Native pieces:** `LeaveWidget` (+ `LeaveWidgetViews`, SwiftUI only) in `TMinusWidgets`;
  `WidgetData` (the answer's Codable shape, the keychain item, the timeline) in both targets; the
  keychain group in both targets' entitlements (the `ios` workflow fails without it in the signed
  app or the extension). Keychain sharing, not an App Group: the CI's API key can't register App
  Groups (401 on `/appGroups`); profiles already allow the team's keychain groups. Builds without
  `widgetSave`: nothing written, nothing logged.
- **Home Screen layouts (2026-10-29, build 31 on; the phone cut "Orange → Forest H…"):** small:
  the trip name, the countdown ("Leave in 5 min"; "Leave now", "Departs in 2 min" amber), its
  time under it ("12:17am", the leave-by; "departs 12:20am", "12:20am"), then ● "Orange Line" and
  "toward Forest Hills" on up to two lines; no arrival. Medium: "Leave in 5 min · 12:17am", ●
  "Orange Line toward Forest Hills" ("→" where it doesn't fit) with the first ride's arrival, then
  the next two rides (leave-by, arrival), naming their vehicle in short form only where it differs
  from the first's ("● Red → Braintree", a several-route leg's "Green D"). The answer adds per row
  `long` and `headsign` and per entry `headTime`; answers without them (and older builds, which
  ignore them) keep the layouts above.
- **Previews:** the `ios` workflow also renders `widget-<theme>.png` (every small state, five
  medium, the Lock Screen sizes).

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

## Auto-route with buses (phase 2)

Phase 1 (station to station on rail, in the browser) is in Setup view. Phase 2 adds bus stops
as From/To and buses as legs (built 2026-10-11; decided the same day):

- **Network data:** `/route_patterns` for every bus and rail route with
  `include=representative_trip.stops` (stops in order, names, coordinates), as the rail network
  already does. Bus routes have no canonical patterns (`canonical: false` on all of them, verified
  2026-10-11), so buses use the typical ones (`typicality: 1`): 334 of 582 patterns, covering
  all 152 bus routes (34 route/directions have more than one, e.g. branches); rail keeps
  `canonical: true`. One request: 3.0 MB (340 KB gzipped), 6,772 stops. No GTFS zip (24.6 MB,
  mostly per-trip stop times; a parser and a nightly job for data this needs only a little of).
- **Ride minutes:** representative trips have no current schedules (0 of 222 asked, verified
  2026-10-11), so run times come from one `/schedules` request for all routes on the next
  weekday, 11:00-13:00 (verified for buses: 10.6 MB, 416 KB gzipped, 5 s, 1,447 trips on 132 routes),
  `fields[schedule]=departure_time,stop_sequence`: per route and direction, the median minutes
  between consecutive stops over the trips that serve both. Routes with no midday trips (the 20
  peak-only and express ones) fall back to distance along the stops at a typical speed (bus
  ~13 km/h, light rail ~18, subway ~30).
- **Where:** the server (`transit` in `server/app.mjs`) builds the network on first use and daily
  after (3 requests: `/routes` types 0,1,3, `/route_patterns`, `/schedules`; `transitNetwork`)
  and keeps it in memory (~870 KB as JSON; built in ~0.6 s). A failed rebuild keeps the old network
  and retries in 10 min; a build without the ride-time sample (distance only) is retried in 10 min
  too; no network at all: 503. Endpoint (rate-limited like the rest of `/api`):
  - `GET /api/plan?from=&to=` (stop or station ids, up to 4 comma-separated per side, or a point
    `@lat,lon`, phase 3): `{ from, to (names; null for a point), options }` (`planTrips`;
    cached per pair until the next network, a point rounded to ~10 m). Measured on live data:
    40-700 ms per plan between stops, 0.1-1.8 s from and to points.
  - `GET /api/places?q=` (phase 3, below).
  The phone downloads nothing large.
- **Search:** rounds of legs (RAPTOR-style) over the patterns, at most 2 transfers (3 legs).
  - A leg rides one pattern from a stop to a later stop. Other routes whose patterns serve both
    stops in the same direction ride along in `also` (like Green branches today, e.g. 116/117).
  - A station counts as all its platforms.
  - Transfers: the same stop or station (3 min), or a walk between stops up to 250 m (minutes =
    max(3, ⌈meters / 80⌉), straight-line distance). Never a walk from one station to another:
    it leaves the fare gates and costs a new fare (Melrose to Kenmore listed Orange to Chinatown,
    a 165 m walk to Boylston, then Green, over Haymarket or North Station); Downtown Crossing to
    Park Street is joined inside the gates, but its 185 m walk only shows when no option on the
    same lines changes within one station (Orange → Green: Haymarket or North Station first).
  - No route on two legs, in either direction and riding along included (Harvard to Logan listed
    Red → SL1 riding along to World Trade Center → SL1 again). No station (or stop) passed
    twice, by station, not platform: Revere Beach to a 132 stop north of Oak Grove listed Blue past State to
    Government Center, then a 156 m walk back to State for the Orange Line.
  - Routes riding along on a leg match by station too: the Green branches each have their own
    westbound platform at Park Street, so Wonderland to Park Street listed Green-B, -C and -D as
    three options; now one leg, "Green-C/B/D/E".
  - Ranked by total estimated minutes (phase 3; before, fewest transfers came first, and a 52-min
    one-change trip ranked above a 44-min two-change one): walks to and from a point, rides
    (bus minutes × 1.25: traffic makes buses less reliable, so of two ways equal on paper the one
    with more subway ranks first; State to a 132 stop north of Oak Grove: Orange to Oak Grove then the 132,
    over the 132 from Malden Center), transfer times, plus 5 min per transfer. Walks between stops count twice: riding one more
    stop to the one by the station beats getting off a stop early to walk 124 m (seen live at
    Oak Grove).
  - Each change also adds its expected wait to the ranking: half the gap between the route's
    departures at that stop in the midday sample (2 hours), capped at 30 min; 30 min too when the
    sample has none (peak-only and overnight routes, e.g. the 171; was 10). The shown "~N min" leaves waits out (the 132 runs hourly at midday: every
    option ending with it would read ~30 min longer). Davis to a 132 stop north of Oak Grove listed three
    96/89 → 101 → 132 chains (~42–45 min on paper, the 96 and 101 every 20–40 min); with waits:
    89 → Orange → 132 (Malden, Oak Grove), then Red → Orange → 132.
  - One option per route chain (a line's branches as one: Green-B and Green-D are both Green) and
    change stations (the best ranked). A change at a bus stop
    counts as the station within 250 m of it, else as any bus stop: the 96 → 101 changes at
    several Medford Sq stops are one option; Orange → 132 via Malden Center and via Oak Grove
    are two. (Before: Orange → 132 via Oak Grove was listed twice, walking 95 m or 198 m.)
  - An option with more transfers than one ranked above it, and no faster (total minutes shown),
    is left out: State to a 132 stop north of Oak Grove listed Orange → 137/131 → 132 (~42 min) under
    Orange → 132 (~37).
  - A leg's stops are named by their station when they have one (rail platforms, busway berths).
  - Each option is a card like a main-list row (2026-10-13, from mockups; before: text
    itinerary rows). Collapsed (all, at first): "~54 min" and the route strip ("● Bus 132 —
    ● Orange"). A tap expands it to the timeline the rows use (`optionSteps` → `renderTimeline`,
    passed to setup as `timeline`): Leave, the walk, each ride's bar from its boarding stop to its
    drop-off, "Walk 3 min to transfer" ("Transfer" in a station), the walk, Arrive; untimed, no
    times, durations or badges. The card's buttons pick it ("See departures" when timed, "Save
    trip"). The total includes the walks (a point end's from the
    option, else the field's). The rail-only fallback's options show their stop count instead of
    minutes. Legs carry `stopName` / `alightName` and `stops` (ridden, from the pattern: "Orange
    Line · 13 stops" on the timeline; no extra requests).
- **Picking From/To:** the planner shows From and To as buttons; each opens the manual leg
  picker in plan mode (`picker.planField`), titled "From" / "To", Back to the planner. Its search
  ("Search stations or routes") lists Stations (rail line tags) and Routes, never bus stop names
  (searching every stop by name was too noisy: "State" matched 1344 Hyde Park Ave and Broadway @
  Bay State Rd). A station sets the field. A route opens its stop list ("From: where do you
  board?" / "To: where do you get off?"; both directions, then "Toward … only"; To leaves out each
  direction's first stop, `dropOffGroups`, as From leaves out the last); a stop sets the field,
  tagged with that route. The stop list pairs the two sides of a street into one row (`stopPairs`):
  "Wyoming Ave @ Fellsway E · both sides"; a stop without a partner reads "· toward Redstone Shopping
  Center only". A pair: the same name once "opp"/"opposite" is read as "@", a leading house
  number dropped and the two streets in either order (`normalStopName`), within 150 m; or any
  stop of the other direction within 25 m (the same spot, named for different cross streets:
  "Summer St @ Lincoln St" / "Summer St @ Chestnut St", 13 m). Each stop pairs once, with the
  nearest. The row shows the "@" name; search matches either. Measured over all bus routes'
  typical patterns (2026-10-12): 55% of one direction's 5,016 stops pair (identical names only:
  19%; normalized names: 41%); 60 m by distance alone would pair 66% but joins different corners
  ("Massachusetts Ave @ Trowbridge St" with "Mt Auburn St @ Putnam Ave", 49 m), and names alone
  join loop stops 3.5 km apart (route 1, "Massachusetts Ave @ Albany St"). A pair is sent as both
  ids (`from=15979,15999`; up to 4 per side) and the planner boards (or gets off) on whichever
  side the route needs; the saved leg names that side. The manual leg picker keeps per-direction
  lists (the side you board decides the direction there).
  "Show nearby stops and stations" (renamed from "Show nearby" in phase 3, in both pickers) works as on a first leg (stations, then routes, with
  distances; a route's stops nearest first). The rest is phase 1's: "Save trip" opens
  the pick in the trip editor (`optionToForm`: the walk's minutes as the transfer), "See
  departures" makes a one-off trip. The walk fields read "Minutes to first stop" / "from last stop".
- **Without the server** (unreachable, an error, or no push server configured): phase 1's
  rail-only search plans between two stations, and a bus stop says "Needs the T-Minus server.".
- Not in phase 2: addresses (phase 3, below), commuter rail and ferry, time-aware search (a route not
  running now is still offered; the trip's rows then show no departures).

## Live times in the planner

Built 2026-10-12 (grilled with mockups: layout C chosen of three). The route-only search can't
see that the 132 runs hourly at midday or that the 171 runs only early mornings; a one-off trip
is for now, so its options are timed (since 2026-10-28 in setup's planner too: one planner).

- **Server:** `GET /api/plan?…&now=1&wb=&wa=&slack=` (the walk fields at a stop or station end,
  the stop slack setting). Up to 8 candidates from `planTrips`, each made a trip
  (`optionToForm`, `formToTrip`; a point end's walks from the option) and timed with the
  reminders' engine: per distinct leg, `/predictions` and the next 2 hours of `/schedules`
  (`TIMED_WINDOW_MIN`), then `rowsFromDocs` timed on the last leg and its first row not missed
  (catchable leaving now: walk and slack). On the last leg, earlier legs take the latest vehicle
  that still makes it: the first live check (6:20pm, State to Main St) left at 6:25 for a 6:31
  Orange and waited at Oak Grove for the 7:33 132. No departure within 2 hours: dropped. `timedOptions` ranks the rest by
  arrival, then fewer transfers, then the search's order (rail favored); each gets `leave`
  (leave-by), `arrive` and `deps` ([{ dep, arr, source, headsign? }] per leg); `timed: true`. All dropped: the
  untimed 3 with `none`; the MBTA failing: the untimed 3 with `timedError` (not cached).
  Answers are cached 30 s per pair, walks and slack.
- **App:** the planner always asks (before 2026-10-28 setup's planner stayed untimed; a saved
  trip keeps only the route; the rail-only fallback stays untimed). "Finding ways…" until
  the timed answer; the best 3 as cards (2026-10-13, from mockups: arrival first, collapsible
  like the rows): "Arrive 2:31pm · ~39 min", "Leave 1:52pm (in 4 min)" ("Leave now" once due),
  the route strip and the first ride's LIVE / SCHEDULED badge. Expanded: the main list's
  timeline with each stop's time, "Orange Line · 8 stops · 18 min LIVE / toward Forest Hills", "7 min to
  transfer" (the wait between vehicles, as on the rows), then "See departures" and "Save trip". The times are as of
  the answer, not refreshed (2026-10-13: a 60 s refresh was removed after a closed search's timer
  redrew it over a later one; the list is for picking, and the picked trip's rows stay live).
  Changing From or To, or reopening, asks again. "Nothing runs
  in the next 2 hours." / "Times unavailable." above the untimed options. Picking works as
  before (the one-off trip's own rows time it).

## Addresses and places (phase 3)

Built 2026-10-12 after a spike (MassGIS, Photon and Nominatim on 6 addresses and 12 places, then
point → stops → plan on the live network) and two grill rounds with mockups.

- **Geocoder:** Photon (komoot's public instance, OSM data) through the server, Nominatim when
  Photon fails or finds nothing usable. Photon found 11 of 11 places it answered (Fenway Park,
  MGH, Logan, MelroseWakefield Hospital, Whole Foods Medford…) and full addresses; Nominatim
  missed "Melrose-Wakefield Hospital"; MassGIS (the state's address points, no key) is exact for
  full addresses but finds no place names, ignores the area in its suggestions ("600 Main St Mel":
  Mashpee, Hyannis, Wareham) and scored the Malden 600 Main Street as high as the Melrose one.
  Photon's public instance answers in ~1.5-4 s (measured 2026-10-12; the server waits 6 s).
  600 Main St, Melrose isn't in OSM as an address: Photon returns only bus stops there, and
  Nominatim's "Main Street · street, Melrose" is the fallback.
- **Endpoint:** `GET /api/places?q=` (3-100 characters): `{ places: [{ name, detail, lat, lon }] }`,
  up to 5, near Boston (Photon: `lat/lon` 42.36,-71.06 and a bbox of the MBTA area, `limit=15`,
  no `lang`: `lang=en` lost Fenway Park; Nominatim: `viewbox`, `bounded=1`, at most 1 request a
  second, its usage policy). Stops, stations, platforms and shelters are left out (the picker
  lists stations and routes itself); the same name and detail once. `detail`: the street address
  and town, "street, Boston", "neighborhood, Boston", or the town for a bare address. Cached per
  lowercased query for a day (500 queries; an empty answer isn't cached); 502 when both fail.
  The searched text goes to Photon (or Nominatim) and is never logged.
- **Stops near a point** (`pointEnds`): the nearest stop of each pattern within 800 m (per
  pattern, not per route: a route's nearest stop can be where one of its patterns ends), walk
  minutes = ⌈meters × 1.3 / 80⌉ (straight line × 1.3 for streets). Each start's walk counts in
  the ranking (a 1-min walk to an earlier stop beats a 9-min walk to a later one) and comes back
  as the option's `walkBefore` / `walkAfter`. Each starting stop keeps its own "places passed"
  (riding from one may pass another).
- **Picker (plan mode):** the search reads "Search stations, routes, places"; with 3+ characters
  and a 300 ms pause, Places load under Stations and Routes ("Searching places…", "No places
  found.", "Place search is unavailable right now."), each "Fenway Park · 4 Jersey Street,
  Boston". From's and To's lists start with "Current location · plan from (to) where you are"
  (the browser's location; "Location is off for this app." when denied; To added 2026-10-12). A place is `@lat,lon` with its name.
- **Planner:** a point end has no walk field (its walk comes with each option); the trip is
  named "Fenway Park → State", "Current location" by the first (From) or last (To) stop's name. Only stops and legs
  are saved, no coordinates. Without the server: "Needs the T-Minus server.".
- Live (2026-10-12): 600 Main St, Melrose → Fenway Park: 137 → Orange → Green, ~53-56 min;
  350 Washington St, Malden → MGH: Orange to North Station or Orange → Red to Charles/MGH,
  ~31-33 min; Harvard Square → Logan: Red → SL1, ~44 min; 24 Beacon St → Encore: Orange → 109,
  ~29 min.

## Future extensions

- Deferred items in `TODO.md`.
- Arrive-by target (highlight the latest departure that makes a target time).
