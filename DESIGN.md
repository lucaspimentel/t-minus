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
| Auto-bell | Per trip: days and an arrive-by time; the server bells the ride 2 h ahead (see "Auto-bell") |
| Deferred | See `TODO.md` (default times estimated from stop coordinates, ferry, skipping an auto-bell day) |

## Surface wording (2026-10-27)

The same ride on every surface follows CLAUDE.md "UI rules". Which time each phase shows (done,
2026-10-27): the leave-by while there's time to walk; from the leave-by on, or once walking, the
first vehicle's departure, counted down to (the app row's hurry state and the widget's and the
leave card's "Departs in 7 min · 7:48am", 2026-10-29; the app row said "Hurry · 5 min" until
2026-11-08). "Leave now" is only in the bell's push and the compact island's word.

Colors (2026-11-08; CLAUDE.md "UI rules"): amber is at risk but catchable (the 3 min before the
leave-by, past it until the last chance, a tight connection); red is too late at your pace (past
the last chance while the vehicle hasn't left, a late walk, a missed or no connection); gray is
gone. The app row, the ride bar, the leave, walk and ride cards, the Dynamic Island and both
widgets switch at the same moments. Native views read `late` (RideState and widget entries:
the headline and note red), `nextLate` (RideState) / `thenLate` (widget entries: the whole "No
connection after" line red), and show the leave card's `gone` phase muted; older builds (54 and
before) ignore them and keep amber (`warn`, `nextWarn`, `thenWarn` and `thenState` are
unchanged).

Vehicle names and headsigns (`lineLabel` + `toward` on full text lines, `vehicleArrow` on tight
ones):

| Surface | Vehicle | Headsign (first leg) |
|---|---|---|
| Notifications (reminders, ride alerts) | "Orange Line" | "toward Malden" |
| Leave, walk and ride cards (Lock Screen, expanded island; 2026-10-29 the widget's layout, the ride card 2026-10-31) | "Orange Line" | "toward Malden" ("→" where it doesn't fit) |
| Ride bar, the app's expanded row | "Orange Line" | "toward Malden" (as now) |
| App card leg strip | "Orange" | none (the expanded row has it) |
| Widget Home Screen (small, medium; 2026-10-29) | "Orange Line" | "toward Forest Hills" ("→" where it doesn't fit) |
| Connection lines ("then ● Bus 132 at 6:38pm"), Dynamic Island | "Orange" | none |
| Riding: ride card, expanded island, both widgets (2026-11-06) | "Orange Line" | the drop-off instead: "to Malden Center" ("to 🚩 Malden Center" at a flag stop) |
| Riding: the app's timeline, the ridden leg (2026-11-06) | "Orange Line" | none (the leg's last row names the drop-off) |
| Route map: vehicle badges (2026-11-07) | "OL", "132" (the island's compact label) | none |
| Route map: stop labels and the caption | the stop's name ("Oak Grove", "Main St @ South St") | none |

Commuter rail (2026-11-01) follows the same two forms: "Haverhill Line" on text lines,
"CR Haverhill" where tight, "CR" as the compact island badge, 🚆. Its assigned track goes before
the headsign so a cut line keeps it: "Haverhill Line · Track 5 toward Haverhill" ("→ Haverhill"
on the cards and widget). The train number ("Train 2317 · Track 5") is in the expanded row only;
a flag stop reads "Malden Center · Flag stop" there and "Haverhill Line · Flag stop" on the ride
card. See "Commuter rail".

Later legs keep their headsign in the expanded row only; no headsign: the vehicle alone ("Bus
132"). Red, Blue and Green follow Orange ("Green Line B" / "Green B"). The Dynamic Island's
compact badge stays the route's short label ("132", "OL"). Widget times carry no weekday
("Leave 5:57am", "arrive 12:08am" late at night; 2026-10-29: "Thu" overflowed the medium rows);
the app's keep it.

Reminder notifications: the heads-ups (60, 10 and 5 min) come before the leave-by, so their body is
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
  more rows are in the fetched schedules. Once any are added, "Show fewer rides ▴" sits beside it
  (alone when no more can be added): it removes all the extras, scrolls to the top and focuses
  "Show more rides". Both reset when the shown trip changes or the app
  reopens. Neither makes requests (the per-leg vehicles already polled).

### Countdown states

| State | Condition | Display |
|---|---|---|
| Green | `now < leave_by - 3 min` | "Leave in 12 min", leave-by time on the right |
| Amber | `leave_by - 3 min <= now < leave_by` | "Leave in 2 min" (the color carries the urgency) |
| Hurry | `leave_by <= now < last_chance` | Amber "Departs in 5 min" (to the first departure), first-leg departure on the right (2026-10-27: the leave-by, then the departure, on every surface; CLAUDE.md "UI rules"). Red "Hurry · 5 min" (state `red`) until 2026-11-08 |
| Missed | `last_chance <= now < first_leg.departure + 5 min` | Red "Departs in 2 min" at full size (can no longer be reached at your pace, still to leave; `.departs`, 2026-10-21, like the leave card; screen readers hear the same; amber until 2026-11-08), then gray and smaller "Missed · left 3 min ago"; first-leg departure on the right |
| Hidden | `now >= first_leg.departure + 5 min` | Row removed |

Only the target row is green (2026-11-04, the same in every mode): the ride the app answers with,
the first row still to catch (green, amber, hurry or en route; `targetRow`), or the belled one.
Later rows in the green state are neutral (the plain border, the text color). Amber (amber,
hurry) and red (missed, still to leave) show on any row at their thresholds, the belled row
included (its outline stays green).

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
  (no stop slack). Reachable rows read "Departs in 6 min" (to the first leg's departure,
  shown on the right; the vehicle is in the leg strip; 2026-11-04, was "Bus 132 in 6 min"); the
  first is highlighted green (the target, `targetRow`, as in the normal list), later ones neutral. No leave-by. Unreachable rides follow the
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
  "Tracking cancelled · Undo"). In every mode the pinned row is the highlighted target instead of
  the first reachable one (in the normal list too, 2026-11-04; amber/red stay amber/red under the outline). Bell off drops only the pin (`unpinTarget`): plain tracking ends;
  "Leaving now" / "At the stop" stays and the highlight goes back to the first reachable ride.
- **Boarding question:** a pinned departure boards on its own only after "Leaving now" / "At the
  stop" with an at-stop time on or before it. Otherwise, at its departure (live, else scheduled)
  the state gets `asking: { dep }` and the bar reads "Did you get on the 7:40am Bus 132?" [Yes]
  [Missed it] (the departed row keeps its outline). Yes boards it from the departure
  (`answerBoarding`; stop alerts already passed are skipped); "Missed it" drops the pin (plain
  tracking ends). Unanswered, it closes `ASK_MINUTES` (30) after the departure
  (`enRouteActive`). The push at the departure asks the same (see Notifications). Saved pins
  from before the bell are dropped at load (`migrateEnRoute`).
- In the iOS app, location can tell the stop, the vehicle boarded, a missed one and getting off
  (see "Boarding from location" under "iOS app").
- Boarding is assumed when the target's first vehicle departs (live or scheduled time) while
  it was reachable: its legs (trip id + times) become the ride, and a trip card replaces the
  list and the bar:
  - Headline by phase (`ridePhase`, `rideHeadline`): "Bus 132 · 9 stops · 4 min" (stops left once
    the vehicle's stop list is loaded, else "Bus 132 · 4 min"; minutes count down to the leg's
    live drop-off arrival, which the timeline shows); with only the drop-off left, "Next stop:
    get off", or "Get off here" while stopped there (`getOffText`); in the transfer (before
    leg i departs), a departure row's headline: "Orange in 9 min" with "7:31am" on the right
    (amber, with the card's edge, when the connection below is tight; red when it's missed or
    none, 2026-11-08, the outlook line too); "Walking · arrive 7:56am" (after the last arrival), "Arrived
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
    `outlookText`): "Then Orange Line toward Forest Hills at 7:31am · 4 min to spare" ("at", 2026-11-06), "· tight" (under 2 min, amber;
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
    "Different bus?" lists those leaving from now, preceded by the ones that already left, as
    "On a different train?" lists them (`otherVehicles`: after the previous leg's arrival, in
    the last 15 min, up to 4; the rider caught an earlier one than planned, 2026-11-03;
    picking one starts that leg), and "I'm at the stop" (only when one
    leaves before the planned one) takes the first from now. Picking re-plans the later legs (`switchLeg`);
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

- Per departure: countdown/state with the leave-by time right-aligned ("Leave in 12 min   8:04am";
  a countdown too long for the time to fit beside it steps down 28 → 24 → 20px, `fitHeads`, and
  only then lets the time wrap, as a next-day "Thu 10:26am" at 360 px does),
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
  this trip" line. The expanded row is remembered
  by the timing vehicle's trip id while the page is open. One at a time (2026-11-09): expanding a
  row collapses the other (tapping the open one collapses it), and the page scrolls so the tapped
  row stays where it was on screen (`keepInPlace`) when the collapsed one was above it. The
  planner's option cards work the same way.
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
  "Refreshing…" until the header ↻ stops (`whenIdle`; a pull during a refresh joins it).
  Updates (2026-10-31): the release also fetches the page (`pageIsNewer`, as the update check);
  a newer version reads "Updating…" and reloads the app (`location.reload()`; trips, the bell and
  rides are stored, only view state resets), else the data refresh is all (also when the check
  fails). With the update banner already showing: "Pull down to update" / "Release to update" /
  "Updating…", reloading without the check. ↻ stays a data refresh. The move, end and cancel
  listeners go on the touched element, not `document`: the once-a-second redraw can replace it
  mid-pull, and a removed element's touch events don't bubble (seen 2026-10-31 as a frozen pull in
  the specs). Upward
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
  - the first row's leave state changing (green → amber → hurry → missed), e.g. "Departs in 5 min ·
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

### Route map (2026-11-07)

The trip drawn at true positions, in addition to the timeline (mockups accepted 2026-11-07).
Web app only (the PWA and the iOS app's WebView); no native surface shows it.

- **Where:** 🗺 in the header, beside ↻, opens a full-screen sheet ("Done" or Escape closes)
  with the shown trip; the trip doesn't switch while it's open. Setup draws the same map inline,
  as a static picture fitted to the trip: above an expanded planner option's timeline, and under
  the legs in the trip editor (redrawn when a leg changes). Only the sheet pans and zooms
  (2026-11-08: the planner's map did too, the editor's didn't; both are pictures now, so the page
  scrolls over them). The main screen with no rows once loaded ("No upcoming departures found",
  2026-11-09, mockups accepted) draws the shown trip under the message as a picture filling the
  space down to the footer (at least 250 px; the page doesn't scroll), with the dot, the legs'
  vehicles, the base map's credit and "Tap for the full map" under it; a tap opens the sheet.
  It's kept across the once-a-second redraw and closed (its location and polling stopped) when
  rows come back, while riding, or without trips.
- **Drawing:** an SVG outline with no street map (equirectangular, north up, in meters from the
  first boarding stop). Each leg is its route's shape (`route_patterns` with
  `representative_trip.shape`), trimmed to its boarding and drop-off stops, in the route's
  color; its stops are small dots, the ends larger and labeled. An intermediate stop is drawn
  only when it's 14 px or more from the last one drawn on its leg and from the leg's end
  (`stopsToShow`, rechecked on zoom; 2026-11-07: the small setup maps were a string of bus-stop
  dots); a selected stop always. Two leg ends within 250 m are
  one transfer: one dot when they share a name, else the next leg's label only ("Oak Grove", not
  "Washington St opp Oak Grove Sta"). Transfer walks are dashed. In the sheet, a tap (or Enter) on
  a stop shows its name in the caption; pinch, drag or the wheel zoom and pan, from 150 m across
  out to all of commuter rail's reach in one view (the base map's `reach`, the commuter rail
  stops' box, 5 km more on each side; `areaRect`, `viewLimits`), the view's center anywhere in it
  (2026-11-08: it stopped one trip-size past the trip and at twice its width, short of the outer
  towns). Without the base map, the old limits. Once the view moves, ⤢ in the map's top-right
  corner ("Show the whole trip", 40 px, card style) eases back to the trip's fit in 250 ms
  (`easeView`; at once with Reduce Motion) and hides; a pan or pinch during it takes over. Marks keep their size in pixels; lines their width.
- **Walks at the ends:** planner options draw dashed walks from the place's point (an address or
  "Current location", held in memory only) and to it. Saved trips keep no place coordinates (the
  config reaches the server), so there is no last walk. No walk from the phone's location
  (2026-11-09: the sheet drew one before boarding; the dot alone now, inside the fit:
  `routeMapModel`'s `fitAlso`).
- **Location (the sheet and the empty screen's map, 2026-11-09):** never asked for on its own.
  Already granted (the Permissions API): the dot, live (`watchPosition`, cleared on close). Not
  granted: no dot until locate. Locate (an arrow, top-right above ⤢, card style, "Center on my
  location") asks the first time (`getCurrentPosition`, then the watch) and centers on you with
  the whole trip still in view (`centerOn`; ⤢ then shows, on the picture too), eased like ⤢
  (250 ms, at once with Reduce Motion; 2026-11-09). Nothing else on the maps is animated. Denied: "Location
  off" in the caption line, only after that tap; the button stays. Until 2026-11-09 the sheet
  asked on opening and showed "Location off" whenever denied. `mapLocation` in `index.html`.
- **Live while open (the sheet; the empty screen's map too):** the phone's location as above, and every
  vehicle on the legs' routes and directions (`/vehicles`, `vehiclesQuery`, every 10 s), as a
  round marker in the route's color ("132", "OL"), between the boarding and drop-off stops, and
  on a bus leg from the line's first stop to the drop-off (buses coming toward your stop, full
  color; none past the drop-off; 2026-11-09) (within 150 m of the shape, updated in the last
  90 s). Its point shows the direction of travel:
  the route line's direction where the vehicle sits on it (`pathHeading`), not the MBTA's
  `bearing` (missing or stale at stops); the label stays upright (2026-11-09; a rectangular badge
  before). The belled or tracked ride's vehicle is larger and outlined. Once riding, finished
  legs fade.
- **Zoomed out (2026-11-09):** with the view more than 1.5× wider than the trip's fit
  (`zoomedOut`, `ZOOMED_OUT`), only your ride's vehicle shows; ⤢ or zooming back in shows the
  others. With no ride of yours on the map (none belled or tracked; the empty-screen map), the
  10 s `/vehicles` poll is skipped while zoomed out and runs at once on zooming back in, unless
  the last one is under 10 s old.
- **A bus leg's whole line (2026-11-09):** a bus leg (the Silver Line too, `isBusRoute`) with a
  shape is drawn end to end along its pattern (`splitPath`): the parts before the boarding stop
  and after the drop-off at 35% (like finished legs, beneath every leg's stretch), and the
  pattern's other stops as faded dots (tappable for their names on the sheet; thinned like
  intermediate stops). On every map (the sheet, the empty screen's, setup's). The view still fits
  your stretch, walks and location only. Subway and commuter rail legs stay trimmed (the base
  map's faint lines show the rest); a leg drawn from its stops (no shape) too.
- **Data:** a leg's main route only (an `also` route runs the same street between the stops).
  The pattern is the one serving the boarding stop and then the drop-off (by id or parent
  station): canonical first, then the most typical, then MBTA sort order. Kept on the phone as
  `t-minus:shapes:<route>/<dir>` (`trimShapesDoc`: patterns with their polyline and stop ids,
  stops with name, position and parent; 132 toward Malden 7.6 → 4 KB, Orange toward Forest Hills
  5.8 → 2.9 KB), 7 days like the stop lists. Without a shape (the MBTA down, nothing kept):
  straight lines through the leg's stops from setup's kept stop list, else its two ends from
  the loaded times, with no message.
- **Privacy:** positions never leave the phone; shape and vehicle requests carry the route and
  direction only.
- **Code:** geometry in `core.js` ("route map": `decodePolyline` / `encodePolyline`,
  `pickPattern`, `trimPath`, `vehiclesOnStretch`, `fitView` / `zoomView` / `panView`,
  `routeMapModel`, `basemapLayers`, `basemapNames`); the SVG, gestures and the sheet in
  `index.html` (`mapWidget`, `openMapSheet`, `routeMapEl` for setup, `loadBasemap`); the base
  map's build in `scripts/build-basemap.mjs` with its geometry in `scripts/basemap-geo.mjs`.

**Base map** (2026-11-07, mockups accepted 2026-11-07): a minimal Boston map behind all three
maps (the sheet, the planner's options, the trip editor).

- **Layers, bottom to top:** water; land (the towns clipped to the shoreline, merged into one
  outline); green areas (parks and reservations, 2026-11-09, mockups of two shades: `--map-green`,
  #e4efdc light, #25362a dark), with lakes and wide rivers cut out in the water color above
  them and narrow rivers as thin water lines; town borders, dashed (only edges two towns share, never the coastline); Boston
  neighborhood borders, dotted; faint lines in their route colors: commuter rail (1.5 px, 35%),
  then the Silver Line, then rapid transit (2.5 px, 30%); town names (small caps) and Boston
  neighborhood names (italic), muted; then the trip as before. Colors: `--map-water`,
  `--map-land`, `--map-green`, `--map-line` in both themes. Faint lines use `stroke-opacity`, not `opacity`:
  a translucent element is composited as a layer, which left seams between Chromium's raster
  tiles over the land (faded legs too).
- **Names:** towns at any zoom; Boston's neighborhoods only while the view is under 10 km
  across, and the name "Boston" only above that; a name is drawn only when it fits inside the
  map; overlapping names keep the town, then the larger area, and the other shows once zooming in
  separates them; rechecked on every pan and zoom. Names sit under the trip (not moved aside).
  Boston's neighborhoods only (Cambridge's official ones are planning names).
- **Coverage, three tiers** (2026-11-09; every layer follows its tier): **inner**, 5 m, a fixed
  rect each edge 1 km past an anchor: Boston College (west), Fields Corner (south), Wonderland
  (east) and the 132's Main St @ South St (north), about 16 × 21 km (`INNER` in the build);
  **middle**, 20 m, the rest of the bus stops' box padded by 1 km (Bedford to Hull, Brockton to
  Beverly), land, water, green, borders and names; the inner and middle pieces are clipped to
  rects that share edges exactly, so they abut in one path with no gap and no evenodd hole;
  green only in these two; **outer**, coarse, 100 m, over the commuter rail stops' box padded by 0.3°:
  Massachusetts towns' land (their shoreline), borders and names, simplified to 100 m (2026-11-08:
  the sheet showed blank land and no names north of Danvers; mockups of 100 m and 200 m, 100 m
  chosen), the land of Rhode Island, New Hampshire and Connecticut (no towns), and lakes over 1 km²;
  no rivers. Outside it, the card color.
- **Sources (public domain):** MassGIS towns (`Basemaps/Mass_Towns_Yellow_Lines_and_Labels`),
  lakes and wide rivers (`AGOL/Hydro_100k`, USGS 1:100,000; 2026-11-09: `Hydro_Major`'s hand-picked
  set had no Spot Pond nor the Middlesex Fells reservoirs) and narrow rivers (`AGOL/Hydro_Major`;
  Hydro_100k's adds three times the streams), the City of Boston's BPDA neighborhoods (data.boston.gov),
  US Census TIGERweb states (the coarse land of RI, NH and CT), the MBTA V3 API (extents, line shapes),
  MassGIS open space (`AGOL/openspace`, Protected and Recreational OpenSpace; green areas: full
  public access, any purpose but agriculture, water supply, flood control and underwater, so the
  Public Garden, filed as "Other", stays; a site is the parcels sharing a town and name, kept
  when they total 20 acres or more, then merged into one outline; a paged query, ~9,300 parcels). MassGIS asks
  for the credit "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts
  EOTSS": the file carries one credit line, shown under the sheet's map once the base map is
  drawn (and in README).
- **File:** `basemap.json` at the repo root, built by `NODE_USE_ENV_PROXY=1 node
  scripts/build-basemap.mjs` (~1 min keyless, about 7 paced MBTA requests) and committed; rebuild
  when the sources change. Rings and lines are Google polylines (precision 5), simplified per
  tier (5 m inner, 20 m middle, 100 m outer; before 2026-11-09 one detailed tier at 10 m, and
  25 m before that, which turned the piers into spikes at the sheet's zoom), with `reach` (the
  commuter rail stops' box, for the sheet's pan and zoom limits), `inner` (the inner rect, for
  reference) and `green`: 215 KB, 140 KB gzipped (2026-11-09, three tiers and green areas, green
  75 KB of it; 94 KB gzipped with one 10 m tier and no green; 75 KB gzipped at 25 m
  with Hydro_100k's lakes; 69 KB
  gzipped before them, 2026-11-08; 42 KB with Massachusetts coarse land only and no outer towns,
  2026-11-07).
- **Loading:** fetched the first time a map opens (a plain same-origin GET: nothing about the
  rider), kept in memory; the maps draw as before until it arrives, then redraw. A failure is
  retried at the next map opening. The server serves it `no-cache` with an ETag; the service
  worker keeps it like any same-origin file (not in `SHELL`, not stamped: a rebuild alone doesn't
  change the footer version). Its paths are projected once per map origin, not on each redraw.

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
      "autoBell": { "days": [2, 4], "arriveBy": "10:00" },
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
  D/E" (`commonLabel`); two or more commuter rail lines are "Commuter Rail" (2026-11-02: South
  Station's twelve made one tag wider than the screen, and iOS enlarged every font on the page;
  `text-size-adjust: 100%` and wrapping tags guard against the next one). One line keeps its
  name ("CR Fitchburg"). The board list ("Where do you board?") and the planner's From / To
  stop list for a route tag their stops the same way (2026-11-08; they had none): per direction
  (`groupConnections`: each side of a street gets the stations near it, a stop served both ways
  once), and a planner row standing for both sides lists each line once (`rowConnections`).
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
- Boarding from location (the iOS app's native code, with GPS on): `/vehicles` for the current
  leg every 10 s, `/predictions` per leg every 60 s, `/schedules` per leg every 30 min, all
  through the proxy (its 5 s cache for `/vehicles`): ~8 requests a minute per phone.
- Route map (2026-11-07): one `/route_patterns` (`shapesQuery`) per leg's route and direction
  the first time, kept on the phone for 7 days like the stop lists (planner and editor maps
  too); while the 🗺 sheet is open, one `/vehicles` per leg every 10 s (6 a minute per leg,
  12 for a 2-leg trip), through the proxy (its 5 s `vehicles` cache). Keyless and direct, a
  3-leg trip's polls come near 20 a minute with the sheet open; the sheet is short-lived, and
  a 429 only skips a round. Nothing once closed. The empty main screen's map (2026-11-09) polls
  the same way while shown, paused while the sheet is open (never both) and in the background;
  with no rows the list's own polling is light, so the total stays as with the sheet open.
- Route map's base map: one same-origin `basemap.json` per page load when a map first opens
  (revalidated, 304 when unchanged); no MBTA requests.
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
    - Heads-ups go out 60, 10 and 5 min before leave-by (`HEADS_UP_MINS`; 10 added 2026-10-15,
      60 on 2026-11-03 with auto-bell: "Leave in 60 min · Home to office"; on a leave card it
      is the switch from "Leave at" to the countdown, with an alert, and it ends "(was …)"),
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
    with 3 or fewer); "Next stop: Oak Grove · get off" / "Then Bus 132 toward Redstone at 6:26pm ·
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
  `manifest.json`, `basemap.json` and `icons/**`) live in the service's Railway settings, not
  the repo. Setup steps are in `server/README.md`. `web-push` is the only dependency, in
  `server/package.json`; the app has none.

## Hosting

- **One origin:** the Railway service serves the app at `https://t-minus.lucasp.net/` (a custom
  domain) and its API under `/api/`, so the app's requests to its server are same-origin.
- **The app's files:** an allowlist from the repo root (`/` → `index.html`, `core.js`,
  `setup.js`, `sw.js`, `manifest.json`, the three icons, `basemap.json`); anything else is a 404. Read once
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
- **Location:** boarding from location sends no coordinates or distances anywhere (RUM, traces,
  the app log): they stay in the native code's on-device log.
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
  | static | `/routes`, `/stops`, `/route_patterns` (2026-11-07: also `filter[direction_id]` and `fields[shape]`, the route map's shapes) | a day, then revalidated (`If-Modified-Since`) | no limit | SQLite `mbta_cache` |

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
  cached. `basemap.json` (the route map's base map) is cached the same way, on its first fetch,
  not precached. The cache is the fallback when the server
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
- **Deploys:** Railway's watch paths are an allowlist (`server/**`, the shell files, `basemap.json`, `icons/**`),
  so `ios/` and `capacitor.config.json` never trigger a deploy.

### Live Activity for tracked rides (Phase 2, 2026-10-20)

- **What:** every tracked ride ("I got on", detected boarding, a "Did you get on?" Yes) shows on the Lock
  Screen and in the Dynamic Island while it lasts, stop alerts or not (iOS Settings → T-Minus →
  Live Activities is the only off switch). Notifications are unchanged, "3 stops to …" included.
- **Card, 2026-10-31 (the build after 41; mockups accepted 2026-10-31):** the leave card's
  layout (`LeaveBody`), the same lines as the widget following the ride (`rideCardFields`,
  `core.js`): riding, "Get off in 5 stops · 9 min" (the countdown to the drop-off after the stop
  count), "Get off next stop · 2 min", "Get off here", "Get off in 9 min" without a stop list;
  the line "● Orange Line toward Oak Grove" with the trip's arrival ("arrive 7:21pm", the item
  the old card lacked); the connection "then ● Bus 132 6:38pm · 4 min to spare" ("· tight",
  "(missed 6:38pm)" amber; "No connection after 6:31pm"; the headline stays white while riding).
  The transfer: "Bus 132 in 6 min · 6:38pm", the line, the note "4 min to spare" / "tight" /
  "Missed the 6:38pm" (amber, the headline too; from 2026-11-08 and the build after 54, a missed
  or no connection is red, `late`, and tight stays amber). The final walk: "Arrive in 5 min · 7:21pm";
  then "Arrived · 7:21pm". The compact island: the mode emoji and "5 stops", "next", "here", or
  the countdown (no stop list, the transfer, the walk). The leave and walk cards also show the
  later legs ("then ● Bus 132"); the question reads "Did you get on? · left 6:15pm" with the
  arrival on the line. The old fields (`title`, `sub`, `next`) are still sent.
- **The drop-off while riding (2026-11-06, mockups accepted 2026-11-06; build 54):** the line
  names the drop-off instead of the headsign, which matters only before boarding: "● Orange Line
  to Malden Center" (`dropOff`; a commuter rail flag stop "to 🚩 Malden Center", the flag before
  the name so a long one can't cut it; without a stop list, the old line). The arrival moves to the third line:
  "then ● Bus 132 at 6:38pm" with "arrive 7:52pm" on its right (the spare is gone: the time is
  amber when tight, red when missed, `thenState`; "No connection after 6:31pm" amber, red from 2026-11-08 with `nextLate`), or
  "Arrive 7:21pm" alone on the last leg. The medium widget matches; the small one reads "● Bus
  132" / "to Washington St opp…" / "arrive 6:52pm" (the arrival amber or red). The app's timeline
  drops the ridden leg's "toward" line: its last row names the drop-off, once per surface.
  `nextWarn`, `headsign` and `right` keep their meaning for older builds.
- **Yes / Missed it (2026-10-31):** the question on the Lock Screen card, the expanded island and
  the medium widget has [Yes] (blue) [Missed it] in place of the legs bar (the widget: in place of
  its bottom row, the arrival moved to the line's end). Each is a link,
  `tminus://answer?a=yes|missed&dep=<s>` (the asked departure: the card's `askDep`, the widget
  entry's `dep`), that opens the app: the scene delegate hands it to `TMinusPlugin` (kept until the
  plugin loads on a cold start), whose `answer` event switches to the bell's trip and answers as
  the bar does when the question for that departure is open (`askAnswerMatches`: within
  `ASK_MATCH_MIN`, 5 min, of it); otherwise (closed, answered, another departure) "Question
  closed". The compact island and the small widget keep a plain tap (opens the app).
- **Card before 2026-10-31** (`ios/App/TMinusWidgets/RideViews.swift`, in the app's light / dark colors with the
  route's color as the dot): the trip name; a headline like the ride card's ("Orange · 4 stops",
  "Next stop: get off", "Bus 132" in the transfer (sub line "Toward Malden · 8:02am · 3 min to
  spare", "· tight" in amber), "Missed the 8:02am · next 8:14am" in amber, "No
  connection after …", "Walking", "Arrived ~8:25am") with a countdown; the drop-off line with the
  time first ("Get off 8:24am at …", so a long stop name is cut, not the time); the next
  connection or "Arrive ~…" (amber when it warns, "· tight" / missed / none, via `nextWarn`; the
  headline stays white while riding a tight connection; until build 38 the line was always white,
  seen 2026-10-29); a progress bar with one segment per leg, sized by its riding time (at
  least 8%), filling on its own while ridden.
- **Countdown:** whole minutes, counted down by iOS without updates ("12 min", rounded down;
  a live date range from now in abbreviated minutes, as the leave card and the widgets; "12
  minutes" until the build after 38, committed 2026-10-30, not yet uploaded. Until build 35 a date
  formatted against the draw time, which didn't tick: seen 2026-10-29 as "Leave in 59 minutes"
  beside the compact island's live "55 min"), then "<1 min" from the last 80 s (`soon`
  in the content: iOS can't say "<1 minute" itself, and the times aren't accurate to the second;
  80 s leaves the server's 20-s poll time to deliver it before "0 minutes"; also shown past the
  time instead of "−1 minute").
  On the dimmed Always-On screen the Lock Screen card's headline drops the countdown and shows
  the time ("Departs 9:43am", "Leave 7:39am", "Get off in 5 stops"; "<1 min" kept): iOS dashes
  self-ticking date text at reduced luminance ("Departs in – min", seen 2026-11-05). From
  build 52.
- **Dynamic Island:** expanded content margins 24 pt at the sides, 14 top, 18 bottom (the
  defaults let the rounded corners clip the route label and the last line). Compact: the route's dot and label (`islandLabel`: "OL", "GL B", "132",
  "SL1"; 🚶 on the final walk), then the stops left, or the countdown when stops don't apply (no
  stop data, a transfer, the final walk); expanded: the trip name and "T-Minus" on top, then the
  Lock Screen card's body, same fonts (until build 35 the top row was the
  compact parts, "● OL … 8 stops", repeating the headline; seen 2026-10-29). The top row is inset
  10 pt more than the body on its outer sides: the corners beside the camera are rounder and
  clipped the "O" of "Office → Home" on build 38 (fix committed 2026-10-30, not yet uploaded);
  minimal: the route's dot.
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
  8:25am"; "Departs in 2 minutes" (amber, to the departure; red from 2026-11-08, `late`: past
  the last chance), the same two lines;
  at the departure "Did you get on?" / "Bus 132 toward Malden left at 7:48am" / "Tap to answer"
  (island "Got on?"; tap opens the app), ended when answered or after 30 min. "Ride cancelled"
  / "Open the app for the next one.", dismissed after 2 min. The legs bar shows the trip, empty.
- **Dynamic Island:** compact: the route's dot and label, then the countdown alone, "9 min"
  ("<1 min" in the last 80 s; amber past the leave-by, red past the last chance, 2026-11-08; the
  walk card's in white, red when late (amber in build 54 and before): it
  counts down to the departure, not a walk), or the word when there's none ("Leave 7:39am" early,
  "Leave now", "Got on?"); expanded: the card. 2026-10-29: "Leave 28 minutes" stretched the
  island across the screen, hiding the clock, so the word moved to the expanded view and the
  countdown got a fixed width (sized for "59 min") so the island doesn't resize as it counts
  down. It ticks on its own (iOS 18's live date range in abbreviated minutes); it may differ
  by a minute from the other surfaces' (seen once: 40 vs 39), accepted.
  (Before 2026-10-24 the walk card showed a walking figure, which read as "walk 10 minutes".)
- **Layout (2026-10-29, build 35; the phone showed three surfaces disagreeing, mockups accepted):**
  the leave and walk cards follow the medium Home Screen widget, on the Lock Screen and in the
  expanded island alike: the trip name and "T-Minus" (muted); "Leave in 28 min · 7:39am" (a live
  countdown, "1h 14m" an hour+ ahead instead of "Leave at", "<1 min" at the end; the time
  smaller); "● Bus 132 toward Malden   arrive 8:25am" ("→" where "toward" doesn't fit; the
  arrival never cut); a note only for extra state ("Moved (was 7:36am)" amber, the walk card's
  "At the stop ~7:45am · 3 min to spare", "Open the app for the next one."); the legs bar. Past
  the leave-by: "Departs in 7 min · 7:48am" (amber; red past the last chance, 2026-11-08), no
  "Leave now"; the walk card the same (red when late). "Did you get on?" / "● Bus 132 toward
  Malden   left 7:48am"; "Missed · left 7:48am" (muted by its `gone` phase from the build after
  54; amber before);
  "Ride cancelled" (no vehicle line). The expanded island's top row is the trip name and
  "T-Minus" (it repeated the route and the countdown or time beside the headline). Compact
  island: "🚶 28 min" to the leave-by ("🚶 7:39am" an hour+ ahead), the vehicle's emoji past it
  ("🚌 7 min" amber; `modeEmoji`: 🚌 bus and Silver Line, 🚇 Red / Orange / Blue, 🚊 Green and
  Mattapan; the walk card too), "Got on?", nothing once missed or cancelled; fixed width (sized
  for "🚌 59 min"). Emoji only there. The state adds `head`, `countTo`, `headTime`, `long`,
  `headsign`, `right`, `note`, `emoji`; builds before 35 ignore them and keep the layout above.
- **Walk card:** "Leaving now" / "At the stop" with the bell mark its reminder `started` (without
  the bell, a reminder is deleted with `?reason=started`) and the app takes over the card (`TMinus.liveActivityList`, by `reminderId`): "Departs in 6
  min · 6:15pm" (`head`; builds before 35 show the `title` "Bus 132 in 6 minutes"), "At the stop ~7:45am · 3 min to spare" ("since 7:45am" once there; "2 min late" in
  red, 2026-11-08; amber in build 54 and before), "Arrive 8:25am" (`walkActivityState`; on both cards "~" only when a leg is a headway estimate), updated by the app while open, no alerts.
  A missed departure turns it into the boarding question (app and server). Boarding ends it just before the ride card starts; Cancel or the vehicle leaving end it. Known
  limit: with the app closed it isn't updated (stale 2 min after its countdown; ended at the next
  open).
- **Late bell (2026-10-30; seen 2026-10-29: belled at 12:18 for a 12:16 leave-by, nothing
  came):** the bell is offered until the departure, and so is its reminder: past the leave-by the
  app posts it with the ride's departure (`dep`), accepted until then and marked `late`. A late
  reminder never sends "Leave now"; with a start token and 80 s or more left (`LIVE_SOON_MS`) the
  server starts the leave card quietly at "Departs in 8 min · 12:27pm" (start alert "Departs in 8
  min · <trip>", no sound), then the card follows the row as after "Leave now" (back to "Leave
  in" if a delay puts the leave-by ahead again) and the departure asks "Did you get on?". Under
  80 s, or without a start token: only the question. Undo of a start and new start tokens also
  count until the departure. Web and server only (build 38 has everything).
- **Walk card without a leave card (2026-10-30):** "Leaving now" / "At the stop" with the bell
  and no card to keep (the server's start failed or never came): the app starts the walk card
  itself (`liveActivityStart`, no reminder id), updated and ended as the adopted one; the ride
  card's start replaces it at boarding.
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

### Swiped-away cards (2026-11-03)

A card that is gone (swiped away; also ended by iOS) still has its push token, and APNs accepts
pushes to it: the leave card's heads-ups went out as card alerts nobody saw (2026-11-03, a card
the app had ended at launch: no notification at all that morning). So:

- **Detection (native, the build after 46):** `LiveActivityObserver` watches every card's state;
  `.dismissed` (not for cards the app ended itself, `liveActivityEnd`) is recorded for the web app
  (`TMinus.liveActivityDismissed()` → `{ activities: [{ id, reminderId }] }`), and a leave card's
  goes to the server as `PUT /api/reminders/<id> { cardDismissed: true }` (retried like its
  token). Cards gone while the app wasn't running count at its next launch (the cards it saw are
  kept, `knownActivities`). A new leave card for the same reminder clears its record.
- **Server:** `cardDismissed` marks the card gone (`card: { tried, dismissed }`): the reminder's
  next steps (heads-ups, "Leave now", "Did you get on?") are notifications, and the card isn't
  started again by itself. Pending notifications shows "card dismissed".
- **"Show again":** on each open (launch, return), a toast "Lock Screen card closed · Show again"
  while the card still applies: the ride's card while riding (also on build 46: an update that
  finds no card marks it `gone`, and later updates stop), or the belled ride's leave card before
  its departure (not once the trip started). The ride card: a new one from the app. The leave
  card: `PUT /api/reminders/<id> { restartCard: true }` → a new start push at the next check
  (past the leave-by, as a late bell's card); 409 while asking, after "Leaving now" / "At the
  stop", or without a start token.
- A swipe is for that ride only: the next bell or ride gets its card.

### Boarding from location (2026-11-06)

The iOS app can tell from the phone's location which vehicle the rider got on, a missed one, and
getting off (`core.js` "Boarding from location", `BoardingLocation.swift`). The PWA doesn't.

- **Setting:** "Detect boarding with location" in setup's Settings (the app only, a build with
  it), off by default, saved at once (`t-minus:boarding-location`). Turning it on asks for While
  Using, then Always. While Using: GPS after "Leaving now" / "At the stop" only. Always: also the
  stop's geofence. The hint under it says which. Location off for the app: the toggle stays off.
- **At the stop (Always):** a belled ride's boarding stop gets a ~100 m geofence
  (`GEOFENCE_METERS`), counted from leave-by − 15 min (`GEOFENCE_BEFORE_MIN`) to the departure +
  `ASK_MINUTES`. Only an entry from outside counts (inside when it starts, e.g. home next to the
  stop, doesn't). An entry marks "At the stop" (`geofenceEntered`, the same state as the tap, so
  boarding is assumed at the departure as today; toast "At the stop (location) · Undo").
- **GPS:** high accuracy, in the background too (the blue indicator), from "Leaving now" /
  "At the stop" (tapped or the geofence) until the ride is over or its last walk starts
  (`boardingWants`). A ride without either (the bell's question answered Yes, "I got on") isn't
  followed.
- **Matching** (`matchVehicle`): the leg's vehicles that left in the last 15 min or leave in the
  next 30 (the planned one, earlier, later), their positions from `/vehicles` (route and
  direction, every 10 s through the proxy). A vehicle that stays within 75 m of the phone
  (`MATCH_METERS`) for 2+ position updates over 30 s (bus) or 60 s (train: positions update every
  15–35 s), while the phone is 100 m+ from the stop, is the one boarded. Two trains side by side at
  Oak Grove (11 m apart) differ only once one leaves: the one leaving with the phone. A stopped
  train's position can be minutes old: positions are deduplicated by update time and compared
  with the phone's fix at that time (within 20 s). Fixes worse than 50 m are ignored; no fix
  (underground) is no verdict: today's behavior applies.
- **What a match does** (each with Undo; an undone verdict isn't applied again):
  - Boarding is still assumed at the departure. A match within 10 min of it confirms it
    (nothing shown) or switches the leg (`switchLeg`, later legs re-planned): "On the 7:26am
    Orange, not the 7:32am · Undo". At the first leg and at each transfer.
  - Missed: the planned vehicle 200 m+ past the stop after being at it, the phone still at the
    stop: `missLeg` (first leg: back to "At the stop", the next departure; a later leg: its
    next vehicle) and "Missed the 7:08am Bus 132 · Undo".
  - Got off (once matched): the vehicle 150 m+ from a phone that is still or walking, for 2
    updates. At the planned drop-off of an earlier leg: that leg's `off` time, the transfer
    starts ("Got off at Oak Grove"). At the last drop-off with a walk after: `off`, the walk
    starts at once and GPS stops ("Got off at State"); the ride still ends at the arrival + the
    walk. Without a walk: the ride ends ("Got off at State · ride ended"). Anywhere else: the ride
    ends ("Got off · ride ended").
  - A leg's `off` ends it in `ridePhase` (also on the server, which stores legs as posted, and
    in the widget's state). Older builds ignore it.
- **The app closed:** the native code runs core.js's `nativeBoardingStep` in a JSContext (a
  geofence event can relaunch the app without its page). The page arms it (`TMinus.boardingArm`:
  `boardingSession`, the trip, its en-route state, the cards, the bell's reminder and window,
  never a position) whenever that changes, and sends `CORE_JS`, the URL of the `core.js` it
  imports (stamped with its hash): the native code fetches it when it changed, strips `export`,
  and keeps a copy for relaunches. An auto-bell's leave card starting with the page closed arms
  it from the server's bell (`POST /bells`, with the page's last trips and subscription). With
  the page closed, the native code also boards at the departure (as the page does) and keeps the
  server and the card in step: `PUT /reminders/<id> { started }` at the geofence, `POST /rides`
  at boarding with the leave card's token (it becomes the ride card: iOS doesn't let an app start
  a Live Activity in the background), `PUT` / `DELETE /rides/<id>` after a switch, a miss or
  getting off, and quiet card updates (no alert). With the page open, the page does all that
  itself.
- **The page:** the `boarding` event (or, at an open, `boardingPending`) gives the latest action;
  it applies when computed from the trip's current state (or the one before earlier actions taken
  while closed: `boardingBase`), while its ride is still on, with its toast for 5 s and Undo
  (`boardingUndo`).
- **Privacy:** coordinates and distances stay on the phone: none in requests (the queries carry
  route, direction and stops), RUM, traces or the server's app log. They go only to the
  on-device log: setup's "Boarding log" (7 days, newest first, Copy).
- **CI:** an `ios` run with `upload` off also compiles the app target (the only Swift compile
  check; no `swiftc` in the cloud sandbox).

### Widget (Phase 3b, 2026-10-26)

- **What:** "Leave times", the shown trip's next leave-bys on the Home Screen (small, medium);
  mockups accepted 2026-10-26. Tap opens the app. The Lock Screen sizes (rectangular, inline,
  circular) were removed 2026-10-31 (the build after 41): the leave, walk and ride cards are the
  Lock Screen's, kept current by pushes, where the widget lagged them within iOS's reload budget
  (seen 2026-10-27 and 2026-10-29).
- **Following the ride (2026-10-31; CLAUDE.md "UI rules": one answer):** the widget shows what
  the app follows (`widgetState`, the one en-route state: a ride first, then the boarding
  question, "Leaving now" / "At the stop", the bell), on that state's trip whatever the trip
  choice: the belled ride only (its leave-by, then "Did you get on? · left 6:15pm" for
  `ASK_MINUTES`); walking, the walk card's "Departs in 6 min · 6:15pm" with "At the stop ~6:13pm
  · 2 min to spare" (red when late, 2026-11-08; amber before); riding, the ride card's lines (Live Activity above): "Get
  off in 5 stops · 9 min", the line with the arrival, the connection on its own line on the
  medium size (the arrival on the small one amber when it's tight, red when missed or
  none, `thenState` / `thenLate`); the transfer, the
  final walk, "Arrived" for 5 min; then leave times. The request carries the state (the trip's
  index and name, the kind, the at-stop time, the target's key and legs, the question, the
  ride's legs with their trip ids, times to the minute so polls don't rewrite it); the app
  rewrites it when the state changes. The server applies the app's rules (`widgetFollow`): a
  walking target that leaves boards it if the at-stop time was in time, else asks (pinned) or
  drops it; each state ends as in the app (30 min after the tap, `ASK_MINUTES`, 5 min after the
  arrival). A ride's legs are refreshed by trip id (`trackLegs`), a missed connection re-planned
  (`transferOutlook`), and the ridden vehicle's stops read (`rideStops`, 1 request); the answer
  has an entry per minute and per predicted stop (the count drops at each stop's time) and asks
  again every 5 min, at each stop once 3 are left, and at each leg's departure and arrival.
  Entries carry their own `long`, `headsign`, `color`, `arrive`, `note`, `then`, `thenText` and
  `thenWarn` (row -1).
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
  minute (rounded down like the page's; iOS's own countdown formats can't say "9 min"); from the
  leave-by "Departs" / "in 7 min" (amber; from the last chance red, `late`, 2026-11-08: an entry
  at the last chance, the same countdown) until the departure (2026-10-29: no "Leave now" until
  the last chance, as the leave card; the circular size shows "7m", not "now"); then the next row. Past the leave-by the vehicle line gets the departure ("Bus
  132 → Malden at 7:48am") and the medium's first row shows it in amber. Entries run 2 h ahead at most;
  past the last one (`end`), "Open T-Minus" / "for new times". No trips: "Plan a trip in
  T-Minus"; no rows: "No more today".
- **Sizes (before 2026-10-29; Lock Screen sizes until 2026-10-31):** small: the trip name, the title and countdown, the first vehicle ("Bus 132 → Malden") and
  the arrival; medium: the countdown only (`head`: "Leave in 9 min", "Leave in 1h 06m" an hour+
  out, "Departs in 2 min"; the leave-by isn't repeated), then the
  entry's row and the next two in one format (leave-by, "Bus 132", "arrive 8:37am"; no headsign or
  weekday, 2026-10-29; "~" on a headway
  estimate; build 25 shows the small's title and count instead; only the route column gives way,
  shrinking then truncating, so long text can't widen the view and clip both sides, as late-night
  "Thu" times did on build 26); rectangular: the name, "Leave
  7:42am", "in 9 min · Bus 132" (past the leave-by: "Bus 132 at 7:48am"; no headsign); inline: "132 Leave 7:42am" (the time, not the
  countdown); circular (2026-10-26, after the phone showed a bare "38 / 132"): "38m" over "Bus
  132" ("Orange" for the Orange Line) in a ring, open at the bottom like the system's gauge, full
  an hour before the leave-by and empty at it (drawn by hand so the previews show it); the time
  with no ring more than an hour out; past the leave-by the minutes to the departure ("7m").
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
  the trip name, the countdown ("Leave in 5 min"; "Departs in 2 min" amber past the leave-by, red past the
  last chance), its
  time under it ("12:17am", the leave-by; "12:20am", the departure), then ● "Orange Line" and
  "toward Forest Hills" on up to two lines; no arrival. Medium: "Leave in 5 min · 12:17am", ●
  "Orange Line toward Forest Hills" ("→" where it doesn't fit) with the first ride's arrival, then
  the next two rides (leave-by, arrival), naming their vehicle in short form only where it differs
  from the first's ("● Red → Braintree", a several-route leg's "Green D"). The answer adds per row
  `long` and `headsign` and per entry `headTime`; answers without them (and older builds, which
  ignore them) keep the layouts above. 2026-10-30 (the build after 38; the phone still cut "→ Oak
  Gr…" beside the arrival, and a differing next ride cut its own headsign): the medium shows one
  ride: the countdown with its time, ● "Orange Line toward Oak Grove" full width, and at the bottom
  its later legs in short form ("then ● Bus 132 · ● Red", cut at the end; none for a one-leg
  trip) with "arrive 7:21pm" (never cut). The answer adds per row `then` ([{ label, color }]). 2026-10-31: the small size adds the
  arrival under the direction (one line each); the medium size puts a note or the connection on
  its own line above the bottom row.
- **Previews:** the `ios` workflow also renders `widget-<theme>.png` (the leave-time samples and
  every followed state, small and medium).

## Commuter rail (2026-11-01)

Commuter rail (route type 2) is a mode like the others: setup's route and station lists, the
rail network (`loadRailNetwork`: canonical patterns, one per branch, all stops), nearby, and the
planner's network (`/api/plan`, `HOP_KMH` 60 km/h without a midday sample) ask for types
`0,1,2,3`. Its stations share the subway's parent ids (`place-north`, `place-sstat`,
`place-bbsta`, `place-mlmnl`), so transfers need nothing new. Excluded everywhere:
`CR-Foxboro` (Foxboro Event Service: stadium events only, fare class "Special";
`EXCLUDED_ROUTES`). The first-leg default list stays the subway (twelve lines would bury it);
commuter rail comes up by typing a station or line. All lines share one color, so a station's
next-leg groups are per line for commuter rail (`reachableFrom`), not per color, and a station
tapped in a group rides that group's line (`legBetween`'s `only`: North Station to Malden Center
is the Orange Line or the Haverhill Line, by the list it was tapped in). Setup's kept
copies are keyed `t-minus:routes:2` and `t-minus:rail-network:2` (the older, rail-only copies
are removed).

- **Timing:** not subway (`isSubwayRoute`): schedules until predictions appear (only for trains
  already given a vehicle, about 1-2 hours ahead), then live. The 6-hour schedule window and the
  next-day fill cover the long gaps (every 2 hours on weekends).
- **Two routes:** a trip can belong to two lines (a Franklin trip also on the Providence line);
  its records land on the same trip and stop in `mergeTrips` (counted once), and the vehicle is
  named by the leg's own route. `rideStops`, `tripStopCount` and the planner's sample skip the
  second copy.
- **Pickup and drop-off** (schedules' `pickup_type` / `drop_off_type`; predictions inherit the
  schedule's): 1 at the board stop (no pickup) or at the alight stop (no drop-off) leaves the
  trip out; 3 (tell the crew) is a flag stop: "Malden Center · Flag stop" (amber) in the
  timeline, "Haverhill Line · Flag stop" on the ride card. Commuter rail only.
- **Track:** the prediction's stop is the track's platform (`BNT-0000-05`, `platform_code`
  "5") once dispatch assigns it; until then the station's no-track stop (`BNT-0000`, `NEC-2287`),
  which is also what schedules name. A track counts only as a real-time assignment: the
  predicted platform has a code and the scheduled stop it replaces has none. Where the
  schedule's stop already is a platform ("Track 1 (All Trains)" at Malden Center) it's no news
  and isn't shown. Kept on the ridden leg once assigned (`trackLegs`).
- **Train number** (the trip's `name`, "2317"): the expanded row only.
- **Per-train alerts** (an alert whose `informed_entity` names a `trip`, "Train 2501 is 5-10
  minutes behind"): left out of the line's alert list (`filterAlerts`) and shown on that train's
  expanded row and, as the `note`, on the leave and ride cards while it's the belled or ridden
  train (another note, "Moved (was …)", wins). From the app's `/alerts` and from the predictions'
  `include=alerts` (`predictionQuery`; `/schedules` answers 400 to it), so the server needs no
  request of its own.
- **Track push:** a belled ride's track, from the reminder's own predictions (no extra polling):
  "Track 5" / "Now Track 7 (was 5)", body "Haverhill Line toward Haverhill at 7:48pm", kind
  `track`, tag `<key>:track` (a change replaces the earlier one, not the reminder). With a leave
  card it's the card's alert instead. Until the departure question; none while riding.
- **Requests:** none added; the leg queries ask for `platform_code`, the trip `name`, the
  pickup types and (predictions) the alerts as sparse fields.
- **iOS:** every new text travels in existing fields (`label`, `emoji`, `long`, `headsign`,
  `note`); no build needed.

Ferry (route type 4, deferred; checked 2026-11-01): predictions and vehicles exist while boats
run (East Boston, Charlestown; no vehicle label or occupancy), but ferry stops (`Boat-*`) have
no parent stations, so no link to the subway (Long Wharf to Aquarium would be a walk by
distance); most routes have no canonical pattern (only F6 and F7), so the rail network's query
would miss them; and the loop routes (F6, F7, F10) don't fit two directions.

## Auto-bell (2026-11-03)

A trip can be belled automatically on chosen weekdays: "arrive by 10:00am on Tue and Thu".

- **Setup:** the trip editor's Auto-bell card (shown where the bell can notify: the server and
  push): seven day buttons (Monday first) and "Arrive by". No days: off. Saved as the trip's
  `autoBell: { days: [2, 4] (0 = Sunday), arriveBy: "HH:MM" }` (`validAutoBell`). Setup's trip
  list adds "🔔 Tue Thu · by 10:00am" (`autoBellLabel`). Return trips don't copy it.
- **To the server:** `PUT /api/auto-bells { subscription, startToken?, stopSlackMinutes, trips:
  [{ index, tripName, trip, autoBell }] }` (`autoBellTrips`; at most 10), the phone's whole set
  (empty: none). The app sends it when it changes (stored as `t-minus:auto-bells`, with the
  subscription and the start token) and at least daily, at launch and on return; from setup's
  Save it may ask for notifications. Stored per phone in the `auto_bells` table; a trip sent
  again with the same index and name keeps the day it last belled (`lastDate`).
- **When:** `AUTO_BELL_LEAD_MIN` (120) before the target on a chosen day, Boston time
  (`autoBellNext`; saved later than that but before the target: at once). The server loop
  checks due schedules each tick.
- **Which ride:** today's rows (as the widget's, 40 of them) → the last arrival (`eta`, walk
  included) at or before the target, else the earliest after it, late in red (`autoBellRow`).
  Then a reminder exactly as the app's bell posts it, marked `auto: { index, dep, legs }`: the
  quiet leave card, the heads-ups, "Leave now", "Did you get on?". The MBTA failing: tried
  again (`RETRY_MS`) until the target.
- **Not belled** that day: this phone already has a bell (one at a time; a manual bell stays),
  or rides that trip, or no ride at all. Each is logged.
- **In the app:** `POST /api/bells { subscription }` lists the server's bells (`adoptBells`, at
  launch and on return): each is pinned on its trip and kept as that trip's reminder, as if
  belled here; one already under way on that trip keeps its state and the server's bell is
  deleted. In the iOS app this runs before the launch's cleanup of leave cards whose reminder it
  doesn't know (2026-11-03: the auto-bell's card, started at 8:30am, was ended when the app
  opened); without an answer from the server the cleanup is skipped. From then on it is a manual bell: it stays on its ride, a manual bell elsewhere
  replaces it, bell off cancels that day only.
- **Widget:** it follows the bell once the app has opened (its request comes from the app); the
  leave card shows it from the start.
- Deferred: skipping a day in advance (`TODO.md`).

## Remaining unknowns

- Daytime Orange prediction horizon (only a late-evening sample was taken). The schedule
  fallback covers any gap.
- Weekend/holiday 132 schedules were not inspected; the app reads them from the API.

## Development

- Unit tests: `npm test` (runs `node --test test/*.test.js`; Node 22+): the pure logic in
  `core.js`.
- Browser tests: `npm run test:browser` (Playwright, Chromium, phone viewport, New York time):
  `test/browser/*.spec.js` cover the main list, en route / ride card, setup, the planner,
  commuter rail, the route map, notifications and stop alerts, auto-bell, the MBTA proxy, RUM,
  the iOS app's web side, pull-to-refresh, the update check, accessibility (axe), and the
  service worker fallbacks. The app runs as is, served by `test/browser/server.mjs` (which can also
  fail, stall, or go down on purpose); MBTA requests are answered by a fake API
  (`fake-mbta.js`) from scenarios (trips with stop times, optional live delays, alerts) plus
  recorded route/stop lists for setup (`test/browser/fixtures/`, refreshed by
  `scripts/record-fixtures.mjs`). The page clock is faked; specs move it with `tick` /
  `tickTo`. The devDependencies are `@playwright/test`, `@axe-core/playwright` and the Capacitor packages
  for the iOS app (`npx cap sync ios`); the app itself has none.
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
    ● Orange"). A tap expands it (one option at a time, like the rows) to the timeline the rows use (`optionSteps` → `renderTimeline`,
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
- Not in phase 2: addresses (phase 3, below), ferry (commuter rail since 2026-11-01: route
  types 0,1,2,3, its hops at 60 km/h without a sample), time-aware search (a route not
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
