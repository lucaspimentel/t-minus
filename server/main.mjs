// Railway entry point: env, web-push, the SQLite store, the app's files (the repo root), and the 5 s loop.
import { createServer } from 'node:http';
import webpush from 'web-push';
import { createApp } from './app.mjs';
import { openStore } from './store.mjs';

const env = process.env;
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
  if (!env[k]) throw new Error(`${k} is not set`);
}
webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

const log = msg => console.log(new Date().toISOString(), msg);
const send = env.DRY_RUN
  ? async (sub, payload) => log(`DRY_RUN push: ${JSON.stringify(payload)}`)
  : (sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' });

const app = createApp({
  fetch,
  send,
  store: openStore(env.DATA_DIR ?? './data'),
  apiKey: env.MBTA_API_KEY,
  publicKey: env.VAPID_PUBLIC_KEY,
  staticRoot: new URL('..', import.meta.url).pathname,
  proxy: env.MBTA_PROXY !== 'off',
  log,
});
const port = Number(env.PORT ?? 8080);
createServer(app.handler).listen(port, () => log(`listening on ${port}`));
setInterval(() => app.tick().catch(e => log(`tick: ${e.stack}`)), 5000);
