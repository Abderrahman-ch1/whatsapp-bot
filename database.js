const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '.';

class TenantDB {
  constructor(tenantId) {
    const dir = path.join(DATA_DIR, 'tenants', tenantId, 'db');
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'app.db'));
    this._migrate();
  }

  _migrate() {
    const { db } = this;
    try { db.exec('ALTER TABLE contacts ADD COLUMN unread INTEGER DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE contacts ADD COLUMN reminder_sent INTEGER DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE contacts ADD COLUMN archived INTEGER DEFAULT 0'); } catch {}
    try { db.exec('ALTER TABLE contacts ADD COLUMN bot_visit_count INTEGER DEFAULT 0'); } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE NOT NULL,
        name TEXT,
        bot_handled INTEGER DEFAULT 0,
        bot_visit_count INTEGER DEFAULT 0,
        unread INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        reminder_sent INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        last_message_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        content TEXT,
        file_path TEXT,
        bot INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  upsertContact(phone, name) {
    this.db.prepare(`
      INSERT INTO contacts (phone, name, last_message_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        last_message_at = datetime('now')
    `).run(phone, name || phone);
  }

  getConversations(archived = 0) {
    return this.db.prepare(`
      SELECT c.phone, c.name, c.bot_handled, c.unread, c.last_message_at, c.archived,
        m.content as last_message, m.direction as last_direction, m.type as last_type
      FROM contacts c
      LEFT JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE phone = c.phone ORDER BY created_at DESC LIMIT 1
      )
      WHERE c.archived = ?
      ORDER BY c.last_message_at DESC
    `).all(archived ? 1 : 0);
  }

  archiveContact(phone, archived = 1) {
    this.db.prepare('UPDATE contacts SET archived = ? WHERE phone = ?').run(archived ? 1 : 0, phone);
  }

  deleteConversation(phone) {
    this.db.prepare('DELETE FROM messages WHERE phone = ?').run(phone);
    this.db.prepare('DELETE FROM contacts WHERE phone = ?').run(phone);
  }

  getMessages(phone) {
    return this.db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC').all(phone);
  }

  saveMessage(phone, direction, type, content, filePath, isBot, countUnread = true, tsUnix = null) {
    // Use real WhatsApp timestamp when provided, otherwise server time
    const createdAt = tsUnix
      ? new Date(tsUnix * 1000).toISOString()
      : new Date().toISOString();

    const result = this.db.prepare(`
      INSERT INTO messages (phone, direction, type, content, file_path, bot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(phone, direction, type, content, filePath || null, isBot ? 1 : 0, createdAt);

    const unreadInc = direction === 'in' && countUnread ? ', unread = unread + 1' : '';
    const tsExpr = tsUnix
      ? `datetime(${Math.floor(tsUnix)}, 'unixepoch')`
      : `datetime('now')`;
    this.db.prepare(`UPDATE contacts SET last_message_at = ${tsExpr}${unreadInc} WHERE phone = ?`).run(phone);

    return {
      id: result.lastInsertRowid,
      phone, direction, type, content,
      file_path: filePath || null,
      bot: isBot ? 1 : 0,
      created_at: createdAt,
    };
  }

  isContactBotHandled(phone) {
    const row = this.db.prepare('SELECT bot_handled FROM contacts WHERE phone = ?').get(phone);
    return row?.bot_handled === 1;
  }

  markBotHandled(phone) {
    this.db.prepare('UPDATE contacts SET bot_handled = 1 WHERE phone = ?').run(phone);
  }

  getVisitCount(phone) {
    const row = this.db.prepare('SELECT bot_visit_count FROM contacts WHERE phone = ?').get(phone);
    return row?.bot_visit_count || 0;
  }

  incrementVisitCount(phone) {
    this.db.prepare('UPDATE contacts SET bot_visit_count = bot_visit_count + 1 WHERE phone = ?').run(phone);
  }

  markAsRead(phone) {
    this.db.prepare('UPDATE contacts SET unread = 0 WHERE phone = ?').run(phone);
  }

  markReminderSent(phone) {
    this.db.prepare('UPDATE contacts SET reminder_sent = 1 WHERE phone = ?').run(phone);
  }

  shouldSendReminder(phone) {
    const contact = this.db.prepare('SELECT reminder_sent FROM contacts WHERE phone = ?').get(phone);
    if (!contact || contact.reminder_sent === 1) return false;
    const lastMsg = this.db.prepare('SELECT direction, bot FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
    // Only remind if the last message was sent by the bot — skip if user replied manually
    return lastMsg && lastMsg.direction === 'out' && lastMsg.bot === 1;
  }

  getConfig(key) {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row?.value || null;
  }

  getAllConfig() {
    const rows = this.db.prepare('SELECT key, value FROM config').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  setConfig(key, value) {
    this.db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  clearConversations() {
    this.db.prepare('DELETE FROM messages').run();
    this.db.prepare('DELETE FROM contacts').run();
  }

  clearBotConfig() {
    const keys = ['trigger_keyword','price_text','reminder_text','active_campaigns'];
    for (let i = 2; i <= 5; i++) keys.push(`trigger_keyword_${i}`, `price_text_${i}`);
    for (const sfx of ['','_2','_3','_4','_5']) {
      keys.push(`audio_file${sfx}`, `audio_name${sfx}`, `images${sfx}`);
    }
    for (const k of keys) this.setConfig(k, '');
  }
}

const cache = new Map();

function getTenantDB(tenantId) {
  if (!cache.has(tenantId)) cache.set(tenantId, new TenantDB(tenantId));
  return cache.get(tenantId);
}

module.exports = { getTenantDB };
