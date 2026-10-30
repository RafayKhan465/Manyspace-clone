// Turns Instagram webhook events into DMs according to the user's automations.
import { pickAutomation } from './matcher.js';

function truncate(s, n = 280) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export async function processWebhook(payload, { db, ig }) {
  if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return;
  const account = await db.getAccount();
  if (!account) {
    await db.log({ type: 'system', status: 'error', detail: 'Webhook received but no Instagram account is connected.' });
    return;
  }

  for (const entry of payload.entry) {
    if (entry.id && String(entry.id) !== String(account.igUserId)) {
      await db.log({
        type: 'system',
        status: 'skipped',
        detail: `Webhook for account ${entry.id}, but the connected account is ${account.igUserId}.`,
      });
      continue;
    }
    for (const change of entry.changes || []) {
      if (change.field === 'comments') await handleComment(change.value, { db, ig, account });
    }
    for (const event of entry.messaging || []) {
      if (event.message) await handleMessage(event, { db, ig, account });
    }
  }
}

async function handleComment(value, { db, ig, account }) {
  if (!value?.id) return;
  const from = value.from || {};
  // Our own public replies also come back as comment webhooks; never answer ourselves.
  if (String(from.id) === String(account.igUserId)) return;
  if (!(await db.claimEvent(`comment:${value.id}`))) return; // Meta retry / duplicate

  const event = { type: 'comment', text: value.text || '', mediaId: value.media?.id };
  const automation = pickAutomation(await db.listAutomations(), event);
  const who = { userId: from.id, username: from.username };

  if (!automation) {
    await db.log({ type: 'comment', status: 'ignored', ...who, text: truncate(event.text), detail: 'No automation matched.' });
    return;
  }

  await db.touchContact(from.id, from.username);
  await db.bumpStat(automation.id, 'triggered');

  const sent = await deliver(automation, { comment_id: value.id }, { db, ig, account, who, text: event.text });

  // Public reply ("Sent you a DM!") — only once we know the DM part is handled.
  if (sent && automation.publicReplies.length > 0) {
    try {
      await ig.replyToComment(account.accessToken, value.id, randomItem(automation.publicReplies));
    } catch (err) {
      await db.log({ type: 'reply', status: 'error', automationId: automation.id, ...who, detail: `Public reply failed: ${err.message}` });
    }
  }
}

async function handleMessage(event, { db, ig, account }) {
  const message = event.message;
  const senderId = event.sender?.id;
  if (!senderId || message.is_echo || String(senderId) === String(account.igUserId)) return;
  if (!message.mid || !(await db.claimEvent(`message:${message.mid}`))) return;

  const text = message.text || '';
  const automation = text ? pickAutomation(await db.listAutomations(), { type: 'dm', text }) : null;
  if (!automation) {
    await db.log({ type: 'dm', status: 'ignored', userId: senderId, text: truncate(text || '[attachment]'), detail: 'No automation matched.' });
    return;
  }

  const username = await ig.getUsername(account.accessToken, senderId);
  const who = { userId: senderId, username };
  await db.touchContact(senderId, username);
  await db.bumpStat(automation.id, 'triggered');
  await deliver(automation, { id: senderId }, { db, ig, account, who, text });
}

// Sends the automation's DM. Returns true if the DM was sent, or deliberately
// skipped because this person already received it.
async function deliver(automation, recipient, { db, ig, account, who, text }) {
  const type = recipient.comment_id ? 'comment' : 'dm';

  if (automation.oncePerUser && !(await db.claimSend(automation.id, who.userId))) {
    await db.log({
      type,
      status: 'skipped',
      automationId: automation.id,
      ...who,
      text: truncate(text),
      detail: 'Already sent this automation to this person.',
    });
    return false;
  }

  try {
    await ig.sendMessage(account.accessToken, account.igUserId, recipient, {
      text: automation.dmText,
      buttonTitle: automation.buttonTitle,
      buttonUrl: automation.buttonUrl,
    });
    await db.bumpStat(automation.id, 'sent');
    await db.log({ type, status: 'sent', automationId: automation.id, ...who, text: truncate(text), detail: `DM sent by "${automation.name}".` });
    return true;
  } catch (err) {
    if (automation.oncePerUser) await db.releaseSend(automation.id, who.userId);
    await db.bumpStat(automation.id, 'failed');
    await db.log({ type, status: 'error', automationId: automation.id, ...who, text: truncate(text), detail: `DM failed: ${err.message}` });
    return false;
  }
}

// Daily maintenance: keep the 60-day token alive and trim old data.
export async function maintenance({ db, ig }) {
  const account = await db.getAccount();
  if (account) {
    const age = Date.now() - (account.tokenRefreshedAt || account.connectedAt || 0);
    const expiresSoon = account.tokenExpiresAt && account.tokenExpiresAt - Date.now() < 30 * 86400000;
    if (age > 7 * 86400000 || expiresSoon) {
      try {
        const res = await ig.refreshLongLived(account.accessToken);
        await db.updateToken(res.access_token, Date.now() + (res.expires_in || 5184000) * 1000);
        await db.log({ type: 'system', status: 'ok', detail: 'Instagram access token refreshed.' });
      } catch (err) {
        await db.log({ type: 'system', status: 'error', detail: `Token refresh failed: ${err.message}. Reconnect Instagram in the dashboard.` });
      }
    }
  }
  await db.prune();
}
