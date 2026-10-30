// Test helpers: a D1-compatible database backed by Node's built-in SQLite,
// and a fake Instagram Graph API.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  return { prepare: (sql) => new Statement(db, sql), raw: db };
}

// Replaces global fetch with a fake Graph API. `routes` maps "METHOD /path" to a
// handler returning a JSON body (or throwing { status, body } for an error).
export function mockFetch(routes = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    let body = init.body;
    if (typeof body === 'string') body = JSON.parse(body);
    else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    const call = { method, url, path: url.pathname.replace(/^\/v\d+\.\d+/, ''), body, headers: init.headers || {} };
    calls.push(call);
    const handler = routes[`${method} ${call.path}`] || routes[`${method} *`];
    if (!handler) return new Response(JSON.stringify({ error: { message: `No mock for ${method} ${call.path}` } }), { status: 404 });
    try {
      return new Response(JSON.stringify(await handler(call)), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify(err.body || { error: { message: String(err.message || err) } }), { status: err.status || 400 });
    }
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

export function sign(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), done: () => Promise.all(pending.splice(0)) };
}
