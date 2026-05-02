const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const db = require('./database');
const bot = require('./bot');

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || null;
// Stable token derived from password — survives restarts without a session store
const SESSION_TOKEN = AUTH_PASSWORD
  ? crypto.createHmac('sha256', AUTH_PASSWORD).update('wa-session-v1').digest('hex')
  : null;

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function requireAuth(req, res, next) {
  if (!SESSION_TOKEN) return next();
  if (parseCookies(req).wa_session === SESSION_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function convertToOpusOgg(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_wa.ogg';
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
  console.error('Upload-time audio conversion failed:', result.stderr?.toString().slice(-300));
  return null;
}

const UPLOADS_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, 'uploads');
[path.join(UPLOADS_DIR, 'audio'), path.join(UPLOADS_DIR, 'images')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

const makeStorage = (subdir) => multer.diskStorage({
  destination: path.join(UPLOADS_DIR, subdir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});

const uploadAudio  = multer({ storage: makeStorage('audio') });
const uploadImages = multer({ storage: makeStorage('images') });

// ── Auth ──────────────────────────────────────────────────
app.get('/api/auth/check', (req, res) => {
  if (!SESSION_TOKEN) return res.json({ ok: true });
  if (parseCookies(req).wa_session === SESSION_TOKEN) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.post('/api/auth/login', (req, res) => {
  if (!SESSION_TOKEN) return res.json({ ok: true });
  if (req.body.password === AUTH_PASSWORD) {
    res.setHeader('Set-Cookie', `wa_session=${SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'wa_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── Status ────────────────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => res.json(bot.getStatus()));

// ── Conversations ─────────────────────────────────────────
app.get('/api/conversations', requireAuth, (req, res) => res.json(db.getConversations()));

app.get('/api/conversations/:phone/messages', requireAuth, (req, res) =>
  res.json(db.getMessages(req.params.phone))
);

app.post('/api/conversations/:phone/read', requireAuth, (req, res) => {
  db.markAsRead(req.params.phone);
  res.json({ success: true });
});

// ── Send message ──────────────────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const { phone, text } = req.body;
  try {
    await bot.sendText(phone, text);
    const msg = db.saveMessage(phone, 'out', 'text', text, null, false);
    io.emit('new_message', { phone, ...msg });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config ────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => res.json(db.getAllConfig()));

app.post('/api/config', requireAuth, (req, res) => {
  const { trigger_keyword, price_text, trigger_keyword_2, price_text_2 } = req.body;
  if (trigger_keyword   !== undefined) db.setConfig('trigger_keyword',   trigger_keyword);
  if (price_text        !== undefined) db.setConfig('price_text',        price_text);
  if (trigger_keyword_2 !== undefined) db.setConfig('trigger_keyword_2', trigger_keyword_2);
  if (price_text_2      !== undefined) db.setConfig('price_text_2',      price_text_2);
  res.json({ success: true });
});

// ── Audio upload ──────────────────────────────────────────
app.post('/api/upload/audio', requireAuth, uploadAudio.single('audio'), (req, res) => {
  const sfx = req.query.slot === '2' ? '_2' : '';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const convertedPath = convertToOpusOgg(req.file.path);
  if (convertedPath && fs.existsSync(convertedPath)) {
    fs.unlinkSync(req.file.path);
    db.setConfig(`audio_file${sfx}`, convertedPath);
  } else {
    db.setConfig(`audio_file${sfx}`, req.file.path);
  }
  db.setConfig(`audio_name${sfx}`, req.file.originalname);
  res.json({ success: true, path: convertedPath || req.file.path, name: req.file.originalname });
});

app.delete('/api/upload/audio', requireAuth, (req, res) => {
  const sfx = req.query.slot === '2' ? '_2' : '';
  const p = db.getConfig(`audio_file${sfx}`);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  db.setConfig(`audio_file${sfx}`, '');
  db.setConfig(`audio_name${sfx}`, '');
  res.json({ success: true });
});

// ── Image upload ──────────────────────────────────────────
app.post('/api/upload/images', requireAuth, uploadImages.array('images', 20), (req, res) => {
  const sfx = req.query.slot === '2' ? '_2' : '';
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const existing = JSON.parse(db.getConfig(`images${sfx}`) || '[]');
  const newFiles = req.files.map(f => ({ path: f.path, name: f.originalname }));
  db.setConfig(`images${sfx}`, JSON.stringify([...existing, ...newFiles]));
  res.json({ success: true, files: newFiles });
});

app.delete('/api/upload/images/:filename', requireAuth, (req, res) => {
  const sfx = req.query.slot === '2' ? '_2' : '';
  const existing = JSON.parse(db.getConfig(`images${sfx}`) || '[]');
  const target = existing.find(f => f.path.includes(req.params.filename));
  if (target && fs.existsSync(target.path)) fs.unlinkSync(target.path);
  db.setConfig(`images${sfx}`, JSON.stringify(existing.filter(f => !f.path.includes(req.params.filename))));
  res.json({ success: true });
});

// ── Serve app ─────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  const status = bot.getStatus();
  if (status.qr) socket.emit('qr', status.qr);
  if (status.connected) socket.emit('ready', status.info);
});

// ── Start ─────────────────────────────────────────────────
bot.init(io, db);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 Open http://localhost:${PORT} in your browser\n`);
});
