// Cloudflare Worker entry point: webhook receiver, dashboard API, OAuth, daily cron.
import { Database } from './db.js';
import { InstagramClient } from './instagram.js';
import { processWebhook, maintenance } from './engine.js';
import { pickAutomation, validateAutomation } from './matcher.js';
import { verifyWebhookSignature, safeEqual, signToken, verifyToken, parseCookies, cookie, hmacHex } from './security.js';

const SESSION_COOKIE = 'ms_session';
const OAUTH_COOKIE = 'ms_oauth';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 10; // per 15 minutes

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

function context(env, request) {
  const origin = new URL(request?.url || 'https://localhost').origin;
  return {
    db: new Database(env.DB),
    ig: new InstagramClient({
      version: env.GRAPH_API_VERSION || 'v23.0',
      appId: env.IG_APP_ID,
      appSecret: env.IG_APP_SECRET,
      redirectUri: `${origin}/auth/instagram/callback`,
    }),
    origin,
    secure: origin.startsWith('https://'),
  };
}

async function sessionSecret(env) {
  // Derived from the password if not set explicitly, so changing the password logs everyone out.
  return env.SESSION_SECRET || hmacHex('manyspace-session', `${env.ADMIN_PASSWORD}:${env.IG_APP_SECRET || ''}`);
}

async function isLoggedIn(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  return verifyToken(await sessionSecret(env), token, 'admin');
}

export function configProblems(env) {
  const problems = [];
  if (!env.IG_APP_SECRET) problems.push('IG_APP_SECRET is not set. Webhooks will be rejected because their signatures cannot be verified.');
  if (!env.WEBHOOK_VERIFY_TOKEN) problems.push('WEBHOOK_VERIFY_TOKEN is not set. Meta cannot verify your webhook URL.');
  if (!env.IG_APP_ID) problems.push('IG_APP_ID is not set. The "Connect with Instagram" button will not work (pasting a token still does).');
  return problems;
}

function publicAccount(account) {
  if (!account) return null;
  const { accessToken, ...rest } = account;
  return { ...rest, tokenPreview: `${accessToken.slice(0, 6)}…${accessToken.slice(-4)}` };
}

// Saves an account from a long-lived token and subscribes it to webhooks.
async function connectWithToken({ db, ig }, token, expiresIn) {
  const me = await ig.getMe(token);
  if (!me.user_id) throw new Error('Token is valid but Instagram did not return a professional account ID.');
  const now = Date.now();
  await db.saveAccount({
    igUserId: String(me.user_id),
    username: me.username,
    name: me.name,
    profilePictureUrl: me.profile_picture_url,
    accessToken: token,
    tokenExpiresAt: now + (expiresIn || 5184000) * 1000,
    tokenRefreshedAt: now,
    connectedAt: now,
  });
  let subscribeError = null;
  try {
    await ig.subscribeToWebhooks(token);
  } catch (err) {
    subscribeError = err.message;
  }
  await db.log({
    type: 'system',
    status: subscribeError ? 'error' : 'ok',
    detail: subscribeError
      ? `Connected @${me.username}, but subscribing to webhooks failed: ${subscribeError}`
      : `Connected @${me.username} and subscribed to comment & message webhooks.`,
  });
  return { username: me.username, subscribeError };
}

// ---------------- route handlers ----------------

async function handleWebhookVerify(url, env) {
  const p = url.searchParams;
  if (p.get('hub.mode') === 'subscribe' && env.WEBHOOK_VERIFY_TOKEN && (await safeEqual(p.get('hub.verify_token'), env.WEBHOOK_VERIFY_TOKEN))) {
    return new Response(p.get('hub.challenge') || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

async function handleWebhookEvent(request, env, ctx, c) {
  const raw = await request.text();
  if (!(await verifyWebhookSignature(env.IG_APP_SECRET, raw, request.headers.get('X-Hub-Signature-256')))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  // Acknowledge immediately (Meta expects a fast 200) and do the work in the background.
  ctx.waitUntil(
    processWebhook(payload, c).catch((err) =>
      c.db.log({ type: 'system', status: 'error', detail: `Webhook processing crashed: ${err.message}` }).catch(() => {}),
    ),
  );
  return new Response('EVENT_RECEIVED', { status: 200 });
}

async function handleLogin(request, env, c) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'Set the ADMIN_PASSWORD secret first (npx wrangler secret put ADMIN_PASSWORD).' }, 503);
  const recentFailures = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE type = 'login' AND status = 'error' AND ts > ?")
    .bind(Date.now() - 15 * 60 * 1000)
    .first();
  if (recentFailures.n >= MAX_FAILED_LOGINS) return json({ error: 'Too many failed attempts. Try again in 15 minutes.' }, 429);

  const body = await request.json().catch(() => ({}));
  if (!(await safeEqual(body.password || '', env.ADMIN_PASSWORD))) {
    await c.db.log({ type: 'login', status: 'error', detail: 'Failed dashboard login.' });
    return json({ error: 'Wrong password.' }, 401);
  }
  const token = await signToken(await sessionSecret(env), 'admin', SESSION_TTL);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL / 1000, secure: c.secure }) });
}

async function handleApi(request, env, url, c) {
  const { db, ig } = c;
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/login' && method === 'POST') return handleLogin(request, env, c);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', { maxAge: 0, secure: c.secure }) });
  }

  const loggedIn = await isLoggedIn(request, env);
  if (path === '/api/status' && method === 'GET') {
    if (!loggedIn) return json({ authenticated: false, passwordSet: Boolean(env.ADMIN_PASSWORD) });
    return json({
      authenticated: true,
      account: publicAccount(await db.getAccount()),
      problems: configProblems(env),
      webhookUrl: `${c.origin}/webhook`,
      redirectUri: `${c.origin}/auth/instagram/callback`,
      privacyUrl: `${c.origin}/privacy`,
      oauthAvailable: Boolean(env.IG_APP_ID && env.IG_APP_SECRET),
      counts: await db.counts(),
    });
  }
  if (!loggedIn) return json({ error: 'Not logged in.' }, 401);

  // Mutations must be JSON: a cross-site <form> cannot send that, so this blocks CSRF.
  if (method !== 'GET' && !String(request.headers.get('Content-Type')).includes('application/json')) {
    return json({ error: 'Expected JSON.' }, 415);
  }
  const body = method === 'GET' ? {} : await request.json().catch(() => ({}));

  // ---- automations ----
  if (path === '/api/automations' && method === 'GET') return json(await db.listAutomations());
  if (path === '/api/automations' && method === 'POST') {
    const { automation, errors } = validateAutomation(body);
    if (errors.length) return json({ error: errors.join(' ') }, 400);
    return json(await db.createAutomation(automation), 201);
  }
  const autoMatch = path.match(/^\/api\/automations\/([\w-]+)$/);
  if (autoMatch) {
    const id = autoMatch[1];
    if (method === 'PUT') {
      const { automation, errors } = validateAutomation(body);
      if (errors.length) return json({ error: errors.join(' ') }, 400);
      const updated = await db.updateAutomation(id, automation);
      return updated ? json(updated) : json({ error: 'Not found.' }, 404);
    }
    if (method === 'DELETE') return (await db.deleteAutomation(id)) ? json({ ok: true }) : json({ error: 'Not found.' }, 404);
  }

  // Dry run: which automation would fire for this comment?
  if (path === '/api/test' && method === 'POST') {
    const event = { type: body.type === 'dm' ? 'dm' : 'comment', text: String(body.text || ''), mediaId: body.mediaId || undefined };
    const automation = pickAutomation(await db.listAutomations(), event);
    return json({ automation });
  }

  // ---- account ----
  if (path === '/api/account' && method === 'DELETE') {
    await db.deleteAccount();
    await db.log({ type: 'system', status: 'ok', detail: 'Instagram account disconnected.' });
    return json({ ok: true });
  }
  if (path === '/api/account/token' && method === 'POST') {
    const token = String(body.token || '').trim();
    if (!token) return json({ error: 'Paste an access token.' }, 400);
    try {
      return json(await connectWithToken(c, token));
    } catch (err) {
      return json({ error: `Instagram rejected that token: ${err.message}` }, 400);
    }
  }
  const account = await db.getAccount();
  if (path.startsWith('/api/account/') || path === '/api/media') {
    if (!account) return json({ error: 'Connect your Instagram account first.' }, 409);
  }
  if (path === '/api/account/resubscribe' && method === 'POST') {
    try {
      await ig.subscribeToWebhooks(account.accessToken);
      await db.log({ type: 'system', status: 'ok', detail: 'Re-subscribed to comment & message webhooks.' });
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (path === '/api/account/refresh' && method === 'POST') {
    try {
      const res = await ig.refreshLongLived(account.accessToken);
      await db.updateToken(res.access_token, Date.now() + (res.expires_in || 5184000) * 1000);
      await db.log({ type: 'system', status: 'ok', detail: 'Instagram access token refreshed.' });
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 502);
    }
  }
  if (path === '/api/media' && method === 'GET') {
    try {
      return json(await ig.listMedia(account.accessToken, 50));
    } catch (err) {
      return json({ error: `Could not load your posts: ${err.message}` }, 502);
    }
  }

  // ---- activity & contacts ----
  if (path === '/api/activity' && method === 'GET') return json(await db.listActivity(300));
  if (path === '/api/contacts' && method === 'GET') return json(await db.listContacts());

  return json({ error: 'Not found.' }, 404);
}

async function handleOAuthStart(request, env, c) {
  if (!(await isLoggedIn(request, env))) return redirect('/');
  if (!env.IG_APP_ID || !env.IG_APP_SECRET) return redirect('/?error=' + encodeURIComponent('Set IG_APP_ID and IG_APP_SECRET first.'));
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const state = await signToken(await sessionSecret(env), nonce, 10 * 60 * 1000);
  return redirect(c.ig.authorizeUrl(nonce), { 'Set-Cookie': cookie(OAUTH_COOKIE, state, { maxAge: 600, secure: c.secure }) });
}

async function handleOAuthCallback(request, env, url, c) {
  const clear = { 'Set-Cookie': cookie(OAUTH_COOKIE, '', { maxAge: 0, secure: c.secure }) };
  const fail = (msg) => redirect('/?error=' + encodeURIComponent(msg), clear);
  if (!(await isLoggedIn(request, env))) return fail('Log in to the dashboard first.');
  if (url.searchParams.get('error')) return fail(url.searchParams.get('error_description') || 'Instagram login was cancelled.');

  const stateCookie = parseCookies(request.headers.get('Cookie'))[OAUTH_COOKIE];
  const nonce = url.searchParams.get('state') || '';
  if (!(await verifyToken(await sessionSecret(env), stateCookie, nonce))) return fail('Login expired or was tampered with. Try again.');

  // Instagram sometimes appends "#_" to the code.
  const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
  try {
    const short = await c.ig.exchangeCode(code);
    const long = await c.ig.exchangeForLongLived(short.access_token);
    const result = await connectWithToken(c, long.access_token, long.expires_in);
    const msg = result.subscribeError ? `Connected, but webhook subscription failed: ${result.subscribeError}` : '';
    return redirect(msg ? '/?error=' + encodeURIComponent(msg) : '/?connected=1', clear);
  } catch (err) {
    return fail(`Instagram login failed: ${err.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const c = context(env, request);
    try {
      if (url.pathname === '/webhook') {
        if (request.method === 'GET') return handleWebhookVerify(url, env);
        if (request.method === 'POST') return handleWebhookEvent(request, env, ctx, c);
        return new Response('Method not allowed', { status: 405 });
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, url, c);
      if (url.pathname === '/auth/instagram') return handleOAuthStart(request, env, c);
      if (url.pathname === '/auth/instagram/callback') return handleOAuthCallback(request, env, url, c);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: `Server error: ${err.message}` }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(maintenance(context(env)));
  },
};
