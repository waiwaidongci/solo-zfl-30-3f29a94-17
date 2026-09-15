'use strict';
const { defineConfig } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 某些离线/精简环境缺少 Chromium 的系统库; 若家目录存在用户态解压的依赖
// (见 README"无 root 安装浏览器依赖"), 自动通过 LD_LIBRARY_PATH 注入给浏览器进程。
const localLibDirs = [
  path.join(os.homedir(), 'chromelibs/root/lib/aarch64-linux-gnu'),
  path.join(os.homedir(), 'chromelibs/root/usr/lib/aarch64-linux-gnu'),
  path.join(os.homedir(), 'chromelibs/root/lib/x86_64-linux-gnu'),
  path.join(os.homedir(), 'chromelibs/root/usr/lib/x86_64-linux-gnu'),
].filter(p => fs.existsSync(p));
const extraLd = localLibDirs.join(':');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8731',
    acceptDownloads: true,
    ...(extraLd ? {
      launchOptions: {
        env: { ...process.env, LD_LIBRARY_PATH: `${extraLd}:${process.env.LD_LIBRARY_PATH || ''}` },
      },
    } : {}),
  },
  webServer: {
    command: 'TEST_RESET_KEY=e2e-reset-key SHARE_DATA_DIR=.e2e-data PORT=8731 node server.js',
    url: 'http://localhost:8731/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
});
