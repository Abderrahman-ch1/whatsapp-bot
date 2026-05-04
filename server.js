// Prevent unhandled puppeteer/WA errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  Unhandled rejection (server kept alive):', err?.message || err);
});

// Load .env file for local development
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0 && !line.startsWith('#')) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k && !(k in process.env)) process.env[k] = v;
      }
    });
} catch {}

const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const https = require('https');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const db = require('./database');
const bot = require('./bot');

// Use bundled ffmpeg if system ffmpeg not available
const FFMPEG_PATH = (() => {
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch { return 'ffmpeg'; }
})();

// Credentials: DB values take priority over env vars (lets clients change their own password)
function getCredentials() {
  const username = db.getConfig('auth_username') || process.env.AUTH_USERNAME || null;
  const password = db.getConfig('auth_password') || process.env.AUTH_PASSWORD || null;
  return { username, password };
}

function makeToken(username, password) {
  return crypto.createHmac('sha256', password).update(`wa-session-v1:${username||''}`).digest('hex');
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function requireAuth(req, res, next) {
  const { password, username } = getCredentials();
  if (!password) return next();
  if (parseCookies(req).wa_session === makeToken(username, password)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function convertToOpusOgg(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_wa.ogg';
  const result = spawnSync(FFMPEG_PATH, [
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
  const { password, username } = getCredentials();
  if (!password) return res.json({ ok: true });
  if (parseCookies(req).wa_session === makeToken(username, password)) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.post('/api/auth/login', (req, res) => {
  const { password, username } = getCredentials();
  if (!password) return res.json({ ok: true });
  const usernameOk = !username || req.body.username === username;
  const passwordOk = req.body.password === password;
  if (usernameOk && passwordOk) {
    const token = makeToken(username, password);
    res.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong username or password' });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'wa_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/auth/change', requireAuth, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  const { password } = getCredentials();
  if (password && currentPassword !== password) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  if (!newUsername || !newUsername.trim()) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  db.setConfig('auth_username', newUsername.trim());
  db.setConfig('auth_password', newPassword);
  // Issue a new session cookie with the updated credentials
  const token = makeToken(newUsername.trim(), newPassword);
  res.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
  res.json({ ok: true });
});

// ── Subscription ──────────────────────────────────────────
app.get('/api/subscription/status', (req, res) => {
  const active  = db.getConfig('subscription_active') === '1';
  const plan    = db.getConfig('subscription_plan') || '';
  const expires = db.getConfig('subscription_expires') || '';
  const pending = db.getConfig('subscription_pending') === '1';

  let daysLeft = null;
  let isExpired = false;
  if (expires) {
    daysLeft = Math.ceil((new Date(expires) - Date.now()) / 86400000);
    isExpired = daysLeft <= 0;
  }

  if (active && isExpired) {
    db.setConfig('subscription_active', '0');
    return res.json({ active: false, plan, expires, daysLeft: 0, pending: false, expired: true });
  }

  res.json({ active, plan, expires, daysLeft, pending, expired: false });
});

app.post('/api/subscription/request', async (req, res) => {
  const { name, phone, email, plan } = req.body;
  if (!name || !phone || !plan) return res.status(400).json({ error: 'Missing required fields' });

  db.setConfig('subscription_pending',        '1');
  db.setConfig('subscription_requester_name',  name);
  db.setConfig('subscription_requester_phone', phone);
  db.setConfig('subscription_requester_email', email || '');
  db.setConfig('subscription_requested_plan',  plan);

  const planLabel = plan === 'pro' ? 'Pro — $25/mo (5 campaigns)' : 'Basic — $15/mo (1 campaign)';
  const appUrl    = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const secret    = process.env.ADMIN_SECRET || 'admin123';
  const grantUrl  = `${appUrl}/api/admin/grant?secret=${secret}&plan=${plan}&days=30`;
  const adminUrl = `${appUrl}/admin?secret=${secret}`;
  const msg = `🆕 New Whatsy subscription request!\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || 'N/A'}\nPlan: ${planLabel}\n\n👉 Open admin panel to grant access:\n${adminUrl}`;

  await sendTelegram(msg);
  res.json({ success: true });
});

app.get('/api/admin/grant', (req, res) => {
  const { secret, plan, days } = req.query;
  const adminSecret = process.env.ADMIN_SECRET || 'admin123';
  if (secret !== adminSecret) return res.status(401).send('❌ Wrong secret');

  const numDays = parseInt(days) || 30;
  if (numDays <= 0) {
    db.setConfig('subscription_active', '0');
    db.setConfig('subscription_pending', '0');
    db.setConfig('subscription_plan', '');
    db.setConfig('subscription_expires', '');
    return res.send('✅ Access revoked. App reset to fresh state.');
  }

  const expires = new Date(Date.now() + numDays * 86400000);
  db.setConfig('subscription_active',  '1');
  db.setConfig('subscription_plan',    plan || 'basic');
  db.setConfig('subscription_expires', expires.toISOString());
  db.setConfig('subscription_pending', '0');

  // Fresh setup: wipe all bot config, uploads, and conversations
  if (req.query.fresh === '1') {
    const botKeys = ['trigger_keyword','price_text','reminder_text','active_campaigns'];
    for (let i = 2; i <= 5; i++) botKeys.push(`trigger_keyword_${i}`, `price_text_${i}`);
    for (const sfx of ['','_2','_3','_4','_5']) {
      botKeys.push(`audio_file${sfx}`, `audio_name${sfx}`, `images${sfx}`);
      const audioPath = db.getConfig(`audio_file${sfx}`);
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      try {
        const imgs = JSON.parse(db.getConfig(`images${sfx}`) || '[]');
        imgs.forEach(img => { const p = img.path||img; if (fs.existsSync(p)) fs.unlinkSync(p); });
      } catch {}
    }
    botKeys.forEach(k => db.setConfig(k, ''));
    db.clearConversations();
  }

  const planLabel = plan === 'pro' ? 'Pro' : 'Basic';
  console.log(`\n✅ Access granted: ${planLabel} plan, expires ${expires.toDateString()}\n`);
  res.send(`✅ Access granted! Plan: ${planLabel}, Expires: ${expires.toDateString()}`);
});

// ── Admin panel ───────────────────────────────────────────
app.get('/admin', (req, res) => {
  const { secret } = req.query;
  const adminSecret = process.env.ADMIN_SECRET || 'admin123';
  if (secret !== adminSecret) return res.status(401).send('❌ Wrong secret');

  const sub = {
    active:  db.getConfig('subscription_active') === '1',
    plan:    db.getConfig('subscription_plan') || '—',
    expires: db.getConfig('subscription_expires') || '—',
    name:    db.getConfig('subscription_requester_name') || '—',
    phone:   db.getConfig('subscription_requester_phone') || '—',
    email:   db.getConfig('subscription_requester_email') || '—',
  };

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Whatsy Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#1a1d27;border:1px solid #2d3148;border-radius:16px;padding:32px;width:100%;max-width:420px;display:flex;flex-direction:column;gap:20px}
    h1{font-size:20px;font-weight:700;color:#fff}
    .info{background:#0f1117;border-radius:10px;padding:14px;font-size:13px;color:#94a3b8;display:flex;flex-direction:column;gap:6px}
    .info strong{color:#e2e8f0}
    .status{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.05em}
    .active{background:rgba(79,172,254,.15);color:#4facfe}
    .inactive{background:rgba(239,68,68,.15);color:#ef4444}
    label{font-size:12px;color:#94a3b8;margin-bottom:4px;display:block}
    input,select{width:100%;padding:10px 12px;background:#0f1117;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;font-size:14px;outline:none}
    input:focus,select:focus{border-color:#4facfe}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    button{width:100%;padding:12px;border-radius:8px;border:none;font-size:14px;font-weight:700;cursor:pointer;transition:.15s}
    .btn-grant{background:linear-gradient(135deg,#4facfe,#00f2fe);color:#000}
    .btn-grant:hover{opacity:.9}
    .btn-revoke{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
    .btn-revoke:hover{background:rgba(239,68,68,.25)}
    .msg{padding:10px 14px;border-radius:8px;font-size:13px;display:none}
    .msg.ok{background:rgba(79,172,254,.1);color:#4facfe;border:1px solid rgba(79,172,254,.2)}
    .msg.err{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
    hr{border:none;border-top:1px solid #2d3148}
  </style>
</head><body>
<div class="card">
  <h1>⚙️ Whatsy Admin</h1>

  <div class="info">
    <div>Status: <span class="status ${sub.active ? 'active' : 'inactive'}">${sub.active ? 'ACTIVE' : 'INACTIVE'}</span></div>
    <div><strong>Client:</strong> ${sub.name} — ${sub.phone}</div>
    <div><strong>Plan:</strong> ${sub.plan} &nbsp;|&nbsp; <strong>Expires:</strong> ${sub.expires !== '—' ? new Date(sub.expires).toDateString() : '—'}</div>
  </div>

  <hr>

  <div>
    <label>Plan</label>
    <select id="plan"><option value="pro">Pro — $25/mo (5 campaigns)</option><option value="basic">Basic — $15/mo (1 campaign)</option></select>
  </div>
  <div class="row">
    <div><label>Username</label><input id="username" placeholder="e.g. client1"></div>
    <div><label>Password</label><input id="password" placeholder="min 6 chars" type="password"></div>
  </div>
  <div><label>Days</label><input id="days" value="30" type="number" min="1"></div>
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#94a3b8">
    <input type="checkbox" id="fresh" checked style="width:auto;accent-color:#4facfe">
    Clear bot configuration (new client setup)
  </label>

  <button class="btn-grant" onclick="grant()">✅ Grant Access</button>
  <button class="btn-revoke" onclick="revoke()">🔒 Revoke Access</button>
  <div id="msg" class="msg"></div>
</div>

<script>
const secret = '${adminSecret}';
async function grant() {
  const plan = document.getElementById('plan').value;
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const days = document.getElementById('days').value;
  const fresh = document.getElementById('fresh').checked;
  if (!username || !password) return showMsg('Username and password are required', false);
  if (password.length < 6) return showMsg('Password must be at least 6 characters', false);
  const r1 = await fetch('/api/admin/grant?secret='+secret+'&plan='+plan+'&days='+days+'&fresh='+(fresh?'1':'0'));
  const t1 = await r1.text();
  const r2 = await fetch('/api/admin/set-credentials?secret='+secret+'&username='+encodeURIComponent(username)+'&password='+encodeURIComponent(password));
  const t2 = await r2.text();
  showMsg(r1.ok && r2.ok ? '✅ Access granted & credentials set! Client can now log in.' : t1+' / '+t2, r1.ok && r2.ok);
  if (r1.ok) setTimeout(() => location.reload(), 1500);
}
async function revoke() {
  const r = await fetch('/api/admin/grant?secret='+secret+'&plan=basic&days=0');
  showMsg(r.ok ? '🔒 Access revoked.' : await r.text(), r.ok);
  if (r.ok) setTimeout(() => location.reload(), 1500);
}
function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}
</script>
</body></html>`);
});

app.get('/api/admin/set-credentials', (req, res) => {
  const { secret, username, password } = req.query;
  const adminSecret = process.env.ADMIN_SECRET || 'admin123';
  if (secret !== adminSecret) return res.status(401).send('❌ Wrong secret');
  if (!username || !password) return res.status(400).send('❌ username and password are required');
  if (password.length < 6) return res.status(400).send('❌ Password must be at least 6 characters');
  db.setConfig('auth_username', username.trim());
  db.setConfig('auth_password', password.trim());
  console.log(`\n🔑 Credentials set — username: ${username}\n`);
  res.send(`✅ Credentials set`);
});

function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) {
    console.log('\n📩 [Telegram not configured — notification below]\n' + text + '\n');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { r.resume(); r.on('end', resolve); });
    req.on('error', (e) => { console.error('Telegram error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Status ────────────────────────────────────────────────
// Public so the QR screen can be shown before dashboard login.
app.get('/api/status', (req, res) => res.json(bot.getStatus()));

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
  const allowed = ['trigger_keyword', 'price_text', 'reminder_text', 'active_campaigns'];
  for (let i = 2; i <= 5; i++) { allowed.push(`trigger_keyword_${i}`, `price_text_${i}`); }
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.setConfig(key, req.body[key]);
  }
  res.json({ success: true });
});

app.delete('/api/campaigns/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot < 2 || slot > 5) return res.status(400).json({ error: 'Only campaigns 2-5 can be removed' });

  const sfx = `_${slot}`;
  const audioPath = db.getConfig(`audio_file${sfx}`);
  if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

  try {
    const images = JSON.parse(db.getConfig(`images${sfx}`) || '[]');
    for (const img of images) {
      const p = img.path || img;
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}

  db.setConfig(`trigger_keyword${sfx}`, '');
  db.setConfig(`price_text${sfx}`, '');
  db.setConfig(`audio_file${sfx}`, '');
  db.setConfig(`audio_name${sfx}`, '');
  db.setConfig(`images${sfx}`, '');

  let active = [];
  try { active = JSON.parse(db.getConfig('active_campaigns') || '[]'); } catch {}
  db.setConfig('active_campaigns', JSON.stringify(active.filter(n => Number(n) !== slot)));

  res.json({ success: true });
});

// ── Audio upload ──────────────────────────────────────────
app.post('/api/upload/audio', requireAuth, uploadAudio.single('audio'), (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx = slot > 1 ? `_${slot}` : '';
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
  const slot = parseInt(req.query.slot) || 1;
  const sfx = slot > 1 ? `_${slot}` : '';
  const p = db.getConfig(`audio_file${sfx}`);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  db.setConfig(`audio_file${sfx}`, '');
  db.setConfig(`audio_name${sfx}`, '');
  res.json({ success: true });
});

// ── Image upload ──────────────────────────────────────────
app.post('/api/upload/images', requireAuth, uploadImages.array('images', 20), (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx = slot > 1 ? `_${slot}` : '';
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const existing = JSON.parse(db.getConfig(`images${sfx}`) || '[]');
  const newFiles = req.files.map(f => ({ path: f.path, name: f.originalname }));
  db.setConfig(`images${sfx}`, JSON.stringify([...existing, ...newFiles]));
  res.json({ success: true, files: newFiles });
});

app.delete('/api/upload/images/:filename', requireAuth, (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx = slot > 1 ? `_${slot}` : '';
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
