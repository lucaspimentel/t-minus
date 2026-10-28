# TODO

Goal: any MBTA rider (bus, subway, light rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including no direction step, nearby-only next legs,
rail connections in the drop-off list, multi-route legs (`also`), return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, a sticky picker search, boxed legs in the trip editor, stop names in the timeline, trip tracking, service worker fallbacks (5xx, 3 s
timeout, "Saved copy", reload banner), and UI affordances: loading indicators, the old-data
age, Retry / backoff / rate-limit countdown, expand hints, pressed states, Undo toasts on
the main screen and in setup, pull-to-refresh, "Tracking ✕", the ride stop list with the stop before the drop-off, and browser tests in CI against a fake MBTA API, and leave-time push reminders ("Notify me", `server/`) deployed on Railway, and accessibility (row buttons, focus kept across redraws, screen-reader announcements; see `DESIGN.md`), and the move to Railway at t-minus.lucasp.net (one origin; repo renamed to `t-minus`), and previous rides ("I got on"), "Show more rides" and "Different train?", and stop alerts while riding (pushes before each drop-off, missed connections), and the MBTA proxy (`/api/mbta/*`: the server's key, a shared cache, stale copies when the MBTA is down), and notification updates (re-sent with "(was …)" when a time moves 2+ min), and starting a trip cancels its reminders, and the ride headline with stops and minutes left, and the ride's stops on the timeline with the vehicle, and connections: tight instead of missed while catchable, with "I'm at the stop" / "Different connection?" picks, and "I got on" in the expanded missed row (missed rows kept 5 min after leaving), and previous rides drawn like upcoming rows ("Missed · left 3 min ago", set apart by a gap), and "Track this trip" keeping reminders (leaving or boarding cancels them), and subway predictions first (no scheduled twin of an ADDED train), and subway headways when a leg has no predictions ("every 6 min", "~" times), and auto-route phase 1 (station to station on rail; one-off trips), and auto-route phase 2 (buses: the server's network, `/api/plan`; From/To in the leg picker), and auto-route phase 3 (addresses and places, "Current location", total-time ranking, itinerary rows), and live times for "Go somewhere else…" (timed candidates, ranked by arrival), and auto-route options as collapsible cards with the rows' timeline, and "Pending notifications" in setup (debug: server entries, local copies, the 24 h push log), and Declarative Web Push (Safari 18.4+ shows pushes even if the service worker fails), and a 10-min heads-up before the 5-min one, and the iOS app phase 1 (Capacitor shell on the live site, APNs, keep-awake, the TestFlight workflow; see `DESIGN.md`), and the iOS app phase 2 (a Live Activity for tracked rides: Lock Screen card and Dynamic Island, updated by the app and by APNs pushes), and the iOS app phase 3a (leave cards: a Live Activity started by the server at the 10-min heads-up, the walk card, the handoff to the ride card), and leave cards from the bell (started quietly when the reminder is set; "Leave at 7:39am" until an hour before), and "Departs in" on missed rows (amber until the vehicle leaves), and tracking folded into the bell ("🔔 Track", one at a time) with "Did you get on?" at the departure instead of boarding on its own (push actions in the iOS app), and native Datadog RUM in the iOS app (crash reporting, WebView tracking; see `DESIGN.md` "Observability"), and stop counts on the timeline's rides, and the iOS app phase 3b (the leave-times widget: Home Screen and Lock Screen, timed by the server's `/api/widget`), and one wording across surfaces (the leave-by, then the departure; "Orange Line" / "toward" on text lines, "Orange" / "→" where tight; see `DESIGN.md` "Surface wording").

## Trip planner (point to point)

The planner builds a trip (walk, legs, transfers, walk); the existing engine times it with live
predictions and schedules. Open questions: a setup aid that saves a trip, a one-off "how do I get
there now" screen, or both; ranking (fewest transfers, total time, least walking; one result or
several); route-only or time-aware (skip routes not running now). Phase 1 (station to station on
rail: "+ Add trip (auto-route)" in setup, "Go somewhere else…" one-off trips), phase 2 (buses,
from the server's daily network) and phase 3 (addresses and places) are done.

- Later, if timed options prove wrong: a full time-dependent search (every departure) instead of
  timing the route-only search's candidates.

## iOS app (see `IOS.md`)

- Yes / Missed it buttons on the leave card's "Did you get on?" (App Intents, iOS 17+); today it
  only opens the app.

## Main list

- "Show more rides" can't be undone: "Show previous rides" toggles to "Hide previous rides ▴",
  but "Show more rides ▾" only adds 4 rows a tap (`extraRows`, `index.html`), with no way back
  short of switching trips. Add a way to hide the extra rows (e.g. "Show fewer rides ▴" once
  any are shown); decide whether it removes all extras or 4 at a time.
- "Keep this train" means two things: in the transfer it closes the next-leg picker
  (`connectionChoices`, later trains); while riding it closes the current-leg correction
  (`otherVehicles`, trains that already left). Word the riding one differently (e.g.
  "On a different train?" / "I'm on this one").

- Setup's sticky header ("Cancel · Edit trip · Save") leaves the status-bar strip above it
  transparent on iOS: scrolled content ("Trip name", the walk minutes) shows behind the clock.
  It sticks at `top: env(safe-area-inset-top)`; cover the inset with the page background (e.g. a
  `::before` of that height above it, or a box-shadow).

## Surface wording follow-ups (seen on the phone 2026-10-27, build 26)

- Widget medium rows cut the headsign ("Orange →…": no room for "Orange → Oak Grove" between the
  time and the arrival). Options: let the text scale down before truncating (Swift, a build);
  drop the headsign from the medium rows (server); the headsign on the first row only (server).
- The Dynamic Island said "Leave 40 minutes" while the widget, the leave card and the app said 39:
  possibly the screenshots' timing, possibly iOS's offset format rounding instead of rounding
  down. Check against the previews before changing native code.
- The compact Dynamic Island can span the whole screen width, hiding the clock (seen
  2026-10-27: "● 132 … Leave 28 minutes"). `IslandTrailing` (`RideViews.swift`) shows the word
  plus a self-updating countdown with the full unit ("28 minutes"), capped at `maxWidth: 110`;
  the self-updating text may also be sized for its widest value. Narrow only in phases without
  the word + countdown (riding "4 stops", "Leave now"). Fix (a build): the countdown alone in
  short form ("28 min", per the UI rules' "in N min"; color carries the state, the word stays in
  the expanded view), cap ~60 pt or a fixed width so the island doesn't resize as it counts
  down; check in the `live-activity-previews` artifact.
- The widget ignores the ride in progress (CLAUDE.md "UI rules": one answer; the departure once
  walking). Seen 2026-10-27: walking to the 6:15pm Orange, the walk card said "Orange in 6
  minutes" while the Lock Screen widgets said "Leave 6:32pm · in 23 min" (the next ride); riding
  it at 6:22, the ride card said "Orange · 5 stops · 10 minutes" while they said "Leave 6:33pm ·
  in 10 min". Phase 3b chose "ride in progress: no change to the widget"; the rules now say
  otherwise. Proposal: the widget request carries the en-route / ride state (kind, the row's key,
  the at-stop time; while riding the tracked legs), rewritten by the app as it changes; the server
  answers walk entries ("Orange in 6 min" / "At the stop ~6:15pm", circle "6m" over "Orange") and
  ride entries ("Orange · 5 stops" / "arrive 6:53pm", next step "Then Bus 132 6:38pm"), with the
  next rides below on the medium size; back to leave times once boarded-and-arrived, cancelled or
  gone. Server and web only (no build). Grill the ride entries' content first.
## Deferred

- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Commuter rail and ferry.
- Pull down to reload the app (`location.reload()`) instead of refreshing data; ↻ stays a data
  refresh. Decided: always reload (offline: the service worker's saved copy), text "Pull down
  to reload" / "Release to reload" / "Reloading…", view-only state (expanded rows, previous /
  more rides) resets. Specs: replace "a long pull refreshes…" with a reload check (a `window`
  marker gone), drop "a pull while a refresh is in flight waits".
