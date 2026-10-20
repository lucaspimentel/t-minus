# IOS.md — T-Minus iOS app (plan)

Status: Phase 1 (shell and native push) done 2026-10-19; its behavior and decisions are in
`DESIGN.md` ("iOS app"). Next: Phase 2. Decisions below come from the 2026-10-17 and 2026-10-18
grills; open questions are listed at the end. When a phase ships, move its behavior into
`DESIGN.md` and keep only the remaining plan here.

## Goal

A native iOS shell around the existing web app, for what a Home Screen PWA cannot do:
Lock Screen / Dynamic Island Live Activities for tracked rides and leave-time countdowns, a
widget, and APNs delivery instead of Web Push. One codebase: the web app stays the UI; native
code is limited to the Capacitor bridge, a Live Activity, and a widget.

## Decisions

The app-wide decisions (Capacitor, remote URL, TestFlight only, builds in CI without a Mac,
names and bundle ID) are in `DESIGN.md` ("iOS app").

## Prerequisites (remaining)

- App Group for the widget (3b), added to the App ID.
- Each new target (the widget extension) gets its own App ID / profile; the CI's automatic
  signing with the API key creates them.

## Phase 2: Live Activity for tracked rides

- **When:** every tracked ride (boarding detected, "I got on", Track this trip) starts one,
  alongside `POST /rides`; Done, Cancel, a replaced ride or the ride ending ends it with the
  `DELETE`. iOS settings can turn Live Activities off for the app.
- **Native:** a widget extension target (added without Xcode's UI; see "Working without a Mac";
  `MainViewController` registers the bridge plugin) with `ActivityAttributes` (fixed: trip name, legs) and a
  `ContentState` (leg, next stop, stops left, arrival, next connection and its slack, phase:
  riding / transfer / missed). Lock Screen view (a compact ride card) and Dynamic Island
  (compact, minimal, expanded). Countdowns use `Text(timerInterval:)` (ticks on device).
- **Bridge:** a small custom Capacitor plugin (`start`, `update`, `end`, push-token events). The
  activity's push token goes to the server with the ride (`POST` / `PUT /rides/:id`).
- **Server (`checkFollowed`):** after `rideAlertStep`, build the `ContentState` from `trackLegs`,
  `ridePhase`, `transferOutlook`, `rideStops`; send it (`apns-push-type: liveactivity`,
  `event: update`) only when it changed. Priority 5 for routine changes, 10 for get off / missed.
  `event: end` with a `dismissal-date` when the ride ends. Activities last at most 8 h (rides end
  at 3 h).
- **Notifications with a Live Activity:** keep the urgent ones (they buzz; the activity doesn't):
  "Next stop … · get off", "Missed the …", "No connection after …". The "3 stops to …" heads-up
  moves into the activity. Without a Live Activity (turned off, PWA) all stay as today.

## Phase 3a: Leave-time Live Activity (push-to-start)

- The app registers a push-to-start token (iOS 17.2+) once and sends it with its reminders.
- At the 10-min heads-up the server starts an activity (`event: start`): "Leave in 8:12"
  ticking, the first vehicle and its time; updated when predictions move the leave-by; ended at
  the last chance, or replaced by the ride's activity when the ride is tracked.
- The 10-min / 5-min / "Leave now" notifications stay.

## Phase 3b: Widget

- Home Screen / Lock Screen widget: the active trip's name, "Leave 7:42am", the first vehicle.
- Data: a WidgetKit timeline (iOS refreshes it on its own budget; minutes-level staleness is
  expected). Source: open question below.

## Working without a Mac

- **Project changes:** new targets (the widget extension for 2/3a/3b), capabilities, App Group,
  and `Info.plist` keys are edited as files, not in Xcode. Phase 1 used the `xcodeproj` Ruby gem
  for new files and build settings (run here; the result is committed); the extension target is
  the open question below.
- **Seeing native UI:** no SwiftUI previews. A CI test renders the Live Activity and widget views
  to PNGs (`ImageRenderer`; Lock Screen, Dynamic Island compact / expanded, widget sizes; light
  and dark) from fixed `ContentState` samples and uploads them as a build artifact: the native
  counterpart of the HTML mockups.
- **Debugging:** no device console, breakpoints, or Safari Web Inspector for the app's WebView.
  - Web UI: debug in a desktop browser as today; the app runs the same page.
  - Native: keep it thin; log bridge and ActivityKit events to the server (`POST /api/log`,
    shown next to setup's "Pending notifications") so failures are visible without Xcode.
  - Push and Live Activity updates: the server's push log already records each send and its
    APNs response.
- **Round trip:** a native change is a CI build, TestFlight processing, and an install
  (~15-30 min). Web and server changes still ship by pushing to `main`.
- **Cost:** none (public repo; see `DESIGN.md`). Workflow logs are public too (secrets are
  masked; the team ID and bundle ID show).

## Testing

- Unchanged: `core.js` unit tests, Playwright specs (they run the web app, with `isNative` false),
  server tests (plus the APNs builder and dispatch).
- Native views: the rendered PNGs above (CI artifact), reviewed like mockups.
- Native behavior (bridge, Live Activity updates, widget refresh, APNs delivery): manual on the
  iPhone via TestFlight. Keep it thin; logic stays in JS or on the server.

## Open questions

- Widget data source: the app writes the trips to the App Group and the widget asks the server
  for the next leave-by (`core.js` already runs there), or the app writes precomputed rows.
- Extension target: XcodeGen spec (regenerates the whole project) or an `xcodeproj` script
  (patches Capacitor's project).
- Android: the PWA for now; Capacitor's Android target with FCM if ever needed.
