// Railway entry point: env, web-push, APNs, the SQLite store, the app's files (the repo root), and the 5 s loop.
import { createServer } from 'node:http';
import webpush from 'web-push';
import { createApp, APNS_PREFIX } from './app.mjs';
import { apnsClient, APNS_HOSTS } from './apns.mjs';
import { openStore } from './store.mjs';

const env = process.env;
for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
  if (!env[k]) throw new Error(`${k} is not set`);
}
webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

// APNs (the iOS app), optional: all of APNS_KEY (the .p8 file's contents), APNS_KEY_ID,
// APNS_TEAM_ID and APNS_TOPIC (the bundle ID); APNS_HOST is production (default, also when empty)
// or sandbox. A bad setting logs and leaves APNs off instead of stopping the server.
let apns = null;
if (env.APNS_KEY) {
  try {
    for (const k of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) {
      if (!env[k]) throw new Error(`${k} is not set`);
    }
    const hostName = (env.APNS_HOST || 'production').trim().toLowerCase();
    const host = APNS_HOSTS[hostName];
    if (!host) throw new Error(`APNS_HOST must be production or sandbox, not ${JSON.stringify(env.APNS_HOST)}`);
    apns = apnsClient({ key: env.APNS_KEY.replace(/\\n/g, '\n'), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC, host });
    console.log(`APNs on (${hostName})`);
  } catch (e) {
    console.error(`APNs off: ${e.message}`);
  }
}

const log = msg => console.log(new Date().toISOString(), msg);
const send = env.DRY_RUN
  ? async (sub, payload) => log(`DRY_RUN push: ${JSON.stringify(payload)}`)
  : async (sub, payload) => {
    if (sub.endpoint.startsWith(APNS_PREFIX)) {
      if (!apns) throw new Error('APNs is not configured');
      return apns(sub.endpoint.slice(APNS_PREFIX.length), payload);
    }
    return webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
  };

// Datadog RUM (optional): each app's ID and client token, both public; served at /api/config.
// A pair counts only when both values are set.
const rumPair = (id, token) => (env[id] && env[token] ? { applicationId: env[id], clientToken: env[token] } : null);
const rum = { web: rumPair('DD_RUM_APP_ID', 'DD_RUM_CLIENT_TOKEN'), ios: rumPair('DD_IOS_RUM_APP_ID', 'DD_IOS_RUM_CLIENT_TOKEN') };

const app = createApp({
  fetch,
  send,
  store: openStore(env.DATA_DIR ?? './data'),
  apiKey: env.MBTA_API_KEY,
  publicKey: env.VAPID_PUBLIC_KEY,
  publicUrl: env.PUBLIC_URL || undefined,
  staticRoot: new URL('..', import.meta.url).pathname,
  proxy: env.MBTA_PROXY !== 'off',
  rum,
  log,
});
const port = Number(env.PORT ?? 8080);
createServer(app.handler).listen(port, () => log(`listening on ${port}`));
setInterval(() => app.tick().catch(e => log(`tick: ${e.stack}`)), 5000);
