'use strict';
const { t: $t } = require('./i18n/i18n');
// 悬浮大屏：一个置顶的无边框窗口 + 一个本机 HTTP 服务（给 OBS / 直播伴侣当「浏览器源」）。
// 两边显示同一个页面 renderer/screen.html，数据由 broadcast(state) 推送。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, screen: electronScreen } = require('electron');

const PAGE_DIR = path.join(__dirname, 'renderer');
const STATIC = { '/screen.html': 'text/html', '/screen.js': 'text/javascript', '/screen.css': 'text/css' };

class BigScreen {
  /**
   * @param {object} h
   * @param {() => object} h.getSettings  返回 settings.screen
   * @param {(patch) => void} h.saveSettings 保存 settings.screen 的改动
   * @param {(text, level) => void} h.log
   * @param {() => object} h.getState     当前完整状态（新连接时先推一次）
   */
  constructor(h) {
    this.h = h;
    this.win = null;
    this.server = null;
    this.port = 0;
    this.clients = new Set();
    this.lastJson = '';
    this.boundsTimer = null;
  }

  get isOpen() {
    return !!(this.win && !this.win.isDestroyed());
  }

  // ---------------- 悬浮窗 ----------------
  open() {
    if (this.isOpen) {
      this.win.show();
      this.win.focus();
      return;
    }
    const cfg = this.h.getSettings();
    const b = this.fitBounds(cfg.bounds || { width: 420, height: 640 });
    const win = new BrowserWindow({
      ...b,
      minWidth: 280,
      minHeight: 320,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: cfg.style !== 'transparent',
      alwaysOnTop: !!cfg.alwaysOnTop,
      skipTaskbar: false,
      title: $t('悬浮大屏'),
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver'); // 盖在全屏的直播软件上面
    win.setOpacity(Math.min(1, Math.max(0.3, Number(cfg.opacity) || 1)));
    win.loadFile(path.join(PAGE_DIR, 'screen.html'));
    win.webContents.on('render-process-gone', (_e, d) => {
      if (d.reason !== 'clean-exit' && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 500);
    });
    win.webContents.on('did-finish-load', () => this.sendTo(win, this.h.getState()));
    const saveBounds = () => {
      clearTimeout(this.boundsTimer);
      this.boundsTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.h.saveSettings({ bounds: win.getBounds() });
      }, 500);
    };
    win.on('move', saveBounds);
    win.on('resize', saveBounds);
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.h.onWindowChange?.(false);
    });
    this.win = win;
    this.h.onWindowChange?.(true);
  }

  close() {
    if (this.isOpen) this.win.close();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
    return this.isOpen;
  }

  /** 设置变化时同步到窗口（置顶、透明度） */
  applyWindowSettings() {
    if (!this.isOpen) return;
    const cfg = this.h.getSettings();
    this.win.setAlwaysOnTop(!!cfg.alwaysOnTop, 'screen-saver');
    this.win.setOpacity(Math.min(1, Math.max(0.3, Number(cfg.opacity) || 1)));
    this.win.setHasShadow(cfg.style !== 'transparent');
  }

  /** 保证窗口在某个显示器里（换了显示器后不会跑到屏幕外） */
  fitBounds(b) {
    const area = electronScreen.getDisplayMatching({ x: b.x ?? 0, y: b.y ?? 0, width: b.width, height: b.height }).workArea;
    const width = Math.min(b.width || 420, area.width);
    const height = Math.min(b.height || 640, area.height);
    let x = b.x ?? area.x + area.width - width - 24;
    let y = b.y ?? area.y + 80;
    x = Math.min(Math.max(x, area.x), area.x + area.width - width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - height);
    return { x, y, width, height };
  }

  // ---------------- OBS 浏览器源 ----------------
  async startObs(port) {
    this.stopObs();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleHttp(req, res));
      server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error($t('端口 {0} 已被占用', port)) : e));
      // 只监听本机：OBS 和本软件在同一台电脑上
      server.listen(Number(port), '127.0.0.1', () => {
        this.server = server;
        this.port = Number(port);
        resolve(`http://127.0.0.1:${this.port}/`);
      });
    });
  }

  stopObs() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (this.server) this.server.close();
    this.server = null;
  }

  get obsUrl() {
    return this.server ? `http://127.0.0.1:${this.port}/` : '';
  }

  handleHttp(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      this.clients.add(res);
      res.write(`data: ${JSON.stringify(this.h.getState())}\n\n`);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (url.pathname === '/i18n/i18n.js') {
      // OBS 浏览器源没有 preload：把当前语言的词典放在脚本前面
      const boot = `window.__LN_I18N = ${JSON.stringify(this.h.getI18n ? this.h.getI18n() : null)};\n`;
      return fs.readFile(path.join(__dirname, 'i18n', 'i18n.js'), (err, buf) => {
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(err ? '' : boot + buf.toString('utf8'));
      });
    }
    const file = url.pathname === '/' ? '/screen.html' : url.pathname;
    if (!STATIC[file]) {
      res.writeHead(404);
      return res.end('not found');
    }
    fs.readFile(path.join(PAGE_DIR, file), (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': STATIC[file] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  // ---------------- 推送 ----------------
  sendTo(win, state) {
    if (win && !win.isDestroyed()) win.webContents.send('screen', state);
  }

  broadcast(state) {
    const json = JSON.stringify(state);
    if (json === this.lastJson) return; // 没变化不推
    this.lastJson = json;
    if (this.isOpen) this.sendTo(this.win, state);
    for (const c of this.clients) c.write(`data: ${json}\n\n`);
  }
}

module.exports = { BigScreen };
