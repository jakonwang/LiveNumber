'use strict';
const { t: $t } = require('./i18n/i18n');
// 浏览器模式：用 Electron 内置浏览器打开直播间页面（可登录 TikTok，登录状态会保存），
// 通过 DevTools 协议截获页面自己的 WebSocket 数据，用 tiktok-live-connector 的解码器解出弹幕。
// 不需要第三方签名服务。
const { BrowserWindow } = require('electron');
const { chatFromWebcast } = require('./rules');

const PARTITION = 'persist:tiktok';
const STREAM_END_ACTIONS = new Set([3, 4]); // CONTROL_ACTION_STREAM_ENDED / SUSPENDED

class BrowserLive {
  /**
   * @param {object} h
   * @param {() => Promise<any>} h.loadLib   加载 tiktok-live-connector
   * @param {(chat) => void} h.onChat
   * @param {(text, level) => void} h.log
   * @param {(status, extra?) => void} h.onStatus
   */
  constructor(h) {
    this.h = h;
    this.win = null;
    this.user = '';
    this.frames = 0;
    this.lastFrameAt = 0;
    this.watchdog = null;
  }

  get isOpen() {
    return !!(this.win && !this.win.isDestroyed());
  }

  async open(user) {
    this.close();
    const lib = await this.h.loadLib();
    this.user = user;
    this.frames = 0;
    const win = new BrowserWindow({
      width: 520,
      height: 860,
      title: $t('直播间 @{0}（浏览器模式，可在这里登录 TikTok）', user),
      autoHideMenuBar: true,
      icon: require('node:path').join(__dirname, 'assets', 'icon.ico'),
      webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    this.win = win;
    // 去掉 UA 里的 Electron 标识，让页面当成普通 Chrome
    const ua = win.webContents.getUserAgent().replace(/\s(livenumber|Electron)\/\S+/gi, '');
    win.webContents.setUserAgent(ua);
    win.webContents.setWindowOpenHandler(({ url }) => {
      win.loadURL(url); // 登录等弹窗在同一窗口打开
      return { action: 'deny' };
    });

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');
    dbg.on('message', (_e, method, params) => {
      if (method === 'Network.webSocketCreated' && /webcast/i.test(params.url)) {
        this.h.log($t('浏览器模式：已连上直播间弹幕通道'), 'success');
        this.h.onStatus('connected');
      }
      if (method === 'Network.webSocketFrameReceived' && params.response?.opcode === 2) {
        this.handleFrame(lib, params.response.payloadData).catch(() => {
          /* 不是弹幕通道的二进制数据，忽略 */
        });
      }
    });
    dbg.on('detach', (_e, reason) => {
      if (this.win === win) this.h.log($t('浏览器模式：调试通道断开 ') + reason, 'warn');
    });

    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      clearInterval(this.watchdog);
      this.h.log($t('浏览器模式：直播间窗口已关闭'), 'warn');
      this.h.onStatus('idle');
    });

    this.h.onStatus('connecting');
    this.h.log($t('浏览器模式：打开 https://www.tiktok.com/@{0}/live ，如提示登录请在弹出的窗口里登录', user));
    await win.loadURL(`https://www.tiktok.com/@${encodeURIComponent(user)}/live`).catch((e) => {
      this.h.log($t('浏览器模式：页面加载失败 ') + e.message, 'error');
    });

    // 页面 60 秒没有任何弹幕数据就提醒一下（可能没开播、需要登录或被验证码拦住）
    this.lastFrameAt = Date.now();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.isOpen && Date.now() - this.lastFrameAt > 60_000) {
        this.h.log($t('浏览器模式：60 秒没有收到直播数据，请看一下直播间窗口（是否开播 / 需要登录 / 有验证码）'), 'warn');
        this.lastFrameAt = Date.now();
      }
    }, 10_000);
  }

  async handleFrame(lib, base64) {
    const frame = await lib.deserializeWebSocketMessage(Buffer.from(base64, 'base64'));
    const messages = frame?.protoMessageFetchResult?.messages || [];
    if (!messages.length) return;
    this.frames += 1;
    this.lastFrameAt = Date.now();
    for (const m of messages) {
      const d = m.decodedData;
      if (!d) continue;
      if (d.type === 'WebcastChatMessage') {
        this.h.onChat(chatFromWebcast(d.data));
      } else if (d.type === 'WebcastControlMessage' && STREAM_END_ACTIONS.has(Number(d.data.action))) {
        this.h.log($t('【{0}】直播已结束', this.user), 'warn');
        this.h.onStatus('ended');
      }
    }
  }

  close() {
    clearInterval(this.watchdog);
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.close();
  }

  show() {
    if (this.isOpen) {
      this.win.show();
      this.win.focus();
    }
  }
}

module.exports = { BrowserLive };
