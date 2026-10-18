# IOS.md — T-Minus iOS app (plan)

Status: planned, nothing built. Decisions below come from the 2026-10-17 grill; open questions
are listed at the end. When a phase ships, move its behavior into `DESIGN.md` and keep only the
remaining plan here.

## Goal

A native iOS shell around the existing web app, for what a Home Screen PWA cannot do:
Lock Screen / Dynamic Island Live Activities for tracked rides and leave-time countdowns, a
widget, and APNs delivery instead of Web Push. One codebase: the web app stays the UI; native
code is limited to the Capacitor bridge, a Live Activity, and a widget.

## Decisions

| Topic | Decision |
|---|---|
| Wrapper | Capacitor (WKWebView + plugins), project in `ios/` in this repo |
| Web files | Remote URL: the WebView loads `https://t-minus.lucasp.net` (`server.url` in `capacitor.config.json`). Pushes to `main` update the app with no new build; `SERVER_API` stays `/api`, no CORS. Revisit a bundled copy later (offline start, App Store) |
| Distribution | Just the author, TestFlight only. No App Store review; a build expires 90 days after upload |
| No Mac | Everything runs from a browser, the iPhone, and CI: Apple's portals in a browser, builds and signing on the macOS runner, installs via TestFlight. No Xcode UI, device console, or Web Inspector (see "Working without a Mac") |
| Builds | GitHub Actions only (`macos` runner): build, sign, upload to TestFlight. Manual trigger (`workflow_dispatch`); the web code ships through the remote URL, so a build is needed only for native changes or before the 90-day expiry |
| Moving trips | The existing Export / Import in setup (the app has its own `localStorage`) |
| PWA on the author's iPhone | Removed once the app works (avoids two push subscriptions and duplicate reminders). The PWA stays supported for Android and browsers |
| Scope | Phase 1 (shell + native push), 2 (ride Live Activity), 3a (leave-time Live Activity, push-to-start), 3b (widget) |

## Prerequisites

- Apple Developer Program ($99/yr; enroll in the Apple Developer app on the iPhone or on the
  website). App ID (bundle ID, e.g. `net.lucasp.tminus`) with Push
  Notifications; App Group for the widget (3b).
- APNs auth key (`.p8`, key ID, team ID): Railway variables only, never in the repo.
- App record in App Store Connect (browser) for TestFlight.
- Signing for CI: an App Store Connect API key (`.p8`, key ID, issuer ID; App Manager role) in
  GitHub Actions secrets. CI uses automatic signing with it (`xcodebuild -allowProvisioningUpdates
  -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …`), which creates
  and renews the certificate and the profiles (app, extension); no `.p12`, profiles, or keychain
  secrets to manage by hand.

## Phase 1: Shell and native push (parity with the PWA)

- **Repo:** `capacitor.config.json`, `ios/` (from `npx cap add ios`, run once in a CI job and
  committed; Swift Package Manager, no CocoaPods), dev dependencies
  `@capacitor/cli`, `@capacitor/core`, `@capacitor/ios`, `@capacitor/push-notifications`, a
  keep-awake plugin. The web shell keeps no build step. Railway's watch patterns (service settings)
  are an allowlist (`server/**`, the shell files, `icons/**`), so `ios/` and
  `capacitor.config.json` never trigger a deploy.
- **Web (`index.html`, `setup.js`), behind `isNative` (`window.Capacitor?.isNativePlatform()`):**
  - Push: `PushNotifications.register()` → APNs device token, posted where the Web Push
    subscription is posted today (`{ apns: token }`). No service worker in the app (WKWebView
    has no Push API); `sw.js` stays for the PWA.
  - Screen on: the keep-awake plugin instead of `navigator.wakeLock` (`syncWakeLock`).
  - Location: `navigator.geolocation` as is (`NSLocationWhenInUseUsageDescription` in `Info.plist`).
  - Copy: no "Add to Home Screen" hints; "Notify me" and the test notification work without them.
- **Server:**
  - Subscriptions keyed by `endpoint` today; native ones use `apns:<token>`, so the tables and the
    5-per-subscription cap stay as they are.
  - `send` dispatches on the prefix: Web Push (`web-push`) or APNs (HTTP/2 + ES256 JWT with
    `node:http2` / `node:crypto`; no new dependency).
  - A pure payload builder beside `declarativePush`: `{ title, body, tag, renotify }` →
    `aps.alert`, `apns-collapse-id` = tag (same-tag replaces), no sound when `renotify` is false
    (later times update quietly, unlike Web Push on iOS).
  - Dead tokens: APNs 410 `Unregistered` / 400 `BadDeviceToken` drop the reminder like a Web Push 404/410.
  - Variables: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (bundle ID), `APNS_HOST`
    (production vs sandbox; TestFlight uses production).
  - Tests: payload builder and dispatch in `test/server.test.js` with a fake APNs `send`.
- **CI:** `.github/workflows/ios.yml` (`workflow_dispatch`): `npm ci`, `npx cap sync ios`,
  `xcodebuild archive` / `-exportArchive` with automatic signing (the API key), upload to
  TestFlight (`xcrun altool --upload-app` or `fastlane pilot` with the same key). The build
  number comes from the run number.

## Phase 2: Live Activity for tracked rides

- **When:** every tracked ride (boarding detected, "I got on", Track this trip) starts one,
  alongside `POST /rides`; Done, Cancel, a replaced ride or the ride ending ends it with the
  `DELETE`. iOS settings can turn Live Activities off for the app.
- **Native:** a widget extension target (added without Xcode's UI; see "Working without a Mac") with `ActivityAttributes` (fixed: trip name, legs) and a
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
  and `Info.plist` keys are edited as files, not in Xcode. Plan: describe the extension in an
  XcodeGen spec (`ios/project.yml`) or add it with a script using the `xcodeproj` Ruby gem, run
  on the CI runner; the resulting project is committed so builds stay reproducible.
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
- **Cost:** macOS minutes count 10x against GitHub's free minutes on a private repo; manual
  builds keep that small.

## Testing

- Unchanged: `core.js` unit tests, Playwright specs (they run the web app, with `isNative` false),
  server tests (plus the APNs builder and dispatch).
- Native views: the rendered PNGs above (CI artifact), reviewed like mockups.
- Native behavior (bridge, Live Activity updates, widget refresh, APNs delivery): manual on the
  iPhone via TestFlight. Keep it thin; logic stays in JS or on the server.

## Open questions

- Widget data source: the app writes the trips to the App Group and the widget asks the server
  for the next leave-by (`core.js` already runs there), or the app writes precomputed rows.
- Bundle ID and the app's display name.
- Extension target: XcodeGen spec (regenerates the whole project) or an `xcodeproj` script
  (patches Capacitor's project).
- `POST /api/log` for native diagnostics: worth adding in Phase 1, or only if Phase 2 needs it.
- `CLAUDE.md` additions once Phase 1 lands (the `cap sync` step, APNs variables, the iOS workflow).
- Android: the PWA for now; Capacitor's Android target with FCM if ever needed.
