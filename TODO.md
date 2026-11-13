# TODO

Goal: any MBTA rider (bus, subway, light rail, commuter rail) can set up any number of trips with any
number of transit legs, without knowing GTFS IDs or the engine's internals.

Done: the N-leg engine and the setup UI, including no direction step, nearby-only next legs,
rail connections in the drop-off list, multi-route legs (`also`), return trips, the
timing-leg override, collapsed rows, the trip list with one-at-a-time editing, short
route labels with MBTA color dots, a sticky picker search, boxed legs in the trip editor, stop names in the timeline, trip tracking, service worker fallbacks (5xx, 3 s
timeout, "Saved copy", reload banner), and UI affordances: loading indicators, the old-data
age, Retry / backoff / rate-limit countdown, expand hints, pressed states, Undo toasts on
the main screen and in setup, pull-to-refresh, "Tracking ✕", the ride stop list with the stop before the drop-off, and browser tests in CI against a fake MBTA API, and leave-time push reminders ("Notify me", `server/`) deployed on Railway, and accessibility (row buttons, focus kept across redraws, screen-reader announcements; see `DESIGN.md`), and the move to Railway at t-minus.lucasp.net (one origin; repo renamed to `t-minus`), and previous rides ("I got on"), "Show more rides" and "On a different train?", and stop alerts while riding (pushes before each drop-off, missed connections), and boarding from location (geofence and GPS in the iOS app; see `DESIGN.md`), and the MBTA proxy (`/api/mbta/*`: the server's key, a shared cache, stale copies when the MBTA is down), and notification updates (re-sent with "(was …)" when a time moves 2+ min), and starting a trip cancels its reminders, and the ride headline with stops and minutes left, and the ride's stops on the timeline with the vehicle, and connections: tight instead of missed while catchable, with "I'm at the stop" / "Different connection?" picks, and "I got on" in the expanded missed row (missed rows kept 5 min after leaving), and previous rides drawn like upcoming rows ("Missed · left 3 min ago", set apart by a gap), and "Track this trip" keeping reminders (leaving or boarding cancels them), and subway predictions first (no scheduled twin of an ADDED train), and subway headways when a leg has no predictions ("every 6 min", "~" times), and auto-route phase 1 (station to station on rail; one-off trips), and auto-route phase 2 (buses: the server's network, `/api/plan`; From/To in the leg picker), and auto-route phase 3 (addresses and places, "Current location", total-time ranking, itinerary rows), and live times for "Go somewhere else…" (timed candidates, ranked by arrival), and auto-route options as collapsible cards with the rows' timeline, and "Pending notifications" in setup (debug: server entries, local copies, the 24 h push log), and Declarative Web Push (Safari 18.4+ shows pushes even if the service worker fails), and a 10-min heads-up before the 5-min one, and the iOS app phase 1 (Capacitor shell on the live site, APNs, keep-awake, the TestFlight workflow; see `DESIGN.md`), and the iOS app phase 2 (a Live Activity for tracked rides: Lock Screen card and Dynamic Island, updated by the app and by APNs pushes), and the iOS app phase 3a (leave cards: a Live Activity started by the server at the 10-min heads-up, the walk card, the handoff to the ride card), and leave cards from the bell (started quietly when the reminder is set; "Leave at 7:39am" until an hour before), and "Departs in" on missed rows (amber until the vehicle leaves), and tracking folded into the bell ("🔔 Track", one at a time) with "Did you get on?" at the departure instead of boarding on its own (push actions in the iOS app), and native Datadog RUM in the iOS app (crash reporting, WebView tracking; see `DESIGN.md` "Observability"), and stop counts on the timeline's rides, and the iOS app phase 3b (the leave-times widget: Home Screen and Lock Screen, timed by the server's `/api/widget`), and one wording across surfaces (the leave-by, then the departure; "Orange Line" / "toward" on text lines, "Orange" / "→" where tight; see `DESIGN.md` "Surface wording"), and the leave card and expanded island in the medium widget's layout ("Departs in" instead of "Leave now", emoji in the compact island, a live headline countdown), and the late bell (a leave card and the question when belled past the leave-by; the walk card from the app when no card exists), and the expanded island's top row clear of the corners, "min" on the ride card, "· tight" in amber on the card, and the medium widget's single ride with "then ● Bus 132", and the widget following the belled ride, walking and the ride (the ride card in the leave card's layout with the final arrival; no Lock Screen widgets), and Yes / Missed it on the card, the expanded island and the medium widget (opening the app with the answer), and "Show fewer rides ▴" beside "Show more rides" (all the extras at once), and pull-to-refresh reloading the app when a newer version is on the server (else a data refresh), and commuter rail (setup, the planner, rows; train numbers, tracks with a push when assigned, flag stops, per-train alerts; see `DESIGN.md` "Commuter rail"), and auto-bell (days and an arrive-by time per trip; the server bells the ride 2 h ahead; a 60-min heads-up for every bell; see `DESIGN.md` "Auto-bell"), and the drop-off named while riding ("● Orange Line to Malden Center" on the cards and widgets; "then ● Bus 132 at 6:38pm" with the time amber or red; see `DESIGN.md` "Surface wording"), and the route map (🗺 in the header: the trip's shapes, stops, your location and its vehicles in a full-screen sheet; inline in the planner's options and the trip editor; see `DESIGN.md` "Route map"), and the route map bounded by the farthest commuter rail stations (the view's edges; locate off outside it) with a whole-map button and a back-to-the-trip icon, and the route map's base map (land, water, town and Boston neighborhood borders and names, faint subway, Silver Line and commuter rail lines; one same-origin file built by `scripts/build-basemap.mjs`; three detail tiers, 5 m inner, 30 m middle, 150 m outer (20 m and 100 m until 2026-11-10), and green areas), and one meaning per color (2026-11-08: amber at risk but catchable, red too late at your pace, gray gone; the app row past the leave-by reads "Departs in 5 min" in amber instead of "Hurry · 5 min" in red; native `late` / `nextLate` / `thenLate`; see `DESIGN.md` "Surface wording"), and rail connection tags on the board list and the planner's stop list for a route (2026-11-08), and the base map's Massachusetts towns (borders, names, coastline) across commuter rail's reach (2026-11-08), and the sheet panning and zooming out over all of it with ⤢ back to the trip (2026-11-08), and the empty main screen's map with locate on both maps (location asked only from locate; no walk from your location) (2026-11-09), and the base map's lakes from Hydro_100k (Spot Pond, the Fells reservoirs) (2026-11-09), and the base map's detailed water from MassGIS's 1:25,000 lakes layer (the Charles between its dams) (2026-11-10), and setup's Permissions in the iOS app (Notifications, Live Activities, Location, Precise Location, Allow buttons, "iOS Settings ›"; boarding detection follows Location instead of its own toggle; "Settings" on permission-off toasts) (2026-11-10), and the route maps' locate following you (a filled arrow; taps switch street, 400 m, and area, 2 km; a drag or the map buttons end it) (2026-11-10), and arrival at the stop from GPS after Leaving now, with "Walking" kept past the estimate (2026-11-10), and trip ids (per-trip state keyed by a stable id; 2026-11-10), and setup saves that keep tracking (same legs: kept, the server's copies renamed; a started trip deleted or given other legs goes on as a one-off; the rest dropped as bell off; duplicate legs noted) (2026-11-11), and the route map's incoming trains on rail legs (whole pattern, faded stations, no line) and a leg's other routes (Green branches' trains labeled by letter, a bus `also` route's faded line and buses) on the main screen's map and the sheet (2026-11-12), and the ridden vehicle at your GPS position on the route maps (blue ring, held until the MBTA position passes it; 2026-11-12), and the main screen's map panning and zooming (a drag, a pinch, ctrl+wheel; a double-tap in and a two-finger tap out on both maps; a stop's name on a tap; "Open the full map" in the right stack, Hide map top-left) (2026-11-13), and the widget's large size ("More rides" or "Trip timeline" before leaving; the app's timeline while walking and riding, with the stops left; 2026-11-13).

## Rides (2026-11-10, one by one)

1. "I'm already on…": pick the vehicle on any leg (e.g. the Orange trains near you in the last
   ~30 min), later legs planned from it, earlier legs done. Today "Show previous rides" offers
   only first-leg vehicles from the last 15 min. To grill.
2. Detect a ride from scratch: with Location on and nothing tracked, match the phone against the
   shown trip's legs' vehicles and offer "On the 9:51am Orange? · Track" (an offer, not
   automatic). Today detection starts only after "Leaving now" / "At the stop". To grill.

## Trip planner (point to point)

The planner builds a trip (walk, legs, transfers, walk); the existing engine times it with live
predictions and schedules. Open questions: a setup aid that saves a trip, a one-off "how do I get
there now" screen, or both; ranking (fewest transfers, total time, least walking; one result or
several); route-only or time-aware (skip routes not running now). Phase 1 (station to station on
rail), phase 2 (buses, from the server's daily network), phase 3 (addresses and places) and one
planner for saved and one-off trips ("Plan a trip", 2026-10-28) are done.

- Later, if timed options prove wrong: a full time-dependent search (every departure) instead of
  timing the route-only search's candidates.

## iOS app (see `IOS.md`)

- Answer "Did you get on?" from the card or the widget without opening the app (App Intents
  running in the background: the server answers, turning the leave card into the ride card and
  driving it; the app catches up at its next open). Today Yes / Missed it open the app.
- Show the target ride's timeline in the app while walking (the large widget shows it; the app
  shows only the list and the bar).

## Ideas (2026-11-06, to grill one by one)

- UI refresh, mostly the setup (settings) screen and the top of the main screen. Mockups first.

## Deferred

- Trip picker as a custom popover menu (2026-11-12: a native select for now): the trips with a
  check on the shown one, a divider, "Plan a trip…"; then the one-off trip's Save and Remove move
  into it from the banner.

- Route map: names for green areas, lakes, ponds and rivers on the base map ("Boston Common",
  "Middlesex Fells", "Spot Pond", "Charles River"), placed like town and neighborhood names.

- Default times to/from the stops and transfer times estimated from stop coordinates
  (a walking estimate; the user can change it, e.g. when getting a ride).
- Auto-bell: skip a day in advance (working from home, a holiday): "Skip Thu, Nov 5" for every
  trip that day. Today: let it bell, then turn the bell off.
- Route map: keep a saved trip's From/To points on the phone only (not in the config sent to
  the server), so the sheet and the main screen's map draw both end walks with their markers
  (2026-11-09: planner options only for now).
- Ferry (see `DESIGN.md` "Commuter rail", ferry note: realtime exists; no station links, few
  canonical patterns, loop routes).
