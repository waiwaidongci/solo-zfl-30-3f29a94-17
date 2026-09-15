'use strict';
/* 敏感遗址分级共享台前端。所有安全判定以服务端响应为准，前端仅负责展示/隐藏。 */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const TYPE_NAMES = { ceramic: '陶片', wood: '木构件', metal: '金属件', wreck: '沉船遗址', unknown: '未知物' };
const RESTRICTED = ['coords', 'image', 'note'];
const FIELD_NAMES = { coords: '坐标', image: '影像', note: '备注' };
const ACTION_LABELS = {
  login: '登录', logout: '退出', list: '列表查看', view: '查看揭示', hide: '隐藏',
  grant: '授权', grant_revoke: '撤销授权', user_manage: '人员管理',
  create: '新建', update: '写入', delete: '删除', stats: '统计', export: '导出',
  audit_view: '审计查询',
};

const state = {
  me: null,
  sites: [],
  selectedId: null,
  // 当前会话中经 reveal 拿到的受限明文(只存内存, 不落地 localStorage)
  secrets: {}, // siteId -> { coords, image, note }
  imageDrafts: {}, // siteId -> 新选影像的 dataURL(仅在保存成功后随提交发出)
  revealedFields: {}, // siteId -> Set
  filters: { type: '', dive: '', code: '' },
  pollTimer: null,
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind || '';
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3600);
}

async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------- 登录态 --------------------------------- */

// 清空本机所有受限明文: 登出、会话失效、会话校验发现降级时调用
function purgeSecrets(siteIds) {
  const ids = siteIds || Object.keys(state.secrets).concat(Object.keys(state.revealedFields), Object.keys(state.imageDrafts));
  for (const id of new Set(ids)) {
    delete state.secrets[id];
    delete state.revealedFields[id];
    delete state.imageDrafts[id];
  }
}
// 清掉详情表单中残留的受限字段 DOM 值(隐藏并不能防止明文留在页面里)
function wipeSecretInputs() {
  const f = $('#siteForm');
  if (f) { f.note.value = ''; f.x.value = ''; f.y.value = ''; }
  const img = $('#imagePreview');
  if (img) img.removeAttribute('src');
}

async function boot() {
  try {
    const { user } = await api('GET', '/api/me');
    enterApp(user);
    // 支持深链直接进入某条遗址详情: /#site=s-001 也会触发服务端详情查看审计
    const m = location.hash.match(/site=([\w-]+)/);
    if (m) await selectSite(m[1], { fromHash: true });
  } catch (_) {
    showLogin();
  }
}
function showLogin() {
  // 会话失效: 内存中的明文与未保存影像草稿一并清掉, 不留在旧页面
  purgeSecrets();
  wipeSecretInputs();
  state.sites = [];
  state.selectedId = null;
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  stopPolling();
}
function enterApp(user) {
  state.me = user;
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#userBadge').textContent = `${user.displayName}（${user.role === 'admin' ? '管理员' : '成员'} · ${user.username}）`;
  $$('#tabs [data-admin]').forEach(b => b.classList.toggle('hidden', user.role !== 'admin'));
  $('#deleteBtn').classList.toggle('hidden', user.role !== 'admin');
  switchTab('sites');
  startSessionChecks();
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('#loginError').textContent = '';
  try {
    const { user } = await api('POST', '/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
    enterApp(user);
    toast('登录成功', 'ok');
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch (_) {}
  state.me = null;
  showLogin();
});

/* -------------------------------- Tab ----------------------------------- */

$$('#tabs button').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
async function switchTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  for (const id of ['sites', 'stats', 'grants', 'users', 'audit']) {
    $('#tab-' + id).classList.toggle('hidden', id !== name);
  }
  if (name === 'sites') await loadSites();
  if (name === 'stats') loadStats();
  if (name === 'grants') loadGrantsTab();
  if (name === 'users') loadUsers();
  if (name === 'audit') loadAudit();
}

/* ----------------------------- 遗址列表/地图 ----------------------------- */

function initStaticOptions() {
  for (const [v, n] of Object.entries(TYPE_NAMES)) {
    $('#fType').insertAdjacentHTML('beforeend', `<option value="${v}">${n}</option>`);
    $('#editType').insertAdjacentHTML('beforeend', `<option value="${v}">${n}</option>`);
  }
}

async function loadSites(opts = {}) {
  const body = { silent: !!opts.silent };
  if (state.filters.type) body.type = state.filters.type;
  if (state.filters.dive) body.dive = state.filters.dive;
  if (state.filters.code) body.code = state.filters.code;
  try {
    const { sites } = await api('POST', '/api/sites/list', body);
    reconcilePermissions(sites);
    state.sites = sites;
    renderSites();
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message, 'error');
  }
}

/**
 * 会话校验核心: 拿最新权限与本机已揭示内容对照。
 * 一旦发现字段被收回(撤销/到期/停用), 立即:
 *  1) 删除该字段内存明文、揭示态、影像草稿; 2) 清空详情表单/DOM 残留;
 * 保证服务端拒绝后的"下一次会话校验"不会把无权明文留在当前页面。
 */
function reconcilePermissions(freshSites) {
  const prev = state._permSnapshot || {};
  let reducedAny = false;
  for (const fresh of freshSites) {
    const old = prev[fresh.id];
    if (!old) continue;
    const lost = RESTRICTED.filter(f => old[f] && !fresh.permissions[f]);
    if (!lost.length) continue;
    reducedAny = true;
    const rev = state.revealedFields[fresh.id];
    const sec = state.secrets[fresh.id];
    for (const f of lost) {
      if (rev) rev.delete(f);
      if (sec) delete sec[f];
      delete state.imageDrafts[fresh.id];
    }
    if (state.selectedId === fresh.id) {
      const f = $('#siteForm');
      if (lost.includes('note')) f.note.value = '';
      if (lost.includes('coords')) { f.x.value = ''; f.y.value = ''; }
      if (lost.includes('image')) { $('#imagePreview').removeAttribute('src'); $('#imageFile').value = ''; }
    }
  }
  state._permSnapshot = Object.fromEntries(freshSites.map(s => [s.id, { ...s.permissions }]));
  return reducedAny;
}

function currentSite() { return state.sites.find(s => s.id === state.selectedId) || null; }

function renderSites() {
  // 地图
  $$('#map .marker').forEach(el => el.remove());
  const obscuredAny = state.sites.some(s => s.hasCoords && !s.permissions.coords);
  const notice = $('#mapNotice');
  if (obscuredAny) {
    notice.classList.remove('hidden');
    notice.textContent = '🔒 虚线斜纹标记为无坐标授权的占位位置（非真实坐标），真实坐标未下发到本机。';
  } else notice.classList.add('hidden');

  state.sites.forEach(site => {
    const el = document.createElement('button');
    const pos = site.coords || { x: 50, y: 50 };
    const obscured = site.hasCoords && !site.permissions.coords;
    el.className = `marker ${site.type}${site.id === state.selectedId ? ' selected' : ''}${obscured ? ' obscured' : ''}`;
    el.style.left = pos.x + '%';
    el.style.top = pos.y + '%';
    el.textContent = site.code.slice(0, 2);
    el.title = obscured ? `${site.code}（坐标未授权）` : site.code;
    el.addEventListener('click', ev => { ev.stopPropagation(); selectSite(site.id); });
    $('#map').appendChild(el);
  });

  // 潜次下拉
  const dives = [...new Set(state.sites.map(s => s.dive).filter(Boolean))].sort();
  const cur = state.filters.dive;
  $('#fDive').innerHTML = '<option value="">全部潜次</option>' + dives.map(d => `<option value="${esc(d)}"${d === cur ? ' selected' : ''}>${esc(d)}</option>`).join('');
  $('#fType').value = state.filters.type;
  $('#fCode').value = state.filters.code;

  // 列表
  $('#siteList').innerHTML = state.sites.map(s => {
    const locks = RESTRICTED.filter(f => s['has' + f[0].toUpperCase() + f.slice(1)] && !s.permissions[f])
      .map(f => `<span class="pill no">🔒${FIELD_NAMES[f]}</span>`).join('');
    const grants = RESTRICTED.filter(f => s.permissions[f]).map(f => `<span class="pill ok">${FIELD_NAMES[f]}</span>`).join('');
    return `<div class="item ${s.id === state.selectedId ? 'active' : ''}" data-id="${s.id}">
      <b>${esc(s.code)}</b> <span class="pill">${TYPE_NAMES[s.type] || s.type}</span>${locks}${grants}
      <div class="sub">${esc(s.dive)} · ${esc(s.depth)} · v${s.version} · 更新于 ${new Date(s.updatedAt).toLocaleString()}</div>
    </div>`;
  }).join('');
  $$('#siteList [data-id]').forEach(el => el.addEventListener('click', () => selectSite(el.dataset.id)));
}

$('#searchBtn').addEventListener('click', () => {
  state.filters = { type: $('#fType').value, dive: $('#fDive').value, code: $('#fCode').value.trim() };
  loadSites();
});
$('#clearFilterBtn').addEventListener('click', () => {
  state.filters = { type: '', dive: '', code: '' };
  loadSites();
});

/* ------------------------------- 详情/编辑 ------------------------------- */

function revealed(id) { return state.revealedFields[id] || (state.revealedFields[id] = new Set()); }
function secretsOf(id) { return state.secrets[id] || (state.secrets[id] = {}); }

function clearDetail() {
  state.selectedId = null;
  $('#siteForm').classList.add('hidden');
  $('#detailEmpty').classList.remove('hidden');
  $('#conflictBox').classList.add('hidden');
}

function newSite() {
  state.selectedId = null;
  $('#detailEmpty').classList.add('hidden');
  const form = $('#siteForm');
  form.classList.remove('hidden');
  form.reset();
  form.id.value = '';
  form.version.value = '0';
  $('#conflictBox').classList.add('hidden');
  $('#versionInfo').textContent = '新记录（尚未创建）';
  const isAdmin = state.me.role === 'admin';
  setupFieldUi(null, isAdmin ? { coords: true, image: false, note: true } : { coords: false, image: false, note: false }, true);
  if (isAdmin) {
    form.x.value = 50; form.y.value = 50;
  }
}
$('#newBtn').addEventListener('click', newSite);
$('#map').addEventListener('click', ev => {
  // 仅管理员新建时允许点地图给坐标
  if (state.me.role !== 'admin' || $('#siteForm').classList.contains('hidden') || $('#siteForm').id.value) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const x = Number(((ev.clientX - rect.left) / rect.width * 100).toFixed(2));
  const y = Number(((ev.clientY - rect.top) / rect.height * 100).toFixed(2));
  $('#siteForm').x.value = x; $('#siteForm').y.value = y;
});

// 进入详情: 以服务端 GET 详情为准(并由服务端写"查看"审计), 不直接复用列表数据
async function selectSite(id, opts = {}) {
  if (!opts.fromHash) history.replaceState(null, '', `#site=${id}`);
  state.selectedId = id;
  $('#detailEmpty').classList.add('hidden');
  $('#siteForm').classList.remove('hidden');
  $('#conflictBox').classList.add('hidden');
  try {
    const { site } = await api('GET', `/api/sites/${encodeURIComponent(id)}`);
    // 用详情响应同步列表缓存里的权限/版本, 并收敛一次本机明文
    const reduced = reconcilePermissions([site]);
    const idx = state.sites.findIndex(s => s.id === site.id);
    if (idx > -1) state.sites[idx] = site;
    renderDetail(site);
    renderSites();
    if (reduced) toast('授权状态已变化，无权字段已立即清除并隐藏', 'warn');
  } catch (err) {
    if (err.status === 401) return showLogin();
    if (err.status === 404) { clearDetail(); return toast('遗址不存在或已被删除', 'error'); }
    toast(err.message, 'error');
  }
}

window.addEventListener('hashchange', () => {
  if (!state.me) return;
  const m = location.hash.match(/site=([\w-]+)/);
  if (m && m[1] !== state.selectedId) selectSite(m[1], { fromHash: true });
});

function setupFieldUi(site, perms, isNew) {
  for (const f of RESTRICTED) {
    const can = !!perms[f];
    $(`#${f}Perm`).textContent = can ? '（已授权）' : '（未授权）';
    const locked = $(`#${f}Locked`), open = $(`#${f}Open`);
    const lockBtn = locked.querySelector('button');
    lockBtn.classList.remove('hidden');

    // 坐标: 有权限即直接展示/可编辑(列表查看已留审计); 影像/备注: 有权限也需点击"显示"并留揭示审计
    if (f === 'coords') {
      if (can) { locked.classList.add('hidden'); open.classList.remove('hidden'); }
      else { locked.classList.remove('hidden'); open.classList.add('hidden'); locked.querySelector('span').textContent = '🔒 坐标已隐藏，地图上为伪装占位位置'; }
      continue;
    }

    const hasData = site && site['has' + f[0].toUpperCase() + f.slice(1)];
    const isRevealed = !isNew && site && revealed(site.id).has(f);
    if (!can) {
      locked.classList.remove('hidden'); open.classList.add('hidden');
      locked.querySelector('span').textContent = `🔒 ${FIELD_NAMES[f]}已隐藏，未获授权`;
    } else if (isNew) {
      locked.classList.add('hidden'); open.classList.remove('hidden');
    } else if (isRevealed) {
      locked.classList.add('hidden'); open.classList.remove('hidden');
    } else {
      locked.classList.remove('hidden'); open.classList.add('hidden');
      locked.querySelector('span').textContent = hasData
        ? `🔒 ${FIELD_NAMES[f]}已隐藏（你有授权，点击显示会记录到审计）`
        : `（暂无${FIELD_NAMES[f]}，可点击后补录，操作会记录到审计）`;
    }
    // 新建记录时不允许直接带影像(成员/管理员均先建公共记录, 取得授权后再补影像)
    if (f === 'image' && isNew) $('#imageFile').disabled = true;
    else $('#imageFile').disabled = !can;
  }
}

// 影像选档: 读取为 data URL 作为待提交草稿, 只有保存成功才会落库
$('#imageFile').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  const site = currentSite();
  if (!file || !site || !site.permissions.image) { ev.target.value = ''; return; }
  if (file.size > 1.2 * 1024 * 1024) {
    ev.target.value = '';
    return toast('影像超过 1.2MB，已拒绝', 'error');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  state.imageDrafts[site.id] = dataUrl;
  $('#imagePreview').src = dataUrl;
  $('#imagePreview').classList.remove('hidden');
  toast('影像已暂存，点击保存后才会写入；授权范围外的保存会整体拒绝', 'ok');
});

function renderDetail(site) {
  const form = $('#siteForm');
  form.id.value = site.id;
  form.version.value = site.version;
  form.code.value = site.code;
  form.type.value = site.type;
  form.dive.value = site.dive;
  form.depth.value = site.depth;
  form.orientation.value = site.orientation || '';
  form.condition.value = site.condition || '';
  $('#versionInfo').textContent = `当前版本 v${site.version} · 更新于 ${new Date(site.updatedAt).toLocaleString()}`;
  applySecretPanel(site);
}

/**
 * 只按最新权限刷新"坐标/影像/备注"三个受限区与本机明文,
 * 不动公共字段输入和版本基线 —— 供定时会话校验调用, 不打断正在进行的编辑。
 */
function applySecretPanel(site) {
  const form = $('#siteForm');
  const sec = state.secrets[site.id] || {};
  // 以本次详情的真实权限为准: 对任何已无权字段, 内存明文/揭示态/草稿一律清除
  for (const f of RESTRICTED) {
    if (!site.permissions[f]) {
      const rev = state.revealedFields[site.id];
      if (rev) rev.delete(f);
      delete sec[f];
      delete state.imageDrafts[site.id];
    }
  }

  // 坐标: 有权限为真实值且可编辑; 无权限时表单里绝不能残留旧真值
  if (site.permissions.coords && site.coords && !site.coords.obscured) {
    // 正在编辑坐标时不要用轮询值打断键入
    if (document.activeElement !== form.x) form.x.value = site.coords.x;
    if (document.activeElement !== form.y) form.y.value = site.coords.y;
    $('#coordsMeta').textContent = `真实坐标 ${site.coords.x}%, ${site.coords.y}%`;
  } else {
    form.x.value = ''; form.y.value = '';
    $('#coordsMeta').textContent = site.hasCoords ? '无授权：地图所示为伪装占位位置' : '该记录暂无坐标';
  }

  // 影像: 只有"仍有权限且本会话已揭示(或有未保存草稿)"才显示
  if (site.permissions.image && revealed(site.id).has('image') && (sec.image || state.imageDrafts[site.id])) {
    $('#imagePreview').src = state.imageDrafts[site.id] || sec.image;
    $('#imagePreview').classList.remove('hidden');
  } else {
    $('#imagePreview').classList.add('hidden');
    $('#imagePreview').removeAttribute('src');
  }
  $('#imageFile').value = '';

  // 备注: 未揭示或授权被收回时文本框必须清空, 不能只靠隐藏把明文留在 DOM 里
  if (!(site.permissions.note && revealed(site.id).has('note'))) form.note.value = '';
  else if (document.activeElement !== form.note) form.note.value = sec.note || '';

  // 权限/揭示态决定锁框与展开框(依据上面已清理过的状态)
  setupFieldUi(site, site.permissions, false);
}

// 申请显示 / 隐藏
document.addEventListener('click', async ev => {
  const rev = ev.target.closest('[data-reveal]');
  const hid = ev.target.closest('[data-hide]');
  if (!rev && !hid) return;
  const id = $('#siteForm').id.value;
  if (!id) return;
  const field = (rev && rev.dataset.reveal) || (hid && hid.dataset.hide);
  if (rev) {
    try {
      const { fields } = await api('POST', `/api/sites/${id}/reveal`, { field });
      Object.assign(secretsOf(id), fields);
      revealed(id).add(field);
      toast(`已显示${FIELD_NAMES[field]}（操作已记录）`, 'ok');
      const fresh = await api('GET', `/api/sites/${id}?silent=1`);
      const idx = state.sites.findIndex(s => s.id === id);
      if (idx > -1) state.sites[idx] = fresh.site;
      renderDetail(fresh.site);
    } catch (err) {
      if (err.status === 401) return showLogin();
      toast(err.status === 403 ? `越权被拒绝：${err.message}` : err.message, 'error');
      // 服务端拒绝后立即按最新权限收敛: 清内存并收起字段
      try {
        const { site } = await api('GET', `/api/sites/${id}?silent=1`);
        const reduced = reconcilePermissions([site]);
        const idx = state.sites.findIndex(s => s.id === id);
        if (idx > -1) state.sites[idx] = site;
        renderDetail(site);
        if (reduced) toast('授权状态已变化，无权明文已清除', 'warn');
      } catch (_) {}
    }
  } else {
    try {
      await api('POST', `/api/sites/${id}/hide`, { fields: [field] });
      // 隐藏成功(审计已记): 收起并删除本机内存明文
      revealed(id).delete(field);
      delete secretsOf(id)[field];
      if (field === 'image') delete state.imageDrafts[id];
      const site = currentSite() || (await api('GET', `/api/sites/${id}?silent=1`)).site;
      renderDetail(site);
      toast(`已隐藏${FIELD_NAMES[field]}`, 'ok');
    } catch (err) {
      if (err.status === 401) return showLogin();
      // 无权隐藏是无效操作: 服务端已记拒绝; 本地同样不得保留该字段明文
      toast(`隐藏被拒绝：${err.message}`, 'error');
      revealed(id).delete(field);
      delete secretsOf(id)[field];
      delete state.imageDrafts[id];
      try {
        const { site } = await api('GET', `/api/sites/${id}?silent=1`);
        reconcilePermissions([site]);
        const idx = state.sites.findIndex(s => s.id === id);
        if (idx > -1) state.sites[idx] = site;
        renderDetail(site);
      } catch (_) {}
    }
  }
});

/* ------------------------------- 保存(乐观锁) ----------------------------- */

$('#saveBtn').addEventListener('click', () => saveSite());
async function saveSite() {
  const form = $('#siteForm');
  const fd = new FormData(form);
  const isNew = !fd.get('id');
  const site = isNew ? null : currentSite();
  const payload = {
    code: String(fd.get('code') || '').trim(),
    type: fd.get('type'),
    dive: String(fd.get('dive') || '').trim(),
    depth: String(fd.get('depth') || '').trim(),
    orientation: fd.get('orientation') || '',
    condition: fd.get('condition') || '',
  };
  let perms;
  if (isNew) {
    perms = state.me.role === 'admin' ? { coords: true, image: false, note: true } : { coords: false, image: false, note: false };
    if (perms.coords) payload.coords = { x: Number(form.x.value), y: Number(form.y.value) };
    if (perms.note) payload.note = form.note.value || null;
  } else {
    // 版本基线取表单打开时的值: 后台轮询刷新不会悄悄抬高基线, 旧版本提交必须撞 409
    payload.version = Number(form.version.value);
    perms = site.permissions;
    // 坐标有权限即可改; 影像/备注必须已揭示(显式查看)才提交, 避免无变化地重写受限内容
    if (perms.coords && site.coords && !site.coords.obscured) {
      payload.coords = { x: Number(form.x.value), y: Number(form.y.value) };
    }
    if (perms.note && revealed(site.id).has('note')) payload.note = form.note.value || null;
    if (perms.image && state.imageDrafts[site.id]) payload.image = state.imageDrafts[site.id];
  }
  try {
    let saved;
    if (isNew) {
      const r = await api('POST', '/api/sites', payload);
      saved = r.site;
      toast('遗址已创建', 'ok');
    } else {
      const r = await api('PATCH', `/api/sites/${site.id}`, payload);
      saved = r.site;
      toast(`保存成功，版本升至 v${saved.version}`, 'ok');
    }
    state.selectedId = saved.id;
    delete state.revealedFields[saved.id]; state.secrets[saved.id] = {};
    delete state.imageDrafts[saved.id];
    $('#conflictBox').classList.add('hidden');
    await loadSites();
    await selectSite(saved.id);
  } catch (err) {
    if (err.status === 409) {
      showConflict(payload, err.data.current);
      toast('保存被拒绝：版本冲突，数据未被覆盖', 'error');
    } else {
      toast(`保存被拒绝：${err.message}（原值保留）`, 'error');
    }
    await loadSites();
  }
}

function showConflict(mine, latest) {
  const rows = [
    ['编号', mine.code, latest.code],
    ['类型', TYPE_NAMES[mine.type] || mine.type, TYPE_NAMES[latest.type] || latest.type],
    ['潜次', mine.dive, latest.dive],
    ['深度', mine.depth, latest.depth],
    ['朝向', mine.orientation, latest.orientation],
    ['保存状态', mine.condition, latest.condition],
  ];
  const box = $('#conflictBox');
  box.innerHTML = `<b>⚠ 冲突：该记录已被其他人改到 v${latest.version}（你基于 v${mine.version} 编辑）。</b>
    <div class="muted">你的提交已被拒绝，服务器数据未被覆盖。请对照后决定：</div>
    <table><thead><tr><th>字段</th><th>你的值（未保存）</th><th>服务器最新值</th></tr></thead>
    <tbody>${rows.map(([k, a, b]) => `<tr><td>${k}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table>
    <div class="row-actions">
      <button type="button" id="conflictReload" class="secondary">放弃我的修改，载入最新版</button>
      <button type="button" id="conflictMerge" class="ghost">我要手动合并：用我的值填入最新版本表单（需自行核对）</button>
    </div>`;
  box.classList.remove('hidden');
  $('#conflictReload').addEventListener('click', () => { box.classList.add('hidden'); renderDetail(currentSite()); });
  $('#conflictMerge').addEventListener('click', () => {
    // 用服务器最新版本打底, 但把用户改过的公共字段值留在表单里, 由用户显式再次提交
    const f = $('#siteForm');
    f.version.value = latest.version;
    toast('已切换到最新版本，核对后请再次点击保存', 'ok');
    box.classList.add('hidden');
  });
}

$('#deleteBtn').addEventListener('click', async () => {
  const site = currentSite();
  if (!site) return;
  if (!confirm(`确认删除 ${site.code}？该操作会被审计记录。`)) return;
  try {
    await api('DELETE', `/api/sites/${site.id}`);
    clearDetail();
    toast('已删除', 'ok');
    loadSites();
  } catch (err) { toast(err.message, 'error'); }
});

/* -------------------------------- 导出 ---------------------------------- */

$('#exportBtn').addEventListener('click', async () => {
  const body = {};
  if (state.filters.type) body.type = state.filters.type;
  if (state.filters.dive) body.dive = state.filters.dive;
  if (state.filters.code) body.code = state.filters.code;
  try {
    const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    if (!res.ok) {
      let d = {}; try { d = await res.json(); } catch (_) {}
      throw new Error(d.error || '导出被拒绝');
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sites-${state.me.username}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('导出完成：仅包含你有权查看的字段', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

/* -------------------------------- 统计 ---------------------------------- */

async function loadStats() {
  try {
    const r = await api('POST', '/api/stats', {});
    const parts = [`<span class="pill ok">共 ${r.total} 处</span>`]
      .concat(Object.entries(r.byType).filter(([, n]) => n > 0).map(([t, n]) => `<span class="pill">${TYPE_NAMES[t] || t}：${n}</span>`))
      .concat(Object.entries(r.byDive).map(([d, n]) => `<span class="pill">${esc(d)}：${n}</span>`));
    $('#statsOut').innerHTML = parts.join('');
  } catch (err) { toast(err.message, 'error'); }
}
$('#statsBtn')?.addEventListener('click', loadStats);

/* ------------------------------- 授权管理 -------------------------------- */

async function loadGrantsTab() {
  try {
    const [{ users }, { sites }, { grants }] = await Promise.all([
      api('GET', '/api/admin/users'),
      api('POST', '/api/sites/list', {}),
      api('GET', '/api/admin/grants'),
    ]);
    $('#grantUser').innerHTML = users.filter(u => u.role !== 'admin').map(u =>
      `<option value="${u.id}">${esc(u.displayName)}（${u.username}）${u.active ? '' : ' [已停用]'}</option>`).join('');
    $('#grantSite').innerHTML = sites.map(s => `<option value="${s.id}">${esc(s.code)}</option>`).join('');
    renderGrants(grants);
  } catch (err) { toast(err.message, 'error'); }
}
function renderGrants(grants) {
  $('#grantsTable').querySelector('tbody').innerHTML = grants.map(g => `
    <tr data-id="${g.id}">
      <td>${esc(g.username)}${g.userActive ? '' : ' <span class="pill no">已停用</span>'}</td>
      <td>${esc(g.siteCode)}</td>
      <td>${g.fields.map(f => `<span class="pill">${FIELD_NAMES[f]}</span>`).join('')}</td>
      <td>${g.level} 级</td>
      <td>${g.expiresAt ? esc(new Date(g.expiresAt).toLocaleString()) : '长期'}${g.active && g.expiresAt && Date.now() > new Date(g.expiresAt) ? '' : ''}</td>
      <td>${g.active ? '<span class="pill ok">生效中</span>' : (g.revokedAt ? '<span class="pill no">已撤销</span>' : '<span class="pill warn">已过期</span>')}</td>
      <td>${g.active ? `<button type="button" class="danger" data-revoke="${g.id}">撤销（即时生效）</button>` : '—'}</td>
    </tr>`).join('');
  $('#grantsTable').querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      const { grant } = await api('POST', `/api/admin/grants/${btn.dataset.revoke}/revoke`);
      toast('授权已撤销，对方下次请求即降权', 'ok');
      const { grants } = await api('GET', '/api/admin/grants');
      renderGrants(grants);
    } catch (err) { toast(err.message, 'error'); }
  }));
}
$('#grantLevel').addEventListener('change', e => {
  const presets = { 1: ['coords'], 2: ['coords', 'image'], 3: ['coords', 'image', 'note'] };
  const set = presets[e.target.value] || [];
  RESTRICTED.forEach(f => { $('#fld-' + f).checked = set.includes(f); });
});
async function submitGrant(expiresAt) {
  const fields = RESTRICTED.filter(f => $('#fld-' + f).checked);
  const body = {
    userId: $('#grantUser').value,
    siteId: $('#grantSite').value,
    level: Number($('#grantLevel').value) || fields.length,
    fields,
    expiresAt: expiresAt || null,
  };
  if (!fields.length) return toast('请至少勾选一个字段', 'error');
  if (!expiresAt && $('#grantExpiry').value) body.expiresAt = new Date($('#grantExpiry').value).toISOString();
  try {
    await api('POST', '/api/admin/grants', body);
    toast('授权已保存并立即生效', 'ok');
    const { grants } = await api('GET', '/api/admin/grants');
    renderGrants(grants);
  } catch (err) { toast(err.message, 'error'); }
}
$('#grantBtn').addEventListener('click', () => submitGrant());
$('#grantQuickExpire').addEventListener('click', () => submitGrant(new Date(Date.now() + 5000).toISOString()));

/* -------------------------------- 人员 ---------------------------------- */

async function loadUsers() {
  try {
    const { users } = await api('GET', '/api/admin/users');
    $('#usersTable').querySelector('tbody').innerHTML = users.map(u => `
      <tr data-id="${u.id}">
        <td>${esc(u.username)}</td>
        <td>${esc(u.displayName)}</td>
        <td>${u.role === 'admin' ? '<span class="pill warn">管理员</span>' : '成员'}</td>
        <td>${u.active ? '<span class="pill ok">启用</span>' : '<span class="pill no">停用</span>'}</td>
        <td>
          <button type="button" class="${u.active ? 'danger' : ''}" data-active="${u.active ? '0' : '1'}">${u.active ? '停用（即时踢下线）' : '启用'}</button>
          ${u.role === 'admin'
            ? `<button type="button" class="ghost" data-role="member">降为成员</button>`
            : `<button type="button" class="ghost" data-role="admin">升为管理员</button>`}
        </td>
      </tr>`).join('');
    $('#usersTable').querySelectorAll('[data-active]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('PATCH', `/api/admin/users/${b.closest('tr').dataset.id}`, { active: b.dataset.active === '1' });
        toast(b.dataset.active === '1' ? '已启用' : '已停用，其会话立即失效', 'ok');
        loadUsers();
      } catch (err) { toast(err.message, 'error'); }
    }));
    $('#usersTable').querySelectorAll('[data-role]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('PATCH', `/api/admin/users/${b.closest('tr').dataset.id}`, { role: b.dataset.role });
        loadUsers();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) { toast(err.message, 'error'); }
}
$('#createUserBtn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/admin/users', {
      username: $('#newUsername').value.trim(),
      displayName: $('#newDisplay').value.trim() || $('#newUsername').value.trim(),
      password: $('#newPassword').value,
    });
    $('#newUsername').value = $('#newDisplay').value = $('#newPassword').value = '';
    toast('人员已创建', 'ok');
    loadUsers();
  } catch (err) { toast(err.message, 'error'); }
});

/* -------------------------------- 审计 ---------------------------------- */

async function loadAudit() {
  try {
    const body = { limit: 200 };
    if ($('#auditResult').value) body.result = $('#auditResult').value;
    if ($('#auditAction').value) body.action = $('#auditAction').value;
    if ($('#auditQ').value.trim()) body.q = $('#auditQ').value.trim();
    const { audit, total } = await api('POST', '/api/admin/audit', body);
    $('#auditTable').querySelector('tbody').innerHTML = audit.map(r => `
      <tr>
        <td>${esc(new Date(r.at).toLocaleString())}</td>
        <td>${esc(r.actorName)}</td>
        <td>${esc(ACTION_LABELS[r.action] || r.action)}</td>
        <td>${esc(r.target || '')}</td>
        <td class="result-${r.result}">${r.result === 'success' ? '成功' : r.result === 'denied' ? '拒绝' : '冲突'}</td>
        <td>${esc(r.detail || '')}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">暂无记录（共 ${total} 条，尝试调整筛选）</td></tr>`;
  } catch (err) { toast(err.message, 'error'); }
}
$('#auditBtn').addEventListener('click', loadAudit);

/* ------- 会话校验: 授权撤销/到期/停用后, 旧页面在下一次校验即降权清屏 ------- */

let checking = false;
async function sessionCheck() {
  if (checking || !state.me) return;
  checking = true;
  try {
    // 1) 会话本身是否仍有效(被停用/登出会 401)
    const { user } = await api('GET', '/api/me');
    if (!user.active || user.id !== state.me.id) return showLogin();

    if (!$('#tab-sites').classList.contains('hidden')) {
      // 2) 已打开详情时优先只校验该条, 撤销/到期会立刻在当前页面清屏
      if (state.selectedId) {
        const { site } = await api('GET', `/api/sites/${state.selectedId}?silent=1`);
        const reduced = reconcilePermissions([site]);
        const idx = state.sites.findIndex(s => s.id === site.id);
        if (idx > -1) state.sites[idx] = site;
        applySecretPanel(site); // 只收敛受限字段区, 公共字段/版本基线不动
        if (reduced) toast('授权已撤销或过期，无权明文已从当前页面清除', 'warn');
        // 地图/列表上的其它记录权限也同步, 但不打断详情
        const body = { silent: true };
        if (state.filters.type) body.type = state.filters.type;
        if (state.filters.dive) body.dive = state.filters.dive;
        if (state.filters.code) body.code = state.filters.code;
        const list = await api('POST', '/api/sites/list', body);
        reconcilePermissions(list.sites);
        state.sites = list.sites.map(s => s.id === site.id ? site : s);
        renderSites();
      } else {
        await loadSites({ silent: true });
      }
    }
  } catch (err) {
    if (err.status === 401) showLogin();
    // 其它错误(网络抖动等)保留当前页面, 下次校验再收敛
  } finally {
    checking = false;
  }
}

function startSessionChecks() {
  stopPolling();
  state.pollTimer = setInterval(sessionCheck, 3000);
  // 切回该标签页/窗口重新聚焦时立即校验一次, 不等定时器
  document.addEventListener('visibilitychange', onVisibleCheck);
  window.addEventListener('focus', sessionCheck);
}
function onVisibleCheck() { if (document.visibilityState === 'visible') sessionCheck(); }
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  document.removeEventListener('visibilitychange', onVisibleCheck);
  window.removeEventListener('focus', sessionCheck);
}

initStaticOptions();
boot();
