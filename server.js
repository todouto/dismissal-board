'use strict';
/* 放学看板 · 单目录版本：所有前端文件放在同一层，避免上传时丢失文件夹结构 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'state.json');
const SESSION_TTL = 12 * 3600 * 1000;
const MAX_CLASSES = 12;
const GRADE_NAMES = ['一年级', '二年级', '三年级', '四年级', '五年级'];
const DEFAULT_PASSCODE = process.env.PASSCODE || '2468';
const DEFAULT_CLASSES = 6;

const FILES = {
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/teacher.html': ['teacher.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/teacher.css': ['teacher.css', 'text/css; charset=utf-8'],
  '/visitor.js': ['visitor.js', 'application/javascript; charset=utf-8'],
  '/teacher.js': ['teacher.js', 'application/javascript; charset=utf-8'],
};

function uid(p) { return p + crypto.randomBytes(4).toString('hex'); }
function newClass(name) { return { id: uid('c'), name, dismissed: false, dismissedAt: null }; }

function defaultState() {
  return {
    title: '放学状态',
    passcode: DEFAULT_PASSCODE,
    grades: GRADE_NAMES.map((name, i) => ({
      id: 'g' + (i + 1), name,
      classes: Array.from({ length: DEFAULT_CLASSES }, (_, k) => newClass(`${k + 1}班`)),
    })),
    updatedAt: Date.now(),
  };
}

function normalize(raw) {
  if (!raw || !Array.isArray(raw.grades)) return defaultState();
  const grades = raw.grades.slice(0, 8).map((g, i) => ({
    id: typeof g.id === 'string' ? g.id : 'g' + (i + 1),
    name: String(g.name || GRADE_NAMES[i] || `年级${i + 1}`).slice(0, 20),
    classes: (Array.isArray(g.classes) ? g.classes : []).slice(0, MAX_CLASSES).map((c, k) => ({
      id: typeof c.id === 'string' ? c.id : uid('c'),
      name: String(c.name || `${k + 1}班`).slice(0, 12),
      dismissed: !!c.dismissed,
      dismissedAt: Number(c.dismissedAt) || null,
    })),
  }));
  for (const g of grades) if (!g.classes.length) g.classes.push(newClass('1班'));
  return {
    title: String(raw.title || '放学状态').slice(0, 24),
    passcode: String(raw.passcode || DEFAULT_PASSCODE).slice(0, 32),
    grades,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function load() {
  try { return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { return defaultState(); }
}

let state = load();

function save() {
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
  catch (e) { console.error('save failed', e.message); }
}

function publicState() { return { title: state.title, grades: state.grades, updatedAt: state.updatedAt }; }

const sessions = new Map();
function newSession() { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + SESSION_TTL); return t; }
function validToken(t) { const e = sessions.get(t); if (!e) return false; if (e < Date.now()) { sessions.delete(t); return false; } return true; }
setInterval(() => { const n = Date.now(); for (const [t, e] of sessions) if (e < n) sessions.delete(t); }, 600000).unref();

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

for (const [route, [file, type]] of Object.entries(FILES)) {
  app.get(route, (req, res) => res.type(type).sendFile(path.join(ROOT, file)));
}
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(ROOT, 'teacher.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state: publicState() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function touch() { state.updatedAt = Date.now(); save(); broadcast(); }

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));
});
setInterval(() => {
  for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000).unref();

function auth(req, res, next) {
  if (!validToken(req.get('x-token') || '')) return res.status(401).json({ error: '登录已过期，请重新输入口令' });
  next();
}

const fails = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'x';
  const rec = fails.get(ip);
  if (rec && rec.until > Date.now() && rec.n >= 10) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  if (!safeEqual(String((req.body || {}).passcode || ''), state.passcode)) {
    const cur = rec && rec.until > Date.now() ? rec : { n: 0, until: Date.now() + 600000 };
    cur.n += 1; fails.set(ip, cur);
    return res.status(401).json({ error: '口令错误' });
  }
  fails.delete(ip);
  res.json({ token: newSession(), expiresIn: SESSION_TTL / 1000 });
});

app.post('/api/logout', auth, (req, res) => { sessions.delete(req.get('x-token')); res.json({ ok: true }); });
app.get('/api/state', (req, res) => res.json(publicState()));

app.get('/api/qr', async (req, res) => {
  let url; try { url = new URL(String(req.query.u || '')); } catch { return res.status(400).send('bad url'); }
  if (!url.host || url.host !== req.get('host')) return res.status(400).send('bad url');
  try {
    const svg = await QRCode.toString(url.toString(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch { res.status(500).send('qr error'); }
});

function findClass(gid, cid) {
  const g = state.grades.find(x => x.id === gid);
  return g ? { g, k: g.classes.find(x => x.id === cid) } : {};
}

app.post('/api/toggle', auth, (req, res) => {
  const { gradeId, classId } = req.body || {};
  const { k } = findClass(gradeId, classId);
  if (!k) return res.status(404).json({ error: '找不到班级' });
  k.dismissed = !k.dismissed;
  k.dismissedAt = k.dismissed ? Date.now() : null;
  touch(); res.json({ ok: true, state: publicState() });
});

app.post('/api/grade-all', auth, (req, res) => {
  const g = state.grades.find(x => x.id === (req.body || {}).gradeId);
  if (!g) return res.status(404).json({ error: '找不到年级' });
  const on = !!(req.body || {}).dismissed;
  for (const k of g.classes) { k.dismissed = on; k.dismissedAt = on ? (k.dismissedAt || Date.now()) : null; }
  touch(); res.json({ ok: true, state: publicState() });
});

app.post('/api/reset', auth, (req, res) => {
  for (const g of state.grades) for (const k of g.classes) { k.dismissed = false; k.dismissedAt = null; }
  touch(); res.json({ ok: true, state: publicState() });
});

app.post('/api/grade', auth, (req, res) => {
  const { gradeId, name, count } = req.body || {};
  const g = state.grades.find(x => x.id === gradeId);
  if (!g) return res.status(404).json({ error: '找不到年级' });
  if (typeof name === 'string' && name.trim()) g.name = name.trim().slice(0, 20);
  if (count !== undefined) {
    const n = Math.max(1, Math.min(MAX_CLASSES, Number(count) | 0));
    while (g.classes.length < n) g.classes.push(newClass(`${g.classes.length + 1}班`));
    if (g.classes.length > n) g.classes.length = n;
  }
  touch(); res.json({ ok: true, state: publicState() });
});

app.post('/api/class-name', auth, (req, res) => {
  const { gradeId, classId, name } = req.body || {};
  const { k } = findClass(gradeId, classId);
  if (!k) return res.status(404).json({ error: '找不到班级' });
  const v = String(name || '').trim().slice(0, 12);
  if (!v) return res.status(400).json({ error: '班级名称不能为空' });
  k.name = v;
  touch(); res.json({ ok: true, state: publicState() });
});

app.post('/api/settings', auth, (req, res) => {
  const { title, passcode } = req.body || {};
  if (typeof title === 'string' && title.trim()) state.title = title.trim().slice(0, 24);
  if (typeof passcode === 'string' && passcode) {
    if (passcode.length < 4) return res.status(400).json({ error: '口令至少 4 位' });
    state.passcode = passcode.slice(0, 32);
    sessions.clear();
    sessions.set(req.get('x-token'), Date.now() + SESSION_TTL);
  }
  touch(); res.json({ ok: true, state: publicState() });
});

function lan() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`放学看板 port ${PORT}`);
  for (const ip of lan()) console.log(`  http://${ip}:${PORT}/  |  /teacher`);
});
