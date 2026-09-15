'use strict';
const { test, expect, request } = require('@playwright/test');

const BASE = 'http://localhost:8731';
const RESET_KEY = 'e2e-reset-key';

async function resetDb() {
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.post('/api/test/reset', { headers: { 'x-test-key': RESET_KEY } });
  await ctx.dispose();
}

// 通过真实登录表单登录(浏览器上下文, 保留 HttpOnly Cookie)
async function loginViaUi(page, username, password) {
  await page.goto('/');
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password);
  await page.click('#loginForm button');
  await expect(page.locator('#appView')).toBeVisible();
}

async function api(ctx, method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.data = body; }
  return ctx.request.fetch(BASE + url, opt);
}

async function newLoggedInContext(browser, username, password) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUi(page, username, password);
  return { context, page };
}

test.beforeEach(async () => { await resetDb(); });

/* ---------------- 1. 越权查看: UI 拒绝 + 审计记录 ---------------- */

test('无授权字段在列表脱敏、揭示被拒；有权揭示成功且全部留审计', async ({ browser }) => {
  const { context, page } = await newLoggedInContext(browser, 'lin', 'lin123');

  await page.waitForSelector('#siteList .item');
  // S-001 lin 有全部授权; S-002 无任何授权(该遗址本身无影像, 故只显示坐标/备注锁)
  const s002 = page.locator('#siteList .item', { hasText: 'S-002' });
  await expect(s002).toContainText('🔒坐标');
  await expect(s002).toContainText('🔒备注');
  await expect(s002).not.toContainText('🔒影像');

  await s002.click();
  // 坐标区是锁定框, 真实坐标输入框不可见
  await expect(page.locator('#coordsLocked')).toBeVisible();
  await expect(page.locator('#coordsOpen')).toBeHidden();

  // 点击"申请显示"备注 → 403
  await page.click('#noteLocked button');
  await expect(page.locator('#toast.error')).toContainText('越权被拒绝');
  // 备注明文绝不出现在页面
  expect(await page.locator('body').innerText()).not.toContain('采样需审批');

  // 地图上 S-002 标记为斜纹伪装占位
  await expect(page.locator('.marker.obscured').first()).toBeVisible();

  // 有权限的 S-001: 影像/备注需显式揭示并记录
  await page.click('#siteList .item:has-text("S-001")');
  await expect(page.locator('#noteLocked')).toBeVisible();
  await page.click('#noteLocked button');
  await expect(page.locator('#noteOpen textarea')).toBeVisible();
  await expect(page.locator('#noteOpen textarea')).toHaveValue(/靠近船肋/);
  // 隐藏
  await page.click('[data-hide="note"]');
  await expect(page.locator('#noteOpen')).toBeHidden();
  await expect(page.locator('body')).not.toContainText('靠近船肋');

  // 管理员审计里应同时看到成功与拒绝的"查看"记录
  const admin = await browser.newContext();
  const ap = await admin.newPage();
  await loginViaUi(ap, 'admin', 'admin123');
  await ap.click('button[data-tab=audit]');
  await ap.selectOption('#auditResult', 'denied');
  await ap.click('#auditBtn');
  await expect(ap.locator('#auditTable tbody')).toContainText('尝试揭示受限字段');
  await ap.selectOption('#auditResult', 'success');
  await ap.selectOption('#auditAction', 'view');
  await ap.click('#auditBtn');
  await expect(ap.locator('#auditTable tbody')).toContainText('揭示字段');
  await admin.close();
  await context.close();
});

test('未登录拿不到任何数据; 成员访问管理接口被拒', async ({ page, context }) => {
  // 未登录访问受保护 API
  const r1 = await api(context, 'POST', '/api/sites/list', {});
  expect(r1.status()).toBe(401);
  const r2 = await api(context, 'POST', '/api/export', {});
  expect(r2.status()).toBe(401);

  await loginViaUi(page, 'wang', 'wang123');
  const r3 = await api(context, 'GET', '/api/admin/grants');
  expect(r3.status()).toBe(403);
  const r4 = await api(context, 'POST', '/api/admin/grants', { userId: 'u-lin', siteId: 's-003', fields: ['coords'] });
  expect(r4.status()).toBe(403);
  // 越权删除
  const r5 = await api(context, 'DELETE', '/api/sites/s-001');
  expect(r5.status()).toBe(403);
});

/* ---------------- 2. 越权写入拒绝, 失败保留原值 ---------------- */

test('越权写入受限字段被 403, 原值不动', async ({ browser }) => {
  const { context, page } = await newLoggedInContext(browser, 'lin', 'lin123');
  // lin 对 S-002 没有 coords 授权
  const r = await api(context, 'PATCH', '/api/sites/s-002', { coords: { x: 1, y: 1 }, version: 1 });
  expect(r.status()).toBe(403);
  expect(await r.json()).toMatchObject({ denied: ['coords'] });

  // 数据库原值保留: 坐标仍是 58/39, 版本仍是 1
  const list = await api(context, 'POST', '/api/sites/list', {});
  const j = await list.json();
  const s2 = j.sites.find(s => s.code === 'S-002');
  expect(s2.version).toBe(1);
  expect(s2.coords).toMatchObject({ obscured: true }); // lin 仍只见伪装坐标

  // 非法输入同样拒绝并保留原值(管理员)
  await page.click('#logoutBtn');
  await loginViaUi(page, 'admin', 'admin123');
  const bad = await api(context, 'PATCH', '/api/sites/s-001', { coords: { x: 999, y: -3 }, version: 3 });
  expect(bad.status()).toBe(400);
  const again = await api(context, 'POST', '/api/sites/list', {});
  const jj = await again.json();
  const s1 = jj.sites.find(s => s.code === 'S-001');
  expect(s1.version).toBe(3);
  expect(s1.coords).toMatchObject({ x: 42, y: 46 });
  await context.close();
});

test('UI 非法坐标提交失败并提示原值保留', async ({ browser }) => {
  const { context, page } = await newLoggedInContext(browser, 'admin', 'admin123');
  await page.click('#siteList .item:has-text("S-001")');
  await page.fill('input[name=x]', '777');
  await page.click('#saveBtn');
  await expect(page.locator('#toast.error')).toContainText(/坐标|原值保留/);
  await expect(page.locator('#conflictBox')).toBeHidden();
  await context.close();
});

test('影像字段: 无授权写入被 403 且原影像保留; 授权后可补录并可再导出', async ({ browser }) => {
  // lin 对 S-002 无影像授权: 直接 PATCH image 必须拒绝, 版本/数据不变
  const lin = await browser.newContext();
  const lp = await lin.newPage();
  await loginViaUi(lp, 'lin', 'lin123');
  const fakePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const denied = await lin.request.fetch(BASE + '/api/sites/s-002', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ image: fakePng, version: 1 }),
  });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ denied: ['image'] });

  // 管理员补录影像到原本无影像的 S-002
  const admin = await browser.newContext({ acceptDownloads: true });
  const ap = await admin.newPage();
  await loginViaUi(ap, 'admin', 'admin123');
  await ap.click('#siteList .item:has-text("S-002")');
  // 影像默认隐藏, 需先显式揭示/打开补录入口
  await ap.click('#imageLocked button');
  await ap.setInputFiles('#imageFile', {
    name: 'tiny.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  });
  await ap.click('#saveBtn');
  await expect(ap.locator('#toast.ok')).toContainText('v2');
  // lin 的列表与导出仍不含该影像
  const linExp = await lin.request.fetch(BASE + '/api/export', { method: 'POST', data: JSON.stringify({ code: 'S-002' }), headers: { 'Content-Type': 'application/json' } });
  const linJson = await linExp.json();
  expect(linJson.sites[0].image).toBeNull();
  // 管理员导出含 data:image
  const [dl] = await Promise.all([ap.waitForEvent('download'), ap.click('#exportBtn')]);
  const raw = require('fs').readFileSync(await dl.path(), 'utf8');
  expect(raw).toContain('data:image/png;base64');
  await lin.close(); await admin.close();
});

/* ---------------- 3. 筛选/统计不能借受限字段探测 ---------------- */

test('按受限字段筛选或统计一律拒绝, 且写拒绝审计', async ({ browser }) => {
  const { context } = await newLoggedInContext(browser, 'lin', 'lin123');
  for (const url of ['/api/sites/list', '/api/stats', '/api/export']) {
    const r = await api(context, 'POST', url, { note: '靠近船肋' });
    expect(r.status(), url).toBe(400);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining('不允许按受限') });
  }
  // 正常公共字段筛选可用
  const ok = await api(context, 'POST', '/api/sites/list', { type: 'wreck' });
  const j = await ok.json();
  expect(j.sites.map(s => s.code)).toEqual(['S-001']);
  await context.close();
});

/* ---------------- 4. 授权过期: 旧会话即时降权(真实双浏览器) -------- */

test('授权过期后, 已登录会话立即失去字段且明文被收起', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const ap = await adminCtx.newPage();
  await loginViaUi(ap, 'admin', 'admin123');
  await ap.click('button[data-tab=grants]');
  await ap.waitForSelector('#grantsTable tbody tr');

  const wangCtx = await browser.newContext();
  const wp = await wangCtx.newPage();
  await loginViaUi(wp, 'wang', 'wang123');
  await wp.click('#siteList .item:has-text("S-001")');
  // 初始无备注权限
  await expect(wp.locator('#noteLocked')).toContainText('未获授权');

  // 管理员授予 wang 对 S-001 的备注, 约 4 秒过期(走真实授权表单)
  await ap.selectOption('#grantUser', 'u-wang');
  await ap.selectOption('#grantSite', 's-001');
  await ap.check('#fld-note');
  await ap.click('#grantQuickExpire'); // 有效期约 5 秒后, 便于真实浏览器验证过期降权
  await expect(ap.locator('#grantsTable tbody')).toContainText('生效中');

  // wang 刷新后拿到备注权限并能揭示
  await wp.click('#searchBtn'); // 重新拉取
  await wp.click('#siteList .item:has-text("S-001")');
  await wp.click('#noteLocked button');
  await expect(wp.locator('#noteOpen textarea')).toBeVisible({ timeout: 5000 });
  await expect(wp.locator('#noteOpen textarea')).toHaveValue(/靠近船肋/);

  // 等待过期; 轮询/重新拉取后立即降权, 明文被收起
  await wp.waitForTimeout(5200);
  await wp.click('#searchBtn');
  await expect(wp.locator('#noteOpen')).toBeHidden({ timeout: 10000 });
  await expect(wp.locator('#noteLocked')).toContainText('未获授权');
  expect(await wp.locator('body').innerText()).not.toContain('靠近船肋');

  // 再点申请显示也被服务端拒绝
  await wp.click('#noteLocked button');
  await expect(wp.locator('#toast.error')).toContainText('越权被拒绝');

  // 授权表显示"已过期"
  await ap.click('button[data-tab=grants]');
  await expect(ap.locator('#grantsTable tbody')).toContainText('已过期');

  await adminCtx.close();
  await wangCtx.close();
});

/* ---------------- 5. 撤销授权 / 停用人员即时生效 ---------------- */

test('撤销授权即时降权; 停用人员立即踢掉旧会话', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const ap = await adminCtx.newPage();
  await loginViaUi(ap, 'admin', 'admin123');

  const linCtx = await browser.newContext();
  const lp = await linCtx.newPage();
  await loginViaUi(lp, 'lin', 'lin123');
  // lin 初始对 S-001 有备注权限
  await lp.click('#siteList .item:has-text("S-001")');
  await lp.click('#noteLocked button');
  await expect(lp.locator('#noteOpen textarea')).toHaveValue(/靠近船肋/);

  // 管理员在 UI 撤销 g-1
  await ap.click('button[data-tab=grants]');
  const row = ap.locator('#grantsTable tbody tr', { hasText: 'lin' }).filter({ hasText: 'S-001' });
  await row.locator('button[data-revoke]').click();
  await expect(row).toContainText('已撤销');

  // lin 重新拉取后立即降权, 明文消失
  await lp.click('#searchBtn');
  await expect(lp.locator('#noteOpen')).toBeHidden({ timeout: 5000 });
  expect(await lp.locator('body').innerText()).not.toContain('靠近船肋');
  const reveal = await api(linCtx, 'POST', '/api/sites/s-001/reveal', { field: 'note' });
  expect(reveal.status()).toBe(403);

  // 停用 wang: 其旧会话立即失效
  const wangCtx = await browser.newContext();
  const wp = await wangCtx.newPage();
  await loginViaUi(wp, 'wang', 'wang123');
  await ap.click('button[data-tab=users]');
  const wangRow = ap.locator('#usersTable tbody tr', { hasText: 'wang' });
  await wangRow.locator('button[data-active="0"]').click();
  await expect(wangRow).toContainText('停用');
  const probe = await api(wangCtx, 'POST', '/api/sites/list', {});
  expect(probe.status()).toBe(401);
  // 已停用账号也不允许登录
  await wp.goto('/');
  await wp.fill('input[name=username]', 'wang');
  await wp.fill('input[name=password]', 'wang123');
  await wp.click('#loginForm button');
  await expect(wp.locator('#loginError')).toContainText(/停用|错误/);

  await adminCtx.close(); await linCtx.close(); await wangCtx.close();
});

/* ---------------- 6. 并发乐观锁: 只允许基于最新版本提交 ---------------- */

test('两人同时改同一条: 旧版本提交被 409, 冲突可见且不覆盖数据', async ({ browser }) => {
  const wangCtx = await browser.newContext();
  const wp = await wangCtx.newPage();
  await loginViaUi(wp, 'wang', 'wang123');
  await wp.click('#siteList .item:has-text("S-002")');
  await expect(wp.locator('#versionInfo')).toContainText('v1');
  await wp.fill('input[name=depth]', '29.9m'); // 暂不保存

  // 另一人(管理员)先把记录改到 v2
  const adminCtx = await browser.newContext();
  const ap = await adminCtx.newPage();
  await loginViaUi(ap, 'admin', 'admin123');
  const r = await api(adminCtx, 'PATCH', '/api/sites/s-002', { depth: '11.1m', version: 1 });
  expect(r.status()).toBe(200);

  // wang 基于 v1 的提交被拒, 冲突面板显示双方值
  await wp.click('#saveBtn');
  await expect(wp.locator('#toast.error')).toContainText('版本冲突');
  const box = wp.locator('#conflictBox');
  await expect(box).toBeVisible();
  await expect(box).toContainText('v2');
  await expect(box).toContainText('29.9m');
  await expect(box).toContainText('11.1m');
  // 服务器数据没有被 wang 的旧提交覆盖
  const list = await api(wangCtx, 'POST', '/api/sites/list', {});
  const j = await list.json();
  const s2 = j.sites.find(s => s.code === 'S-002');
  expect(s2.version).toBe(2);
  expect(s2.depth).toBe('11.1m');

  // 载入最新版后再提交 → 成功升版
  await wp.click('#conflictMerge');
  await wp.click('#saveBtn');
  await expect(wp.locator('#toast.ok')).toContainText('v3');
  const list2 = await api(wangCtx, 'POST', '/api/sites/list', {});
  const j2 = await list2.json();
  const s2b = j2.sites.find(s => s.code === 'S-002');
  expect(s2b.version).toBe(3);
  expect(s2b.depth).toBe('29.9m');

  // 审计中有冲突记录
  await ap.click('button[data-tab=audit]');
  await ap.selectOption('#auditResult', 'conflict');
  await ap.click('#auditBtn');
  await expect(ap.locator('#auditTable tbody')).toContainText('提交版本=1');

  await wangCtx.close(); await adminCtx.close();
});

/* ---------------- 7. 导出隔离: 各下各的, 密文不落地 ---------------- */

test('导出文件按人脱敏; 受限明文不出现在无权导出中', async ({ browser }) => {
  // 成员 wang: 只对 S-002 有坐标授权
  const wangCtx = await browser.newContext({ acceptDownloads: true });
  const wp = await wangCtx.newPage();
  await loginViaUi(wp, 'wang', 'wang123');
  const [dl] = await Promise.all([
    wp.waitForEvent('download'),
    wp.click('#exportBtn'),
  ]);
  const path = await dl.path();
  const raw = require('fs').readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  expect(data.by).toBe('wang');
  const byCode = Object.fromEntries(data.sites.map(s => [s.code, s]));
  // S-002 真实坐标随附
  expect(byCode['S-002'].coords).toMatchObject({ x: 58, y: 39 });
  // S-001 坐标是伪装占位, 影像/备注为 null
  expect(byCode['S-001'].coords).toMatchObject({ obscured: true });
  expect(byCode['S-001'].image).toBeNull();
  expect(byCode['S-001'].note).toBeNull();
  // 任何无权备注明文、影像数据都不得出现在文件字节中
  expect(raw).not.toContain('靠近船肋');
  expect(raw).not.toContain('采样需审批');
  expect(raw).not.toContain('data:image');

  // 管理员导出含全部明文
  const adminCtx = await browser.newContext({ acceptDownloads: true });
  const ap = await adminCtx.newPage();
  await loginViaUi(ap, 'admin', 'admin123');
  const [dl2] = await Promise.all([
    ap.waitForEvent('download'),
    ap.click('#exportBtn'),
  ]);
  const raw2 = require('fs').readFileSync(await dl2.path(), 'utf8');
  expect(raw2).toContain('靠近船肋');
  expect(raw2).toContain('采样需审批');
  expect(raw2).toContain('data:image');

  // 带筛选的导出同样不能借筛选条件探测
  const denied = await api(wangCtx, 'POST', '/api/export', { note: '靠近船肋' });
  expect(denied.status()).toBe(400);

  await wangCtx.close(); await adminCtx.close();
});

/* ---------------- 8. 审计: 查看/隐藏/授权/导出都可查错 ---------------- */

test('审计记录操作者、时间、动作、对象、结果', async ({ browser }) => {
  const { context, page } = await newLoggedInContext(browser, 'lin', 'lin123');
  // 产生: 成功查看 + 越权查看 + 隐藏
  await page.click('#siteList .item:has-text("S-001")');
  await page.click('#noteLocked button');
  await page.click('[data-hide="note"]');
  await api(context, 'POST', '/api/sites/s-002/reveal', { field: 'image' });
  await page.click('#logoutBtn');

  await loginViaUi(page, 'admin', 'admin123');
  await page.click('button[data-tab=audit]');
  // 导出动作记录
  await page.click('button[data-tab=sites]');
  await page.click('#exportBtn').catch(() => {});
  await page.waitForTimeout(800);
  await page.click('button[data-tab=audit]');
  await page.click('#auditBtn');
  const body = await page.locator('#auditTable tbody').innerText();
  for (const kw of ['lin', '查看揭示', '揭示字段', '拒绝', '隐藏', 'admin', '导出']) {
    expect(body).toContain(kw);
  }
  // 时间列存在且格式像本地时间
  await expect(page.locator('#auditTable tbody tr td').first()).not.toBeEmpty();
  await context.close();
});

/* ---------------- 9. 手机端: 授权/查看/导出/撤销/查错全流程 ----------- */

test('手机视口下可完成授权、查看、导出、撤销、查错', async ({ browser }) => {
  const phone = await browser.newContext({
    viewport: { width: 375, height: 780 }, isMobile: true, hasTouch: true, acceptDownloads: true,
  });
  const p = await phone.newPage();
  await loginViaUi(p, 'admin', 'admin123');
  // 窄屏: 地图与侧栏堆叠为单列
  const mapBox = await p.locator('.map').boundingBox();
  expect(mapBox.width).toBeLessThan(375);

  // 授权
  await p.click('button[data-tab=grants]');
  await p.selectOption('#grantUser', 'u-wang');
  await p.selectOption('#grantSite', 's-003');
  await p.check('#fld-coords');
  await p.click('#grantBtn');
  await expect(p.locator('#grantsTable tbody', )).toContainText('S-003');
  // 撤销
  const row = p.locator('#grantsTable tbody tr', { hasText: 'wang' }).filter({ hasText: 'S-003' });
  await row.locator('button[data-revoke]').click();
  await expect(row).toContainText('已撤销');

  // 查看
  await p.click('button[data-tab=sites]');
  await p.click('#siteList .item:has-text("S-001")');
  await p.click('#noteLocked button');
  await expect(p.locator('#noteOpen textarea')).toBeVisible();

  // 导出
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
  expect(dl.suggestedFilename()).toMatch(/^sites-admin-.*\.json$/);

  // 查错
  await p.click('button[data-tab=audit]');
  await p.selectOption('#auditResult', 'success');
  await p.click('#auditBtn');
  await expect(p.locator('#auditTable tbody')).toContainText('授权');

  await phone.close();
});

/* ---------------- 10. 旧标记入口保持可用 ---------------- */

test('旧标记页 /legacy.html 保持原有全部功能并可返回', async ({ page }) => {
  await page.goto('/legacy.html');
  await expect(page.locator('h1')).toHaveText('水下考古潜水记录');
  // 种子标记渲染
  await expect(page.locator('.marker')).toHaveCount(2);
  // 点地图新增
  await page.click('#map', { position: { x: 200, y: 200 } });
  await page.fill('input[name=code]', 'M-TEST');
  await page.fill('input[name=dive]', 'DIVE-09');
  await page.fill('input[name=depth]', '9.9m');
  await page.click('#form button:not(#deleteBtn)');
  await expect(page.locator('.marker')).toHaveCount(3);
  // 刷新后仍在(localStorage)
  await page.reload();
  await expect(page.locator('.marker')).toHaveCount(3);
  // 时间线视图
  await page.selectOption('#view', 'timeline');
  await expect(page.locator('#list')).toContainText('DIVE-09');
  // 导出旧 JSON
  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportBtn'),
  ]);
  const raw = require('fs').readFileSync(await dl.path(), 'utf8');
  expect(raw).toContain('M-TEST');
  // 返回新台
  await page.click('header a');
  await expect(page).toHaveURL(/\/(index\.html)?$/);
});
