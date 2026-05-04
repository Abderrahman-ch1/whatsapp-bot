const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'db') : './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));

// Safe migrations for existing databases
try { db.exec('ALTER TABLE contacts ADD COLUMN unread INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN reminder_sent INTEGER DEFAULT 0'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    bot_handled INTEGER DEFAULT 0,
    unread INTEGER DEFAULT 0,
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

function upsertContact(phone, name) {
  db.prepare(`
    INSERT INTO contacts (phone, name, last_message_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      last_message_at = datetime('now')
  `).run(phone, name || phone);
}

function getConversations() {
  return db.prepare(`
    SELECT c.phone, c.name, c.bot_handled, c.unread, c.last_message_at,
      m.content as last_message, m.direction as last_direction, m.type as last_type
    FROM contacts c
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE phone = c.phone ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY c.last_message_at DESC
  `).all();
}

function getMessages(phone) {
  return db.prepare('SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC').all(phone);
}

function saveMessage(phone, direction, type, content, filePath, isBot, countUnread = true) {
  const result = db.prepare(`
    INSERT INTO messages (phone, direction, type, content, file_path, bot)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(phone, direction, type, content, filePath || null, isBot ? 1 : 0);

  const unreadInc = direction === 'in' && countUnread ? ', unread = unread + 1' : '';
  db.prepare(`UPDATE contacts SET last_message_at = datetime('now')${unreadInc} WHERE phone = ?`).run(phone);

  return {
    id: result.lastInsertRowid,
    phone, direction, type, content,
    file_path: filePath || null,
    bot: isBot ? 1 : 0,
    created_at: new Date().toISOString()
  };
}

function isContactBotHandled(phone) {
  const row = db.prepare('SELECT bot_handled FROM contacts WHERE phone = ?').get(phone);
  return row?.bot_handled === 1;
}

function markBotHandled(phone) {
  db.prepare('UPDATE contacts SET bot_handled = 1 WHERE phone = ?').run(phone);
}

function markAsRead(phone) {
  db.prepare('UPDATE contacts SET unread = 0 WHERE phone = ?').run(phone);
}

function markReminderSent(phone) {
  db.prepare('UPDATE contacts SET reminder_sent = 1 WHERE phone = ?').run(phone);
}

function shouldSendReminder(phone) {
  const contact = db.prepare('SELECT reminder_sent FROM contacts WHERE phone = ?').get(phone);
  if (!contact || contact.reminder_sent === 1) return false;
  const lastMsg = db.prepare('SELECT direction FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(phone);
  return lastMsg && lastMsg.direction === 'out';
}

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row?.value || null;
}

function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function clearConversations() {
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM contacts').run();
}

module.exports = {
  upsertContact, getConversations, getMessages,
  saveMessage, isContactBotHandled, markBotHandled, markAsRead,
  markReminderSent, shouldSendReminder,
  getConfig, getAllConfig, setConfig, clearConversations
};
