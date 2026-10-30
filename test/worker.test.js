import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1, mockFetch, sign, makeCtx } from './helpers.js';

const SECRET = 'app-secret';
const IG_ID = '17841400000000001';
const ORIGIN = 'https://manyspace.example.workers.dev';

let env, ctx, mock, cookie;

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] ??= 'application/json';
  }
  const res = await worker.fetch(new Request(ORIGIN + path, init), env, ctx);
  await ctx.done();
  return res;
}

async function sendWebhook(payload, secret = SECRET) {
  const raw = JSON.stringify(payload);
  return call('/webhook', { method: 'POST', body: raw, headers: { 'X-Hub-Signature-256': sign(secret, raw) } });
}

function commentEvent({ id = 'c1', text = 'LINK please', fromId = '999', username = 'fan', mediaId = 'm1' } = {}) {
  return {
    object: 'instagram',
    entry: [{ id: IG_ID, time: 1, changes: [{ field: 'comments', value: { id, text, from: { id: fromId, username }, media: { id: mediaId } } }] }],
  };
}

const sends = () => mock.calls.filter((c) => c.method === 'POST' && c.path === `/${IG_ID}/messages`);

beforeEach(async () => {
  env = {
    DB: createD1(),
    IG_APP_ID: '123',
    IG_APP_SECRET: SECRET,
    WEBHOOK_VERIFY_TOKEN: 'verify-me',
    ADMIN_PASSWORD: 'hunter2',
  };
  ctx = makeCtx();
  cookie = null;
  mock = mockFetch({
    'GET /me': () => ({ user_id: IG_ID, username: 'creator', id: 'app-scoped' }),
    'POST /me/subscribed_apps': () => ({ success: true }),
    [`POST /${IG_ID}/messages`]: () => ({ recipient_id: '999', message_id: 'mid.1' }),
    'POST *': (c) => {
      if (/^\/[\w]+\/replies$/.test(c.path)) return { id: 'reply1' };
      throw new Error('unexpected');
    },
  });

  const login = await call('/api/login', { method: 'POST', body: { password: 'hunter2' } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('Set-Cookie').split(';')[0];
  const connect = await call('/api/account/token', { method: 'POST', body: { token: 'IGAAtoken' } });
  assert.equal(connect.status, 200);
  mock.calls.length = 0;
});

afterEach(() => mock.restore());

test('webhook verification handshake', async () => {
  const ok = await call('/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '42');
  const bad = await call('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42');
  assert.equal(bad.status, 403);
});

test('rejects webhooks with a bad signature', async () => {
  const res = await sendWebhook(commentEvent(), 'wrong-secret');
  assert.equal(res.status, 401);
});

test('dashboard API requires login', async () => {
  cookie = null;
  assert.equal((await call('/api/automations')).status, 401);
  const wrong = await call('/api/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
});

test('comment with keyword triggers a private-reply DM and public reply', async () => {
  const created = await call('/api/automations', {
    method: 'POST',
    body: {
      name: 'Guide',
      keywords: ['link'],
      dmText: 'Here is the link!',
      buttonTitle: 'Open',
      buttonUrl: 'https://example.com/guide',
      publicReplies: ['Check your DMs!'],
    },
  });
  assert.equal(created.status, 201);

  assert.equal((await sendWebhook(commentEvent())).status, 200);
  assert.equal(sends().length, 1);
  const msg = sends()[0];
  assert.deepEqual(msg.body.recipient, { comment_id: 'c1' });
  assert.equal(msg.body.message.attachment.payload.buttons[0].url, 'https://example.com/guide');
  assert.equal(msg.headers.Authorization, 'Bearer IGAAtoken');

  const reply = mock.calls.find((c) => c.path === '/c1/replies');
  assert.equal(reply.url.searchParams.get('message'), 'Check your DMs!');

  const [auto] = await (await call('/api/automations')).json();
  assert.deepEqual(auto.stats, { triggered: 1, sent: 1, failed: 0 });
  const contacts = await (await call('/api/contacts')).json();
  assert.equal(contacts[0].username, 'fan');
});

test('duplicate deliveries, own comments and non-matching comments send nothing', async () => {
  await call('/api/automations', { method: 'POST', body: { name: 'A', keywords: ['link'], dmText: 'hi' } });
  await sendWebhook(commentEvent());
  await sendWebhook(commentEvent()); // Meta retry
  await sendWebhook(commentEvent({ id: 'c2', fromId: IG_ID })); // our own reply
  await sendWebhook(commentEvent({ id: 'c3', text: 'nice video' }));
  assert.equal(sends().length, 1);
  const activity = await (await call('/api/activity')).json();
  assert.ok(activity.some((a) => a.status === 'ignored' && a.text === 'nice video'));
});

test('"once per person" sends only the first time', async () => {
  await call('/api/automations', { method: 'POST', body: { name: 'A', keywords: ['link'], dmText: 'hi', oncePerUser: true } });
  await sendWebhook(commentEvent({ id: 'c1' }));
  await sendWebhook(commentEvent({ id: 'c2' }));
  await sendWebhook(commentEvent({ id: 'c3', fromId: '555', username: 'other' }));
  assert.equal(sends().length, 2);
});

test('falls back to plain text when the button template is rejected', async () => {
  mock.restore();
  let attempt = 0;
  mock = mockFetch({
    [`POST /${IG_ID}/messages`]: (c) => {
      attempt++;
      if (c.body.message.attachment) throw Object.assign(new Error('template not supported'), { status: 400 });
      return { message_id: 'mid.2' };
    },
  });
  await call('/api/automations', {
    method: 'POST',
    body: { name: 'A', keywords: ['link'], dmText: 'hi', buttonTitle: 'Go', buttonUrl: 'https://x.com' },
  });
  await sendWebhook(commentEvent());
  assert.equal(attempt, 2);
  assert.equal(mock.calls.at(-1).body.message.text, 'hi\n\nhttps://x.com');
});

test('failed sends are logged and counted', async () => {
  mock.restore();
  mock = mockFetch({
    [`POST /${IG_ID}/messages`]: () => {
      throw Object.assign(new Error(), { status: 400, body: { error: { message: 'User cannot be messaged' } } });
    },
  });
  await call('/api/automations', { method: 'POST', body: { name: 'A', keywords: ['link'], dmText: 'hi', oncePerUser: true } });
  await sendWebhook(commentEvent());
  const [auto] = await (await call('/api/automations')).json();
  assert.equal(auto.stats.failed, 1);
  const activity = await (await call('/api/activity')).json();
  assert.match(activity[0].detail, /User cannot be messaged/);
  // A failed send must not count as "already sent" for once-per-person.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sends').get().n, 0);
});

test('DM keyword automations reply to direct messages', async () => {
  mock.restore();
  mock = mockFetch({
    'GET /777': () => ({ username: 'dmfan' }),
    [`POST /${IG_ID}/messages`]: () => ({ message_id: 'mid.3' }),
  });
  await call('/api/automations', { method: 'POST', body: { name: 'DM', triggerType: 'dm', keywords: ['price'], dmText: 'It is $10' } });
  const event = (mid, extra = {}) => ({
    object: 'instagram',
    entry: [{ id: IG_ID, messaging: [{ sender: { id: '777' }, recipient: { id: IG_ID }, timestamp: 1, message: { mid, text: 'what is the PRICE?', ...extra } }] }],
  });
  await sendWebhook(event('m1'));
  await sendWebhook(event('m2', { is_echo: true }));
  assert.equal(sends().length, 1);
  assert.deepEqual(sends()[0].body.recipient, { id: '777' });
  const contacts = await (await call('/api/contacts')).json();
  assert.equal(contacts[0].username, 'dmfan');
});

test('daily maintenance refreshes an old token', async () => {
  env.DB.raw.prepare('UPDATE account SET token_refreshed_at = ?').run(Date.now() - 8 * 86400000);
  mock.restore();
  mock = mockFetch({ 'GET /refresh_access_token': () => ({ access_token: 'NEWTOKEN', expires_in: 5184000 }) });
  await worker.scheduled({}, env, ctx);
  await ctx.done();
  assert.equal(env.DB.raw.prepare('SELECT access_token FROM account').get().access_token, 'NEWTOKEN');
});
