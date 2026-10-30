// Manyspace dashboard — plain JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  status: null,
  automations: [],
  media: null, // loaded lazily for the post picker
  editingId: null,
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Not logged in.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(message, kind = 'ok') {
  const el = $('#flash');
  el.textContent = message;
  el.className = `flash ${kind}`;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => el.classList.add('hidden'), 6000);
}

// ---------------- login ----------------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  showLogin();
});

// ---------------- tabs ----------------
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
  if (name === 'activity') loadActivity();
  if (name === 'contacts') loadContacts();
  if (name === 'setup') renderSetup();
  history.replaceState(null, '', `#${name}`);
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------------- status / header ----------------
async function loadStatus() {
  state.status = await api('/api/status');
  const { account, counts } = state.status;
  $('#account-chip').innerHTML = account
    ? `${account.profilePictureUrl ? `<img src="${esc(account.profilePictureUrl)}" alt="">` : ''}<span>@${esc(account.username)}</span>`
    : `<a href="#setup" class="warn-link">Not connected</a>`;
  $('#account-chip a')?.addEventListener('click', (e) => {
    e.preventDefault();
    showTab('setup');
  });
  $('#stats').innerHTML = [
    ['Active automations', counts.active],
    ['DMs sent', counts.sent],
    ['Failed', counts.failed],
    ['Contacts', counts.contacts],
  ]
    .map(([label, n]) => `<div class="stat card"><div class="stat-n">${Number(n || 0).toLocaleString()}</div><div class="muted">${label}</div></div>`)
    .join('');
}

// ---------------- automations ----------------
async function loadAutomations() {
  state.automations = await api('/api/automations');
  renderAutomations();
}

function describeTrigger(a) {
  const kws = a.keywords.map((k) => `<span class="pill">${esc(k)}</span>`).join(' ');
  const what = a.matchMode === 'any' ? 'anything' : a.matchMode === 'exact' ? `exactly ${kws}` : kws;
  if (a.triggerType === 'dm') return `DM containing ${what}`;
  const where = a.mediaIds.length ? `${a.mediaIds.length} selected post${a.mediaIds.length > 1 ? 's' : ''}` : 'any post';
  return `Comment on ${where} containing ${what}`;
}

function renderAutomations() {
  const list = $('#automation-list');
  if (!state.automations.length) {
    list.innerHTML = `<div class="card empty">
      <p><b>No automations yet.</b></p>
      <p class="muted">Create one: say "Comment <b>GUIDE</b> and I'll DM you the link" in your reel, then set the keyword to GUIDE here.</p>
    </div>`;
    return;
  }
  list.innerHTML = state.automations
    .map(
      (a) => `
    <div class="card automation ${a.enabled ? '' : 'disabled'}" data-id="${a.id}">
      <div class="automation-main">
        <div class="automation-title">
          <label class="switch" title="${a.enabled ? 'Active' : 'Paused'}">
            <input type="checkbox" data-action="toggle" ${a.enabled ? 'checked' : ''}><span></span>
          </label>
          <h3>${esc(a.name)}</h3>
        </div>
        <div class="muted trigger">${describeTrigger(a)}</div>
        <div class="dm-preview">${esc(a.dmText)}${a.buttonTitle ? `<div class="dm-button">${esc(a.buttonTitle)} ↗</div>` : ''}</div>
      </div>
      <div class="automation-side">
        <div class="mini-stats">
          <span><b>${a.stats.triggered}</b> triggered</span>
          <span><b>${a.stats.sent}</b> sent</span>
          <span class="${a.stats.failed ? 'bad' : ''}"><b>${a.stats.failed}</b> failed</span>
        </div>
        <div class="actions">
          <button class="btn small" data-action="edit">Edit</button>
          <button class="btn small ghost danger" data-action="delete">Delete</button>
        </div>
      </div>
    </div>`,
    )
    .join('');
}

$('#automation-list').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  const id = e.target.closest('.automation')?.dataset.id;
  if (!action || !id) return;
  const automation = state.automations.find((a) => a.id === id);
  try {
    if (action === 'edit') openEditor(automation);
    if (action === 'delete' && confirm(`Delete "${automation.name}"?`)) {
      await api(`/api/automations/${id}`, { method: 'DELETE', body: {} });
      await Promise.all([loadAutomations(), loadStatus()]);
    }
  } catch (err) {
    flash(err.message, 'error');
  }
});

$('#automation-list').addEventListener('change', async (e) => {
  if (e.target.dataset.action !== 'toggle') return;
  const id = e.target.closest('.automation').dataset.id;
  const automation = state.automations.find((a) => a.id === id);
  try {
    await api(`/api/automations/${id}`, { method: 'PUT', body: { ...automation, enabled: e.target.checked } });
    await Promise.all([loadAutomations(), loadStatus()]);
  } catch (err) {
    e.target.checked = !e.target.checked;
    flash(err.message, 'error');
  }
});

$('#test-run').addEventListener('click', runTest);
$('#test-text').addEventListener('keydown', (e) => e.key === 'Enter' && runTest());
async function runTest() {
  const out = $('#test-result');
  try {
    const { automation } = await api('/api/test', { method: 'POST', body: { type: $('#test-type').value, text: $('#test-text').value } });
    out.innerHTML = automation
      ? `✅ <b>${esc(automation.name)}</b> would send: <span class="muted">${esc(automation.dmText)}</span>`
      : '❌ No automation matches. (Automations tied to specific posts only match comments on those posts.)';
  } catch (err) {
    out.textContent = err.message;
  }
}

// ---------------- editor ----------------
const editor = $('#editor');
const form = $('#editor-form');

$('#new-automation').addEventListener('click', () => openEditor(null));
$('#editor-cancel').addEventListener('click', () => editor.close());

function openEditor(a) {
  state.editingId = a?.id || null;
  $('#editor-title').textContent = a ? 'Edit automation' : 'New automation';
  $('#editor-error').textContent = '';
  form.reset();
  const f = form.elements;
  if (a) {
    f.name.value = a.name;
    f.triggerType.value = a.triggerType;
    f.mediaScope.value = a.mediaIds.length ? 'specific' : 'any';
    f.matchMode.value = a.matchMode;
    f.keywords.value = a.keywords.join(', ');
    f.dmText.value = a.dmText;
    f.buttonTitle.value = a.buttonTitle || '';
    f.buttonUrl.value = a.buttonUrl || '';
    f.publicReplies.value = a.publicReplies.join('\n');
    f.oncePerUser.checked = a.oncePerUser;
    f.enabled.checked = a.enabled;
  }
  form.dataset.selected = JSON.stringify(a?.mediaIds || []);
  syncEditor();
  editor.showModal();
}

function selectedMedia() {
  return JSON.parse(form.dataset.selected || '[]');
}

function syncEditor() {
  const f = form.elements;
  const isComment = f.triggerType.value === 'comment';
  $('#media-fieldset').classList.toggle('hidden', !isComment);
  $('#replies-fieldset').classList.toggle('hidden', !isComment);
  $('#keywords-input').classList.toggle('hidden', f.matchMode.value === 'any');
  $('#dm-count').textContent = f.dmText.value.length;
  const specific = isComment && f.mediaScope.value === 'specific';
  $('#media-picker').classList.toggle('hidden', !specific);
  if (specific) renderMediaPicker();
}
form.addEventListener('input', syncEditor);

async function renderMediaPicker() {
  const picker = $('#media-picker');
  if (!state.media) {
    picker.innerHTML = '<p class="muted">Loading your posts…</p>';
    try {
      state.media = await api('/api/media');
    } catch (err) {
      picker.innerHTML = `<p class="error">${esc(err.message)}</p>`;
      return;
    }
  }
  if (!state.media.length) {
    picker.innerHTML = '<p class="muted">No posts found on your account.</p>';
    return;
  }
  const selected = new Set(selectedMedia());
  picker.innerHTML = state.media
    .map((m) => {
      const img = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url || m.thumbnail_url;
      const kind = m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post';
      return `<button type="button" class="media ${selected.has(m.id) ? 'selected' : ''}" data-media="${esc(m.id)}" title="${esc(m.caption || '')}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="noimg">🎬</div>'}
        <span class="media-kind">${kind}</span>
        <span class="media-caption">${esc((m.caption || '').slice(0, 60))}</span>
      </button>`;
    })
    .join('');
}

$('#media-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-media]');
  if (!btn) return;
  const selected = new Set(selectedMedia());
  const id = btn.dataset.media;
  selected.has(id) ? selected.delete(id) : selected.add(id);
  form.dataset.selected = JSON.stringify([...selected]);
  btn.classList.toggle('selected');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const isComment = f.triggerType.value === 'comment';
  const body = {
    name: f.name.value,
    triggerType: f.triggerType.value,
    mediaIds: isComment && f.mediaScope.value === 'specific' ? selectedMedia() : [],
    matchMode: f.matchMode.value,
    keywords: f.keywords.value.split(','),
    dmText: f.dmText.value,
    buttonTitle: f.buttonTitle.value,
    buttonUrl: f.buttonUrl.value,
    publicReplies: f.publicReplies.value.split('\n'),
    oncePerUser: f.oncePerUser.checked,
    enabled: f.enabled.checked,
  };
  if (isComment && f.mediaScope.value === 'specific' && body.mediaIds.length === 0) {
    $('#editor-error').textContent = 'Pick at least one post, or choose "Any post or reel".';
    return;
  }
  try {
    if (state.editingId) await api(`/api/automations/${state.editingId}`, { method: 'PUT', body });
    else await api('/api/automations', { method: 'POST', body });
    editor.close();
    await Promise.all([loadAutomations(), loadStatus()]);
  } catch (err) {
    $('#editor-error').textContent = err.message;
  }
});

// ---------------- activity ----------------
const STATUS_LABEL = { sent: 'Sent', error: 'Error', ignored: 'No match', skipped: 'Skipped', ok: 'OK' };

async function loadActivity() {
  const rows = await api('/api/activity').catch((err) => (flash(err.message, 'error'), []));
  $('#activity-table').innerHTML = rows.length
    ? `<thead><tr><th>When</th><th>Status</th><th>Type</th><th>Who</th><th>Message</th><th>Details</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr>
        <td title="${new Date(r.ts).toLocaleString()}">${timeAgo(r.ts)}</td>
        <td><span class="status ${esc(r.status)}">${STATUS_LABEL[r.status] || esc(r.status)}</span></td>
        <td>${esc(r.type)}</td>
        <td>${r.username ? `@${esc(r.username)}` : esc(r.userId || '')}</td>
        <td class="msg">${esc(r.text || '')}</td>
        <td class="msg">${esc(r.detail || '')}</td>
      </tr>`,
        )
        .join('')}</tbody>`
    : '<tbody><tr><td class="empty">Nothing yet. Comments and DMs show up here as they arrive.</td></tr></tbody>';
}
$('#activity-refresh').addEventListener('click', loadActivity);

// ---------------- contacts ----------------
async function loadContacts() {
  const rows = await api('/api/contacts').catch((err) => (flash(err.message, 'error'), []));
  $('#contacts-table').innerHTML = rows.length
    ? `<thead><tr><th>User</th><th>Interactions</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>${rows
        .map(
          (c) => `<tr>
        <td>${c.username ? `<a href="https://instagram.com/${encodeURIComponent(c.username)}" target="_blank" rel="noopener">@${esc(c.username)}</a>` : esc(c.id)}</td>
        <td>${c.interactions}</td>
        <td>${new Date(c.firstSeen).toLocaleDateString()}</td>
        <td>${timeAgo(c.lastSeen)}</td>
      </tr>`,
        )
        .join('')}</tbody>`
    : '<tbody><tr><td class="empty">People who trigger an automation will appear here.</td></tr></tbody>';
}

// ---------------- setup ----------------
function renderSetup() {
  const s = state.status;
  $('#problems').innerHTML = s.problems.map((p) => `<div class="card problem">⚠️ ${esc(p)}</div>`).join('');
  $('#webhook-url').textContent = s.webhookUrl;
  $('#redirect-uri').textContent = s.redirectUri;
  $('#privacy-url').textContent = s.privacyUrl;

  const a = s.account;
  const tokenForm = `
    <details ${s.oauthAvailable ? '' : 'open'}>
      <summary>Or paste an access token</summary>
      <p class="muted">Meta App Dashboard → Instagram → API setup with Instagram login → "Generate access tokens" → Generate token for your account.</p>
      <div class="row"><input id="token-input" type="password" placeholder="IGAA…"><button class="btn" id="token-save">Connect</button></div>
    </details>`;
  if (!a) {
    $('#connection').innerHTML = `
      <h3>Connect your Instagram account</h3>
      <p class="muted">You need an Instagram <b>Business or Creator</b> account.</p>
      ${s.oauthAvailable ? '<a class="btn primary" href="/auth/instagram">Connect with Instagram</a>' : ''}
      ${tokenForm}`;
  } else {
    const days = a.tokenExpiresAt ? Math.round((a.tokenExpiresAt - Date.now()) / 86400000) : null;
    $('#connection').innerHTML = `
      <h3>Connected account</h3>
      <div class="connected">
        ${a.profilePictureUrl ? `<img src="${esc(a.profilePictureUrl)}" alt="">` : ''}
        <div>
          <b>@${esc(a.username)}</b> <span class="muted">(ID ${esc(a.igUserId)})</span><br>
          <span class="muted">Token ${esc(a.tokenPreview)} · ${days !== null ? `expires in ${days} days (auto-refreshed daily)` : 'expiry unknown'}</span>
        </div>
      </div>
      <div class="row wrap">
        <button class="btn" id="resubscribe">Re-subscribe webhooks</button>
        <button class="btn" id="refresh-token">Refresh token now</button>
        ${s.oauthAvailable ? '<a class="btn" href="/auth/instagram">Reconnect</a>' : ''}
        <button class="btn ghost danger" id="disconnect">Disconnect</button>
      </div>
      ${tokenForm}`;
  }

  $('#token-save')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/account/token', { method: 'POST', body: { token: $('#token-input').value } });
      flash(r.subscribeError ? `Connected @${r.username}, but webhook subscription failed: ${r.subscribeError}` : `Connected @${r.username}!`, r.subscribeError ? 'error' : 'ok');
      await refreshAll();
    } catch (err) {
      flash(err.message, 'error');
    }
  });
  const action = (id, path, method, msg) =>
    $(id)?.addEventListener('click', async () => {
      if (id === '#disconnect' && !confirm('Disconnect Instagram? Automations stop until you reconnect.')) return;
      try {
        await api(path, { method, body: {} });
        flash(msg);
        await refreshAll();
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  action('#resubscribe', '/api/account/resubscribe', 'POST', 'Subscribed to comment & message webhooks.');
  action('#refresh-token', '/api/account/refresh', 'POST', 'Token refreshed.');
  action('#disconnect', '/api/account', 'DELETE', 'Disconnected.');
}

document.addEventListener('click', (e) => {
  const id = e.target.dataset?.copy;
  if (!id) return;
  navigator.clipboard.writeText($(`#${id}`).textContent).then(() => flash('Copied!'));
});

async function refreshAll() {
  await Promise.all([loadStatus(), loadAutomations()]);
  if (!$('#tab-setup').classList.contains('hidden')) renderSetup();
}

// ---------------- boot ----------------
async function boot() {
  const status = await api('/api/status');
  if (!status.authenticated) {
    showLogin();
    if (!status.passwordSet) $('#login-error').textContent = 'Set the ADMIN_PASSWORD secret on the Worker to enable the dashboard.';
    return;
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refreshAll();

  const params = new URLSearchParams(location.search);
  if (params.get('error')) flash(params.get('error'), 'error');
  if (params.get('connected')) flash(`Connected @${state.status.account?.username}! Webhooks are subscribed.`);
  if (params.has('error') || params.has('connected')) history.replaceState(null, '', location.pathname + location.hash);

  const tab = location.hash.slice(1);
  showTab(['automations', 'activity', 'contacts', 'setup'].includes(tab) ? tab : state.status.account ? 'automations' : 'setup');
}

setInterval(() => {
  if (!$('#app').classList.contains('hidden') && !$('#tab-activity').classList.contains('hidden')) loadActivity();
}, 15000);

boot().catch((err) => flash(err.message, 'error'));
