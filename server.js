const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const db = require('./database');
const bot = require('./bot');

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

// ── Status ────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json(bot.getStatus()));

// ── Conversations ─────────────────────────────────────────
app.get('/api/conversations', (req, res) => res.json(db.getConversations()));

app.get('/api/conversations/:phone/messages', (req, res) =>
  res.json(db.getMessages(req.params.phone))
);

app.post('/api/conversations/:phone/read', (req, res) => {
  db.markAsRead(req.params.phone);
  res.json({ success: true });
});

// ── Send message ──────────────────────────────────────────
app.post('/api/send', async (req, res) => {
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
app.get('/api/config', (req, res) => res.json(db.getAllConfig()));

app.post('/api/config', (req, res) => {
  const { trigger_keyword, price_text } = req.body;
  if (trigger_keyword !== undefined) db.setConfig('trigger_keyword', trigger_keyword);
  if (price_text !== undefined) db.setConfig('price_text', price_text);
  res.json({ success: true });
});

// ── Audio upload ──────────────────────────────────────────
app.post('/api/upload/audio', uploadAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  db.setConfig('audio_file', req.file.path);
  db.setConfig('audio_name', req.file.originalname);
  res.json({ success: true, path: req.file.path, name: req.file.originalname });
});

app.delete('/api/upload/audio', (req, res) => {
  const p = db.getConfig('audio_file');
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  db.setConfig('audio_file', '');
  db.setConfig('audio_name', '');
  res.json({ success: true });
});

// ── Image upload ──────────────────────────────────────────
app.post('/api/upload/images', uploadImages.array('images', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const existing = JSON.parse(db.getConfig('images') || '[]');
  const newFiles = req.files.map(f => ({ path: f.path, name: f.originalname }));
  db.setConfig('images', JSON.stringify([...existing, ...newFiles]));
  res.json({ success: true, files: newFiles });
});

app.delete('/api/upload/images/:filename', (req, res) => {
  const existing = JSON.parse(db.getConfig('images') || '[]');
  const target = existing.find(f => f.path.includes(req.params.filename));
  if (target && fs.existsSync(target.path)) fs.unlinkSync(target.path);
  db.setConfig('images', JSON.stringify(existing.filter(f => !f.path.includes(req.params.filename))));
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
