const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let client = null;
let currentQR = null;
let isConnected = false;
let clientInfo = null;

const DATA_DIR = process.env.DATA_DIR || '.';

function convertToOpus(inputPath) {
  const outputPath = inputPath + '_wa.ogg';
  // WhatsApp voice notes: OGG container, OPUS codec, mono 16 kHz — same as WA native recordings
  const result = spawnSync('ffmpeg', [
    '-i', inputPath,
    '-c:a', 'libopus',
    '-b:a', '32k',
    '-ar', '16000',
    '-ac', '1',
    '-vn',
    '-f', 'ogg',
    outputPath, '-y'
  ], { timeout: 30000 });
  if (result.status === 0) return outputPath;
  console.error('Audio conversion failed:', result.stderr?.toString().slice(-200));
  return null;
}

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
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('@g.us')) return;

    const phone = msg.from.replace('@c.us', '');
    const body = msg.body || '';
    const contactName = msg._data?.notifyName || phone;

    db.upsertContact(phone, contactName);

    // Detect trigger match before saving so we can skip the unread increment
    const alreadyHandled = db.isContactBotHandled(phone);
    const triggerKw  = db.getConfig('trigger_keyword');
    const triggerKw2 = db.getConfig('trigger_keyword_2');
    const lc = body.toLowerCase();
    const matchedSlot =
      !alreadyHandled && triggerKw  && lc.includes(triggerKw.toLowerCase())  ? '' :
      !alreadyHandled && triggerKw2 && lc.includes(triggerKw2.toLowerCase()) ? '_2' : null;

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
      const convertedPath = convertToOpus(audioPath);
      try {
        let media;
        if (convertedPath && fs.existsSync(convertedPath)) {
          // Explicit MIME type so WhatsApp treats it as a native voice note on all devices
          const data = fs.readFileSync(convertedPath).toString('base64');
          media = new MessageMedia('audio/ogg; codecs=opus', data, 'voice.ogg');
        } else {
          media = MessageMedia.fromFilePath(audioPath);
        }
        await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
        const m = db.saveMessage(phone, 'out', 'audio', '🎵 Voice message', audioPath, true);
        io.emit('new_message', { phone, ...m });
        await sleep(1000);
      } finally {
        if (convertedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
      }
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
  } catch (err) {
    console.error('Bot error:', err.message);
  }
}

async function sendText(phone, text) {
  if (!client || !isConnected) throw new Error('WhatsApp not connected');
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  await client.sendMessage(chatId, text);
}

function getStatus() {
  return { connected: isConnected, qr: currentQR, info: clientInfo };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { init, getStatus, sendText };
