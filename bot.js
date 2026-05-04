const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

let client = null;
let currentQR = null;
let isConnected = false;
let clientInfo = null;

const DATA_DIR = process.env.DATA_DIR || '.';

// Delete stale Chrome user data dirs on startup — LocalAuth restores WA session from its zip backup.
// LocalAuth names the dir "session" (no clientId) or "session-{clientId}". We wipe ALL session* dirs
// so the hostname embedded in SingletonLock from a crashed container can never block a fresh start.
function clearChromiumLocks() {
  const authDir = path.join(DATA_DIR, '.wwebjs_auth');
  try {
    if (!fs.existsSync(authDir)) return;
    let cleared = false;
    for (const entry of fs.readdirSync(authDir)) {
      const full = path.join(authDir, entry);
      if (entry.startsWith('session') && fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`🧹 Cleared stale Chrome session dir: ${entry}`);
        cleared = true;
      }
    }
    if (!cleared) console.log('🧹 No stale Chrome session dirs found');
  } catch (e) {
    console.error('Could not clear session dirs:', e.message);
  }
}

function init(io, db) {
  clearChromiumLocks();

  const puppeteerOpts = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
    headless: true,
  };
  if (process.env.CHROMIUM_PATH) puppeteerOpts.executablePath = process.env.CHROMIUM_PATH;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
    puppeteer: puppeteerOpts,
  });

  client.on('qr', (qr) => {
    currentQR = qr;
    isConnected = false;
    console.log('📱 QR code ready — open http://localhost:3000 to scan');
    io.emit('qr', qr);
  });

  client.on('authenticated', () => {
    currentQR = null;
    console.log('🔐 Authenticated');
    io.emit('authenticated');
  });

  client.on('ready', () => {
    isConnected = true;
    currentQR = null;
    clientInfo = client.info;
    console.log(`✅ Connected as ${client.info?.pushname || 'Unknown'}`);
    io.emit('ready', client.info);
  });

  client.on('disconnected', (reason) => {
    isConnected = false;
    clientInfo = null;
    console.log('❌ Disconnected:', reason);
    io.emit('disconnected', reason);
    // Re-initialize after logout so a new QR is generated
    setTimeout(() => {
      try { client.initialize(); } catch {}
    }, 3000);
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('@g.us')) return;

    const phone = msg.from.replace('@c.us', '');
    const body = msg.body || '';
    const contactName = msg._data?.notifyName || phone;

    db.upsertContact(phone, contactName);

    // Detect trigger match before saving so we can skip the unread increment
    const alreadyHandled = db.isContactBotHandled(phone);
    const lc = body.toLowerCase();
    let matchedSlot = null;
    if (!alreadyHandled) {
      const slots = getCampaignSlots(db);
      for (const sfx of slots) {
        const kw = db.getConfig(`trigger_keyword${sfx}`);
        if (kw && lc.includes(kw.toLowerCase())) { matchedSlot = sfx; break; }
      }
    }

    // Trigger messages are handled by the bot — don't mark as unread
    const saved = db.saveMessage(phone, 'in', 'text', body, null, false, matchedSlot === null);
    io.emit('new_message', { phone, name: contactName, ...saved, countUnread: matchedSlot === null });

    if (matchedSlot !== null) {
      await sleep(30000);
      await sendBotResponse(msg.from, phone, db, io, matchedSlot);
    }
  });

  console.log('🚀 Starting WhatsApp — this may take 30 seconds...');
  client.initialize();
}

function getCampaignSlots(db) {
  const plan = db.getConfig('subscription_plan') || '';
  if (plan === 'basic') return [''];

  const slots = [''];
  let active = [];
  try {
    active = JSON.parse(db.getConfig('active_campaigns') || '[]');
  } catch {}

  if (!active.length) {
    for (let i = 2; i <= 5; i++) {
      if (
        db.getConfig(`trigger_keyword_${i}`) ||
        db.getConfig(`price_text_${i}`) ||
        db.getConfig(`audio_file_${i}`) ||
        db.getConfig(`images_${i}`)
      ) {
        active.push(i);
      }
    }
  }

  for (const n of active) {
    const slot = Number(n);
    if (slot >= 2 && slot <= 5) slots.push(`_${slot}`);
  }
  return [...new Set(slots)];
}

async function sendBotResponse(chatId, phone, db, io, sfx = '') {
  try {
    const priceText = db.getConfig(`price_text${sfx}`);
    if (priceText) {
      await client.sendMessage(chatId, priceText);
      const m = db.saveMessage(phone, 'out', 'text', priceText, null, true);
      io.emit('new_message', { phone, ...m });
      await sleep(800);
    }

    const audioPath = db.getConfig(`audio_file${sfx}`);
    if (audioPath && fs.existsSync(audioPath)) {
      const ext = path.extname(audioPath).toLowerCase();
      const mimeMap = { '.ogg': 'audio/ogg; codecs=opus', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webm': 'audio/webm; codecs=opus' };
      const mime = mimeMap[ext] || 'audio/ogg; codecs=opus';
      const data = fs.readFileSync(audioPath).toString('base64');
      const media = new MessageMedia(mime, data, `voice${ext}`);
      await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      const m = db.saveMessage(phone, 'out', 'audio', '🎵 Voice message', audioPath, true);
      io.emit('new_message', { phone, ...m });
      await sleep(1000);
    }

    const imagesJson = db.getConfig(`images${sfx}`);
    if (imagesJson) {
      const images = JSON.parse(imagesJson);
      for (const img of images) {
        const imgPath = img.path || img;
        if (fs.existsSync(imgPath)) {
          const media = MessageMedia.fromFilePath(imgPath);
          await client.sendMessage(chatId, media);
          const m = db.saveMessage(phone, 'out', 'image', '🖼 Product image', imgPath, true);
          io.emit('new_message', { phone, ...m });
          await sleep(600);
        }
      }
    }

    db.markBotHandled(phone);
    console.log(`🤖 Bot response sent to ${phone} (campaign${sfx || '1'})`);

    // Schedule 15-minute follow-up reminder if client doesn't reply
    const REMINDER_DEFAULT = 'مرحبا ممكن تخلي لينا شحال بغيتي و الإسم و العنوان و رقم الهاتف';
    setTimeout(async () => {
      try {
        if (!db.shouldSendReminder(phone)) return;
        const reminderText = db.getConfig('reminder_text') || REMINDER_DEFAULT;
        if (!reminderText.trim()) return;
        await client.sendMessage(chatId, reminderText);
        const m = db.saveMessage(phone, 'out', 'text', reminderText, null, true);
        io.emit('new_message', { phone, ...m });
        db.markReminderSent(phone);
        console.log(`⏰ Reminder sent to ${phone}`);
      } catch (err) {
        console.error('Reminder error:', err.message);
      }
    }, 15 * 60 * 1000);

  } catch (err) {
    console.error('Bot error:', err.message);
  }
}

async function sendText(phone, text) {
  if (!client || !isConnected) throw new Error('WhatsApp not connected');
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendMessage(text);
  } catch {
    await client.sendMessage(chatId, text);
  }
}

function getStatus() {
  return { connected: isConnected, qr: currentQR, info: clientInfo };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { init, getStatus, sendText };
