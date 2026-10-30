// Minimal client for the "Instagram API with Instagram Login" (graph.instagram.com).
// Only uses fetch, so it runs on Cloudflare Workers, Node and browsers alike.

const GRAPH = 'https://graph.instagram.com';
const OAUTH_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

export const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
];

export class GraphError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GraphError';
    this.details = details;
  }
}

async function request(method, url, { token, query, body, form } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (form) {
    payload = new URLSearchParams(form);
  }

  const res = await fetch(u, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok || json.error) {
    const err = typeof json.error === 'object' ? json.error : {};
    const msg = err.error_user_msg || err.message || json.error_message || `HTTP ${res.status}`;
    throw new GraphError(msg, { status: res.status, ...err });
  }
  return json;
}

export class InstagramClient {
  constructor({ version = 'v23.0', appId, appSecret, redirectUri } = {}) {
    this.base = `${GRAPH}/${version}`;
    this.appId = appId;
    this.appSecret = appSecret;
    this.redirectUri = redirectUri;
  }

  // ---- OAuth (Instagram Login) ----
  authorizeUrl(state) {
    const u = new URL('https://www.instagram.com/oauth/authorize');
    u.searchParams.set('enable_fb_login', '0');
    u.searchParams.set('force_authentication', '1');
    u.searchParams.set('client_id', this.appId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(','));
    u.searchParams.set('state', state);
    return u.toString();
  }

  exchangeCode(code) {
    return request('POST', OAUTH_TOKEN_URL, {
      form: {
        client_id: this.appId,
        client_secret: this.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri,
        code,
      },
    });
  }

  // Short-lived (1 hour) token -> long-lived (60 day) token.
  exchangeForLongLived(shortToken) {
    return request('GET', `${GRAPH}/access_token`, {
      query: { grant_type: 'ig_exchange_token', client_secret: this.appSecret, access_token: shortToken },
    });
  }

  // Long-lived tokens that are at least 24h old can be refreshed for another 60 days.
  refreshLongLived(token) {
    return request('GET', `${GRAPH}/refresh_access_token`, {
      query: { grant_type: 'ig_refresh_token', access_token: token },
    });
  }

  // ---- Account ----
  // `user_id` is the Instagram professional account ID: it is the `entry.id` in
  // webhooks and the ID used in the /{IG_ID}/messages endpoint.
  getMe(token) {
    return request('GET', `${this.base}/me`, {
      token,
      query: { fields: 'user_id,username,name,profile_picture_url,account_type' },
    });
  }

  // Without this the app receives no webhooks for the account.
  subscribeToWebhooks(token) {
    return request('POST', `${this.base}/me/subscribed_apps`, {
      token,
      query: { subscribed_fields: 'comments,messages' },
    });
  }

  async listMedia(token, limit = 30) {
    const res = await request('GET', `${this.base}/me/media`, {
      token,
      query: {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp',
        limit,
      },
    });
    return res.data || [];
  }

  // Username of someone who messaged us (not included in message webhooks).
  async getUsername(token, igsid) {
    try {
      const res = await request('GET', `${this.base}/${igsid}`, { token, query: { fields: 'username' } });
      return res.username || null;
    } catch {
      return null;
    }
  }

  // ---- Messaging ----
  // recipient is { comment_id } for a private reply to a comment (allowed once per
  // comment, within 7 days), or { id: IGSID } for a DM inside the 24h window.
  async sendMessage(token, igUserId, recipient, dm) {
    const send = (message) =>
      request('POST', `${this.base}/${igUserId}/messages`, { token, body: { recipient, message } });
    try {
      return await send(buildMessage(dm));
    } catch (err) {
      // If the button template is rejected, fall back to plain text with the link
      // inline so the person still gets what they asked for.
      if (dm.buttonTitle && dm.buttonUrl) return send({ text: `${dm.text}\n\n${dm.buttonUrl}` });
      throw err;
    }
  }

  replyToComment(token, commentId, message) {
    return request('POST', `${this.base}/${commentId}/replies`, { token, query: { message } });
  }
}

export function buildMessage({ text, buttonTitle, buttonUrl }) {
  if (buttonTitle && buttonUrl) {
    return {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text,
          buttons: [{ type: 'web_url', url: buttonUrl, title: buttonTitle }],
        },
      },
    };
  }
  return { text };
}
