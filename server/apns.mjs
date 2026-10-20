// APNs, for the iOS app's pushes: one HTTP/2 session to Apple (reopened when it closes) and a
// provider token (an ES256 JWT signed with the .p8 key) reused for 50 min. Built-in modules only.
// A dead device token (410 Unregistered, 400 BadDeviceToken / DeviceTokenNotForTopic) throws with
// statusCode 410, like a Web Push subscription that is gone. Live Activity pushes
// (`apns-push-type: liveactivity`) go to the `<topic>.push-type.liveactivity` topic.
import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const TOKEN_TTL = 50 * 60_000; // Apple accepts a token for 60 min
const TIMEOUT_MS = 10_000;
const GONE = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

// send(deviceToken, { headers, body }) → Promise (apnsPush in app.mjs builds the second argument).
// A connection idle for IDLE_MS is replaced before use: a middlebox can drop an idle connection
// without telling either end (2026-10-19: a push 10 min after the last one hung until the 10-s
// timeout). A push that times out, or whose stream closes without an answer, drops the connection
// and is tried once more on a new one; every send settles (it never hangs the server's loop).
export const IDLE_MS = 4 * 60_000;
export function apnsClient({ key, keyId, teamId, topic, host = APNS_HOSTS.production, ttlSeconds = 600, now = Date.now, connectTo = connect, timeoutMs = TIMEOUT_MS }) {
  const privateKey = createPrivateKey(key);
  let token = null; // { jwt, at }
  let session = null;
  let usedAt = 0;

  function providerToken(t) {
    if (token && t - token.at < TOKEN_TTL) return token.jwt;
    const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: Math.floor(t / 1000) })}`;
    const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    token = { jwt: `${input}.${sig}`, at: t };
    return token.jwt;
  }

  function dropSession() {
    const s = session;
    session = null;
    s?.destroy();
  }

  function open(t) {
    if (session && (session.closed || session.destroyed || t - usedAt > IDLE_MS)) dropSession();
    if (session) return session;
    const s = connectTo(host);
    const drop = () => { if (session === s) session = null; };
    s.on('error', drop);
    s.on('goaway', drop);
    s.on('close', drop);
    s.unref?.();
    session = s;
    return s;
  }

  // One try; rejects with `retry: true` when the connection, not Apple, failed.
  function attempt(deviceToken, { headers, body }) {
    const t = now();
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (f, v) => { if (!done) { done = true; f(v); } };
      const lost = msg => { dropSession(); settle(reject, Object.assign(new Error(msg), { retry: true })); };
      let req;
      try {
        req = open(t).request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`, authorization: `bearer ${providerToken(t)}`,
          'apns-topic': headers['apns-push-type'] === 'liveactivity' ? `${topic}.push-type.liveactivity` : topic, 'apns-expiration': String(Math.floor(t / 1000) + ttlSeconds), 'content-type': 'application/json', ...headers,
        });
        usedAt = t;
      } catch (e) { return lost(`APNs connection failed: ${e.message}`); }
      let status = 0;
      const chunks = [];
      req.setTimeout(timeoutMs, () => { req.close(); lost('APNs timeout'); });
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => chunks.push(c));
      req.on('error', e => (status ? settle(reject, e) : lost(`APNs stream error: ${e.message}`)));
      req.on('close', () => { if (!status) lost('APNs stream closed without an answer'); });
      req.on('end', () => {
        if (!status) return lost('APNs stream closed without an answer');
        if (status === 200) return settle(resolve);
        let reason = '';
        try { reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason ?? ''; } catch {}
        if (reason === 'ExpiredProviderToken') token = null;
        settle(reject, Object.assign(new Error(`APNs ${status} ${reason}`.trim()), { statusCode: status === 410 || GONE.has(reason) ? 410 : status, reason }));
      });
      req.end(JSON.stringify(body));
    });
  }

  return async function send(deviceToken, push) {
    try {
      return await attempt(deviceToken, push);
    } catch (e) {
      if (!e.retry) throw e;
      return attempt(deviceToken, push);
    }
  };
}
