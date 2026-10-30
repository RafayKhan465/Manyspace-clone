// Data access on top of Cloudflare D1 (see migrations/0001_init.sql).

const ACTIVITY_LIMIT = 2000;
const PROCESSED_TTL_MS = 8 * 24 * 60 * 60 * 1000; // Meta never retries a webhook this late

export class Database {
  constructor(d1) {
    this.d1 = d1;
  }

  // ---- account ----
  async getAccount() {
    const row = await this.d1.prepare('SELECT * FROM account WHERE id = 1').first();
    if (!row) return null;
    return {
      igUserId: row.ig_user_id,
      username: row.username,
      name: row.name,
      profilePictureUrl: row.profile_picture_url,
      accessToken: row.access_token,
      tokenExpiresAt: row.token_expires_at,
      tokenRefreshedAt: row.token_refreshed_at,
      connectedAt: row.connected_at,
    };
  }

  async saveAccount(a) {
    await this.d1
      .prepare(
        `INSERT INTO account (id, ig_user_id, username, name, profile_picture_url, access_token,
           token_expires_at, token_refreshed_at, connected_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           ig_user_id = excluded.ig_user_id, username = excluded.username, name = excluded.name,
           profile_picture_url = excluded.profile_picture_url, access_token = excluded.access_token,
           token_expires_at = excluded.token_expires_at, token_refreshed_at = excluded.token_refreshed_at,
           connected_at = excluded.connected_at`,
      )
      .bind(
        a.igUserId,
        a.username ?? null,
        a.name ?? null,
        a.profilePictureUrl ?? null,
        a.accessToken,
        a.tokenExpiresAt ?? null,
        a.tokenRefreshedAt ?? null,
        a.connectedAt ?? Date.now(),
      )
      .run();
  }

  async updateToken(accessToken, tokenExpiresAt) {
    await this.d1
      .prepare('UPDATE account SET access_token = ?, token_expires_at = ?, token_refreshed_at = ? WHERE id = 1')
      .bind(accessToken, tokenExpiresAt, Date.now())
      .run();
  }

  async deleteAccount() {
    await this.d1.prepare('DELETE FROM account').run();
  }

  // ---- automations ----
  static toAutomation(row) {
    return {
      ...JSON.parse(row.data),
      id: row.id,
      stats: { triggered: row.triggered, sent: row.sent, failed: row.failed },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listAutomations() {
    const { results } = await this.d1.prepare('SELECT * FROM automations ORDER BY created_at').all();
    return results.map(Database.toAutomation);
  }

  async getAutomation(id) {
    const row = await this.d1.prepare('SELECT * FROM automations WHERE id = ?').bind(id).first();
    return row ? Database.toAutomation(row) : null;
  }

  async createAutomation(fields) {
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.d1
      .prepare('INSERT INTO automations (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(id, JSON.stringify(fields), now, now)
      .run();
    return this.getAutomation(id);
  }

  async updateAutomation(id, fields) {
    const res = await this.d1
      .prepare('UPDATE automations SET data = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(fields), Date.now(), id)
      .run();
    return res.meta.changes > 0 ? this.getAutomation(id) : null;
  }

  async deleteAutomation(id) {
    const res = await this.d1.prepare('DELETE FROM automations WHERE id = ?').bind(id).run();
    await this.d1.prepare('DELETE FROM sends WHERE automation_id = ?').bind(id).run();
    return res.meta.changes > 0;
  }

  async bumpStat(id, column) {
    if (!['triggered', 'sent', 'failed'].includes(column)) throw new Error(`bad stat ${column}`);
    await this.d1.prepare(`UPDATE automations SET ${column} = ${column} + 1 WHERE id = ?`).bind(id).run();
  }

  // ---- de-duplication ----
  // Atomically claims an event; returns false if it was already processed.
  async claimEvent(key) {
    const res = await this.d1
      .prepare('INSERT OR IGNORE INTO processed_events (key, created_at) VALUES (?, ?)')
      .bind(key, Date.now())
      .run();
    return res.meta.changes > 0;
  }

  // Atomically claims "this person gets this automation's DM"; false if they already did.
  async claimSend(automationId, userId) {
    const res = await this.d1
      .prepare('INSERT OR IGNORE INTO sends (automation_id, user_id, created_at) VALUES (?, ?, ?)')
      .bind(automationId, userId, Date.now())
      .run();
    return res.meta.changes > 0;
  }

  async releaseSend(automationId, userId) {
    await this.d1.prepare('DELETE FROM sends WHERE automation_id = ? AND user_id = ?').bind(automationId, userId).run();
  }

  // ---- contacts ----
  async touchContact(id, username) {
    if (!id) return;
    const now = Date.now();
    await this.d1
      .prepare(
        `INSERT INTO contacts (id, username, first_seen, last_seen, interactions) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET
           username = COALESCE(excluded.username, contacts.username),
           last_seen = excluded.last_seen,
           interactions = contacts.interactions + 1`,
      )
      .bind(id, username ?? null, now, now)
      .run();
  }

  async listContacts(limit = 500) {
    const { results } = await this.d1.prepare('SELECT * FROM contacts ORDER BY last_seen DESC LIMIT ?').bind(limit).all();
    return results.map((r) => ({
      id: r.id,
      username: r.username,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      interactions: r.interactions,
    }));
  }

  // ---- activity log ----
  async log({ type, status, automationId, userId, username, text, detail }) {
    await this.d1
      .prepare(
        `INSERT INTO activity (ts, type, status, automation_id, user_id, username, text, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(Date.now(), type, status, automationId ?? null, userId ?? null, username ?? null, text ?? null, detail ?? null)
      .run();
  }

  async listActivity(limit = 200) {
    const { results } = await this.d1.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').bind(limit).all();
    return results.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      status: r.status,
      automationId: r.automation_id,
      userId: r.user_id,
      username: r.username,
      text: r.text,
      detail: r.detail,
    }));
  }

  async counts() {
    const row = await this.d1
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM contacts) AS contacts,
           (SELECT COALESCE(SUM(sent), 0) FROM automations) AS sent,
           (SELECT COALESCE(SUM(failed), 0) FROM automations) AS failed,
           (SELECT COUNT(*) FROM automations WHERE json_extract(data, '$.enabled') = 1) AS active`,
      )
      .first();
    return row;
  }

  async prune() {
    await this.d1.prepare('DELETE FROM processed_events WHERE created_at < ?').bind(Date.now() - PROCESSED_TTL_MS).run();
    await this.d1
      .prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?)')
      .bind(ACTIVITY_LIMIT)
      .run();
  }
}
