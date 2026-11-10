// Muse 邀请码互助站 — 独立公网版 v2（零依赖 Node 服务）
// 功能：邀请码池 / 分享码附图 / 晒图墙 / 评论区。数据存 DATA_FILE 指向的 JSON，图片存同目录 uploads/。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const UPLOAD_DIR = path.join(path.dirname(DATA_FILE), 'uploads');
const SEED_FILE = path.join(__dirname, 'seed.json');

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
  } else {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    const now = new Date().toISOString();
    db = { nextId: 1, codes: [], gallery: [], comments: [] };
    db.codes.push(mk(seed.pinned.code, seed.pinned.totalSlots, true, null, now));
    for (const c of seed.collected) db.codes.push(mk(c.code, 30, false, c.sourceNote, now, true));
  }
  db.gallery = db.gallery || [];
  db.comments = db.comments || [];
  for (const c of db.codes) c.reporters = c.reporters || [];
  for (const g of db.gallery) g.reporters = g.reporters || [];
  for (const c of db.comments) c.reporters = c.reporters || [];
  save();
}
function mk(code, totalSlots, pinned, sourceNote, now, collected = false) {
  return {
    id: db.nextId++, code, totalSlots, remaining: totalSlots,
    pinned: !!pinned, collected: !!collected, sourceNote: sourceNote || null,
    reports: 0, usedCount: 0, manageToken: null, image: null,
    createdAt: now, status: 'available',
  };
}
function pub(c) {
  return {
    id: c.id, code: c.code, totalSlots: c.totalSlots, remaining: c.remaining,
    pinned: c.pinned, collected: c.collected, sourceNote: c.sourceNote,
    status: c.status, usedCount: c.usedCount, createdAt: c.createdAt,
    image: c.image || null,
  };
}
// 防刷：同一台设备（did）对同一条目只能反馈一次。返回 true 表示这次计数生效。
function countReport(item, did) {
  item.reporters = item.reporters || [];
  if (did) {
    if (item.reporters.includes(did)) return false;
    item.reporters.push(did);
  }
  item.reports++;
  return true;
}
function refreshStatus(c) {
  if (c.status === 'deleted') return;
  if (c.reports >= 3) c.status = 'reported';
  else if (c.remaining <= 0) c.status = 'exhausted';
  else c.status = 'available';
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } }
function state() {
  const pool = db.codes.filter(c => !c.collected && c.status !== 'deleted');
  const pinned = pool.filter(c => c.pinned);
  const rest = pool.filter(c => !c.pinned && c.status === 'available');
  shuffle(rest);
  const grey = pool.filter(c => !c.pinned && c.status !== 'available');
  const codes = [...pinned, ...rest.slice(0, 20), ...grey];
  const collected = db.codes.filter(c => c.collected && c.status !== 'deleted').map(pub);
  const availableCount = pool.filter(c => c.status === 'available').length;
  const gallery = db.gallery.filter(g => !g.hidden)
    .sort((a, b) => b.id - a.id).slice(0, 60)
    .map(g => ({ id: g.id, caption: g.caption, name: g.name, url: g.url, createdAt: g.createdAt }));
  const comments = db.comments.filter(c => !c.hidden)
    .sort((a, b) => b.id - a.id).slice(0, 50)
    .map(c => ({ id: c.id, name: c.name, text: c.text, createdAt: c.createdAt }));
  return {
    codes: codes.map(pub), collected, availableCount, gallery, comments,
    stats: { sharedCount: pool.length, galleryCount: gallery.length, commentCount: comments.length },
  };
}
function extractCode(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  const labelled = up.match(/(?:CODE|邀请码)\s*[:：]?\s*([A-Z0-9]{6})\b/);
  if (labelled) return labelled[1];
  const all = up.match(/\b[A-Z0-9]{6}\b/g) || [];
  const bad = new Set(['TOKENS', 'TOKEN', 'MUSEAI']);
  return all.find(t => /[A-Z]/.test(t) && !bad.has(t)) || null;
}
function token() {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
const IMG_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
function saveImage(dataUrl) {
  if (!dataUrl) return null;
  const m = String(dataUrl).match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('图片格式不对，只支持 png/jpg/webp/gif');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > 2 * 1024 * 1024) throw new Error('图片要小于 2MB');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + '.' + ext;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}
function readBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > limit) { req.destroy(); reject(new Error('内容太大了')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const clean = (s, max) => String(s || '').trim().slice(0, max);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/codes' && req.method === 'GET') return json(res, 200, state());
    if (p === '/api/codes' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      const code = extractCode(body.rawText || '');
      if (!code) return json(res, 400, { error: '没有识别到 6 位邀请码' });
      if (db.codes.some(c => c.code === code && c.status !== 'deleted' && !c.collected))
        return json(res, 409, { error: '这个码已经在池子里了' });
      const total = Math.min(999, Math.max(1, parseInt(body.totalSlots, 10) || 30));
      const entry = mk(code, total, false, null, new Date().toISOString());
      entry.manageToken = token();
      try { entry.image = saveImage(body.imageDataUrl); } catch (e) { return json(res, 400, { error: e.message }); }
      db.codes.push(entry); save();
      return json(res, 201, { entry: pub(entry), manageToken: entry.manageToken, managePath: '/manage/' + entry.manageToken });
    }
    const mCopy = p.match(/^\/api\/codes\/(\d+)\/copy$/);
    if (mCopy && req.method === 'POST') {
      const c = db.codes.find(x => x.id === +mCopy[1]);
      if (!c || c.status === 'deleted') return json(res, 404, { error: 'not found' });
      if (c.remaining > 0) { c.remaining--; c.usedCount++; refreshStatus(c); save(); }
      return json(res, 200, state());
    }
    const mRep = p.match(/^\/api\/codes\/(\d+)\/report$/);
    if (mRep && req.method === 'POST') {
      const c = db.codes.find(x => x.id === +mRep[1]);
      if (!c || c.status === 'deleted') return json(res, 404, { error: 'not found' });
      const body = await readBody(req).catch(() => ({}));
      if (!countReport(c, clean(body.did, 64))) return json(res, 409, { error: '你已经反馈过这个码了' });
      refreshStatus(c); save();
      return json(res, 200, state());
    }
    // 晒图墙
    if (p === '/api/gallery' && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024 * 1024);
      let imgUrl;
      try { imgUrl = saveImage(body.dataUrl); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!imgUrl) return json(res, 400, { error: '请先选一张图片' });
      const g = {
        id: db.nextId++, url: imgUrl,
        caption: clean(body.caption, 120) || '（没有写说明）',
        name: clean(body.name, 20) || '匿名',
        reports: 0, hidden: false, createdAt: new Date().toISOString(),
      };
      db.gallery.push(g); save();
      return json(res, 201, state());
    }
    const mGal = p.match(/^\/api\/gallery\/(\d+)\/report$/);
    if (mGal && req.method === 'POST') {
      const g = db.gallery.find(x => x.id === +mGal[1]);
      if (!g) return json(res, 404, { error: 'not found' });
      const body = await readBody(req).catch(() => ({}));
      if (!countReport(g, clean(body.did, 64))) return json(res, 409, { error: '你已经举报过这张图了' });
      if (g.reports >= 3) g.hidden = true; save();
      return json(res, 200, state());
    }
    // 评论区
    if (p === '/api/comments' && req.method === 'POST') {
      const body = await readBody(req);
      const text = clean(body.text, 300);
      if (!text) return json(res, 400, { error: '评论不能为空' });
      const c = {
        id: db.nextId++, name: clean(body.name, 20) || '匿名', text,
        reports: 0, hidden: false, createdAt: new Date().toISOString(),
      };
      db.comments.push(c); save();
      return json(res, 201, state());
    }
    const mCom = p.match(/^\/api\/comments\/(\d+)\/report$/);
    if (mCom && req.method === 'POST') {
      const c = db.comments.find(x => x.id === +mCom[1]);
      if (!c) return json(res, 404, { error: 'not found' });
      const body = await readBody(req).catch(() => ({}));
      if (!countReport(c, clean(body.did, 64))) return json(res, 409, { error: '你已经举报过这条了' });
      if (c.reports >= 3) c.hidden = true; save();
      return json(res, 200, state());
    }
    // 管理
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
    // 上传图片读取
    const mUp = p.match(/^\/uploads\/([a-z0-9]+\.(png|jpg|webp|gif))$/);
    if (mUp && req.method === 'GET') {
      const fp = path.join(UPLOAD_DIR, mUp[1]);
      if (!fs.existsSync(fp)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': IMG_TYPES[mUp[2] === 'jpg' ? 'jpeg' : mUp[2]], 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(fp).pipe(res);
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // 搜索收录：robots / sitemap / IndexNow 验证文件
    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nAllow: /\nSitemap: https://muse-invite-site.onrender.com/sitemap.xml\n');
    }
    if (p === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://muse-invite-site.onrender.com/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n</urlset>\n');
    }
    if (p === '/f719408ca62eb71920e6a05f760cabba.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('f719408ca62eb71920e6a05f760cabba');
    }
    // 静态文件：只对外提供 index.html
    let file = p;
    if (p === '/' || p.startsWith('/manage/')) file = '/index.html';
    if (file !== '/index.html') return json(res, 404, { error: 'not found' });
    const fp = path.join(__dirname, 'index.html');
    if (!fs.existsSync(fp)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

load();
server.listen(PORT, () => console.log('muse-invite-site listening on :' + PORT));
