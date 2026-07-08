const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const registry = require('./registry');

let _io = null;

function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (r) => r.resume());
  req.on('error', (e) => console.error('Telegram error:', e.message));
  req.write(body); req.end();
}

// Map<tenantId, { client, qr, connected, info }>
const tenants = new Map();

function setIO(io) { _io = io; }

// Normalize a WhatsApp JID for storage as the phone key.
// @lid contacts must keep their domain so we can send back correctly.
// All other domains (@c.us, @s.whatsapp.net, etc.) are stripped.
function jidToPhone(jid) {
  const s = String(jid || '');
  if (s.endsWith('@lid')) return s; // keep full LID JID
  return s.split('@')[0];           // strip @c.us etc.
}

// Build a valid send-to chatId from a stored phone value.
function phoneToChatId(phone) {
  const s = String(phone || '');
  if (s.includes('@')) return s;    // already has domain (@lid, etc.)
  return `${s}@c.us`;              // plain number → standard JID
}

function emit(tenantId, event, data) {
  if (_io) _io.to('tenant:' + tenantId).emit(event, data);
}

function getState(tenantId) {
  if (!tenants.has(tenantId)) tenants.set(tenantId, { client: null, qr: null, connected: false, info: null });
  return tenants.get(tenantId);
}

// Puppeteer/Chromium crash signatures — page died but no 'disconnected' event fired
const CRASH_PATTERNS = ['detached Frame', 'Execution context was destroyed', 'Protocol error', 'Session closed', 'Target closed'];
function isCrashError(err) {
  const msg = err?.message || String(err || '');
  return CRASH_PATTERNS.some(p => msg.includes(p));
}

function recoverTenant(tenantId, db) {
  const state = tenants.get(tenantId);
  if (!state || state.recovering) return;
  state.recovering = true;
  state.connected = false;
  console.log(`🩹 [${tenantId}] Crash detected, recovering session...`);
  emit(tenantId, 'disconnected', 'crashed');
  sendTelegram(`🩹 [${tenantId}] WhatsApp session crashed (Puppeteer error). Auto-recovering...`);
  (async () => {
    try { if (state.client) await state.client.destroy(); } catch {}
    state.client = null;
    setTimeout(() => {
      state.recovering = false;
      try {
        initTenant(tenantId, db);
        sendTelegram(`✅ [${tenantId}] Auto-recovery finished — session restarting normally.`);
      } catch (e) {
        console.error(`[${tenantId}] Recovery failed:`, e.message);
        sendTelegram(`❌ [${tenantId}] Auto-recovery FAILED: ${e.message}. Manual restart needed.`);
      }
    }, 3000);
  })();
}

function clearChromiumLocks(tenantId) {
  const authDir = path.join(registry.getTenantDir(tenantId), '.wwebjs_auth');
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', '.lock', 'DevToolsActivePort'];
  try {
    if (!fs.existsSync(authDir)) return;
    for (const entry of fs.readdirSync(authDir)) {
      const sessionDir = path.join(authDir, entry);
      if (entry.startsWith('session') && fs.statSync(sessionDir).isDirectory()) {
        for (const lockFile of lockFiles) {
          const lockPath = path.join(sessionDir, lockFile);
          if (fs.existsSync(lockPath)) {
            fs.rmSync(lockPath, { force: true });
            console.log(`🧹 [${tenantId}] Removed lock file: ${lockFile}`);
          }
        }
      }
    }
  } catch (e) {
    console.error(`[${tenantId}] Could not clear lock files:`, e.message);
  }
}

function initTenant(tenantId, db) {
  const state = getState(tenantId);
  // Block double-init: already connected OR already in the process of connecting
  if (state.client) return;


  clearChromiumLocks(tenantId);

  const tenantDir = registry.getTenantDir(tenantId);
  fs.mkdirSync(tenantDir, { recursive: true });

  const puppeteerOpts = {
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote'],
    headless: true,
  };
  if (process.env.CHROMIUM_PATH) puppeteerOpts.executablePath = process.env.CHROMIUM_PATH;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(tenantDir, '.wwebjs_auth') }),
    puppeteer: puppeteerOpts,
  });

  state.client = client;

  client.on('qr', (qr) => {
    state.qr = qr;
    state.connected = false;
    console.log(`📱 [${tenantId}] QR code ready`);
    emit(tenantId, 'qr', qr);
  });

  client.on('authenticated', () => {
    state.qr = null;
    console.log(`🔐 [${tenantId}] Authenticated`);
    emit(tenantId, 'authenticated');
  });

  client.on('ready', () => {
    state.connected = true;
    state.qr = null;
    state.info = client.info;
    console.log(`✅ [${tenantId}] Connected as ${client.info?.pushname || 'Unknown'}`);
    emit(tenantId, 'ready', client.info);

    try {
      client.pupBrowser?.on('disconnected', () => recoverTenant(tenantId, db));
      client.pupPage?.on('close', () => recoverTenant(tenantId, db));
      client.pupPage?.on('error', () => recoverTenant(tenantId, db));
    } catch {}

    // Heartbeat: catches "Execution context destroyed" crashes that don't fire close/error
    const heartbeat = setInterval(async () => {
      const cur = tenants.get(tenantId);
      if (!cur?.client || cur.client !== client) { clearInterval(heartbeat); return; }
      try { await client.getState(); }
      catch (err) { clearInterval(heartbeat); if (isCrashError(err)) recoverTenant(tenantId, db); }
    }, 60000);
  });

  client.on('disconnected', (reason) => {
    state.connected = false;
    state.info = null;
    console.log(`❌ [${tenantId}] Disconnected:`, reason);
    emit(tenantId, 'disconnected', reason);
    setTimeout(() => { try { client.initialize(); } catch {} }, 3000);
  });

  // When the admin reads a chat on their phone, unread drops to 0 → clear it in the app too
  client.on('chat_update', (chat) => {
    if (chat.id?.server === 'g.us') return; // skip groups
    if (chat.unreadCount === 0) {
      const phone = jidToPhone(chat.id?._serialized || '');
      if (!phone) return;
      db.markAsRead(phone);
      emit(tenantId, 'chat_read', { phone });
    }
  });

  client.on('message_create', (msg) => {
    if (!msg.fromMe || msg.to.includes('@g.us')) return;
    const phone = jidToPhone(msg.to);
    db.upsertContact(phone, msg._data?.notifyName || phone);
    const saved = db.saveMessage(phone, 'out', 'text', msg.body || '', null, false, true, msg.timestamp);
    emit(tenantId, 'new_message', { phone, ...saved });
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('@g.us')) return;
    const phone = jidToPhone(msg.from);
    const body = msg.body || '';
    const contactName = msg._data?.notifyName || phone;

    db.upsertContact(phone, contactName);

    const lc = body.toLowerCase();
    let matchedSlot = null;
    for (const sfx of getCampaignSlots(db)) {
      const kw = db.getConfig(`trigger_keyword${sfx}`);
      if (kw && lc.includes(kw.toLowerCase())) { matchedSlot = sfx; break; }
    }

    const saved = db.saveMessage(phone, 'in', 'text', body, null, false, matchedSlot === null, msg.timestamp);
    emit(tenantId, 'new_message', { phone, name: contactName, ...saved, countUnread: matchedSlot === null });

    if (matchedSlot !== null) {
      await sleep(getSmartDelay());
      await sendBotResponse(tenantId, phoneToChatId(phone), phone, db, matchedSlot);
    }
  });

  console.log(`🚀 [${tenantId}] Starting WhatsApp...`);
  client.initialize();
}

async function stopTenant(tenantId) {
  const state = tenants.get(tenantId);
  if (!state) return;
  try { if (state.client) await state.client.destroy(); } catch {}
  tenants.delete(tenantId);
}

function getCampaignSlots(db) {
  const plan = db.getConfig('subscription_plan') || '';
  if (plan === 'basic') return [''];
  const slots = [''];
  let active = [];
  try { active = JSON.parse(db.getConfig('active_campaigns') || '[]'); } catch {}
  if (!active.length) {
    for (let i = 2; i <= 5; i++) {
      if (db.getConfig(`trigger_keyword_${i}`) || db.getConfig(`price_text_${i}`) || db.getConfig(`audio_file_${i}`) || db.getConfig(`images_${i}`)) active.push(i);
    }
  }
  for (const n of active) { const s = Number(n); if (s >= 2 && s <= 5) slots.push(`_${s}`); }
  return [...new Set(slots)];
}

function getSmartDelay() {
  const hour = new Date().getHours();
  const isNight = hour >= 23 || hour < 8;
  const min = isNight ? 45000 : 20000;
  const max = isNight ? 120000 : 45000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function humanDelay(min, max) {
  return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendBotResponse(tenantId, chatId, phone, db, sfx = '') {
  const state = tenants.get(tenantId);
  if (!state?.client) return;
  const client = state.client;
  const visitCount = db.getVisitCount(phone);

  try {
    if (visitCount === 0) {
      // First visit: full campaign flow
      const priceText = db.getConfig(`price_text${sfx}`);
      if (priceText) {
        try { const ch = await client.getChatById(chatId); await ch.sendStateTyping(); await humanDelay(1500, 3000); await ch.clearState(); } catch {}
        await client.sendMessage(chatId, priceText);
        const m = db.saveMessage(phone, 'out', 'text', priceText, null, true);
        emit(tenantId, 'new_message', { phone, ...m });
        await humanDelay(3000, 6000);
      }

      const audioPath = db.getConfig(`audio_file${sfx}`);
      if (audioPath && fs.existsSync(audioPath)) {
        await humanDelay(2000, 4000);
        const media = MessageMedia.fromFilePath(audioPath);
        await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
        const m = db.saveMessage(phone, 'out', 'audio', '🎵 Voice message', audioPath, true);
        emit(tenantId, 'new_message', { phone, ...m });
        await humanDelay(4000, 8000);
      }

      const imagesJson = db.getConfig(`images${sfx}`);
      if (imagesJson) {
        for (const img of JSON.parse(imagesJson)) {
          const imgPath = img.path || img;
          if (fs.existsSync(imgPath)) {
            await client.sendMessage(chatId, MessageMedia.fromFilePath(imgPath));
            const m = db.saveMessage(phone, 'out', 'image', '🖼 Product image', imgPath, true);
            emit(tenantId, 'new_message', { phone, ...m });
            await humanDelay(2000, 5000);
          }
        }
      }

      const compText = db.getConfig(`comparison_text${sfx}`);
      if (compText) {
        await humanDelay(3000, 6000);
        try { const ch = await client.getChatById(chatId); await ch.sendStateTyping(); await humanDelay(1500, 3000); await ch.clearState(); } catch {}
        await client.sendMessage(chatId, compText);
        const m = db.saveMessage(phone, 'out', 'text', compText, null, true);
        emit(tenantId, 'new_message', { phone, ...m });
        await humanDelay(3000, 6000);
      }

      const compImagesJson = db.getConfig(`comparison_images${sfx}`);
      if (compImagesJson) {
        for (const img of JSON.parse(compImagesJson)) {
          const imgPath = img.path || img;
          if (fs.existsSync(imgPath)) {
            await client.sendMessage(chatId, MessageMedia.fromFilePath(imgPath));
            const m = db.saveMessage(phone, 'out', 'image', '🖼 Comparison image', imgPath, true);
            emit(tenantId, 'new_message', { phone, ...m });
            await humanDelay(2000, 5000);
          }
        }
      }

    } else if (visitCount === 1) {
      // Second visit: returning message + audio
      const returningText = db.getConfig('returning_text');
      if (returningText) {
        try { const ch = await client.getChatById(chatId); await ch.sendStateTyping(); await humanDelay(1500, 3000); await ch.clearState(); } catch {}
        await client.sendMessage(chatId, returningText);
        const m = db.saveMessage(phone, 'out', 'text', returningText, null, true);
        emit(tenantId, 'new_message', { phone, ...m });
        await humanDelay(3000, 6000);
      }
      const returningAudio = db.getConfig('returning_audio_file');
      if (returningAudio && fs.existsSync(returningAudio)) {
        await humanDelay(2000, 4000);
        const media = MessageMedia.fromFilePath(returningAudio);
        await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
        const m = db.saveMessage(phone, 'out', 'audio', '🎵 Voice message', returningAudio, true);
        emit(tenantId, 'new_message', { phone, ...m });
      }

    } else {
      // Third+ visit: repeat message only
      const repeatText = db.getConfig('repeat_text');
      if (repeatText) {
        try { const ch = await client.getChatById(chatId); await ch.sendStateTyping(); await humanDelay(1500, 3000); await ch.clearState(); } catch {}
        await client.sendMessage(chatId, repeatText);
        const m = db.saveMessage(phone, 'out', 'text', repeatText, null, true);
        emit(tenantId, 'new_message', { phone, ...m });
      }
    }

    db.incrementVisitCount(phone);
    db.markBotHandled(phone);
    console.log(`🤖 [${tenantId}] Bot response sent to ${phone} (campaign${sfx || '1'}, visit #${visitCount + 1})`);

    const REMINDER_DEFAULT = 'مرحبا ممكن تخلي لينا شحال بغيتي و الإسم و العنوان و رقم الهاتف';
    setTimeout(async () => {
      try {
        if (!db.shouldSendReminder(phone)) return;
        const reminderText = db.getConfig('reminder_text') || REMINDER_DEFAULT;
        if (!reminderText.trim()) return;
        const cur = tenants.get(tenantId);
        if (!cur?.client) return;
        try { const ch = await cur.client.getChatById(chatId); await ch.sendStateTyping(); await humanDelay(1500, 3000); await ch.clearState(); } catch {}
        await cur.client.sendMessage(chatId, reminderText);
        const m = db.saveMessage(phone, 'out', 'text', reminderText, null, true);
        emit(tenantId, 'new_message', { phone, ...m });
        db.markReminderSent(phone);
        console.log(`⏰ [${tenantId}] Reminder sent to ${phone}`);
      } catch (err) {
        console.error(`[${tenantId}] Reminder error:`, err.message);
        if (isCrashError(err)) recoverTenant(tenantId, db);
      }
    }, 15 * 60 * 1000);

  } catch (err) {
    console.error(`[${tenantId}] Bot error:`, err.message);
    if (isCrashError(err)) recoverTenant(tenantId, db);
  }
}

async function sendText(tenantId, phone, text) {
  const state = tenants.get(tenantId);
  if (!state?.client || !state.connected) throw new Error('WhatsApp not connected');
  const chatId = phoneToChatId(phone);
  console.log(`[${tenantId}] sendText → chatId=${chatId} text="${text}" connected=${state.connected} hasClient=${!!state.client}`);
  try {
    const result = await state.client.sendMessage(chatId, text);
    console.log(`[${tenantId}] sendText ✓ result type=${typeof result}`);
  } catch (err) {
    console.error(`[${tenantId}] sendText FAIL type=${typeof err} instanceof Error=${err instanceof Error} JSON=${JSON.stringify(err)} message=${err?.message} name=${err?.name}`);
    console.error(`[${tenantId}] sendText FAIL raw:`, err);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error('Send failed: ' + msg);
  }
}

function getStatus(tenantId) {
  const state = tenants.get(tenantId);
  if (!state) return { connected: false, qr: null, info: null };
  return { connected: state.connected, qr: state.qr, info: state.info };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getRunningCount() {
  let count = 0;
  for (const [, state] of tenants) if (state.client) count++;
  return count;
}

module.exports = { setIO, initTenant, stopTenant, getStatus, sendText, getRunningCount };
