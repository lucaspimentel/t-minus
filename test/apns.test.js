// The APNs client (server/apns.mjs) against a local HTTP/2 server standing in for Apple.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import { apnsClient } from '../server/apns.mjs';
import { apnsPush, apnsActivityPush } from '../server/app.mjs';

const TOKEN = 'ab'.repeat(32);

// Apple: answers each request with world.reply(headers, body) → [status, reason?], records them.
async function fakeApple() {
  const world = { requests: [], sessions: [], reply: () => [200] };
  const server = createServer();
  server.on('session', x => world.sessions.push(x));
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      world.requests.push({ headers, body });
      const [status, reason] = world.reply(headers, body);
      stream.respond({ ':status': status, ...(reason && { 'content-type': 'application/json' }) });
      stream.end(reason ? JSON.stringify({ reason }) : undefined);
    });
  });
  await new Promise(r => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => { for (const x of world.sessions) x.destroy(); return new Promise(r => server.close(r)); };
  return { world, server, url, close };
}

function client(apple, clock) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const send = apnsClient({
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'KEY123', teamId: 'TEAM45', topic: 'net.lucasp.tminus',
    now: () => clock.t, connectTo: () => connect(apple.url),
  });
  return { send, publicKey };
}

const jwtParts = h => h.authorization.replace(/^bearer /, '').split('.');
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('APNs: path, topic, expiration, the push\'s headers and body, a valid ES256 provider token', async () => {
  const apple = await fakeApple();
  const clock = { t: Date.parse('2026-10-18T12:00:00Z') };
  const { send, publicKey } = client(apple, clock);
  try {
    await send(TOKEN, apnsPush({ kind: 'leave', title: 'Leave now', body: '132 at 7:10am', tag: 'o1', renotify: true }));
    const [{ headers, body }] = apple.world.requests;
    assert.equal(headers[':method'], 'POST');
    assert.equal(headers[':path'], `/3/device/${TOKEN}`);
    assert.equal(headers['apns-topic'], 'net.lucasp.tminus');
    assert.equal(headers['apns-expiration'], String(clock.t / 1000 + 600));
    assert.equal(headers['apns-push-type'], 'alert');
    assert.equal(headers['apns-priority'], '10');
    assert.equal(headers['apns-collapse-id'], 'o1');
    assert.deepEqual(body, { aps: { alert: { title: 'Leave now', body: '132 at 7:10am' }, 'interruption-level': 'time-sensitive', sound: 'default' }, kind: 'leave' });
    const [h, p, sig] = jwtParts(headers);
    assert.deepEqual(decode(h), { alg: 'ES256', kid: 'KEY123' });
    assert.deepEqual(decode(p), { iss: 'TEAM45', iat: clock.t / 1000 });
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  } finally { await apple.close(); }
});

test('APNs: a Live Activity push goes to the <bundle id>.push-type.liveactivity topic', async () => {
  const apple = await fakeApple();
  const clock = { t: Date.parse('2026-10-18T12:00:00Z') };
  const { send } = client(apple, clock);
  try {
    await send(TOKEN, apnsActivityPush({ event: 'update', state: { title: 'Orange · 4 stops' }, nowMs: clock.t }));
    const [{ headers, body }] = apple.world.requests;
    assert.equal(headers['apns-topic'], 'net.lucasp.tminus.push-type.liveactivity');
    assert.equal(headers['apns-push-type'], 'liveactivity');
    assert.equal(body.aps.event, 'update');
  } finally { await apple.close(); }
});

test('APNs: one session and token reused; the token renewed after 50 min or when Apple says it expired', async () => {
  const apple = await fakeApple();
  const clock = { t: Date.parse('2026-10-18T12:00:00Z') };
  const { send } = client(apple, clock);
  const push = apnsPush({ kind: 'test', title: 'T', body: 'B', tag: 'test' });
  const iat = i => decode(jwtParts(apple.world.requests[i].headers)[1]).iat;
  try {
    await send(TOKEN, push);
    clock.t += 49 * 60_000;
    await send(TOKEN, push);
    assert.equal(iat(1), iat(0));
    clock.t += 2 * 60_000;
    await send(TOKEN, push);
    assert.equal(iat(2), clock.t / 1000);
    assert.equal(apple.world.sessions.length, 1);
    // ExpiredProviderToken (e.g. a clock skew): fails, and the next send signs a new token.
    apple.world.reply = () => [403, 'ExpiredProviderToken'];
    clock.t += 60_000;
    await assert.rejects(send(TOKEN, push), e => e.statusCode === 403 && e.reason === 'ExpiredProviderToken');
    apple.world.reply = () => [200];
    clock.t += 1000;
    await send(TOKEN, push);
    assert.equal(iat(4), clock.t / 1000);
  } finally { await apple.close(); }
});

test('APNs: a dead token is a 410; other errors keep their status; a closed session is reopened', async () => {
  const apple = await fakeApple();
  const clock = { t: Date.parse('2026-10-18T12:00:00Z') };
  const { send } = client(apple, clock);
  const push = apnsPush({ kind: 'test', title: 'T', body: 'B', tag: 'test' });
  try {
    for (const [status, reason] of [[410, 'Unregistered'], [400, 'BadDeviceToken'], [400, 'DeviceTokenNotForTopic']]) {
      apple.world.reply = () => [status, reason];
      await assert.rejects(send(TOKEN, push), e => e.statusCode === 410 && e.reason === reason, reason);
    }
    apple.world.reply = () => [400, 'PayloadTooLarge'];
    await assert.rejects(send(TOKEN, push), e => e.statusCode === 400 && /PayloadTooLarge/.test(e.message));
    apple.world.reply = () => [503, 'ServiceUnavailable'];
    await assert.rejects(send(TOKEN, push), e => e.statusCode === 503);
    // Apple closes the connection (GOAWAY): the next send opens a new session.
    apple.world.reply = () => [200];
    assert.equal(apple.world.sessions.length, 1);
    apple.world.sessions[0].close();
    await new Promise(r => setTimeout(r, 50));
    await send(TOKEN, push);
    assert.equal(apple.world.sessions.length, 2);
  } finally { await apple.close(); }
});
