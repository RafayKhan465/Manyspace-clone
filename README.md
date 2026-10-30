# Manyspace

A free, self-hosted alternative to ManyChat's Instagram comment automation.

Say *"Comment **GUIDE** and I'll send you the link"* in a reel. When someone comments `guide`, they automatically get your DM (with an optional link button), and their comment can get a public "Sent you a DM 📩" reply.

It runs on **Cloudflare Workers (free plan)** and the official **Instagram API** through a free **Meta developer app**. There's no server to babysit and no monthly fee.

## Features

- **Comment → DM**: keyword triggers on any post or reel, or only on the posts you pick
- **DM keyword → DM**: auto-answer DMs that contain a keyword (e.g. "price")
- Whole-word keyword matching that ignores case and accents (`link` matches "LINK pls!" but not "blinking"), emoji keywords, exact-match and catch-all modes
- DM with an optional **link button** (if Instagram rejects the button, it falls back to text with the link)
- Optional **public comment replies**, picked at random from a list you write
- **Send once per person** option
- Activity log, contacts list, per-automation stats, and a "Try it" box for testing keywords
- Webhook signature verification, de-duplication of Meta retries, and it never replies to your own comments
- Daily cron job that refreshes your 60-day Instagram token automatically

## How it works

```
Someone comments "guide" on your reel
        │
        ▼
Instagram ──webhook──▶ Cloudflare Worker (/webhook)
                         │  verifies signature, matches your automations
                         ├──▶ POST /{ig-id}/messages  { recipient: { comment_id } }   → DM ("private reply")
                         └──▶ POST /{comment-id}/replies                             → public reply (optional)
```

The DM is sent as an Instagram **private reply** to the comment. That's the same mechanism ManyChat uses, and it works even if the person has never messaged you.

---

## Setup (about 30 minutes, one time)

You need:
- An Instagram **Business** or **Creator** account (Instagram app → Settings → Account type and tools → Switch to professional account)
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A free [Meta for Developers](https://developers.facebook.com/) account
- Node.js 22+ on your computer

### 1. Deploy to Cloudflare

```bash
git clone <this repo> && cd Manyspace-clone
npm install
npx wrangler login
npx wrangler d1 create manyspace
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```bash
npm run db:init                                 # creates the tables
npx wrangler secret put ADMIN_PASSWORD          # dashboard password (make it strong)
npx wrangler secret put WEBHOOK_VERIFY_TOKEN    # any random string, e.g. from: openssl rand -hex 16
npm run deploy
```

You'll get a URL like `https://manyspace.<your-subdomain>.workers.dev`. Open it and log in. The **Setup** tab lists every URL you need in the next step.

### 2. Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app**. Choose the use case **"Manage messaging & content on Instagram"** and app type **Business** if asked.
2. In the app, open **Instagram → API setup with Instagram login**.
3. Copy the **Instagram app ID** into `IG_APP_ID` in `wrangler.toml`, then save the **Instagram app secret**:
   ```bash
   npx wrangler secret put IG_APP_SECRET
   npm run deploy
   ```
4. **Generate access tokens** → **Add account** → log in with your Instagram account. This gives your account a role on the app.
5. **Configure webhooks**:
   - Callback URL: `https://<your-worker>/webhook`
   - Verify token: the same value you set for `WEBHOOK_VERIFY_TOKEN`
   - Click **Verify and save**, then subscribe to the **`comments`** and **`messages`** fields.
6. **Set up Instagram business login** → add the redirect URL `https://<your-worker>/auth/instagram/callback`.
7. **App settings → Basic**: set the **Privacy policy URL** and **User data deletion** URL to `https://<your-worker>/privacy` (the Worker serves this page), then save.
8. Switch the app from **Development** to **Live** using the toggle at the top of the dashboard. Meta only sends comment webhooks to apps that are Live.

### 3. Connect Instagram

In your dashboard → **Setup** → **Connect with Instagram**. Approve all the permissions. The app then saves a long-lived token and subscribes your account to webhooks automatically.

(Or click **Generate token** next to your account in the Meta dashboard and paste it into the "paste an access token" box.)

On your phone: Instagram → **Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages** must be **on**, or DMs can't be sent.

### 4. Create an automation and test it

**Automations → New automation**: keyword `guide`, write your DM, optionally add a button such as "Get the guide" → `https://…`.

Then **comment from a different Instagram account** (comments from your own account are ignored on purpose) and check the **Activity** tab.

---

## Instagram's rules (applies to ManyChat too)

- One private-reply DM per comment, sent within 7 days of the comment. Instagram doesn't allow follow-up DMs unless the person writes back, which opens a 24-hour window.
- If the person doesn't follow you, the DM lands in their **message requests**.
- Comments from your own account never trigger anything. That stops your public replies from looping.
- Keep DM text under 1,000 characters (640 if you add a button). Button labels can be up to 20 characters.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing appears in **Activity** when someone comments | The app must be **Live**, the webhook must be subscribed to `comments`, and you can click **Re-subscribe webhooks** in Setup. Test with a comment from another account. |
| Activity says "No automation matched" | The keyword wasn't in the comment, or the automation is tied to a different post. Try the text in the **Try it** box. |
| `DM failed: … Allow access to messages` or similar | Turn on **Connected tools → Allow access to messages** in the Instagram app. |
| `DM failed: … permission` | Reconnect Instagram and approve every permission it asks for. |
| Comments from your own test accounts work, but strangers' comments never show up | Your app may need **Advanced Access** for `instagram_business_manage_comments` and `instagram_business_manage_messages`. Request it under **App Review** in the Meta dashboard. |
| "Token refresh failed" in Activity | Click **Reconnect** in Setup. |

You can watch live Worker logs with `npx wrangler tail`.

## Development

```bash
cp .dev.vars.example .dev.vars    # local secrets
npm run db:init:local
npm run dev                       # http://localhost:8787
npm test                          # unit + end-to-end tests (mocked Instagram API)
```

Meta can't reach `localhost`, so test real webhooks on the deployed Worker.

## Project layout

```
src/index.js       Worker: routing, webhook endpoint, dashboard API, OAuth, cron
src/engine.js      Turns webhook events into DMs / replies
src/matcher.js     Keyword matching + automation validation
src/instagram.js   Instagram Graph API client
src/db.js          D1 (SQLite) data access
src/security.js    Webhook signature + session cookies (Web Crypto)
public/            Dashboard (plain HTML/CSS/JS) and privacy page
migrations/        D1 schema
test/              node:test suite
```

## Cost

$0. Cloudflare's free plan includes 100,000 Worker requests a day and 5 GB of D1 storage, far more than a creator account needs. The Meta developer account and the Instagram API are free.
