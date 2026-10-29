# IOS.md — T-Minus iOS app (plan)

Status: Phase 1 (shell and native push, 2026-10-19), Phase 2 (Live Activity for tracked
rides, 2026-10-20), Phase 3a (leave cards, 2026-10-20) and Phase 3b (widget, 2026-10-26) are
done; their behavior and decisions are in `DESIGN.md` ("iOS app"). Decisions below come from the 2026-10-17 and 2026-10-18 grills; open questions are
listed at the end. When a phase ships, move its behavior into `DESIGN.md` and keep only the
remaining plan here.

## Goal

A native iOS shell around the existing web app, for what a Home Screen PWA cannot do:
Lock Screen / Dynamic Island Live Activities for tracked rides and leave-time countdowns, a
widget, and APNs delivery instead of Web Push. One codebase: the web app stays the UI; native
code is limited to the Capacitor bridge, a Live Activity, and a widget.

## Decisions

The app-wide decisions (Capacitor, remote URL, TestFlight only, builds in CI without a Mac,
names and bundle ID) are in `DESIGN.md` ("iOS app").

## Prerequisites

- A new target gets its own App ID / profile; the CI's automatic signing with the API key creates
  them (it did for `net.lucasp.tminus.widgets`). It can't register App Groups (the API key gets
  401 on `/appGroups`), so the widget shares data with the app through a keychain group instead
  (3b; every profile allows the team's keychain groups).

## Working without a Mac

- **Project changes:** new targets, capabilities, entitlements, and `Info.plist` keys are edited as
  files, not in Xcode: the `xcodeproj` Ruby gem, run here, for new files, build settings and the
  `TMinusWidgets` extension (Phase 2); the result is committed. 3b added the widget to it.
- **Seeing native UI:** no SwiftUI previews; the `ios` workflow renders the views to PNGs
  (`ios/Previews`, the `live-activity-previews` artifact; see `DESIGN.md`), the widget's sizes
  included.
- **Debugging:** no device console, breakpoints, or Safari Web Inspector for the app's WebView.
  - Web UI: debug in a desktop browser as today; the app runs the same page.
  - Native: keep it thin; log bridge and ActivityKit events to the server (`POST /api/log`,
    shown next to setup's "Pending notifications") so failures are visible without Xcode.
  - Push and Live Activity updates: the server's push log already records each send and its
    APNs response.
- **SwiftUI traps (seen in the previews and on the phone):**
  - A countdown that ticks on its own: `Text(.dateRange(endingAt: until), format:
    .components(style:fields:))`. `Text(until, format: .offset(to: Date()))` is drawn once and
    doesn't tick (the card showed "59 minutes" beside the island's live "55 min");
    `.durationOffset(to:)` reads negative ("-28 min").
  - A `Text` with `minimumScaleFactor` in a `VStack` is squeezed vertically when a line follows
    it (the headline shrank above a note); `.fixedSize(horizontal: false, vertical: true)` keeps
    its height (`.layoutPriority(1)` didn't).
- **Round trip:** a native change is a CI build, TestFlight processing, and an install
  (~15-30 min). Web and server changes still ship by pushing to `main`.
- **Cost:** none (public repo; see `DESIGN.md`). Workflow logs are public too (secrets are
  masked; the team ID and bundle ID show).

## Testing

- Unchanged: `core.js` unit tests, Playwright specs (they run the web app, with `isNative` false),
  server tests (plus the APNs builder and dispatch).
- Native views: the rendered PNGs (CI artifact), reviewed like mockups.
- Native behavior (bridge, Live Activity updates, widget refresh, APNs delivery): manual on the
  iPhone via TestFlight. Keep it thin; logic stays in JS or on the server.

## Open questions

- Android: the PWA for now; Capacitor's Android target with FCM if ever needed.
