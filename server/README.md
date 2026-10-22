# Push server (leave-time reminders and stop alerts)

A small Node service that serves the app (an allowlist of its files from the repo root) and
its API under `/api/`. It takes reminders (`POST /api/reminders`), polls the MBTA for each ride,
and pushes the heads-up, "Leave now", or "Ride cancelled". Setup's "Pending notifications" lists a phone's reminders and
followed rides with their next push and its last 24 h of sent pushes (`POST /api/pending`,
`POST /api/pending/clear`, with the push subscription in the body). It also follows tracked rides for stop
alerts (`POST /api/rides`, `PUT` / `DELETE /api/rides/:id`): a heads-up 3 stops before each
drop-off, "get off" with the drop-off next, and missed connections (see `DESIGN.md`,
Notifications and Hosting). It also answers setup's "Show nearby" (`GET /api/nearby?lat&lon`: the routes around a
point with their distances), auto-route (`GET /api/plan?from&to`:
plans with buses, from a network built daily from 3 MBTA requests, from stops, stations or a
point `@lat,lon`; `GET /api/places?q`: addresses and places from Photon, else Nominatim; see
`DESIGN.md`, "Auto-route with buses" and "Addresses and places"), and proxies the app's MBTA requests (`GET /api/mbta/<path>?…`:
an allowlist, the server's key, a shared cache, stale copies with `x-data-age` when the MBTA
fails, 120 requests/min per IP; see `DESIGN.md`, "MBTA data caching").

The iOS app (`IOS.md`) subscribes with an APNs device token (`{ endpoint: 'apns:<token>' }`)
instead of a Web Push subscription; its pushes go to Apple over HTTP/2 (`server/apns.mjs`), and
its diagnostics to `POST /api/log` (`POST /api/log/read` lists a device's last 24 h).

## Railway setup

1. **Project:** in Railway, create a project with a service sourced from
   `lucaspimentel/t-minus`, branch `main` (repo root, so `server/` can import
   `../core.js`). The deploy config lives in the service's Railway settings, not the repo:
   build command `npm ci --prefix server`, start command `node server/main.mjs`, health check
   `/health`, watch paths `server/**`, `core.js`, `index.html`, `setup.js`, `sw.js`,
   `manifest.json` and `icons/**` (the server and the app's files). To redeploy without a code
   change, edit `server/deploy-trigger` and push.
2. **Volume:** right-click the service → Attach volume, mounted at `/data`. Reminders are kept
   there in `reminders.db` (SQLite), with the proxy's static MBTA copies. An old `reminders.json`
   from before the move can be deleted.
3. **VAPID keys:** run this once, anywhere with Node:
   ```
   npx web-push generate-vapid-keys
   ```
   Keep the private key secret. Changing the keys later invalidates existing subscriptions,
   which is harmless: the app subscribes again the next time the bell is turned on.
4. **Variables** (service → Variables):

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | from step 3 |
   | `VAPID_PRIVATE_KEY` | from step 3 |
   | `VAPID_SUBJECT` | `mailto:<your email>` |
   | `MBTA_API_KEY` | your MBTA V3 API key (free at https://api-v3.mbta.com/register) |
   | `DATA_DIR` | `/data` |
   | `PUBLIC_URL` | the app's URL: the page a notification opens when iOS shows a push without the service worker (default `https://t-minus.lucasp.net/`; set it when hosting elsewhere) |
   | `MBTA_PROXY` | optional: `off` turns the MBTA proxy off (503; the app calls the MBTA directly) |
   | `APNS_KEY` | optional, for the iOS app (`IOS.md`): the APNs auth key's `.p8` contents (multi-line, or `\n` for newlines). Without it, pushes to the app fail and are logged |
   | `APNS_KEY_ID` | with `APNS_KEY`: the key's ID |
   | `APNS_TEAM_ID` | with `APNS_KEY`: the Apple Developer team ID |
   | `APNS_TOPIC` | with `APNS_KEY`: the app's bundle ID (`net.lucasp.tminus`) |
   | `APNS_HOST` | optional: `production` (default, also when empty; TestFlight builds) or `sandbox` (Xcode debug builds). A bad APNs setting logs `APNs off: …` at startup and leaves APNs off; the rest of the server runs |

   `PORT` is set by Railway.
5. **Always on:** in Settings, leave Serverless (app sleeping) **off**, so the 5-second loop
   keeps running. One replica is enough. Don't add more, because they would each send the
   pushes.
6. **Domain:** Settings → Networking → Custom Domain: `t-minus.lucasp.net`, with the CNAME
   (and TXT record, if asked) Railway shows added at the DNS host. Check
   `https://t-minus.lucasp.net/api/health`, which should return `{"ok":true,"reminders":0}`, and
   `https://t-minus.lucasp.net/` (the app).
7. **Test:** in the Home Screen app, open Setup → Notifications → "Send test notification in
   10 s", then lock the phone. "Test notification" should arrive.

## Local run

```
npm --prefix server ci
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
  DRY_RUN=1 DATA_DIR=./server/data PORT=8790 node server/main.mjs
```

Then open `http://localhost:8790/` (the app, with its API on the same port).

- `DRY_RUN=1` logs pushes instead of sending them.
- Node 22.13+ (`node:sqlite`). Node 22 logs a one-line SQLite `ExperimentalWarning` at startup.
- In the Claude Code cloud sandbox, add `NODE_USE_ENV_PROXY=1` so `fetch` uses the proxy.
- Tests: `node --test test/server.test.js test/apns.test.js` (part of `npm test`).
