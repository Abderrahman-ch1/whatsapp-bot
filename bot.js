const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

let client = null;
let currentQR = null;
let isConnected = false;
let clientInfo = null;

const DATA_DIR = process.env.DATA_DIR || '.';

// Remove Chromium lock files left by crashed/restarted containers
function clearChromiumLocks() {
  const base = path.join(DATA_DIR, '.wwebjs_auth', 'session-default');
  ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
    try { fs.unlinkSync(path.join(base, f)); } catch {}
  });
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
    const saved = db.saveMessage(phone, 'in', 'text', body, null, false);

    io.emit('new_message', { phone, name: contactName, ...saved });

    const triggerKw = db.getConfig('trigger_keyword');
    const alreadyHandled = db.isContactBotHandled(phone);

    if (!alreadyHandled && triggerKw && body.toLowerCase().includes(triggerKw.toLowerCase())) {
      await sendBotResponse(msg.from, phone, db, io);
    }
  });

  console.log('🚀 Starting WhatsApp — this may take 30 seconds...');
  client.initialize();
}

async function sendBotResponse(chatId, phone, db, io) {
  try {
    const priceText = db.getConfig('price_text');
    if (priceText) {
      await client.sendMessage(chatId, priceText);
      const m = db.saveMessage(phone, 'out', 'text', priceText, null, true);
      io.emit('new_message', { phone, ...m });
      await sleep(800);
    }

    const audioPath = db.getConfig('audio_file');
    if (audioPath && fs.existsSync(audioPath)) {
      const media = MessageMedia.fromFilePath(audioPath);
      await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      const m = db.saveMessage(phone, 'out', 'audio', '🎵 Voice message', audioPath, true);
      io.emit('new_message', { phone, ...m });
      await sleep(1000);
    }

    const imagesJson = db.getConfig('images');
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
    console.log(`🤖 Bot response sent to ${phone}`);
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
