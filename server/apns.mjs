// APNs, for the iOS app's pushes: one HTTP/2 session to Apple (reopened when it closes) and a
// provider token (an ES256 JWT signed with the .p8 key) reused for 50 min. Built-in modules only.
// A dead device token (410 Unregistered, 400 BadDeviceToken / DeviceTokenNotForTopic) throws with
// statusCode 410, like a Web Push subscription that is gone.
import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

export const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const TOKEN_TTL = 50 * 60_000; // Apple accepts a token for 60 min
const TIMEOUT_MS = 10_000;
const GONE = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

// send(deviceToken, { headers, body }) → Promise (apnsPush in app.mjs builds the second argument).
export function apnsClient({ key, keyId, teamId, topic, host = APNS_HOSTS.production, ttlSeconds = 600, now = Date.now, connectTo = connect }) {
  const privateKey = createPrivateKey(key);
  let token = null; // { jwt, at }
  let session = null;

  function providerToken(t) {
    if (token && t - token.at < TOKEN_TTL) return token.jwt;
    const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: Math.floor(t / 1000) })}`;
    const sig = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    token = { jwt: `${input}.${sig}`, at: t };
    return token.jwt;
  }

  function open() {
    if (session && !session.closed && !session.destroyed) return session;
    const s = connectTo(host);
    const drop = () => { if (session === s) session = null; };
    s.on('error', drop);
    s.on('goaway', drop);
    s.on('close', drop);
    s.unref?.();
    session = s;
    return s;
  }

  return function send(deviceToken, { headers, body }) {
    const t = now();
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = open().request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`, authorization: `bearer ${providerToken(t)}`,
          'apns-topic': topic, 'apns-expiration': String(Math.floor(t / 1000) + ttlSeconds), 'content-type': 'application/json', ...headers,
        });
      } catch (e) { session = null; return reject(e); }
      let status = 0;
      const chunks = [];
      req.setTimeout(TIMEOUT_MS, () => { req.close(); reject(new Error('APNs timeout')); });
      req.on('response', h => { status = h[':status']; });
      req.on('data', c => chunks.push(c));
      req.on('error', reject);
      req.on('end', () => {
        if (status === 200) return resolve();
        let reason = '';
        try { reason = JSON.parse(Buffer.concat(chunks).toString('utf8')).reason ?? ''; } catch {}
        if (reason === 'ExpiredProviderToken') token = null;
        reject(Object.assign(new Error(`APNs ${status} ${reason}`.trim()), { statusCode: status === 410 || GONE.has(reason) ? 410 : status, reason }));
      });
      req.end(JSON.stringify(body));
    });
  };
}
