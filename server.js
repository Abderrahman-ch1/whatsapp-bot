process.on('uncaughtException',  (err) => console.error('⚠️  Uncaught exception:', err.message));
process.on('unhandledRejection', (err) => console.error('⚠️  Unhandled rejection:', err?.message || err));

// Load .env for local dev
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

const express    = require('express');
const { Server } = require('socket.io');
const http       = require('http');
const https      = require('https');
const path       = require('path');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const crypto     = require('crypto');
const { spawnSync } = require('child_process');

const registry         = require('./registry');
const { getTenantDB }  = require('./database');
const bot              = require('./bot');

const DATA_DIR       = process.env.DATA_DIR || '.';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_SECRET || 'whatsy-secret';
const ADMIN_SECRET   = process.env.ADMIN_SECRET || 'admin123';

const FFMPEG_PATH = (() => {
  try { return require('@ffmpeg-installer/ffmpeg').path; } catch { return 'ffmpeg'; }
})();

// ── Session helpers ──────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function makeSessionToken(tenantId) {
  const payload = Buffer.from(JSON.stringify({ tenantId })).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function parseSessionToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  try {
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const session = parseSessionToken(parseCookies(req).wa_session);
  if (!session?.tenantId) return res.status(401).json({ error: 'Unauthorized' });
  req.tenantId = session.tenantId;
  next();
}

function adminAuth(req, res, next) {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) return res.status(401).send('❌ Wrong admin secret');
  next();
}

function getDB(req) { return getTenantDB(req.tenantId); }

// ── Audio conversion ─────────────────────────────────────────────
function convertToOpusOgg(inputPath) {
  const outputPath = inputPath.replace(/\.[^.]+$/, '') + '_wa.ogg';
  const result = spawnSync(FFMPEG_PATH, [
    '-i', inputPath, '-c:a', 'libopus', '-b:a', '64k',
    '-ar', '48000', '-ac', '1', '-vn', '-f', 'ogg', outputPath, '-y'
  ], { timeout: 30000 });
  if (result.status === 0) return outputPath;
  console.error('Audio conversion failed:', result.stderr?.toString().slice(-300));
  return null;
}

// ── Express setup ────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

bot.setIO(io);

app.use(cors());
app.use(express.json());

// Block direct access to sensitive server-side files
const BLOCKED_FILES = /\.(js|json|db|env|mjs|cjs|log|sqlite|sqlite3)$/i;
const BLOCKED_NAMES = /^(server|bot|database|registry|package|yarn\.lock|package-lock|\.env|take_)/i;
app.use((req, res, next) => {
  const base = path.basename(req.path);
  if (BLOCKED_FILES.test(base) && BLOCKED_NAMES.test(base)) return res.status(403).end();
  next();
});

app.use(express.static(__dirname));

// Per-tenant uploads (auth-protected, path-traversal safe)
app.get('/uploads/:tenantId/*', requireAuth, (req, res) => {
  if (req.params.tenantId !== req.tenantId) return res.status(403).end();
  const relative = req.params[0];
  // Block path traversal attempts
  if (relative.includes('..') || path.isAbsolute(relative)) return res.status(403).end();
  const tenantUploadsDir = path.join(DATA_DIR, 'tenants', req.params.tenantId, 'uploads');
  const filePath = path.join(tenantUploadsDir, relative);
  // Ensure resolved path stays within tenant uploads dir
  if (!filePath.startsWith(tenantUploadsDir + path.sep) && filePath !== tenantUploadsDir) return res.status(403).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath, { root: '/' });
});

// Dynamic per-tenant multer storage
const uploadAudio = multer({
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_DIR, 'tenants', req.tenantId, 'uploads', 'audio');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
});

const uploadImages = multer({
  limits: { fileSize: 10 * 1024 * 1024, files: 20 }, // 10 MB per image, 20 max
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_DIR, 'tenants', req.tenantId, 'uploads', 'images');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
});

const uploadComparison = multer({
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_DIR, 'tenants', req.tenantId, 'uploads', 'comparison');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
});

// ── Login rate limiting (5 attempts per 15 min per IP) ───────────
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const window = 15 * 60 * 1000;
  const max = 5;
  const entry = loginAttempts.get(ip) || { count: 0, reset: now + window };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + window; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= max;
}
// Clean old entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) if (now > entry.reset) loginAttempts.delete(ip);
}, 30 * 60 * 1000);

// ── Auth routes ──────────────────────────────────────────────────
app.get('/api/auth/check', (req, res) => {
  const session = parseSessionToken(parseCookies(req).wa_session);
  if (!session?.tenantId) return res.status(401).json({ ok: false });
  const tenant = registry.getTenant(session.tenantId);
  if (!tenant) return res.status(401).json({ ok: false });
  res.json({ ok: true, tenantId: session.tenantId });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!checkLoginRate(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = req.body;
  const result = registry.verifyLogin(username, password);
  if (!result) return res.status(401).json({ error: 'Wrong username or password' });

  // Start bot for this tenant if not already running
  const db = getTenantDB(result.tenantId);
  bot.initTenant(result.tenantId, db);

  const token = makeSessionToken(result.tenantId);
  res.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
  res.json({ ok: true, tenantId: result.tenantId });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'wa_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/auth/change', requireAuth, (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (!newUsername?.trim()) return res.status(400).json({ error: 'Username cannot be empty' });

  const tenant = registry.getTenant(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (!registry.verifyPassword(currentPassword, tenant.pwd_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  registry.updateCredentials(req.tenantId, newUsername.trim(), newPassword);
  const token = makeSessionToken(req.tenantId);
  res.setHeader('Set-Cookie', `wa_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict`);
  res.json({ ok: true });
});

// ── Subscription routes ──────────────────────────────────────────
app.get('/api/subscription/status', requireAuth, (req, res) => {
  const status = registry.getSubscriptionStatus(req.tenantId);
  // Store plan in tenant DB so bot can read it for campaign gating
  if (status.plan) getDB(req).setConfig('subscription_plan', status.plan);
  res.json(status);
});

app.post('/api/subscription/request', async (req, res) => {
  const { name, phone, email, plan } = req.body;
  if (!name || !phone || !plan) return res.status(400).json({ error: 'Missing required fields' });

  registry.createAccessRequest({ name, phone, email, plan });

  const planLabel = plan === 'pro' ? 'Pro — $25/mo (5 campaigns)' : 'Basic — $15/mo (1 campaign)';
  const appUrl    = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const adminUrl  = `${appUrl}/admin?secret=${encodeURIComponent(ADMIN_SECRET)}`;
  const msg = `🆕 New Whatsy subscription request!\n\nName: ${name}\nPhone: ${phone}\nEmail: ${email || 'N/A'}\nPlan: ${planLabel}\n\n👉 Open admin panel to grant access:\n${adminUrl}`;

  await sendTelegram(msg);
  res.json({ success: true });
});

// ── Admin routes ─────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const RAM_PER_BOT_MB = 300;
  const PLAN_RAM_MB    = parseInt(process.env.SERVER_RAM_MB || '4096', 10);
  const running        = bot.getRunningCount();
  const usedMB         = running * RAM_PER_BOT_MB;
  const pct            = Math.min(100, Math.round((usedMB / PLAN_RAM_MB) * 100));
  res.json({ running, usedMB, totalMB: PLAN_RAM_MB, pct });
});

app.get('/api/admin/tenants', adminAuth, (req, res) => {
  const tenants = registry.getAllTenants().map(t => {
    const status = bot.getStatus(t.id);
    return { ...t, whatsappName: status.connected ? (status.info?.pushname || null) : null };
  });
  res.json(tenants);
});

app.post('/api/admin/tenants', adminAuth, (req, res) => {
  const { id, username, password, plan, days, fresh } = req.body;
  if (!id || !username || !password) return res.status(400).json({ error: 'id, username, password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  registry.upsertTenant({ id, username, password, plan: plan || 'basic', days: parseInt(days, 10) || 30 });

  if (fresh === true || fresh === 'true' || fresh === 1) {
    const db = getTenantDB(id);
    db.clearBotConfig();
    db.clearConversations();
    // Remove uploads dir
    const uploadsDir = path.join(DATA_DIR, 'tenants', id, 'uploads');
    try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`✅ Tenant ${id} upserted: plan=${plan}, days=${days}`);
  res.json({ ok: true });
});

app.post('/api/admin/tenants/:id/revoke', adminAuth, (req, res) => {
  registry.revokeTenant(req.params.id);
  bot.stopTenant(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/requests', adminAuth, (req, res) => {
  res.json(registry.getAccessRequests());
});

app.delete('/api/admin/requests/:id', adminAuth, (req, res) => {
  registry.deleteAccessRequest(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ── Admin panel HTML ─────────────────────────────────────────────
app.get('/admin', adminAuth, (req, res) => {
  const secret = ADMIN_SECRET;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Whatsy Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;padding:24px}
h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:24px}
h2{font-size:15px;font-weight:700;color:#94a3b8;margin-bottom:14px;letter-spacing:.05em;text-transform:uppercase}
.card{background:#1a1d27;border:1px solid #2d3148;border-radius:14px;padding:24px;margin-bottom:24px}
.ram-bar-wrap{background:#0f1117;border-radius:99px;height:10px;overflow:hidden;margin:10px 0 6px}
.ram-bar{height:100%;border-radius:99px;transition:width .5s}
.ram-ok{background:linear-gradient(90deg,#4facfe,#00f2fe)}
.ram-warn{background:linear-gradient(90deg,#f59e0b,#fbbf24)}
.ram-danger{background:linear-gradient(90deg,#ef4444,#f87171)}
.ram-label{font-size:12px;color:#64748b}
.ram-alert{margin-top:10px;padding:10px 14px;border-radius:8px;font-size:13px;background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.25);display:none}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;color:#64748b;font-weight:600;border-bottom:1px solid #2d3148}
td{padding:10px 12px;border-bottom:1px solid #1e2235;vertical-align:middle}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700}
.active{background:rgba(79,172,254,.15);color:#4facfe}
.inactive{background:rgba(239,68,68,.15);color:#ef4444}
.days-ok{color:#4facfe;font-weight:700}
.days-warn{color:#f59e0b;font-weight:700}
.days-danger{color:#ef4444;font-weight:700}
label{font-size:12px;color:#94a3b8;margin-bottom:4px;display:block;margin-top:10px}
label:first-child{margin-top:0}
input,select{width:100%;padding:9px 11px;background:#0f1117;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;font-size:13px;outline:none}
input:focus,select:focus{border-color:#4facfe}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
button{padding:9px 18px;border-radius:8px;border:none;font-size:13px;font-weight:700;cursor:pointer;transition:.15s}
.btn-grant{background:linear-gradient(135deg,#4facfe,#00f2fe);color:#000}
.btn-grant:hover{opacity:.9}
.btn-revoke{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3);padding:6px 14px;font-size:12px}
.btn-revoke:hover{background:rgba(239,68,68,.25)}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-top:12px;display:none}
.msg.ok{background:rgba(79,172,254,.1);color:#4facfe;border:1px solid rgba(79,172,254,.2)}
.msg.err{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
hr{border:none;border-top:1px solid #2d3148;margin:20px 0}
.req-item{padding:12px;background:#0f1117;border-radius:8px;margin-bottom:8px;font-size:13px;cursor:pointer}
.req-item:hover{background:#141824}
.req-item strong{color:#fff}
.req-item span{color:#64748b;font-size:11px;margin-left:8px}
</style>
</head><body>
<h1>⚙️ Whatsy Admin</h1>

<!-- RAM usage widget -->
<div class="card" id="ram-card">
  <h2>Server Capacity</h2>
  <div class="ram-bar-wrap"><div class="ram-bar ram-ok" id="ram-bar" style="width:0%"></div></div>
  <div class="ram-label" id="ram-label">Loading...</div>
  <div class="ram-alert" id="ram-alert">⚠️ You are using over 80% of estimated RAM. Consider upgrading your Hetzner server before adding more clients to avoid crashes.</div>
</div>

<!-- Tenants table -->
<div class="card">
  <h2>Tenants</h2>
  <div id="tenants-wrap"><p style="color:#64748b;font-size:13px">Loading...</p></div>
</div>

<!-- Pending requests -->
<div class="card">
  <h2>Pending Requests</h2>
  <div id="requests-wrap"><p style="color:#64748b;font-size:13px">Loading...</p></div>
</div>

<!-- Grant / create tenant form -->
<div class="card">
  <h2>Grant Access</h2>
  <label>Tenant ID (slug, no spaces)</label>
  <input id="tid" placeholder="e.g. shop99">
  <div class="row">
    <div><label>Username</label><input id="username" placeholder="e.g. abdoo"></div>
    <div><label>Password</label><input id="password" type="password" placeholder="min 6 chars"></div>
  </div>
  <div class="row">
    <div><label>Plan</label><select id="plan"><option value="pro">Pro — $25/mo (5 campaigns)</option><option value="basic">Basic — $15/mo (1 campaign)</option></select></div>
    <div><label>Days</label><input id="days" value="30" type="number" min="1"></div>
  </div>
  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:12px">
    <input type="checkbox" id="fresh" checked style="width:auto;accent-color:#4facfe">
    <span style="font-size:13px;color:#94a3b8">Clear bot config & conversations (new client setup)</span>
  </label>
  <div style="margin-top:16px">
    <button class="btn-grant" onclick="grantAccess()">✅ Grant Access</button>
  </div>
  <div id="msg" class="msg"></div>
</div>

<script>
const secret = '${secret.replace(/'/g,"\\'")}';
const qp = encodeURIComponent(secret);

async function loadTenants() {
  const r = await fetch('/api/admin/tenants?secret=' + qp);
  const tenants = await r.json();
  const wrap = document.getElementById('tenants-wrap');
  if (!tenants.length) { wrap.innerHTML = '<p style="color:#64748b;font-size:13px">No tenants yet.</p>'; return; }
  wrap.innerHTML = '<table><thead><tr><th>ID</th><th>Username</th><th>WhatsApp</th><th>Plan</th><th>Expires</th><th>Days Left</th><th>Status</th><th></th></tr></thead><tbody>' +
    tenants.map(t => {
      const dColor = t.daysLeft === null ? '' : t.daysLeft <= 5 ? 'days-danger' : t.daysLeft <= 15 ? 'days-warn' : 'days-ok';
      const dText  = t.daysLeft === null ? '—' : t.daysLeft <= 0 ? 'EXPIRED' : t.daysLeft + ' days';
      const exp    = t.expires ? new Date(t.expires).toDateString() : '—';
      const wa     = t.whatsappName ? '<span style="color:#34d399">' + t.whatsappName + '</span>' : '<span style="color:#64748b">— not connected —</span>';
      return '<tr>' +
        '<td><strong style="color:#fff">' + t.id + '</strong></td>' +
        '<td>' + t.username + '</td>' +
        '<td style="font-size:12px">' + wa + '</td>' +
        '<td>' + t.plan + '</td>' +
        '<td style="font-size:12px;color:#64748b">' + exp + '</td>' +
        '<td><span class="' + dColor + '">' + dText + '</span></td>' +
        '<td><span class="badge ' + (t.active ? 'active' : 'inactive') + '">' + (t.active ? 'ACTIVE' : 'INACTIVE') + '</span></td>' +
        '<td><button class="btn-revoke" onclick="revokeTenant(\\''+t.id+'\\')">Revoke</button></td>' +
        '</tr>';
    }).join('') + '</tbody></table>';
}

async function loadRequests() {
  const r = await fetch('/api/admin/requests?secret=' + qp);
  const reqs = await r.json();
  const wrap = document.getElementById('requests-wrap');
  if (!reqs.length) { wrap.innerHTML = '<p style="color:#64748b;font-size:13px">No pending requests.</p>'; return; }
  wrap.innerHTML = reqs.map(r =>
    '<div class="req-item" style="display:flex;align-items:center;justify-content:space-between">' +
    '<div onclick="prefill(\\''+r.name+'\\',\\''+r.phone+'\\',\\''+r.plan+'\\')" style="flex:1;cursor:pointer">' +
    '<strong>' + r.name + '</strong> — ' + r.phone +
    '<span>' + r.plan + '</span>' +
    '<span>' + new Date(r.created_at).toLocaleString() + '</span>' +
    '</div>' +
    '<button class="btn-revoke" style="margin-left:12px;flex-shrink:0" onclick="deleteRequest('+r.id+')">✕ Delete</button>' +
    '</div>'
  ).join('');
}

async function deleteRequest(id) {
  await fetch('/api/admin/requests/' + id + '?secret=' + qp, { method: 'DELETE' });
  loadRequests();
}

function prefill(name, phone, plan) {
  document.getElementById('tid').value = phone.replace(/\\D/g,'').slice(-8);
  document.getElementById('plan').value = plan;
}

async function grantAccess() {
  const id       = document.getElementById('tid').value.trim().replace(/\\s+/g,'-').toLowerCase();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const plan     = document.getElementById('plan').value;
  const days     = document.getElementById('days').value;
  const fresh    = document.getElementById('fresh').checked;
  if (!id) return showMsg('Tenant ID is required', false);
  if (!username || !password) return showMsg('Username and password are required', false);
  if (password.length < 6) return showMsg('Password must be at least 6 characters', false);

  const r = await fetch('/api/admin/tenants?secret=' + qp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username, password, plan, days, fresh })
  });
  const data = await r.json();
  if (r.ok) {
    showMsg('✅ Access granted! Client can now log in at this URL.', true);
    setTimeout(() => { loadTenants(); loadRequests(); }, 1000);
  } else {
    showMsg(data.error || 'Error', false);
  }
}

async function revokeTenant(id) {
  if (!confirm('Revoke access for ' + id + '?')) return;
  const r = await fetch('/api/admin/tenants/' + id + '/revoke?secret=' + qp, { method: 'POST' });
  if (r.ok) { showMsg('🔒 Access revoked for ' + id, true); loadTenants(); }
  else showMsg('Error revoking', false);
}

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.style.display = 'block';
}

async function loadStats() {
  try {
    const r = await fetch('/api/admin/stats?secret=' + qp);
    const s = await r.json();
    const bar   = document.getElementById('ram-bar');
    const label = document.getElementById('ram-label');
    const alert = document.getElementById('ram-alert');
    const cls   = s.pct >= 80 ? 'ram-danger' : s.pct >= 55 ? 'ram-warn' : 'ram-ok';
    bar.style.width = s.pct + '%';
    bar.className   = 'ram-bar ' + cls;
    label.textContent = s.running + ' bot' + (s.running !== 1 ? 's' : '') + ' running — ~' + s.usedMB + ' MB / ' + s.totalMB + ' MB estimated (' + s.pct + '%)';
    alert.style.display = s.pct >= 80 ? 'block' : 'none';
  } catch {}
}

loadTenants();
loadRequests();
loadStats();
setInterval(loadStats, 30000);
setInterval(loadTenants, 15000);
</script>
</body></html>`);
});

// ── Bot status ───────────────────────────────────────────────────
app.get('/api/status', requireAuth, (req, res) => res.json(bot.getStatus(req.tenantId)));

// ── Conversations ────────────────────────────────────────────────
app.get('/api/conversations', requireAuth, (req, res) => {
  const archived = req.query.archived === '1';
  res.json(getDB(req).getConversations(archived));
});

app.post('/api/conversations/:phone/archive', requireAuth, (req, res) => {
  getDB(req).archiveContact(req.params.phone, true);
  res.json({ ok: true });
});

app.post('/api/conversations/:phone/unarchive', requireAuth, (req, res) => {
  getDB(req).archiveContact(req.params.phone, false);
  res.json({ ok: true });
});

app.delete('/api/conversations/:phone', requireAuth, (req, res) => {
  getDB(req).deleteConversation(req.params.phone);
  res.json({ ok: true });
});

app.get('/api/conversations/:phone/messages', requireAuth, (req, res) =>
  res.json(getDB(req).getMessages(req.params.phone))
);

app.post('/api/conversations/:phone/read', requireAuth, (req, res) => {
  getDB(req).markAsRead(req.params.phone);
  res.json({ success: true });
});

// ── Send ─────────────────────────────────────────────────────────
app.post('/api/send', requireAuth, async (req, res) => {
  const { phone, text } = req.body;
  try {
    await bot.sendText(req.tenantId, phone, text);
    const msg = getDB(req).saveMessage(phone, 'out', 'text', text, null, false);
    io.to('tenant:' + req.tenantId).emit('new_message', { phone, ...msg });
    res.json({ success: true });
  } catch (err) {
    console.error('[send error]', typeof err, err?.message, err?.stack || err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── Config ────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => res.json(getDB(req).getAllConfig()));

app.post('/api/config', requireAuth, (req, res) => {
  const allowed = ['trigger_keyword','price_text','reminder_text','active_campaigns','comparison_text','returning_text','returning_audio_file','returning_audio_name','repeat_text'];
  for (let i = 2; i <= 5; i++) allowed.push(`trigger_keyword_${i}`, `price_text_${i}`, `comparison_text_${i}`);
  for (const key of allowed) {
    if (req.body[key] !== undefined) getDB(req).setConfig(key, req.body[key]);
  }
  res.json({ success: true });
});

app.delete('/api/campaigns/:slot', requireAuth, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  if (slot < 2 || slot > 5) return res.status(400).json({ error: 'Only campaigns 2-5 can be removed' });
  const db  = getDB(req);
  const sfx = `_${slot}`;
  const audioPath = db.getConfig(`audio_file${sfx}`);
  if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  try {
    for (const img of JSON.parse(db.getConfig(`images${sfx}`) || '[]')) {
      const p = img.path || img; if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
  db.setConfig(`trigger_keyword${sfx}`, '');
  db.setConfig(`price_text${sfx}`, '');
  db.setConfig(`audio_file${sfx}`, '');
  db.setConfig(`audio_name${sfx}`, '');
  db.setConfig(`images${sfx}`, '');
  try {
    for (const img of JSON.parse(db.getConfig(`comparison_images${sfx}`) || '[]')) {
      const p = img.path || img; if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch {}
  db.setConfig(`comparison_images${sfx}`, '');
  db.setConfig(`comparison_text${sfx}`, '');
  let active = [];
  try { active = JSON.parse(db.getConfig('active_campaigns') || '[]'); } catch {}
  db.setConfig('active_campaigns', JSON.stringify(active.filter(n => Number(n) !== slot)));
  res.json({ success: true });
});

// ── Audio upload ──────────────────────────────────────────────────
app.post('/api/upload/audio', requireAuth, uploadAudio.single('audio'), (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx  = slot > 1 ? `_${slot}` : '';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const converted = convertToOpusOgg(req.file.path);
  const finalPath = converted || req.file.path;
  if (converted && converted !== req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  getDB(req).setConfig(`audio_file${sfx}`, finalPath);
  getDB(req).setConfig(`audio_name${sfx}`, req.file.originalname);
  res.json({ success: true, path: finalPath, name: req.file.originalname });
});

app.delete('/api/upload/audio', requireAuth, (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx  = slot > 1 ? `_${slot}` : '';
  const p    = getDB(req).getConfig(`audio_file${sfx}`);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  getDB(req).setConfig(`audio_file${sfx}`, '');
  getDB(req).setConfig(`audio_name${sfx}`, '');
  res.json({ success: true });
});

// ── Image upload ──────────────────────────────────────────────────
app.post('/api/upload/images', requireAuth, uploadImages.array('images', 20), (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx  = slot > 1 ? `_${slot}` : '';
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const existing = JSON.parse(getDB(req).getConfig(`images${sfx}`) || '[]');
  const newFiles = req.files.map(f => ({ path: f.path, name: f.originalname }));
  getDB(req).setConfig(`images${sfx}`, JSON.stringify([...existing, ...newFiles]));
  res.json({ success: true, files: newFiles });
});

app.delete('/api/upload/images/:filename', requireAuth, (req, res) => {
  const slot     = parseInt(req.query.slot) || 1;
  const sfx      = slot > 1 ? `_${slot}` : '';
  const existing = JSON.parse(getDB(req).getConfig(`images${sfx}`) || '[]');
  const target   = existing.find(f => f.path.includes(req.params.filename));
  if (target && fs.existsSync(target.path)) fs.unlinkSync(target.path);
  getDB(req).setConfig(`images${sfx}`, JSON.stringify(existing.filter(f => !f.path.includes(req.params.filename))));
  res.json({ success: true });
});

// ── Returning customer audio upload ──────────────────────────────
const uploadReturningAudio = multer({
  limits: { fileSize: 20 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_DIR, 'tenants', req.tenantId, 'uploads', 'returning-audio');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
});

app.post('/api/upload/returning-audio', requireAuth, uploadReturningAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const old = getDB(req).getConfig('returning_audio_file');
  if (old && fs.existsSync(old)) try { fs.unlinkSync(old); } catch {}
  const converted = convertToOpusOgg(req.file.path);
  const finalPath = converted || req.file.path;
  if (converted && converted !== req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
  getDB(req).setConfig('returning_audio_file', finalPath);
  getDB(req).setConfig('returning_audio_name', req.file.originalname);
  res.json({ success: true, path: finalPath, name: req.file.originalname });
});

app.delete('/api/upload/returning-audio', requireAuth, (req, res) => {
  const p = getDB(req).getConfig('returning_audio_file');
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  getDB(req).setConfig('returning_audio_file', '');
  getDB(req).setConfig('returning_audio_name', '');
  res.json({ success: true });
});

// ── Comparison image upload ───────────────────────────────────────
app.post('/api/upload/comparison-images', requireAuth, uploadComparison.array('images', 20), (req, res) => {
  const slot = parseInt(req.query.slot) || 1;
  const sfx  = slot > 1 ? `_${slot}` : '';
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const existing = JSON.parse(getDB(req).getConfig(`comparison_images${sfx}`) || '[]');
  const newFiles = req.files.map(f => ({ path: f.path, name: f.originalname }));
  getDB(req).setConfig(`comparison_images${sfx}`, JSON.stringify([...existing, ...newFiles]));
  res.json({ success: true, files: newFiles });
});

app.delete('/api/upload/comparison-images/:filename', requireAuth, (req, res) => {
  const slot     = parseInt(req.query.slot) || 1;
  const sfx      = slot > 1 ? `_${slot}` : '';
  const existing = JSON.parse(getDB(req).getConfig(`comparison_images${sfx}`) || '[]');
  const target   = existing.find(f => f.path.includes(req.params.filename));
  if (target && fs.existsSync(target.path)) fs.unlinkSync(target.path);
  getDB(req).setConfig(`comparison_images${sfx}`, JSON.stringify(existing.filter(f => !f.path.includes(req.params.filename))));
  res.json({ success: true });
});

// ── App ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Socket.io (tenant rooms) ──────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join-tenant', (tenantId) => {
    // Verify the session cookie matches the claimed tenantId
    const token   = parseCookies({ headers: { cookie: socket.handshake.headers.cookie } }).wa_session;
    const session = parseSessionToken(token);
    if (!session || session.tenantId !== tenantId) return;

    socket.join('tenant:' + tenantId);
    const status = bot.getStatus(tenantId);
    if (status.qr) socket.emit('qr', status.qr);
    if (status.connected) socket.emit('ready', status.info);
  });
});

// ── Telegram ──────────────────────────────────────────────────────
function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) {
    console.log('\n📩 [Telegram not configured]\n' + text + '\n');
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
    req.write(body); req.end();
  });
}

// ── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 Open http://localhost:${PORT} in your browser\n`);

  // Stagger bot startup: one every 8 seconds to avoid RAM spike on restart
  const activeTenants = registry.getAllTenants().filter(t => t.active === 1 && t.daysLeft > 0);
  activeTenants.forEach((t, i) => {
    setTimeout(() => {
      console.log(`🔄 [${i + 1}/${activeTenants.length}] Starting bot for tenant: ${t.id}`);
      bot.initTenant(t.id, getTenantDB(t.id));
    }, i * 8000);
  });
});
