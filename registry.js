const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });

const reg = new Database(path.join(DATA_DIR, 'registry.db'));
reg.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    pwd_hash   TEXT NOT NULL,
    plan       TEXT NOT NULL DEFAULT 'basic',
    expires    TEXT,
    active     INTEGER NOT NULL DEFAULT 0,
    name       TEXT DEFAULT '',
    phone      TEXT DEFAULT '',
    email      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS access_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    phone      TEXT,
    email      TEXT,
    plan       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function getTenantDir(tenantId) {
  return path.join(DATA_DIR, 'tenants', tenantId);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const attempt = crypto.scryptSync(password, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(hash));
  } catch {
    return false;
  }
}

function getSubscriptionStatus(tenantId) {
  const row = reg.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  if (!row) return { active: false, plan: '', daysLeft: null, pending: false, expired: false };

  let daysLeft = null;
  let isExpired = false;
  if (row.expires) {
    daysLeft = Math.ceil((new Date(row.expires) - Date.now()) / 86400000);
    isExpired = daysLeft <= 0;
  }

  if (row.active === 1 && isExpired) {
    reg.prepare('UPDATE tenants SET active = 0 WHERE id = ?').run(tenantId);
  }

  return {
    active: row.active === 1 && !isExpired,
    plan: row.plan,
    daysLeft: daysLeft ?? null,
    pending: false,
    expired: isExpired,
  };
}

function verifyLogin(username, password) {
  const row = reg.prepare('SELECT * FROM tenants WHERE username = ?').get(username);
  if (!row) return null;
  if (!verifyPassword(password, row.pwd_hash)) return null;
  return { tenantId: row.id, username: row.username };
}

function upsertTenant({ id, username, password, plan, days, name, phone, email }) {
  const existing = reg.prepare('SELECT pwd_hash FROM tenants WHERE id = ?').get(id);
  const pwd_hash = password ? hashPassword(password) : (existing?.pwd_hash || hashPassword('changeme'));
  const active = days > 0 ? 1 : 0;
  const expires = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;

  reg.prepare(`
    INSERT INTO tenants (id, username, pwd_hash, plan, expires, active, name, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      pwd_hash = excluded.pwd_hash,
      plan     = excluded.plan,
      expires  = excluded.expires,
      active   = excluded.active,
      name     = COALESCE(NULLIF(excluded.name,''), name),
      phone    = COALESCE(NULLIF(excluded.phone,''), phone),
      email    = COALESCE(NULLIF(excluded.email,''), email)
  `).run(id, username, pwd_hash, plan || 'basic', expires, active,
         name || '', phone || '', email || '');
}

function updateCredentials(tenantId, username, password) {
  const pwd_hash = hashPassword(password);
  reg.prepare('UPDATE tenants SET username = ?, pwd_hash = ? WHERE id = ?')
     .run(username, pwd_hash, tenantId);
}

function revokeTenant(tenantId) {
  reg.prepare('UPDATE tenants SET active = 0, expires = NULL WHERE id = ?').run(tenantId);
}

function getAllTenants() {
  return reg.prepare('SELECT id, username, plan, expires, active, name, phone, email, created_at FROM tenants ORDER BY created_at DESC').all().map(t => ({
    ...t,
    daysLeft: t.expires ? Math.ceil((new Date(t.expires) - Date.now()) / 86400000) : null,
  }));
}

function getTenant(tenantId) {
  return reg.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
}

function createAccessRequest({ name, phone, email, plan }) {
  reg.prepare('INSERT INTO access_requests (name, phone, email, plan) VALUES (?, ?, ?, ?)')
     .run(name || '', phone || '', email || '', plan || 'basic');
}

function getAccessRequests() {
  return reg.prepare('SELECT * FROM access_requests ORDER BY created_at DESC').all();
}

module.exports = {
  getTenantDir, hashPassword, verifyPassword,
  getSubscriptionStatus, verifyLogin,
  upsertTenant, updateCredentials, revokeTenant,
  getAllTenants, getTenant,
  createAccessRequest, getAccessRequests,
};
