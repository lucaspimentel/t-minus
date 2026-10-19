# IOS.md — T-Minus iOS app (plan)

Status: Phase 1 in progress. Apple prerequisites, server (APNs, app log), web (the native code
path), the `ios/` project and the TestFlight workflow are done (2026-10-19); next the first build
and the "Done when" checks. Decisions below
come from the 2026-10-17 and 2026-10-18 grills; open questions are listed at the end. When a phase ships, move its behavior into `DESIGN.md` and keep only the
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
| App | "T-Minus" on the Home Screen (`CFBundleDisplayName`); "T-Minus Boston Commute" in App Store Connect and TestFlight ("T-Minus" was taken; "MBTA" left out, since the MassDOT license bars using its trademarks); bundle ID `net.lucasp.tminus`, SKU `tminus`; iOS 18 minimum |
| Scope | Phase 1 (shell + native push), 2 (ride Live Activity), 3a (leave-time Live Activity, push-to-start), 3b (widget) |

## Prerequisites

- Apple Developer Program ($99/yr; enroll in the Apple Developer app on the iPhone or on the
  website). App ID `net.lucasp.tminus` with Push Notifications and Time Sensitive
  Notifications; App Group for the widget (3b).
- APNs auth key (`.p8`, key ID, team ID): Railway variables only, never in the repo.
- App record in App Store Connect (browser) for TestFlight.
- Signing for CI: an App Store Connect API key (`.p8`, key ID, issuer ID; Admin role, so it can
  create the distribution certificate) in GitHub Actions secrets (`ASC_KEY_P8`, `ASC_KEY_ID`,
  `ASC_ISSUER_ID`, plus `APPLE_TEAM_ID`). CI uses automatic signing with it (`xcodebuild -allowProvisioningUpdates
  -authenticationKeyPath … -authenticationKeyID … -authenticationKeyIssuerID …`), which creates
  and renews the certificate and the profiles (app, extension); no `.p12`, profiles, or keychain
  secrets to manage by hand.

## Phase 1: Shell and native push (parity with the PWA)

Decisions (2026-10-18): Time Sensitive notifications; a bundled error page when the server is
unreachable at launch; keep-awake through the app's own plugin (no third-party dependency); native
diagnostics from the first build; notification permission asked on the first "Notify me" or
test-notification tap, as in the PWA.

- **Server (done, `a320904`):** an APNs device token is a subscription
  (`{ endpoint: 'apns:<hex>' }`), stored and capped like a Web Push one. `apnsPush` builds the
  push (`apns-collapse-id` from the tag, hashed past 64 bytes; Time Sensitive with a sound, passive
  for quiet updates); `server/apns.mjs` sends it (HTTP/2, ES256 provider token; dead tokens count
  as 410). `POST /api/log` / `POST /api/log/read`: diagnostics per device. Variables `APNS_KEY`,
  `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_HOST` (`server/README.md`). Details in
  `DESIGN.md` (Notifications, APNs).
- **Web (done):** `native` (`window.Capacitor?.isNativePlatform()`) in `index.html`:
  - Push: `PushNotifications.requestPermissions()` / `register()` → the device token (stored as
    `t-minus:apns-token`) as the subscription; permission state from `checkPermissions()`.
  - Screen on: `TMinus.keepAwake({ on })`, called only when the wanted state changes.
  - Errors (registration, permission, plugin): `POST /api/log` with a random device id
    (`t-minus:device`); setup's "Pending notifications" shows the token's end and the app log.
  - No service worker and no "Add to Home Screen" hints in the app.
  - Spec: `test/browser/ios-app.spec.js` (a fake Capacitor bridge).
- **iOS project (done):**
  - Root dev dependencies `@capacitor/cli`, `@capacitor/core`, `@capacitor/ios` 8.5.3,
    `@capacitor/push-notifications` 8.1.3. `capacitor.config.json`: `server.url`
    `https://t-minus.lucasp.net`, `webDir` `ios/www` (only the bundled "Can't reach T-Minus" page
    with Retry, `server.errorPath` `index.html`), PushNotifications `presentationOptions` banner,
    sound, list (stop alerts show with the app open, as today).
  - `ios/` from `npx cap add ios --packagemanager SPM` (verified to run on Linux, so it is generated
    here and committed), then edited: `AppDelegate` forwards the APNs registration to Capacitor;
    `App.entitlements` (`aps-environment` production, time-sensitive); deployment target 18.0;
    `NSLocationWhenInUseUsageDescription`; `TMinusPlugin.swift` (`keepAwake` sets
    `isIdleTimerDisabled`) registered by a `MainViewController` subclass (Phase 2 extends it);
    a 1024 px icon from `icons/icon.svg` (no alpha channel); iPhone only; launch screen in the
    app's background colors (light / dark); `ITSAppUsesNonExemptEncryption` false (no export
    compliance question per build). Project file edits (new files, build settings) were made with
    the `xcodeproj` gem; `npx cap sync ios` keeps them. Railway's watch patterns are an allowlist (`server/**`,
    the shell files, `icons/**`), so `ios/` and `capacitor.config.json` never trigger a deploy.
- **CI (done, not yet run):** `.github/workflows/ios.yml` (`workflow_dispatch`, `macos-15`,
  latest stable Xcode): `npm ci`, `npx cap sync ios`, `xcodebuild archive` signed ad hoc (it
  carries the entitlements; automatic signing at archive time would need a development profile,
  which needs a registered device), then `-exportArchive` with automatic signing and the API key
  (creates the distribution certificate and the App Store profile in Apple's cloud), a check that
  the signed app has `aps-environment`, and a second export with `destination: upload` (straight
  to TestFlight). Build number: the run number. On failure the Xcode distribution logs are an
  artifact. After the first upload: add yourself to an internal testing group in App Store
  Connect (once), then install from TestFlight.
- **Done when:** installed from TestFlight with trips imported, the debug screen shows the token;
  the test notification, "Notify me" (heads-ups, a quiet later-time update, Leave now) and stop
  alerts arrive through APNs; the screen stays on; airplane mode at launch shows the error page.
  Then the PWA comes off the iPhone.

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
- **Cost:** none: the repo is public, and standard GitHub-hosted runners (`macos-15` included) are
  free there. Workflow logs are public too (secrets are masked; the team ID and bundle ID show).

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
