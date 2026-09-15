# 敏感遗址分级共享台（离线）

在原“水下考古潜水记录”标记页基础上扩展的**离线**分级共享系统，零第三方运行时依赖（仅 Node.js 标准库）。
旧标记页原样保留在 `/legacy.html`，入口在新台页头。

## 启动

```bash
node server.js          # 默认 http://localhost:8731
PORT=9000 node server.js
```

首次启动自动在 `data/db.json` 生成演示数据；删掉该文件即恢复出厂种子。

演示账号（请在实际部署时改密码或重建账号）：

| 账号 | 密码 | 角色 |
|---|---|---|
| admin | admin123 | 管理员 |
| lin | lin123 | 成员（S-001 三级字段全授权） |
| wang | wang123 | 成员（仅 S-002 坐标） |
| shen | shen123 | 已停用成员 |

## 安全模型

受限字段固定为三类：**坐标（coords）、影像（image）、备注（note）**。其余为公共字段。

- **授权粒度**：管理员按 `人员 × 遗址 × 字段（或一/二/三级预设）× 有效期` 授权；可随时撤销。
- **即时降权**：授权撤销、有效期到期、账号停用都在**每次请求时实时判定**。停用会清空该用户的会话；前端每 5 秒轮询，旧页面上已显示的明文会立即收起并从 DOM 清除。
- **查看隔离**：
  - 列表/详情只下发公共字段；坐标有权才给真值，无权则给一个确定性的**伪装占位坐标**（虚线斜纹标记，真实坐标不出服务端）；
  - 影像、备注明文只能通过“显示”按钮（`/reveal`）或导出获取，两次通道都写审计；
- **筛选/统计/导出不泄露**：筛选条件白名单只含公共字段，提交 `note`/`coords` 等条件直接 400；统计只聚合公共字段；导出逐行逐字段按授权附带，无权字段输出 `null` 或占位坐标，且整个导出文件字节中不出现无权明文（有测试扫描）。
- **写入拒绝 + 失败回滚**：PATCH 逐字段校验写权限，越权字段整单 403、数据不变；非法输入 400、原值保留。
- **乐观锁并发**：每条记录有 `version`，提交必须携带打开时的版本；过期版本返回 409 和服务器最新值，前端显示双方差异，绝不覆盖。冲突也写审计。
- **审计**：登录/退出、列表查看、受限字段揭示、隐藏、授权/撤销、人员停用、写入（含冲突）、导出、删除全部记录**操作者、时间、对象、结果、说明**，管理员可在“操作审计/查错”按结果/动作/关键字筛查。
- 密码用 scrypt + 每用户随机盐存储；会话为 HttpOnly、SameSite=Lax Cookie；受限明文只存在前端内存，不写 localStorage。

## 界面

桌面与手机（375px 实测）均可完成：登录、按类型/潜次/编号筛选、揭示/隐藏受限字段、编辑与冲突处理、导出、授权、撤销、人员停用、审计查错。窄屏自动切换为单列布局。

## 自动化测试（真实浏览器）

Playwright + Chromium，共 13 个用例，覆盖：越权查看/写入/管理接口、受限字段筛选拒绝、授权过期与撤销的**旧会话即时降权**、停用踢下线、双人并发 409 冲突且不覆盖、导出文件按人脱敏与明文字节扫描、非法写入失败回滚、手机视口全流程、旧标记入口回归。

```bash
npm install
npx playwright install chromium
npm test
```

### 无 root 的精简 Linux 上安装浏览器依赖

测试用机会若缺 `libnspr4/libnss3/...` 且没有 sudo，可用用户态 deb 解压（Playwright 配置会自动把
`~/chromelibs` 加入浏览器进程的 `LD_LIBRARY_PATH`）：

```bash
apt-get update -o Dir::State::Lists=/tmp/aptlists -o Dir::Cache=/tmp/aptcache
mkdir -p ~/chromelibs/deb && cd ~/chromelibs/deb
apt-get download -o Dir::State::Lists=/tmp/aptlists \
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libatspi2.0-0 libpango-1.0-0 libcairo2 libxi6 libdbus-1-3 \
  libwayland-server0 libavahi-client3 libavahi-common3
for f in *.deb; do dpkg-deb -x "$f" ../root/; done
```

测试服务通过 `TEST_RESET_KEY` 暴露仅测试用的重置接口（`POST /api/test/reset`），未配置该环境变量时接口不存在。

## 文件

- `server.js`：HTTP 服务、授权判定、脱敏、乐观锁、审计、JSON 原子持久化
- `index.html` / `app.js` / `styles.css`：分级共享台前端
- `legacy.html`：旧标记页（localStorage 单机版，功能与原页一致）
- `tests/e2e.spec.js`：Playwright 真实浏览器测试
