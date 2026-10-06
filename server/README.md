# Push server (leave-time reminders)

A small Node service that serves the app (an allowlist of its files from the repo root) and
its API under `/api/`. It takes reminders (`POST /api/reminders`), polls the MBTA for each ride,
and pushes the heads-up, "Leave now", or "Ride cancelled" (see `DESIGN.md`, Notifications and
Hosting). It also answers setup's "Show nearby" (`GET /api/nearby?lat&lon`: the routes around a
point with their distances).

## Railway setup

1. **Project:** in Railway, create a project with a service sourced from
   `lucaspimentel/mbta-leave-by`, branch `main` (repo root, so `server/` can import
   `../core.js`). The deploy config lives in the service's Railway settings, not the repo:
   build command `npm ci --prefix server`, start command `node server/main.mjs`, health check
   `/health`, watch paths `server/**`, `core.js`, `index.html`, `setup.js`, `sw.js`,
   `manifest.json` and `icons/**` (the server and the app's files).
2. **Volume:** right-click the service → Attach volume, mounted at `/data`. Reminders are kept
   there in `reminders.db` (SQLite). An old `reminders.json`
   from before the move can be deleted.
3. **VAPID keys:** run this once, anywhere with Node:
   ```
   npx web-push generate-vapid-keys
   ```
   Keep the private key secret. Changing the keys later invalidates existing subscriptions,
   which is harmless: the app subscribes again on the next "Notify me".
4. **Variables** (service → Variables):

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | from step 3 |
   | `VAPID_PRIVATE_KEY` | from step 3 |
   | `VAPID_SUBJECT` | `mailto:<your email>` |
   | `MBTA_API_KEY` | the key from 1Password (`op item get ai4cbcfsnlhcflmjczne6wipey --fields label=api-key --reveal`) |
   | `DATA_DIR` | `/data` |
   | `ALLOWED_ORIGINS` | `https://lucaspimentel.github.io` (the default; the old Pages copy, until phase 2) |

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
- Tests: `node --test test/server.test.js` (part of `npm test`).
