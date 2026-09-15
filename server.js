/**
 * 离线敏感遗址分级共享台 —— 零运行时依赖的 Node HTTP 服务。
 * 启动: node server.js   (默认端口 8731, 可用 PORT 覆盖)
 *
 * 安全边界全部在服务端:
 *  - 受限字段(coords/image/note)一律按"当前生效授权"过滤后才下发;
 *  - 筛选/统计/导出只允许公共字段条件, 受限字段条件直接拒绝;
 *  - 授权的增/删/用户停用/有效期到期, 在每次请求时即时评估(旧会话立刻降权);
 *  - 写入带乐观锁版本号, 旧版本提交返回 409, 不改数据;
 *  - 查看(含受限字段揭示)/隐藏/授权/写入/导出/删除/登录全部写审计日志。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8731);
const DATA_DIR = process.env.SHARE_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// 测试专用: 设为该值时允许 POST /api/test/reset 重置数据库
const TEST_RESET_KEY = process.env.TEST_RESET_KEY || '';

const RESTRICTED_FIELDS = ['coords', 'image', 'note'];
const PUBLIC_SORTABLE = ['code', 'type', 'dive', 'depth', 'updatedAt', 'createdAt'];
const LEVEL_PRESETS = {
  1: ['coords'],
  2: ['coords', 'image'],
  3: ['coords', 'image', 'note'],
};
const SITE_TYPES = ['ceramic', 'wood', 'metal', 'wreck', 'unknown'];

/* ----------------------------- 数据库与种子 ----------------------------- */

function nowIso() { return new Date().toISOString(); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function seedImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#0f5262"/><ellipse cx="80" cy="64" rx="52" ry="30" fill="rgba(220,235,224,.35)"/><text x="80" y="70" font-size="14" text-anchor="middle" fill="#dcebe0">S-001 影像</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function seedDb() {
  const ts = nowIso();
  const users = [
    { id: 'u-admin', username: 'admin', passwordHash: hashPassword('admin123'), role: 'admin', active: true, displayName: '管理员', createdAt: ts },
    { id: 'u-lin', username: 'lin', passwordHash: hashPassword('lin123'), role: 'member', active: true, displayName: '林潜水', createdAt: ts },
    { id: 'u-wang', username: 'wang', passwordHash: hashPassword('wang123'), role: 'member', active: true, displayName: '王记录', createdAt: ts },
    { id: 'u-inactive', username: 'shen', passwordHash: hashPassword('shen123'), role: 'member', active: false, displayName: '沈暂停', createdAt: ts },
  ];
  const sites = [
    {
      id: 's-001', code: 'S-001', type: 'wreck', dive: 'DIVE-01', depth: '17.8m',
      orientation: '东', condition: '船体中段保存较好',
      coords: { x: 42, y: 46 }, image: seedImage(), note: '受限备注: 靠近船肋, 疑似装载瓷器堆, 请勿外传。',
      version: 3, createdBy: 'u-admin', createdAt: ts, updatedAt: ts,
    },
    {
      id: 's-002', code: 'S-002', type: 'ceramic', dive: 'DIVE-02', depth: '18.2m',
      orientation: '西北', condition: '边缘残缺',
      coords: { x: 58, y: 39 }, image: null, note: '受限备注: 陶片集中区, 采样需审批。',
      version: 1, createdBy: 'u-admin', createdAt: ts, updatedAt: ts,
    },
    {
      id: 's-003', code: 'S-003', type: 'metal', dive: 'DIVE-02', depth: '19.0m',
      orientation: '南', condition: '锈蚀',
      coords: null, image: null, note: null,
      version: 1, createdBy: 'u-admin', createdAt: ts, updatedAt: ts,
    },
  ];
  const grants = [
    // lin 对 S-001 有全部三级字段, 长期有效
    { id: 'g-1', userId: 'u-lin', siteId: 's-001', fields: ['coords', 'image', 'note'], level: 3,
      grantedBy: 'u-admin', createdAt: ts, expiresAt: null, revokedAt: null },
    // wang 对 S-002 仅有坐标, 长期有效
    { id: 'g-2', userId: 'u-wang', siteId: 's-002', fields: ['coords'], level: 1,
      grantedBy: 'u-admin', createdAt: ts, expiresAt: null, revokedAt: null },
  ];
  return { users, sites, grants, audit: [], counters: { site: 4, grant: 3 }, auditSeq: 1 };
}

let db;
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {
    db = seedDb();
    persistDb();
  }
  return db;
}
let writeChain = Promise.resolve();
function persistDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // 同目录原子替换
}
// 所有写操作串行化, 保证"读到最新版本 -> 校验 -> 写回"期间不被穿插
function mutate(fn) {
  const run = writeChain.then(() => fn());
  writeChain = run.catch(() => {});
  return run;
}

/* ------------------------------- 会话 ----------------------------------- */

const sessions = new Map(); // token -> { userId, createdAt }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: nowIso() });
  return token;
}
function destroySession(token) { sessions.delete(token); }

/* ------------------------------- 授权评估 ------------------------------- */

function isGrantActive(g, at = Date.now()) {
  if (g.revokedAt) return false;
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= at) return false;
  return true;
}

/** 返回某用户此刻对某遗址有效的受限字段集合 */
function fieldsFor(userId, siteId) {
  const user = db.users.find(u => u.id === userId);
  if (!user || !user.active) return new Set();
  const set = new Set();
  for (const g of db.grants) {
    if (g.userId !== userId || g.siteId !== siteId || !isGrantActive(g)) continue;
    for (const f of g.fields) if (RESTRICTED_FIELDS.includes(f)) set.add(f);
  }
  return set;
}
function canField(user, siteId, field) {
  if (!user || !user.active) return false;
  if (user.role === 'admin') return true;
  return fieldsFor(user.id, siteId).has(field);
}

/* ------------------------------- 审计日志 ------------------------------- */

function audit({ actorId, action, target, result, detail, ip }) {
  const entry = {
    id: db.auditSeq++,
    at: nowIso(),
    actorId: actorId || null,
    action,            // login/logout/view/hide/grant/update/create/delete/export/stats/list/login_failed...
    target: target || null,
    result,            // success | denied | conflict
    detail: detail || '',
    ip: ip || '',
  };
  db.audit.push(entry);
  if (db.audit.length > 5000) db.audit = db.audit.slice(-5000);
  persistDb();
  return entry;
}

/* ------------------------------- 脱敏输出 ------------------------------- */

// 无坐标授权时用于平面图展示的确定性偏移(仅为视觉占位, 服务端绝不下发真实坐标)
function fakeCoords(siteId) {
  const h = crypto.createHash('sha256').update(siteId).digest();
  const jx = 12 + (h[0] / 255) * 70;
  const jy = 12 + (h[1] / 255) * 70;
  return { x: Number(jx.toFixed(2)), y: Number(jy.toFixed(2)), obscured: true };
}

function publicSite(site) {
  return {
    id: site.id, code: site.code, type: site.type, dive: site.dive, depth: site.depth,
    orientation: site.orientation, condition: site.condition,
    hasCoords: !!site.coords, hasImage: !!site.image, hasNote: !!site.note,
    version: site.version, createdBy: site.createdBy, createdAt: site.createdAt, updatedAt: site.updatedAt,
  };
}

/**
 * 列表/详情脱敏输出:
 *  - 坐标: 有权限则下发真实值(地图展示即授权查看), 无权限则下发确定性伪装坐标占位;
 *  - 影像/备注: 永不在列表通道下发明文, 只能经 POST /reveal(留审计)或 /export(留审计)获取。
 */
function redactSite(site, viewer) {
  const out = publicSite(site);
  const allowed = viewer ? fieldsFor(viewer.id, site.id) : new Set();
  const isAdmin = viewer && viewer.role === 'admin';
  out.permissions = {
    coords: isAdmin || allowed.has('coords'),
    image: isAdmin || allowed.has('image'),
    note: isAdmin || allowed.has('note'),
  };
  if (!site.coords) out.coords = null;
  else out.coords = out.permissions.coords ? { ...site.coords } : fakeCoords(site.id);
  out.image = null;
  out.note = null;
  return out;
}

/* ------------------------------- HTTP 工具 ------------------------------ */

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 6 * 1024 * 1024) { reject(new Error('payload-too-large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getUser(req) {
  const token = parseCookies(req).session;
  const sess = token && sessions.get(token);
  if (!sess) return { user: null, token: null };
  const user = db.users.find(u => u.id === sess.userId);
  // 用户停用即时生效: 旧会话立刻降权并清除
  if (!user || !user.active) {
    sessions.delete(token);
    return { user: null, token: null };
  }
  return { user, token };
}
function clientIp(req) { return req.socket.remoteAddress || ''; }

/* ------------------------------- 路由处理 ------------------------------- */

const handlers = {};

handlers['POST /api/auth/login'] = async (req, res) => {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = db.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    audit({ actorId: user && user.id, action: 'login', target: username, result: 'denied',
      detail: '用户名或密码错误', ip: clientIp(req) });
    return sendJson(res, 401, { error: '用户名或密码错误' });
  }
  if (!user.active) {
    audit({ actorId: user.id, action: 'login', target: username, result: 'denied',
      detail: '账号已停用', ip: clientIp(req) });
    return sendJson(res, 403, { error: '账号已停用' });
  }
  const token = createSession(user.id);
  audit({ actorId: user.id, action: 'login', target: user.username, result: 'success', ip: clientIp(req) });
  return sendJson(res, 200, { user: sanitizedUser(user) }, {
    'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
  });
};

handlers['POST /api/auth/logout'] = async (req, res) => {
  const { user, token } = getUser(req);
  if (user && token) {
    destroySession(token);
    audit({ actorId: user.id, action: 'logout', target: user.username, result: 'success', ip: clientIp(req) });
  }
  return sendJson(res, 200, { ok: true }, {
    'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  });
};

function sanitizedUser(u) {
  return { id: u.id, username: u.username, role: u.role, active: u.active, displayName: u.displayName };
}

handlers['GET /api/me'] = async (req, res) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  return sendJson(res, 200, { user: sanitizedUser(user) });
};

/* -------- 遗址列表 / 详情 / 统计 / 导出: 全部脱敏 -------- */

function filterSites(body, viewer) {
  const allowedFilterKeys = new Set(['type', 'dive', 'code', 'depth', 'q']);
  for (const k of Object.keys(body || {})) {
    if (!allowedFilterKeys.has(k)) {
      const err = new Error('forbidden-filter');
      err.status = 400;
      err.clientMsg = `不允许按受限或未知字段筛选: ${k}`;
      throw err;
    }
  }
  let rows = db.sites.slice();
  if (body.type) rows = rows.filter(s => s.type === body.type);
  if (body.dive) rows = rows.filter(s => s.dive === body.dive);
  if (body.depth) rows = rows.filter(s => s.depth === body.depth);
  if (body.code) rows = rows.filter(s => s.code.toLowerCase().includes(String(body.code).toLowerCase()));
  if (body.q) {
    const q = String(body.q).toLowerCase();
    rows = rows.filter(s => [s.code, s.dive, s.depth, s.orientation, s.condition, s.type]
      .some(v => String(v).toLowerCase().includes(q)));
  }
  const sort = PUBLIC_SORTABLE.includes(body.sort) ? body.sort : 'code';
  rows.sort((a, b) => String(a[sort]).localeCompare(String(b[sort])));
  return rows;
}

handlers['POST /api/sites/list'] = async (req, res) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  let body = {};
  try { body = await readBody(req); } catch (_) { body = {} }
  const silent = body.silent === true; // 前端定时会话校验不算一次显式查看, 不刷审计
  delete body.silent;
  try {
    const rows = filterSites(body, user);
    // 列表即查看: 记录操作者/时间/结果, 便于查错
    if (!silent) {
      audit({ actorId: user.id, action: 'list', result: 'success',
        detail: `列表 ${rows.length} 条${Object.keys(body).length ? '（带筛选）' : ''}`, ip: clientIp(req) });
    }
    return sendJson(res, 200, { sites: rows.map(s => redactSite(s, user)) });
  } catch (e) {
    audit({ actorId: user.id, action: 'list', result: 'denied', detail: e.clientMsg || e.message, ip: clientIp(req) });
    return sendJson(res, e.status || 400, { error: e.clientMsg || '筛选条件非法' });
  }
};

handlers['GET /api/sites/:id'] = async (req, res, params) => {
  const { user } = getUser(req);
  if (!user) {
    audit({ actorId: null, action: 'view', target: params.id, result: 'denied',
      detail: '未登录打开遗址详情', ip: clientIp(req) });
    return sendJson(res, 401, { error: '未登录' });
  }
  const site = db.sites.find(s => s.id === params.id);
  if (!site) {
    audit({ actorId: user.id, action: 'view', target: params.id, result: 'denied',
      detail: '打开不存在的遗址详情', ip: clientIp(req) });
    return sendJson(res, 404, { error: '遗址不存在' });
  }
  const silent = new URL(req.url, 'http://x').searchParams.get('silent') === '1';
  // 详情进入即一次查看: 记录操作者/时间/对象/结果, 与揭示动作保持同一审计口径
  if (!silent) {
    const allowed = fieldsFor(user.id, site.id);
    const grantDesc = user.role === 'admin'
      ? '管理员全部字段'
      : `当前可见受限字段: ${[...allowed].join(',') || '无'}`;
    audit({ actorId: user.id, action: 'view', target: site.code, result: 'success',
      detail: `进入详情（${grantDesc}）`, ip: clientIp(req) });
  }
  return sendJson(res, 200, { site: redactSite(site, user) });
};

// 受限字段"点开看一眼"也记审计; 只返回当前有权的字段, 服务端重新判定
handlers['POST /api/sites/:id/reveal'] = async (req, res, params) => {
  const { user } = getUser(req);
  if (!user) {
    audit({ actorId: null, action: 'view', target: params.id, result: 'denied',
      detail: '未登录请求揭示字段', ip: clientIp(req) });
    return sendJson(res, 401, { error: '未登录' });
  }
  const site = db.sites.find(s => s.id === params.id);
  if (!site) return sendJson(res, 404, { error: '遗址不存在' });
  const body = await readBody(req).catch(() => ({}));
  const want = RESTRICTED_FIELDS.includes(body.field) ? [body.field] : RESTRICTED_FIELDS;
  const denied = want.filter(f => !canField(user, site.id, f));
  if (denied.length) {
    audit({ actorId: user.id, action: 'view', target: site.code, result: 'denied',
      detail: `尝试揭示受限字段: ${denied.join(',')}`, ip: clientIp(req) });
    return sendJson(res, 403, { error: '无权查看该字段', denied });
  }
  audit({ actorId: user.id, action: 'view', target: site.code, result: 'success',
    detail: `揭示字段: ${want.join(',')}`, ip: clientIp(req) });
  const out = {};
  for (const f of want) out[f] = site[f];
  return sendJson(res, 200, { fields: out });
};

// "隐藏"是用户对已授权字段的查看动作: 必须按真实权限判定, 无权隐藏记拒绝, 不允许记成成功
handlers['POST /api/sites/:id/hide'] = async (req, res, params) => {
  const { user } = getUser(req);
  if (!user) {
    audit({ actorId: null, action: 'hide', target: params.id, result: 'denied',
      detail: '未登录请求隐藏', ip: clientIp(req) });
    return sendJson(res, 401, { error: '未登录' });
  }
  const site = db.sites.find(s => s.id === params.id);
  if (!site) {
    audit({ actorId: user.id, action: 'hide', target: params.id, result: 'denied', detail: '遗址不存在', ip: clientIp(req) });
    return sendJson(res, 404, { error: '遗址不存在' });
  }
  const body = await readBody(req).catch(() => ({}));
  const rawFields = Array.isArray(body.fields) ? body.fields : [];
  // 非受限/未知字段: 无效操作
  const unknown = rawFields.filter(f => !RESTRICTED_FIELDS.includes(f));
  if (unknown.length) {
    audit({ actorId: user.id, action: 'hide', target: site.code, result: 'denied',
      detail: `无效隐藏字段: ${unknown.join(',')}`, ip: clientIp(req) });
    return sendJson(res, 400, { error: `无效字段: ${unknown.join(',')}` });
  }
  // 缺省(空数组)视为隐藏全部受限字段, 但只能隐藏本人有权的部分
  const fields = rawFields.length ? rawFields : RESTRICTED_FIELDS;
  const noGrant = fields.filter(f => !canField(user, site.id, f));
  if (noGrant.length) {
    audit({ actorId: user.id, action: 'hide', target: site.code, result: 'denied',
      detail: `无权隐藏(未授权)字段: ${noGrant.join(',')}`, ip: clientIp(req) });
    return sendJson(res, 403, { error: `无权隐藏未授权字段: ${noGrant.join(',')}`, denied: noGrant });
  }
  audit({ actorId: user.id, action: 'hide', target: site.code, result: 'success',
    detail: `隐藏字段: ${fields.join(',')}`, ip: clientIp(req) });
  return sendJson(res, 200, { ok: true });
};

const PUBLIC_WRITABLE = new Set(['code', 'type', 'dive', 'depth', 'orientation', 'condition']);
function validatePublicPatch(patch) {
  for (const k of Object.keys(patch)) {
    if (!PUBLIC_WRITABLE.has(k) && !RESTRICTED_FIELDS.includes(k) && k !== 'version') {
      const e = new Error('unknown-field'); e.status = 400; e.clientMsg = `未知字段: ${k}`; throw e;
    }
  }
  if ('code' in patch && !String(patch.code).trim()) {
    const e = new Error('bad-code'); e.status = 400; e.clientMsg = '编号不能为空'; throw e;
  }
  if ('type' in patch && !SITE_TYPES.includes(patch.type)) {
    const e = new Error('bad-type'); e.status = 400; e.clientMsg = '类型非法'; throw e;
  }
  if ('coords' in patch && patch.coords !== null) {
    const c = patch.coords;
    if (typeof c !== 'object' || typeof c.x !== 'number' || typeof c.y !== 'number' ||
        c.x < 0 || c.x > 100 || c.y < 0 || c.y > 100) {
      const e = new Error('bad-coords'); e.status = 400; e.clientMsg = '坐标必须是 0-100 的数值'; throw e;
    }
  }
  if ('image' in patch && patch.image !== null) {
    const s = String(patch.image);
    if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,|^data:image\/svg\+xml;charset=utf-8,/.test(s) || s.length > 1_200_000) {
      const e = new Error('bad-image'); e.status = 400; e.clientMsg = '影像格式不支持或超过 1.2MB'; throw e;
    }
  }
}

handlers['POST /api/sites'] = async (req, res) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  const body = await readBody(req).catch(() => { const e = new Error('bad-json'); e.status = 400; throw e; });
  return mutate(() => {
    try { validatePublicPatch(body); }
    catch (e) {
      audit({ actorId: user.id, action: 'create', result: 'denied', detail: e.clientMsg, ip: clientIp(req) });
      return sendJson(res, e.status, { error: e.clientMsg });
    }
    // 受限字段: 仅管理员可在创建时直接写入(成员需先建公共记录, 取得授权后再补录)
    const restrictedTouched = RESTRICTED_FIELDS.filter(f => body[f] !== undefined && body[f] !== null);
    if (restrictedTouched.length && user.role !== 'admin') {
      audit({ actorId: user.id, action: 'create', target: body.code || '', result: 'denied',
        detail: `创建时不能直接写入受限字段: ${restrictedTouched.join(',')}（需先获授权）`, ip: clientIp(req) });
      return sendJson(res, 403, { error: '受限字段需先取得授权, 请先创建公共记录再编辑' });
    }
    const id = 's-' + String(db.counters.site++).padStart(3, '0');
    const ts = nowIso();
    const site = {
      id,
      code: String(body.code || '').trim(), type: SITE_TYPES.includes(body.type) ? body.type : 'unknown',
      dive: String(body.dive || ''), depth: String(body.depth || ''),
      orientation: String(body.orientation || ''), condition: String(body.condition || ''),
      coords: body.coords || null, image: body.image || null, note: body.note || null,
      version: 1, createdBy: user.id, createdAt: ts, updatedAt: ts,
    };
    db.sites.push(site);
    audit({ actorId: user.id, action: 'create', target: site.code, result: 'success',
      detail: `新建遗址 ${site.id}`, ip: clientIp(req) });
    persistDb();
    return sendJson(res, 201, { site: redactSite(site, user) });
  });
};

handlers['PATCH /api/sites/:id'] = async (req, res, params) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  const body = await readBody(req).catch(() => { const e = new Error('bad-json'); e.status = 400; throw e; });
  return mutate(() => {
    const site = db.sites.find(s => s.id === params.id);
    if (!site) {
      audit({ actorId: user.id, action: 'update', target: params.id, result: 'denied', detail: '遗址不存在', ip: clientIp(req) });
      return sendJson(res, 404, { error: '遗址不存在' });
    }
    try { validatePublicPatch(body); }
    catch (e) {
      audit({ actorId: user.id, action: 'update', target: site.code, result: 'denied', detail: e.clientMsg, ip: clientIp(req) });
      return sendJson(res, e.status, { error: e.clientMsg });
    }
    // 乐观锁: 必须携带与当前一致的版本号
    if (typeof body.version !== 'number' || body.version !== site.version) {
      audit({ actorId: user.id, action: 'update', target: site.code, result: 'conflict',
        detail: `提交版本=${body.version} 当前版本=${site.version}`, ip: clientIp(req) });
      return sendJson(res, 409, {
        error: '记录已被他人修改, 请基于最新版本重新提交',
        current: redactSite(site, user),
      });
    }
    // 字段级写授权
    const touchedRestricted = RESTRICTED_FIELDS.filter(f => Object.prototype.hasOwnProperty.call(body, f));
    const denied = touchedRestricted.filter(f => !canField(user, site.id, f));
    if (denied.length) {
      audit({ actorId: user.id, action: 'update', target: site.code, result: 'denied',
        detail: `越权写入字段: ${denied.join(',')}`, ip: clientIp(req) });
      return sendJson(res, 403, { error: `无权修改字段: ${denied.join(',')}`, denied });
    }
    const before = JSON.stringify(site);
    for (const k of PUBLIC_WRITABLE) if (k in body) site[k] = body[k];
    for (const f of RESTRICTED_FIELDS) if (f in body) site[f] = body[f];
    // 校验全部通过后才提交; 若序列化异常则保留原值
    try {
      JSON.stringify(site);
    } catch (_) {
      const restored = JSON.parse(before);
      Object.assign(site, restored);
      audit({ actorId: user.id, action: 'update', target: site.code, result: 'denied', detail: '提交内容无法保存, 已回滚', ip: clientIp(req) });
      return sendJson(res, 400, { error: '保存失败, 已保留原值' });
    }
    site.version += 1;
    site.updatedAt = nowIso();
    const changed = Object.keys(body).filter(k => k !== 'version').join(',');
    audit({ actorId: user.id, action: 'update', target: site.code, result: 'success',
      detail: `修改字段: ${changed} -> v${site.version}`, ip: clientIp(req) });
    persistDb();
    return sendJson(res, 200, { site: redactSite(site, user) });
  });
};

handlers['DELETE /api/sites/:id'] = async (req, res, params) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  return mutate(() => {
    const site = db.sites.find(s => s.id === params.id);
    if (!site) return sendJson(res, 404, { error: '遗址不存在' });
    if (user.role !== 'admin') {
      audit({ actorId: user.id, action: 'delete', target: site.code, result: 'denied', detail: '仅管理员可删除', ip: clientIp(req) });
      return sendJson(res, 403, { error: '仅管理员可删除遗址记录' });
    }
    db.sites = db.sites.filter(s => s.id !== site.id);
    audit({ actorId: user.id, action: 'delete', target: site.code, result: 'success', detail: '删除遗址', ip: clientIp(req) });
    persistDb();
    return sendJson(res, 200, { ok: true });
  });
};

/* -------- 统计 / 导出: 不使用任何受限字段, 且拒绝受限条件 -------- */

handlers['POST /api/stats'] = async (req, res) => {
  const { user } = getUser(req);
  if (!user) return sendJson(res, 401, { error: '未登录' });
  let body = {};
  try { body = await readBody(req); } catch (_) { body = {}; }
  try {
    const rows = filterSites(body, user);
    const byType = {};
    for (const t of SITE_TYPES) byType[t] = 0;
    const byDive = {};
    for (const s of rows) {
      byType[s.type] = (byType[s.type] || 0) + 1;
      byDive[s.dive] = (byDive[s.dive] || 0) + 1;
    }
    audit({ actorId: user.id, action: 'stats', result: 'success',
      detail: `${rows.length} 条记录的公共字段统计`, ip: clientIp(req) });
    return sendJson(res, 200, { total: rows.length, byType, byDive });
  } catch (e) {
    audit({ actorId: user.id, action: 'stats', result: 'denied', detail: e.clientMsg || e.message, ip: clientIp(req) });
    return sendJson(res, 400, { error: e.clientMsg || '筛选条件非法' });
  }
};

handlers['POST /api/export'] = async (req, res) => {
  const { user } = getUser(req);
  if (!user) {
    audit({ actorId: null, action: 'export', result: 'denied', detail: '未登录导出', ip: clientIp(req) });
    return sendJson(res, 401, { error: '未登录' });
  }
  let body = {};
  try { body = await readBody(req); } catch (_) { body = {}; }
  let rows;
  try {
    rows = filterSites(body, user);
  } catch (e) {
    audit({ actorId: user.id, action: 'export', result: 'denied', detail: e.clientMsg || e.message, ip: clientIp(req) });
    return sendJson(res, 400, { error: e.clientMsg || '筛选条件非法' });
  }
  // 导出是唯一允许把受限明文随数据带走的通道, 逐字段按授权附带
  const exported = rows.map(s => {
    const out = redactSite(s, user);
    if (out.permissions.coords) out.coords = s.coords ? { ...s.coords } : null;
    if (out.permissions.image) out.image = s.image;
    if (out.permissions.note) out.note = s.note;
    return out;
  });
  const grantedCount = exported.reduce((n, s) =>
    n + (s.permissions.coords ? 1 : 0) + (s.permissions.image ? 1 : 0) + (s.permissions.note ? 1 : 0), 0);
  audit({ actorId: user.id, action: 'export', target: `导出${exported.length}条`, result: 'success',
    detail: `受限字段随附 ${grantedCount} 项; 其余已脱敏`, ip: clientIp(req) });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="sites-${user.username}-${Date.now()}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ exportedAt: nowIso(), by: user.username, count: exported.length, sites: exported }, null, 2));
};

/* -------- 用户管理 (管理员) -------- */

function requireAdmin(req, res, action) {
  const { user } = getUser(req);
  if (!user) { sendJson(res, 401, { error: '未登录' }); return null; }
  if (user.role !== 'admin') {
    audit({ actorId: user.id, action: action || 'admin', result: 'denied', detail: '非管理员访问管理接口', ip: clientIp(req) });
    sendJson(res, 403, { error: '需要管理员权限' });
    return null;
  }
  return user;
}

handlers['GET /api/admin/users'] = async (req, res) => {
  const admin = requireAdmin(req, res, 'user_manage');
  if (!admin) return;
  return sendJson(res, 200, { users: db.users.map(sanitizedUser) });
};

handlers['POST /api/admin/users'] = async (req, res) => {
  const admin = requireAdmin(req, res, 'user_manage');
  if (!admin) return;
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  if (!/^[a-zA-Z0-9_\-]{2,32}$/.test(username)) return sendJson(res, 400, { error: '用户名需为 2-32 位字母数字/下划线/连字符' });
  if (db.users.some(u => u.username === username)) return sendJson(res, 409, { error: '用户名已存在' });
  if (!String(body.password || '').length || String(body.password).length < 6) {
    return sendJson(res, 400, { error: '密码至少 6 位' });
  }
  return mutate(() => {
    const u = {
      id: 'u-' + crypto.randomBytes(5).toString('hex'),
      username, passwordHash: hashPassword(body.password),
      role: body.role === 'admin' ? 'admin' : 'member',
      active: true, displayName: String(body.displayName || username), createdAt: nowIso(),
    };
    db.users.push(u);
    audit({ actorId: admin.id, action: 'user_manage', target: username, result: 'success', detail: `新建${u.role === 'admin' ? '管理员' : '成员'}`, ip: clientIp(req) });
    persistDb();
    return sendJson(res, 201, { user: sanitizedUser(u) });
  });
};

handlers['PATCH /api/admin/users/:id'] = async (req, res, params) => {
  const admin = requireAdmin(req, res, 'user_manage');
  if (!admin) return;
  const body = await readBody(req);
  return mutate(() => {
    const u = db.users.find(x => x.id === params.id);
    if (!u) return sendJson(res, 404, { error: '用户不存在' });
    const changes = [];
    if ('active' in body && typeof body.active === 'boolean') {
      u.active = body.active;
      changes.push(body.active ? '启用' : '停用');
      // 停用即时踢下线: 清除其全部会话
      if (!body.active) {
        for (const [token, sess] of sessions) if (sess.userId === u.id) sessions.delete(token);
      }
    }
    if ('role' in body && (body.role === 'admin' || body.role === 'member') && body.role !== u.role) {
      u.role = body.role; changes.push('角色->' + body.role);
    }
    if (body.password) {
      if (String(body.password).length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
      u.passwordHash = hashPassword(body.password); changes.push('重置密码');
      for (const [token, sess] of sessions) if (sess.userId === u.id) sessions.delete(token);
    }
    audit({ actorId: admin.id, action: 'user_manage', target: u.username, result: 'success',
      detail: changes.join(';') || '无变更', ip: clientIp(req) });
    persistDb();
    return sendJson(res, 200, { user: sanitizedUser(u) });
  });
};

/* -------- 授权管理 (管理员): 人员 × 遗址 × 字段 × 有效期 -------- */

function grantView(g) {
  const user = db.users.find(u => u.id === g.userId);
  const site = db.sites.find(s => s.id === g.siteId);
  return {
    id: g.id, userId: g.userId, username: user ? user.username : '(已删除)',
    userActive: user ? user.active : false,
    siteId: g.siteId, siteCode: site ? site.code : '(已删除)',
    fields: g.fields, level: g.level,
    grantedBy: g.grantedBy, createdAt: g.createdAt, expiresAt: g.expiresAt,
    revokedAt: g.revokedAt, active: isGrantActive(g),
  };
}

handlers['GET /api/admin/grants'] = async (req, res) => {
  const admin = requireAdmin(req, res, 'grant');
  if (!admin) return;
  return sendJson(res, 200, { grants: db.grants.map(grantView) });
};

handlers['POST /api/admin/grants'] = async (req, res) => {
  const admin = requireAdmin(req, res, 'grant');
  if (!admin) return;
  const body = await readBody(req);
  const target = db.users.find(u => u.id === body.userId);
  const site = db.sites.find(s => s.id === body.siteId);
  if (!target) return sendJson(res, 400, { error: '请选择人员' });
  if (!site) return sendJson(res, 400, { error: '请选择遗址' });
  let fields;
  if (Array.isArray(body.fields)) fields = [...new Set(body.fields)].filter(f => RESTRICTED_FIELDS.includes(f));
  if ((!fields || !fields.length) && [1, 2, 3].includes(Number(body.level))) {
    fields = LEVEL_PRESETS[Number(body.level)];
  }
  if (!fields || !fields.length) return sendJson(res, 400, { error: '请至少选择一个受限字段或分级' });
  fields.sort((a, b) => RESTRICTED_FIELDS.indexOf(a) - RESTRICTED_FIELDS.indexOf(b));
  let expiresAt = null;
  if (body.expiresAt) {
    const t = new Date(body.expiresAt).getTime();
    if (Number.isNaN(t)) return sendJson(res, 400, { error: '有效期格式不正确' });
    if (t <= Date.now()) return sendJson(res, 400, { error: '有效期不能早于当前时间' });
    expiresAt = new Date(t).toISOString();
  }
  return mutate(() => {
    // 同一(人, 遗址)若已有生效授权, 则更新其字段/期限(审计仍记录一次授权变更, 立即生效)
    let g = db.grants.find(x => x.userId === target.id && x.siteId === site.id && isGrantActive(x));
    if (g) {
      g.fields = fields;
      g.level = Number(body.level) || fields.length;
      g.expiresAt = expiresAt;
      g.grantedBy = admin.id;
      g.createdAt = nowIso();
      audit({ actorId: admin.id, action: 'grant', target: `${target.username}@${site.code}`, result: 'success',
        detail: `更新授权字段: ${fields.join(',')} 到期: ${expiresAt || '长期'}`, ip: clientIp(req) });
    } else {
      g = {
        id: 'g-' + db.counters.grant++,
        userId: target.id, siteId: site.id, fields,
        level: Number(body.level) || fields.length,
        grantedBy: admin.id, createdAt: nowIso(), expiresAt, revokedAt: null,
      };
      db.grants.push(g);
      audit({ actorId: admin.id, action: 'grant', target: `${target.username}@${site.code}`, result: 'success',
        detail: `授权字段: ${fields.join(',')} 到期: ${expiresAt || '长期'}`, ip: clientIp(req) });
    }
    persistDb();
    return sendJson(res, 201, { grant: grantView(g) });
  });
};

handlers['POST /api/admin/grants/:id/revoke'] = async (req, res, params) => {
  const admin = requireAdmin(req, res, 'grant');
  if (!admin) return;
  return mutate(() => {
    const g = db.grants.find(x => x.id === params.id);
    if (!g) return sendJson(res, 404, { error: '授权不存在' });
    if (!g.revokedAt) {
      g.revokedAt = nowIso();
      const user = db.users.find(u => u.id === g.userId);
      const site = db.sites.find(s => s.id === g.siteId);
      audit({ actorId: admin.id, action: 'grant_revoke',
        target: `${user ? user.username : g.userId}@${site ? site.code : g.siteId}`,
        result: 'success', detail: `撤销字段: ${g.fields.join(',')}（即时生效）`, ip: clientIp(req) });
    }
    persistDb();
    return sendJson(res, 200, { grant: grantView(g) });
  });
};

/* -------- 审计查询 (管理员): 查错/追责 -------- */

handlers['POST /api/admin/audit'] = async (req, res) => {
  const admin = requireAdmin(req, res, 'audit_view');
  if (!admin) return;
  const body = await readBody(req).catch(() => ({}));
  let rows = db.audit.slice();
  if (body.result && ['success', 'denied', 'conflict'].includes(body.result)) rows = rows.filter(r => r.result === body.result);
  if (body.action) rows = rows.filter(r => r.action === body.action);
  if (body.actorId) rows = rows.filter(r => r.actorId === body.actorId);
  if (body.q) {
    const q = String(body.q).toLowerCase();
    rows = rows.filter(r => JSON.stringify({ t: r.target, d: r.detail }).toLowerCase().includes(q));
  }
  rows.reverse(); // 最新在前
  const limit = Math.min(Number(body.limit) || 200, 500);
  rows = rows.slice(0, limit).map(r => {
    const u = db.users.find(x => x.id === r.actorId);
    return { ...r, actorName: u ? u.username : (r.actorId || '匿名') };
  });
  return sendJson(res, 200, { audit: rows, total: db.audit.length });
};

/* -------- 测试专用重置接口 (需 TEST_RESET_KEY) -------- */

handlers['POST /api/test/reset'] = async (req, res) => {
  if (!TEST_RESET_KEY || req.headers['x-test-key'] !== TEST_RESET_KEY) {
    return sendJson(res, 404, { error: 'not found' });
  }
  return mutate(() => {
    sessions.clear();
    db = seedDb();
    persistDb();
    return sendJson(res, 200, { ok: true });
  });
};

/* ------------------------------- 静态文件 ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC_FILES = new Set(['/', '/index.html', '/app.js', '/styles.css', '/legacy.html']);

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { urlPath = '/'; }
  if (urlPath === '/') urlPath = '/index.html';
  if (!PUBLIC_FILES.has(urlPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const file = path.join(__dirname, urlPath.replace(/^\/+/, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------- 路由器 ------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  // 精确匹配
  const exact = `${req.method} ${p}`;
  if (handlers[exact]) {
    try { return await handlers[exact](req, res); }
    catch (e) {
      if (e.message === 'payload-too-large') return sendJson(res, 413, { error: '提交内容过大' });
      if (e.message === 'bad-json') return sendJson(res, 400, { error: '请求体不是合法 JSON' });
      return sendJson(res, 500, { error: '服务器错误' });
    }
  }
  // 参数路由
  const paramMatch = [
    ['GET', /^\/api\/sites\/([^/]+)$/, 'GET /api/sites/:id'],
    ['POST', /^\/api\/sites\/([^/]+)\/reveal$/, 'POST /api/sites/:id/reveal'],
    ['POST', /^\/api\/sites\/([^/]+)\/hide$/, 'POST /api/sites/:id/hide'],
    ['PATCH', /^\/api\/sites\/([^/]+)$/, 'PATCH /api/sites/:id'],
    ['DELETE', /^\/api\/sites\/([^/]+)$/, 'DELETE /api/sites/:id'],
    ['PATCH', /^\/api\/admin\/users\/([^/]+)$/, 'PATCH /api/admin/users/:id'],
    ['POST', /^\/api\/admin\/grants\/([^/]+)\/revoke$/, 'POST /api/admin/grants/:id/revoke'],
  ];
  for (const [method, re, key] of paramMatch) {
    if (req.method !== method) continue;
    const m = p.match(re);
    if (m) {
      try { return await handlers[key](req, res, { id: m[1] }); }
      catch (e) {
        if (e.message === 'payload-too-large') return sendJson(res, 413, { error: '提交内容过大' });
        if (e.message === 'bad-json') return sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return sendJson(res, 500, { error: '服务器错误' });
      }
    }
  }
  if (req.method === 'GET') return serveStatic(req, res);
  return sendJson(res, 404, { error: '接口不存在' });
});

loadDb();
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`离线敏感遗址分级共享台: http://localhost:${PORT}`);
    console.log(`旧标记入口: http://localhost:${PORT}/legacy.html`);
  });
}
module.exports = { server, loadDb, db: () => db, fieldsFor, isGrantActive, RESTRICTED_FIELDS };
