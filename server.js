// Muse 邀请码互助站 — 独立公网版（零依赖 Node 服务）
// 数据存 DATA_FILE 指向的 JSON 文件（单实例部署）。种子来自 seed.json。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const SEED_FILE = path.join(__dirname, 'seed.json');
const PUBLIC_DIR = __dirname; // index.html 与 server.js 同目录（扁平结构，方便网页上传部署）

let db = null;
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function load() {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return;
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const now = new Date().toISOString();
  db = { nextId: 1, codes: [] };
  db.codes.push(mk(seed.pinned.code, seed.pinned.totalSlots, true, null, now));
  for (const c of seed.collected) db.codes.push(mk(c.code, 30, false, c.sourceNote, now, true));
  save();
}
function mk(code, totalSlots, pinned, sourceNote, now, collected = false) {
  return {
    id: db.nextId++, code, totalSlots, remaining: totalSlots,
    pinned: !!pinned, collected: !!collected, sourceNote: sourceNote || null,
    reports: 0, usedCount: 0, manageToken: null,
    createdAt: now, status: 'available',
  };
}
function pub(c) {
  return {
    id: c.id, code: c.code, totalSlots: c.totalSlots, remaining: c.remaining,
    pinned: c.pinned, collected: c.collected, sourceNote: c.sourceNote,
    status: c.status, usedCount: c.usedCount, createdAt: c.createdAt,
  };
}
function refreshStatus(c) {
  if (c.status === 'deleted') return;
  if (c.reports >= 3) c.status = 'reported';
  else if (c.remaining <= 0) c.status = 'exhausted';
  else c.status = 'available';
}
function batch() {
  const pool = db.codes.filter(c => !c.collected && c.status !== 'deleted');
  const pinned = pool.filter(c => c.pinned);
  const rest = pool.filter(c => !c.pinned && c.status === 'available');
  shuffle(rest);
  const grey = pool.filter(c => !c.pinned && c.status !== 'available');
  const codes = [...pinned, ...rest.slice(0, 20), ...grey];
  const collected = db.codes.filter(c => c.collected && c.status !== 'deleted').map(pub);
  const availableCount = pool.filter(c => c.status === 'available').length;
  return { codes: codes.map(pub), collected, availableCount };
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } }
function extractCode(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  const labelled = up.match(/(?:CODE|邀请码)\s*[:：]?\s*([A-Z0-9]{6})\b/);
  if (labelled) return labelled[1];
  const all = up.match(/\b[A-Z0-9]{6}\b/g) || [];
  const bad = new Set(['TOKENS', 'TOKEN', 'MUSEAI']);
  return all.find(t => /[A-Z]/.test(t) && /[0-9A-Z]/.test(t) && !bad.has(t)) || null;
}
function token() {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/codes' && req.method === 'GET') return json(res, 200, batch());
    if (p === '/api/codes' && req.method === 'POST') {
      const body = await readBody(req);
      const code = extractCode(body.rawText || '');
      if (!code) return json(res, 400, { error: '没有识别到 6 位邀请码' });
      if (db.codes.some(c => c.code === code && c.status !== 'deleted' && !c.collected))
        return json(res, 409, { error: '这个码已经在池子里了' });
      const total = Math.min(999, Math.max(1, parseInt(body.totalSlots, 10) || 30));
      const entry = mk(code, total, false, null, new Date().toISOString());
      entry.manageToken = token();
      db.codes.push(entry); save();
      return json(res, 201, { entry: pub(entry), manageToken: entry.manageToken, managePath: '/manage/' + entry.manageToken });
    }
    const mCopy = p.match(/^\/api\/codes\/(\d+)\/copy$/);
    if (mCopy && req.method === 'POST') {
      const c = db.codes.find(x => x.id === +mCopy[1]);
      if (!c || c.status === 'deleted') return json(res, 404, { error: 'not found' });
      if (c.remaining > 0) { c.remaining--; c.usedCount++; refreshStatus(c); save(); }
      return json(res, 200, batch());
    }
    const mRep = p.match(/^\/api\/codes\/(\d+)\/report$/);
    if (mRep && req.method === 'POST') {
      const c = db.codes.find(x => x.id === +mRep[1]);
      if (!c || c.status === 'deleted') return json(res, 404, { error: 'not found' });
      c.reports++; refreshStatus(c); save();
      return json(res, 200, batch());
    }
    const mMan = p.match(/^\/api\/manage\/([A-Za-z0-9]+)$/);
    if (mMan) {
      const c = db.codes.find(x => x.manageToken === mMan[1]);
      if (!c || c.status === 'deleted') return json(res, 404, { error: '管理凭据无效' });
      if (req.method === 'GET') return json(res, 200, { entry: pub(c) });
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const rem = parseInt(body.remaining, 10);
        if (Number.isFinite(rem)) { c.remaining = Math.min(c.totalSlots, Math.max(0, rem)); refreshStatus(c); save(); }
        return json(res, 200, { entry: pub(c) });
      }
      if (req.method === 'DELETE') { c.status = 'deleted'; save(); return json(res, 200, { ok: true }); }
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // 静态文件：只对外提供 index.html（server.js / seed.json / data 一律不暴露）
    let file = p;
    if (p === '/' || p.startsWith('/manage/')) file = '/index.html';
    if (file !== '/index.html') return json(res, 404, { error: 'not found' });
    const fp = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(fp)) return json(res, 404, { error: 'not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

load();
server.listen(PORT, () => console.log('muse-invite-site listening on :' + PORT));
