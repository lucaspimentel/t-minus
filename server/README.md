# Push server (leave-time reminders)

A small Node service that sends the "Notify me" pushes. The app stays on GitHub Pages; this
service only takes reminders (`POST /reminders`), polls the MBTA for each ride, and pushes the
heads-up, "Leave now", or "Ride cancelled" (see `DESIGN.md`, Notifications).

## Railway setup

1. **Project:** in Railway, choose New Project → Deploy from GitHub repo →
   `lucaspimentel/mbta-leave-by`. Keep the root directory as the repo root.
   `railway.json` sets the build (`npm ci --prefix server`), the start command
   (`node server/main.mjs`), the health check (`/health`), and redeploys only when `server/`,
   `core.js` or `railway.json` change.
2. **Volume:** right-click the service → Attach volume, mounted at `/data`. Reminders are kept
   there in `reminders.json`.
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
   | `ALLOWED_ORIGINS` | `https://lucaspimentel.github.io` (the default; comma-separate more) |

   `PORT` is set by Railway.
5. **Always on:** in Settings, leave Serverless (app sleeping) **off**, so the 5-second loop
   keeps running. One replica is enough. Don't add more, because they would each send the
   pushes.
6. **Domain:** Settings → Networking → Generate Domain. Check `https://<domain>/health`, which
   should return `{"ok":true,"reminders":0}`. Then send the URL, and `PUSH_SERVER` in
   `index.html` gets set to it. "Notify me" appears once that version is live.

## Local run

```
npm --prefix server ci
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
  DRY_RUN=1 DATA_DIR=./server/data PORT=8790 ALLOWED_ORIGINS=http://localhost:8765 \
  node server/main.mjs
```

- `DRY_RUN=1` logs pushes instead of sending them.
- In the Claude Code cloud sandbox, add `NODE_USE_ENV_PROXY=1` so `fetch` uses the proxy.
- Tests: `node --test test/server.test.js` (part of `npm test`).
