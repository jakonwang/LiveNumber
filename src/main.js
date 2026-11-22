'use strict';
const i18n = require('./i18n/i18n');
const { t: $t } = i18n;
const { COUNTRIES, byCode: countryOf } = require('./i18n/countries');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { Store } = require('./store');
const { matchComment, GrabEngine, parseBid, AuctionEngine, chatFromWebcast, matchCancel, retryDelaySeconds, duplicateReason } = require('./rules');
const { FileLogger } = require('./logger');
const { readTable, pick } = require('./table');
const { LabelPrinter } = require('./printer');
const { ShareServer, requestCode, ping, lanAddresses } = require('./share');
const { BrowserLive } = require('./browser-live');
const { BigScreen } = require('./screen');
const { ShopClient } = require('./shop');
const { planNotes, combineNote, NOTE_FIELDS } = require('./shopnote');
/** 当前国家的数字格式（金额分组），如 vi-VN：120.000 */
const numLocale = () => countryOf(store && store.settings.country).numLocale;
const fmtMoney = (v) => Number(v || 0).toLocaleString(numLocale());

let win = null;
let store = null;
const grab = new GrabEngine();
const auction = new AuctionEngine();
const printer = new LabelPrinter();
const stats = { total: 0, failed: 0 };

// ---------------- 工具 ----------------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let fileLog = null;
function log(text, level = 'info') {
  send('log', { time: Date.now(), text, level });
  fileLog?.write(level, text);
}

function sendStats() {
  send('stats', { ...stats, queue: printer.pending, counters: store.data.counters });
}

function sendPanel() {
  const slots = grab.active(3);
  const auc = auction.status();
  send('grab', { slots, auction: auc });
  bigScreen.broadcast(screenState(slots, auc));
}

// ---------------- TikTok Shop 订单备注 ----------------
const shop = new ShopClient({
  getHost: () => store.settings.shop.host,
  onLog: (t, l) => log(t, l),
  onStatus: (st) => {
    if (st.loggedIn && !store.settings.shop.everLoggedIn) {
      store.setSettings({ shop: { everLoggedIn: true } });
      send('settingsPatch', { shop: { everLoggedIn: true } });
    }
    send('shop', { type: 'status', ...st, busy: shopJob.busy });
  },
});
const shopJob = { busy: false, stop: false, lastAuto: 0, orders: new Map() };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function shopPlan(orders) {
  const s = store.settings.shop;
  if (!orders.length) return [];
  const minT = Math.min(...orders.map((o) => o.createTime)) - (Number(s.backMin) || 0) * 60000;
  const recs = store.data.history.filter((h) => h.time >= minT);
  return planNotes(orders, recs, {
    template: s.template,
    backMin: s.backMin,
    fwdMin: s.fwdMin,
    serial: s.serial,
    allowRepeat: s.allowRepeat,
    merge: s.merge,
    used: store.usedRecords(),
    customers: store.listCustomers(),
    formatCode: (c) => store.formatCode(c),
  });
}

/** 订单 + 匹配结果，给界面显示 */
function shopRows(orders) {
  const plans = new Map(shopPlan(orders).map((p) => [p.orderId, p]));
  return orders.map((o) => {
    const p = plans.get(o.id) || {};
    const noted = store.data.shopNoted[o.id];
    return { ...o, match: p.status, user: p.user, nickname: p.nickname, code: p.code, note: p.note, candidates: p.candidates, merged: p.merged || 0, noted: noted ? noted.text : '' };
  });
}

async function shopFetch(sinceMs = 0, status = 'to_ship') {
  const s = store.settings.shop;
  const orders = await shop.listToShip({ pageDelay: s.pageDelay, sinceMs, status });
  if (!sinceMs) shopJob.orders = new Map();
  for (const o of orders) shopJob.orders.set(o.id, o);
  return orders;
}

const skipText = (k) => ({ nomatch: $t('客户编号里没找到对得上的客户'), ambiguous: $t('多个用户对得上，无法确定'), used: $t('对应的扣号记录已经备注到别的订单') }[k]);

/** 批量备注。ids 为空 = 当前列表全部；auto = 自动备注（只写没写过的） */
async function runShopNotes(ids, { auto = false } = {}) {
  if (shopJob.busy) throw new Error($t('正在备注中，请稍等'));
  shopJob.busy = true;
  shopJob.stop = false;
  send('shop', { type: 'busy', busy: true });
  const s = store.settings.shop;
  const res = { total: 0, ok: 0, fail: 0, skip: 0 };
  try {
    let orders;
    if (auto) orders = await shopFetch(Date.now() - (Number(s.autoHours) || 24) * 3600000);
    else orders = (ids && ids.length ? ids.map((id) => shopJob.orders.get(String(id))) : [...shopJob.orders.values()]).filter(Boolean);
    const plans = shopPlan(orders);
    for (const p of plans) {
      if (shopJob.stop) break;
      const prev = store.data.shopNoted[p.orderId];
      if (auto && (p.status !== 'ok' || (prev && prev.text === p.note))) continue;
      res.total++;
      if (p.status !== 'ok') {
        res.skip++;
        log($t('订单【{0}】未备注：{1}（买家 {2}）{3}', p.orderId, skipText(p.status) || p.status, p.order.buyer, p.candidates && p.candidates.length > 1 ? $t('：') + p.candidates.join($t('、')) : ''), 'warn');
        continue;
      }
      if (s.skipNoted && p.order.hasNote && !prev) {
        res.skip++;
        log($t('订单【{0}】已有备注，按设置跳过', p.orderId), 'warn');
        continue;
      }
      try {
        let text = p.note;
        if (s.mode === 'append' && (p.order.hasNote || prev)) {
          const old = await shop.getNote(p.orderId);
          // 追加模式：把本软件上次写的那段换成新的，别的内容保留
          const base = prev && prev.text && old.includes(prev.text) ? old.replace(prev.text, '').trim() : old;
          text = combineNote(base, p.note, 'append');
          if (text === old) {
            res.skip++;
            continue;
          }
        }
        await shop.setNote(p.orderId, text);
        store.markNoted(p.orderId, { text, recIds: p.recIds, user: p.user });
        p.order.hasNote = true;
        res.ok++;
        log($t('订单【{0}】备注成功，内容：【{1}】', p.orderId, text), 'success');
        send('shop', { type: 'noted', orderId: p.orderId, text });
      } catch (e) {
        res.fail++;
        log($t('订单【{0}】备注失败：{1}', p.orderId, e.message), 'error');
        await shop.check();
        if (!shop.loggedIn) {
          log($t('店铺登录已失效，停止备注'), 'error');
          break;
        }
      }
      await wait(Math.max(200, Number(s.pageDelay) || 800));
    }
    if (res.total || !auto)
      log(
        $t('{0}共批量备注【{1}】条记录，成功【{2}】条，失败【{3}】条，跳过【{4}】条【{5}】【订单合并模式：{6}】{7}', auto ? $t('自动备注：') : '', res.total, res.ok, res.fail, res.skip, s.mode === 'append' ? $t('追加到原有备注') : $t('完全覆盖原有备注'), s.merge ? 'YES' : 'NO', shopJob.stop ? $t('（已手动停止）') : ''),
        res.fail ? 'warn' : 'success'
      );
    return res;
  } finally {
    shopJob.busy = false;
    send('shop', { type: 'busy', busy: false });
  }
}

/** 自动备注：每 10 秒看一次是否到点 */
function shopAutoTick() {
  const s = store.settings.shop;
  if (!s.auto || shopJob.busy || !shop.loggedIn) return;
  if (Date.now() - shopJob.lastAuto < Math.max(20, Number(s.autoSeconds) || 60) * 1000) return;
  shopJob.lastAuto = Date.now();
  runShopNotes(null, { auto: true }).catch((e) => log($t('自动备注出错：') + e.message, 'error'));
}

// ---------------- 悬浮大屏 ----------------
const recentHits = []; // 最近命中（给大屏用）
let lastDeal = null; // 最近一次竞拍成交
let todayCount = 0;
let todayKey = '';

function maskName(name) {
  const chars = Array.from(String(name || ''));
  if (chars.length <= 1) return chars.join('') + '*';
  if (chars.length <= 3) return chars[0] + '**';
  return chars.slice(0, 2).join('') + '***';
}

function refreshToday() {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  todayKey = String(start);
  todayCount = store.stats(start, Date.now() + 60_000).orders;
}

function screenState(slots = grab.active(3), auc = auction.status()) {
  const s = store.settings;
  const sc = s.screen;
  const name = (n, u) => (sc.maskNames ? maskName(n || u) : n || u);
  const m = s.monitor;
  const rangeText = m.limitMode === 'range' ? `${m.min} – ${m.max}` : m.limitMode === 'specific' ? String(m.specific || '').slice(0, 24) : '';
  return {
    lang: i18n.getLang(),
    numLocale: numLocale(),
    mode: s.grab.mode,
    status: live.status,
    style: sc.style,
    scale: sc.scale,
    title: sc.title,
    hint: sc.hint,
    showHits: sc.showHits,
    showToday: sc.showToday,
    alwaysOnTop: sc.alwaysOnTop,
    today: todayCount,
    rangeText,
    grab: { slots, limit: s.grab.limit, seconds: s.grab.seconds },
    auction: { ...auc, leader: auc.leader ? (sc.maskNames ? maskName(auc.leader) : auc.leader) : '', total: s.auction.seconds },
    deal: lastDeal ? { ...lastDeal, name: name(lastDeal.nickname, lastDeal.uniqueId) } : null,
    hits: recentHits.slice(0, Math.max(1, Number(sc.hitsCount) || 5)).map((h) => ({
      id: h.id,
      codeText: h.codeText,
      name: name(h.nickname, h.uniqueId),
      isNew: h.isNew,
      what: h.auction ? $t('成交 ') + fmtMoney(h.amount) : h.productName ? `${h.content} · ${h.productName}` : h.content,
    })),
  };
}

const bigScreen = new BigScreen({
  getSettings: () => store.settings.screen,
  saveSettings: (patch) => store.setSettings({ screen: patch }),
  getState: () => screenState(),
  getI18n: () => i18nPayload(),
  log: (t, l) => log(t, l),
  onWindowChange: (open) => {
    send('screenWin', open);
    refreshTray();
  },
});

async function applyObs() {
  const sc = store.settings.screen;
  if (!sc.obsEnabled) {
    if (bigScreen.obsUrl) log($t('OBS 大屏地址已关闭'));
    bigScreen.stopObs();
    return { url: '' };
  }
  const url = await bigScreen.startObs(sc.obsPort);
  log($t('OBS 大屏地址：{0}（在 OBS / 直播伴侣里添加「浏览器源」，填这个地址）', url), 'success');
  return { url };
}

// ---------------- TikTok 连接 ----------------
let ttLib = null;
async function loadTikTok() {
  if (!ttLib) {
    const entry = require.resolve('tiktok-live-connector');
    ttLib = await import(pathToFileURL(entry).href);
  }
  return ttLib;
}

const live = {
  conn: null,
  mode: 'api', // api：第三方签名服务；browser：内置浏览器
  status: 'idle', // idle | connecting | connected | ended | error
  user: '',
  wantConnected: false,
  retryTimer: null,
  seenMsgIds: new Set(),
};

function setStatus(status, extra = {}) {
  live.status = status;
  send('status', { status, user: live.user, mode: live.mode, ...extra });
  refreshTray();
}

// ---------------- 系统托盘 ----------------
// 关闭窗口 = 隐藏到托盘，继续收弹幕、打印；只有托盘菜单「退出」或设置成直接退出才真正退出
let tray = null;
let quitting = false;
const statusLabel = (k) => ({ idle: $t('未连接'), connecting: $t('连接中'), connected: $t('直播中'), ended: $t('已下播'), error: $t('连接出错') }[k]);

function showMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setPrintEnabled(enabled) {
  store.setSettings({ print: { enabled } });
  send('settingsPatch', { print: { enabled } });
  log(enabled ? $t('打印已开启（托盘菜单）') : $t('打印已暂停（托盘菜单）'), enabled ? 'success' : 'warn');
  refreshTray();
}

async function quitApp() {
  if (live.status === 'connected' || live.status === 'connecting') {
    const { response } = await dialog.showMessageBox(win && !win.isDestroyed() && win.isVisible() ? win : undefined, {
      type: 'warning',
      title: $t('退出 LiveNumber'),
      message: $t('正在连接直播间，退出后不会再收弹幕和打印。'),
      detail: $t('只是想关掉窗口的话，点窗口右上角的关闭按钮即可，程序会在托盘里继续运行。'),
      buttons: [$t('退出'), $t('取消')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
  }
  quitting = true;
  app.quit();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const s = store?.settings;
  const st = statusLabel(live.status) || live.status;
  tray.setToolTip($t('LiveNumber 直播扣号打单\n{0}{1}{2}', live.user ? '@' + live.user + ' · ' : '', st, s && !s.print.enabled ? $t(' · 打印已暂停') : ''));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${live.user ? '@' + live.user + $t('：') : ''}${st}`, enabled: false },
      { type: 'separator' },
      { label: $t('显示主窗口'), click: showMain },
      { label: $t('悬浮大屏'), type: 'checkbox', checked: bigScreen.isOpen, click: () => bigScreen.toggle() },
      { label: $t('打印'), type: 'checkbox', checked: !!(s && s.print.enabled), click: (item) => setPrintEnabled(item.checked) },
      { type: 'separator' },
      { label: $t('退出'), click: quitApp },
    ])
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')) : icon);
  fileLog?.write('info', `托盘已创建（图标${icon.isEmpty() ? '读取失败，用 png 代替' : '正常'}）`);
  tray.on('click', showMain);
  tray.on('double-click', showMain);
  refreshTray();
}

const browserLive = new BrowserLive({
  loadLib: loadTikTok,
  onChat: (c) => handleChat(c),
  log,
  onStatus: (st) => {
    if (live.mode === 'browser') setStatus(st);
  },
});

function normalizeUser(input) {
  return String(input || '')
    .trim()
    .replace(/.*tiktok\.com\/@([^/?#]+).*/i, '$1')
    .replace(/^@/, '');
}

async function connectLive() {
  const s = store.settings;
  const user = normalizeUser(s.liveUser);
  if (!user) throw new Error($t('请先填写直播间用户名'));
  await disconnectLive(false);
  live.user = user;
  live.mode = s.browserMode ? 'browser' : 'api';

  if (live.mode === 'browser') {
    await browserLive.open(user);
    return;
  }

  live.wantConnected = true;
  setStatus('connecting');
  log($t('开始连接直播间 @{0} ...', user));

  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await loadTikTok();
  const conn = new TikTokLiveConnection(user, {
    processInitialData: false, // 不处理连接前的历史弹幕，避免重复打印
    signApiKey: s.signApiKey ? String(s.signApiKey).trim() : undefined,
  });
  live.conn = conn;

  conn.on(WebcastEvent.CHAT, (data) => {
    if (live.conn !== conn) return;
    handleChat(chatFromWebcast(data));
  });
  conn.on(WebcastEvent.STREAM_END, () => {
    if (live.conn !== conn) return;
    live.wantConnected = false;
    setStatus('ended');
    log($t('【{0}】直播已结束', user), 'warn');
  });
  conn.on(ControlEvent.DISCONNECTED, ({ code, reason } = {}) => {
    if (live.conn !== conn) return;
    log($t('连接断开{0}{1}', code ? ` (${code})` : '', reason ? $t('：') + reason : ''), 'warn');
    scheduleReconnect();
  });
  conn.on(ControlEvent.ERROR, ({ info, exception } = {}) => {
    if (live.conn !== conn) return;
    log($t('连接错误：{0} {1}', info || '', exception?.message || '').trim(), 'error');
  });

  try {
    const state = await conn.connect();
    if (live.conn !== conn) return;
    live.retryCount = 0; // 连上了，下次断线从 10 秒重新开始
    setStatus('connected', { roomId: state?.roomId });
    log($t('已连接直播间 @{0}（房间 {1}）', user, state?.roomId || '-'), 'success');
  } catch (err) {
    if (live.conn !== conn) return;
    const msg = describeConnectError(err);
    log($t('连接失败：{0}', msg), 'error');
    if (/未开播/.test(msg)) {
      live.wantConnected = false;
      setStatus('ended', { error: msg });
    } else {
      setStatus('error', { error: msg });
      scheduleReconnect();
    }
  }
}

function describeConnectError(err) {
  const name = err?.constructor?.name || err?.name || '';
  const msg = err?.message || String(err);
  if (/UserOffline/i.test(name) || /offline/i.test(msg)) return $t('主播当前未开播（offline）');
  if (/SignAPI|sign|rate ?limit|429/i.test(name + msg)) return $t('签名服务错误：{0}。可在高级设置里填写 Euler Stream API Key，或改用浏览器模式', msg);
  return msg;
}

function scheduleReconnect() {
  clearTimeout(live.retryTimer);
  if (!live.wantConnected || !store.settings.autoReconnect) {
    setStatus('idle');
    return;
  }
  const wait = retryDelaySeconds(live.retryCount || 0);
  live.retryCount = (live.retryCount || 0) + 1;
  setStatus('connecting', { retry: true });
  log($t('{0} 秒后第 {1} 次重连...', wait, live.retryCount));
  live.retryTimer = setTimeout(() => {
    if (live.wantConnected) connectLive().catch((e) => log($t('重连失败：') + e.message, 'error'));
  }, wait * 1000);
}

async function disconnectLive(notify = true) {
  clearTimeout(live.retryTimer);
  live.wantConnected = false;
  browserLive.close();
  const conn = live.conn;
  live.conn = null;
  if (conn) {
    try {
      await conn.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (notify) {
    setStatus('idle');
    log($t('已断开直播间'));
  }
}

// ---------------- 客户编号（本地 / 共享） ----------------
async function assignCode(uniqueId, nickname) {
  const s = store.settings;
  if (s.code.mode === 'shared') {
    const res = await requestCode(s.share.serverUrl, s.share.key, uniqueId, nickname);
    store.rememberCustomer(uniqueId, nickname, res.code);
    return { code: res.code, codeText: res.codeText, isNew: !!res.isNew };
  }
  const { code, isNew } = store.allocate(uniqueId, nickname);
  return { code, codeText: store.formatCode(code), isNew };
}

const shareServer = new ShareServer((uniqueId, nickname) => {
  const mode = store.settings.code.mode === 'fill' ? 'fill' : 'increment';
  const { code, isNew } = store.allocate(uniqueId, nickname, mode);
  setTimeout(sendStats, 0);
  return { code, codeText: store.formatCode(code), isNew };
}, log);

async function applyShareServer() {
  const sh = store.settings.share;
  if (!sh.hostEnabled) {
    if (shareServer.running) log($t('共享编号主机已关闭'));
    shareServer.stop();
    return { running: false };
  }
  if (!String(sh.key || '').trim()) {
    // 没设密码就自动生成一个，避免同一局域网（店铺 / 公共 Wi-Fi）里任何人都能改你的客户编号
    const key = Math.random().toString(36).slice(2, 8);
    store.setSettings({ share: { key } });
    send('settingsPatch', { share: { key } });
    log($t('共享编号主机已自动设置密码：{0}（其他电脑填同样的密码）', key), 'warn');
  }
  const urls = await shareServer.start(sh.port, store.settings.share.key);
  log($t('共享编号主机已开启，其他电脑填写：{0}', urls.join($t(' 或 '))), 'success');
  return { running: true, urls };
}

// ---------------- 弹幕处理主流程 ----------------
function handleChat({ uniqueId, nickname, comment, msgId, simulated = false }) {
  if (!uniqueId || !comment) return;
  if (msgId) {
    if (live.seenMsgIds.has(msgId)) return; // 重连后可能重复推送
    live.seenMsgIds.add(msgId);
    if (live.seenMsgIds.size > 5000) live.seenMsgIds = new Set([...live.seenMsgIds].slice(-2000));
  }

  const s = store.settings;
  const chat = { id: ++chatSeq, time: Date.now(), uniqueId, nickname, comment, simulated, result: '' };

  if (s.cancel.enabled) {
    const c = matchCancel(comment, s.cancel.keywords);
    if (c) {
      const target = store.findCancelTarget(uniqueId, c.number, s.cancel.minutes);
      if (target) {
        cancelOrder(target.id, 'buyer');
        chat.result = $t('已取消 编号 {0}（{1}）', target.codeText, target.content);
        chat.cancel = true;
      } else chat.result = c.number != null ? $t('没有 {0} 的订单可取消', c.number) : $t('没有可取消的订单');
      return send('chat', chat);
    }
  }

  if (s.grab.mode === 'auction') {
    const amount = parseBid(comment, { kSuffix: s.auction.kSuffix, allowText: s.monitor.numberWithText });
    if (amount == null) return send('chat', chat);
    const blocked = store.blockReason(uniqueId);
    if (blocked) {
      chat.result = blocked;
      return send('chat', chat);
    }
    const r = auction.bid(uniqueId, nickname, amount, s.auction);
    chat.result = r.ok ? $t('出价 {0}（当前最高）', amount) : r.reason;
    chat.hit = r.ok;
    send('chat', chat);
    sendPanel();
    return;
  }

  const match = matchComment(comment, s.monitor);
  if (!match) return send('chat', chat);
  const blocked = store.blockReason(uniqueId);
  if (blocked) {
    chat.result = blocked;
    send('chat', chat);
    if (blocked === $t('黑名单')) log($t('黑名单用户 {0}（{1}）：{2}，已忽略', nickname || uniqueId, uniqueId, comment), 'warn');
    return;
  }
  // 重复下单（同一人同一号码）
  const dup = duplicateReason(uniqueId, match.number, store.currentSession()?.id, store.data.history, s.dedupe);
  if (dup) {
    chat.result = dup;
    return send('chat', chat);
  }
  // 商品匹配 / 库存
  const product = s.products.enabled ? store.findProduct(match.number) : null;
  if (s.products.enabled && s.products.requireMatch && match.number != null && !product) {
    chat.result = $t('没有对应商品');
    return send('chat', chat);
  }
  if (product && s.products.blockOutOfStock && product.stock != null && product.stock <= 0) {
    chat.result = $t('{0} 已售罄', product.name || product.code);
    return send('chat', chat);
  }
  const offer = grab.offer(uniqueId, match.key, s.grab);
  if (!offer.ok) {
    chat.result = offer.reason;
    return send('chat', chat);
  }
  chat.hit = true;
  chat.result = $t('命中');
  send('chat', chat);
  createRecord({ uniqueId, nickname, content: match.content, number: match.number, simulated, time: chat.time, extra: { chatId: chat.id } });
}
let chatSeq = 0;

/** 取消一单：标记取消、退回库存、让出抢单名额、大屏移除 */
function cancelOrder(id, by = 'manual') {
  const rec = store.cancelRecord(id, by);
  if (!rec) return null;
  grab.release(rec.uniqueId, String(rec.number));
  const i = recentHits.findIndex((h) => h.id === rec.id);
  if (i >= 0) recentHits.splice(i, 1);
  todayCount = Math.max(0, todayCount - 1);
  log($t('{0}：{1}（{2}）编号 {3}，{4}{5}', by === 'buyer' ? $t('买家取消') : $t('手动取消'), rec.nickname || rec.uniqueId, rec.uniqueId, rec.codeText, rec.content, rec.productName ? $t('（') + rec.productName + $t('，库存已退回）') : ''), 'warn');
  send('record', rec);
  sendPanel();
  return rec;
}

/** 分配编号 → 写打印历史 → 打印 */
async function createRecord({ uniqueId, nickname, content, number, simulated, time, extra = {} }) {
  const s = store.settings;
  const product = s.products.enabled && !extra.auction ? store.findProduct(number) : null;
  if (product) {
    store.sellProduct(product.code);
    extra = { productCode: product.code, productName: product.name, price: product.price, spec: product.spec, ...extra };
  }
  if (extra.auction) extra = { price: extra.amount, ...extra };
  else if (!product && s.products.numberAsPrice && number != null) extra = { price: number * (Number(s.products.multiplier) || 1), ...extra };
  const session = store.ensureSession();
  if (store.data.sessions.length && session.startAt > Date.now() - 1000) send('session', session);
  extra = { sessionId: session.id, ...extra };
  const rec = store.addHistory({
    time: time || Date.now(),
    uniqueId,
    nickname,
    content,
    number,
    serial: store.nextSerial(),
    code: null,
    codeText: '',
    note: s.hostNote || '',
    status: s.print.enabled ? 'pending' : 'off',
    simulated,
    ...extra,
  });
  stats.total += 1;
  try {
    Object.assign(rec, await assignCode(uniqueId, nickname));
    store.updateHistory(rec.id, {});
  } catch (e) {
    store.updateHistory(rec.id, { status: 'fail', error: e.message });
    stats.failed += 1;
    log($t('编号分配失败（{0}：{1}）：{2}', nickname || uniqueId, content, e.message), 'error');
    send('record', rec);
    sendStats();
    return rec;
  }
  rec.newbie = rec.isNew ? s.newbieMark || '' : '';
  store.updateHistory(rec.id, {});
  send('record', rec);
  send('hit', rec);
  recentHits.unshift(rec);
  if (recentHits.length > 20) recentHits.length = 20;
  const d = new Date();
  if (todayKey !== String(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime())) refreshToday();
  else todayCount += 1;
  log($t('{0}（{1}）：{2}{3} → 编号 {4}{5}', nickname || uniqueId, uniqueId, content, rec.productName ? $t('（') + rec.productName + $t('）') : '', rec.codeText, rec.isNew ? $t(' · 新客户') : ''));
  if (s.print.enabled) await doPrint(rec);
  sendStats();
  return rec;
}

async function doPrint(rec) {
  const s = store.settings;
  sendStats();
  let res;
  for (let attempt = 0; attempt <= (Number(s.print.retry) || 0); attempt++) {
    if (attempt) {
      log($t('打印失败，{0} 秒后第 {1} 次重试（编号 {2}）', attempt, attempt, rec.codeText), 'warn');
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    res = await printer.print(rec, store.activeTemplate(), s.print).catch((e) => ({ ok: false, error: e.message }));
    if (res.ok) break;
  }
  const updated = store.updateHistory(rec.id, { status: res.ok ? 'ok' : 'fail', error: res.ok ? '' : res.error });
  if (!res.ok) {
    stats.failed += 1;
    log($t('打印失败（编号 {0}，{1}）：{2}', rec.codeText, rec.nickname || rec.uniqueId, res.error), 'error');
  }
  send('record', updated);
  sendStats();
  return res;
}

function finishAuction(result) {
  if (!result) return;
  if (!result.best) {
    log($t('竞拍结束：无人出价'), 'warn');
    sendPanel();
    return;
  }
  const { user, nickname, amount } = result.best;
  log($t('竞拍结束：{0}（{1}）以 {2} 拍得，共 {3} 次出价', nickname || user, user, amount, result.count), 'success');
  lastDeal = { uniqueId: user, nickname, amount, time: Date.now() };
  send('chat', { time: Date.now(), uniqueId: user, nickname, comment: String(amount), hit: true, result: $t('竞拍成交 {0}', amount) });
  createRecord({ uniqueId: user, nickname, content: String(amount), number: amount, extra: { amount, bidCount: result.count, auction: true } });
  sendPanel();
}

// ---------------- 环境自检 ----------------
async function probe(url) {
  const t = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { ok: res.status > 0 && res.status < 500, detail: `HTTP ${res.status} · ${Date.now() - t} ms` };
  } catch (e) {
    return { ok: false, detail: (e.cause && e.cause.code) || e.name || e.message };
  }
}

async function runSelfCheck() {
  const s = store.settings;
  const items = [];
  const add = (name, ok, detail, tip = '') => items.push({ name, ok, detail, tip });

  // 数据目录
  try {
    const f = path.join(app.getPath('userData'), 'data', '.write-test');
    fs.writeFileSync(f, String(Date.now()));
    fs.unlinkSync(f);
    add($t('数据目录可写'), true, app.getPath('userData'));
  } catch (e) {
    add($t('数据目录可写'), false, e.message, $t('检查磁盘空间或杀毒软件是否拦截'));
  }

  // 打印机
  const printers = await printer.listPrinters(win.webContents);
  const chosen = printers.find((p) => p.name === s.print.printer);
  add($t('已选择打印机'), !!chosen, chosen ? chosen.name : s.print.printer ? $t('找不到「{0}」', s.print.printer) : $t('还没选'), $t('在控制台「打印设置」里选择标签打印机'));
  const tpl = store.activeTemplate();
  add($t('打印模板'), !!tpl, tpl ? $t('{0}（{1}×{2} mm）', tpl.name, tpl.width, tpl.height) : $t('无'), $t('打印机驱动里的纸张尺寸也要设成同样大小，否则可能缩放或分页'));
  add($t('打印开关'), !!s.print.enabled, s.print.enabled ? $t('开启') : $t('已暂停'), $t('顶部栏「打印暂停」点一下开启，或按 F9'));

  // 网络
  const tk = await probe('https://www.tiktok.com/');
  add($t('能访问 TikTok'), tk.ok, tk.detail, $t('网络无法访问 TikTok 时两种模式都连不上，检查网络 / 代理'));
  const eu = await probe('https://api.eulerstream.com/');
  add($t('签名服务（第三方模式）'), eu.ok, eu.detail, $t('连不上时改用浏览器模式'));
  add('Euler API Key', !!s.signApiKey, s.signApiKey ? $t('已填写') : $t('未填写（免费额度，可能限流）'), $t('连接频繁失败时到 eulerstream.com 申请后填到系统设置'));

  // 浏览器模式登录
  try {
    const { session } = require('electron');
    const cookies = await session.fromPartition('persist:tiktok').cookies.get({ name: 'sessionid' });
    add($t('浏览器模式已登录 TikTok'), cookies.length > 0, cookies.length ? $t('已登录') : $t('未登录'), $t('用浏览器模式时，在弹出的直播间窗口里登录一次即可（会记住）'));
  } catch (e) {
    add($t('浏览器模式已登录 TikTok'), false, e.message);
  }

  // 共享编号
  if (s.code.mode === 'shared') {
    try {
      const r = await ping(s.share.serverUrl, s.share.key);
      add($t('共享编号主机'), true, $t('已连接 {0}', r.host));
    } catch (e) {
      add($t('共享编号主机'), false, e.message, $t('检查主机是否开着、地址和密码是否正确、防火墙是否放行'));
    }
  }
  if (s.share.hostEnabled) add($t('本机共享主机'), shareServer.running, shareServer.running ? $t('运行中') : $t('未运行'), $t('系统设置里重新打开一次「本机作为主机」'));

  // 监控规则
  const m = s.monitor;
  add($t('监控规则'), m.pureNumber || m.numberWithText || m.keywordEnabled, m.pureNumber || m.numberWithText || m.keywordEnabled ? $t('已启用') : $t('纯数字 / 数字+文字 / 特定文字 都没勾选，任何弹幕都不会命中'), $t('在控制台「监控规则」里至少勾一项'));
  log($t('环境自检：{0}/{1} 项正常', items.filter((i) => i.ok).length, items.length), items.every((i) => i.ok) ? 'success' : 'warn');
  return items;
}

// ---------------- 发货汇总 A4 ----------------
function summaryHtml(q) {
  const { customers, totals } = store.summary(q);
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = fmtMoney;
  const rows = customers
    .map(
      (c) => `<tr><td class="code">${esc(c.codeText)}</td><td><b>${esc(c.nickname)}</b>${c.isNew ? $t(' <span class="new">新</span>') : ''}<div class="u">@${esc(c.uniqueId)}</div></td>
        <td>${c.items.map((i) => `${esc(i.label)}${i.count > 1 ? ` <b>×${i.count}</b>` : ''}${i.price ? ` <span class="u">${money(i.price)}</span>` : ''}`).join('<br>')}</td>
        <td class="num">${c.qty}</td><td class="num">${money(c.total)}</td><td class="chk"></td></tr>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #111; }
    h1 { font-size: 16pt; margin: 0 0 4px; } .meta { color: #555; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #999; padding: 5px 6px; vertical-align: top; }
    th { background: #eee; font-size: 10pt; } tr { page-break-inside: avoid; }
    .code { font-size: 15pt; font-weight: 800; text-align: center; width: 14mm; } .num { text-align: right; white-space: nowrap; }
    .u { color: #666; font-size: 9pt; } .new { border: 1px solid #000; font-size: 8pt; padding: 0 3px; } .chk { width: 12mm; }
  </style></head><body>
    <h1>${$t('发货汇总 ·')} ${esc(q.name || '')}</h1>
    <div class="meta">${$t('共')} ${totals.customers} ${$t('位客户，')}${totals.qty} ${$t('件，合计')} ${money(totals.amount)}　${$t('·　打印时间')} ${fmtDate(Date.now())}</div>
    <table><thead><tr><th>${$t('编号')}</th><th>${$t('客户')}</th><th>${$t('商品明细')}</th><th>${$t('件数')}</th><th>${$t('金额')}</th><th>${$t('已配')}</th></tr></thead><tbody>${rows || $t('<tr><td colspan="6">没有订单</td></tr>')}</tbody></table>
  </body></html>`;
}

async function loadSummaryWindow(q) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(summaryHtml(q)));
  return w;
}

async function renderSummaryPdf(q) {
  const w = await loadSummaryWindow(q);
  try {
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
  } finally {
    w.destroy();
  }
}

// ---------------- CSV 导出 ----------------
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.title)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return '﻿' + lines.join('\r\n'); // BOM，Excel 打开中文/越南文不乱码
}

function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function saveFile(defaultName, content, filters) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
}
const CSV_FILTER = [{ name: 'CSV (Excel)', extensions: ['csv'] }];

/** 选一个表格文件（CSV / Excel）并读成对象数组；取消返回 null */
async function openTable(title = $t('选择要导入的文件')) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title,
    filters: [{ name: $t('表格（Excel / CSV）'), extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  return readTable(filePaths[0]);
}

const TITLEBAR = {
  dark: { color: '#08111f', symbolColor: '#cbd5e1', height: 56 },
  light: { color: '#f8fafc', symbolColor: '#334155', height: 56 },
};
function applyTitleBar(theme) {
  if (!win || win.isDestroyed()) return;
  const t = TITLEBAR[theme] || TITLEBAR.dark;
  try {
    win.setTitleBarOverlay(t);
  } catch {
    /* 非 Windows */
  }
  win.setBackgroundColor(theme === 'light' ? '#f4f7fd' : '#060b16');
}

// ---------------- IPC ----------------
// ---------------- 语言 / 国家 ----------------
function i18nPayload() {
  const lang = i18n.getLang();
  return {
    lang,
    dict: i18n.dictFor(lang),
    numLocale: numLocale(),
    country: store.settings.country,
    langs: i18n.LANGS,
    countries: COUNTRIES.map((c) => ({ ...c, name: $t(c.name) })),
  };
}

// 设置里还是「默认文字」的项，切换语言时跟着换（用户改过的不动）
const LANG_DEFAULTS = [
  ['screen', 'title', 'LIVE 抢单'],
  ['screen', 'hint', '评论区发送号码即可下单'],
  [null, 'newbieMark', '新'],
  ['notify', 'voiceText', '{code}号 {content}'],
];
// 模板里还是默认文字的：模板名、发货单的「共…件」
const TEMPLATE_NAME_DEFAULTS = ['默认模板(40*30)', '发货单(40*30)'];
const ELEMENT_TEXT_DEFAULTS = ['共', '件', '文本'];

function setLanguage(code) {
  if (!i18n.LANGS.some((l) => l.code === code)) throw new Error('unknown language ' + code);
  const patch = { lang: code };
  const forms = (zh) => new Set(i18n.allForms(zh));
  i18n.setLang(code);
  for (const [group, key, zh] of LANG_DEFAULTS) {
    const cur = group ? store.settings[group][key] : store.settings[key];
    if (forms(zh).has(cur)) {
      if (group) (patch[group] = patch[group] || {})[key] = $t(zh);
      else patch[key] = $t(zh);
    }
  }
  // 模板：默认名称和默认文字跟着换（用户改过的不动）
  let tplChanged = false;
  const templates = store.settings.templates.map((t) => {
    const nt = { ...t, elements: (t.elements || []).map((el) => ({ ...el })) };
    for (const zh of TEMPLATE_NAME_DEFAULTS) if (forms(zh).has(nt.name)) (nt.name = $t(zh)), (tplChanged = true);
    for (const el of nt.elements)
      for (const k of ['prefix', 'suffix', 'text'])
        for (const zh of ELEMENT_TEXT_DEFAULTS) if (el[k] && forms(zh).has(el[k]) && el[k] !== $t(zh)) (el[k] = $t(zh)), (tplChanged = true);
    return nt;
  });
  store.setSettings(patch);
  if (tplChanged) store.setSettings({ templates });
  refreshTray();
  bigScreen.broadcast(screenState());
  log($t('界面语言已切换：{0}', i18n.LANGS.find((l) => l.code === code).label), 'success');
  return patch;
}

function applyCountry(code) {
  const c = countryOf(code);
  const patch = { country: c.code, shop: { host: c.host }, cancel: { keywords: c.cancel }, products: { multiplier: c.multiplier } };
  store.setSettings(patch);
  send('settingsPatch', patch);
  bigScreen.broadcast(screenState());
  log($t('国家/站点：{0}（卖家中心 {1}，取消关键词「{2}」）', $t(c.name), c.host, c.cancel), 'success');
  return patch;
}

function registerIpc() {
  const h = (ch, fn) =>
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        log($t('{0} 出错：{1}', ch, err.message), 'error');
        throw err;
      }
    });

  // ---- 语言 / 国家 ----
  ipcMain.on('i18n:get', (e) => {
    e.returnValue = i18nPayload();
  });
  h('lang:set', (code) => setLanguage(code));
  h('country:apply', (code) => applyCountry(code));
  h('init', async () => {
    fileLog?.write('info', '界面初始化完成');
    return initPayload();
  });
  const initPayload = async () => ({
    snapshot: store.snapshot(),
    printers: await printer.listPrinters(win.webContents),
    status: { status: live.status, user: live.user, mode: live.mode },
    stats: { ...stats, queue: printer.pending },
    userData: app.getPath('userData'),
    version: app.getVersion(),
    lanUrls: lanAddresses().map((ip) => `http://${ip}:${store.settings.share.port}`),
    shareRunning: shareServer.running,
    session: store.currentSession(),
  });
  h('printers', () => printer.listPrinters(win.webContents));
  h('settings:set', (patch) => {
    // 大屏窗口位置由主进程自己记录，不让界面里的旧值覆盖
    if (patch && patch.screen) delete patch.screen.bounds;
    const r = store.setSettings(patch);
    refreshTray();
    bigScreen.applyWindowSettings();
    bigScreen.broadcast(screenState());
    return r;
  });
  h('screen:toggle', () => bigScreen.toggle());
  h('screen:close', () => bigScreen.close());
  h('screen:state', () => screenState());
  h('screen:togglePin', () => {
    store.setSettings({ screen: { alwaysOnTop: !store.settings.screen.alwaysOnTop } });
    bigScreen.applyWindowSettings();
    bigScreen.broadcast(screenState());
    send('screenPin', store.settings.screen.alwaysOnTop);
  });
  h('screen:applyObs', () => applyObs());
  h('selfcheck:run', () => runSelfCheck());
  h('app:quit', () => quitApp());
  // ---- TikTok Shop 订单备注 ----
  h('shop:status', () => ({ ...shop.status(), busy: shopJob.busy, fields: NOTE_FIELDS() }));
  h('shop:check', () => shop.check());
  h('shop:login', () => shop.openLogin());
  h('shop:cookie', (text) => shop.importCookies(text));
  h('shop:logout', async () => {
    await shop.logout();
    shopJob.orders = new Map();
    log($t('已退出店铺登录'), 'warn');
  });
  h('shop:orders', async (status) => shopRows(await shopFetch(0, ['to_ship', 'collect', 'shipped'].includes(status) ? status : 'to_ship')));
  h('shop:replan', () => shopRows([...shopJob.orders.values()]));
  h('shop:noteBatch', (ids) => runShopNotes(ids));
  h('shop:stop', () => {
    shopJob.stop = true;
  });
  h('shop:getNote', (id) => shop.getNote(id));
  h('shop:noteOne', async (id, text) => {
    text = String(text || '').trim().slice(0, 500);
    if (!text) throw new Error($t('备注内容不能为空'));
    await shop.setNote(id, text);
    const prev = store.data.shopNoted[String(id)];
    store.markNoted(id, { text, recIds: prev ? prev.recIds : [], user: prev ? prev.user : '', manual: true });
    const o = shopJob.orders.get(String(id));
    if (o) o.hasNote = true;
    log($t('订单【{0}】备注成功，内容：【{1}】', id, text), 'success');
    return true;
  });
  h('logs:open', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
  h('screen:info', () => ({ open: bigScreen.isOpen, obsUrl: bigScreen.obsUrl }));

  h('live:connect', () => {
    live.retryCount = 0;
    return connectLive();
  });
  h('live:disconnect', () => disconnectLive());
  h('live:showBrowser', () => browserLive.show());

  h('sim:comment', (msg) => handleChat({ ...msg, simulated: true }));
  // 弹幕流里手动打印一条（没命中规则 / 被拦下的弹幕）：不过规则，直接分配编号并打印
  h('chat:print', async ({ chatId, uniqueId, nickname, comment, time, simulated } = {}) => {
    if (!uniqueId || !comment) throw new Error($t('记录不存在'));
    const match = matchComment(comment, store.settings.monitor);
    const rec = await createRecord({
      uniqueId,
      nickname,
      content: match?.content ?? comment,
      number: match?.number ?? null,
      simulated: !!simulated,
      time: time || Date.now(),
      extra: { chatId, manual: true },
    });
    return { ok: rec.status === 'ok' || rec.status === 'off', status: rec.status, codeText: rec.codeText, error: rec.error || '' };
  });

  h('grab:reset', () => {
    grab.reset();
    sendPanel();
  });
  h('auction:start', () => {
    auction.start(store.settings.auction);
    log($t('竞拍开始，{0} 秒', store.settings.auction.seconds), 'success');
    sendPanel();
  });
  h('auction:finish', () => finishAuction(auction.finish()));
  h('auction:cancel', () => {
    if (auction.cancel()) log($t('竞拍已取消，本轮不打印'), 'warn');
    sendPanel();
  });

  h('history:query', (q) => store.queryHistory(q));
  h('history:reprint', async (id) => {
    const rec = store.getHistory(id);
    if (!rec) throw new Error($t('记录不存在'));
    if (rec.code == null) {
      try {
        Object.assign(rec, await assignCode(rec.uniqueId, rec.nickname));
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    store.updateHistory(id, { status: 'pending', reprints: (rec.reprints || 0) + 1 });
    send('record', rec);
    return doPrint(rec);
  });
  h('history:clear', () => store.clearHistory());
  h('history:export', (q) => {
    const { rows } = store.queryHistory({ ...q, limit: 1e9 });
    const statusText = { ok: $t('成功'), fail: $t('失败'), pending: $t('打印中'), off: $t('未打印') };
    const csv = toCsv(rows, [
      { title: $t('时间'), get: (r) => fmtDate(r.time) },
      { title: $t('用户名'), key: 'uniqueId' },
      { title: $t('昵称'), key: 'nickname' },
      { title: $t('内容'), key: 'content' },
      { title: $t('流水'), key: 'serial' },
      { title: $t('编号'), key: 'codeText' },
      { title: $t('状态'), get: (r) => statusText[r.status] || r.status },
    ]);
    return saveFile($t('打印历史_{0}.csv', fmtDate(Date.now()).replace(/[: ]/g, '-')), csv, CSV_FILTER);
  });

  // 名单（kind = blacklist | whitelist）
  h('names:list', (kind) => store.listOf(kind));
  h('names:add', ({ kind, uniqueId, nickname, note }) => {
    const ok = store.addToList(kind, normalizeUser(uniqueId), nickname, note);
    if (ok) log($t('已加入{0}名单：{1}（{2}）', kind === 'whitelist' ? $t('白') : $t('黑'), nickname || uniqueId, uniqueId), kind === 'whitelist' ? 'info' : 'warn');
    return ok;
  });
  h('names:note', ({ kind, uniqueId, note }) => store.noteInList(kind, uniqueId, note));
  h('names:remove', ({ kind, uniqueId }) => store.removeFromList(kind, uniqueId));
  h('names:export', (kind) => {
    const csv = toCsv(store.listOf(kind), [
      { title: $t('用户名'), key: 'uniqueId' },
      { title: $t('昵称'), key: 'nickname' },
      { title: $t('备注'), key: 'note' },
      { title: $t('添加时间'), get: (r) => fmtDate(r.addedAt) },
    ]);
    return saveFile(kind === 'whitelist' ? $t('白名单.csv') : $t('黑名单.csv'), csv, CSV_FILTER);
  });
  h('names:import', async (kind) => {
    const rows = await openTable();
    if (!rows) return null;
    let n = 0;
    for (const r of rows) if (store.addToList(kind, normalizeUser(pick(r, ['用户名', 'uniqueId', 'username', '账号', 'id'])), pick(r, ['昵称', 'nickname', '名称']), pick(r, ['备注', 'note']))) n++;
    return n;
  });

  // 商品
  h('products:list', () => store.data.products);
  h('products:save', (p) => store.upsertProduct(p));
  h('products:delete', (codes) => store.deleteProducts(codes));
  h('products:export', () => {
    const csv = toCsv(store.data.products, [
      { title: $t('商品编号'), key: 'code' },
      { title: $t('商品名称'), key: 'name' },
      { title: $t('价格'), key: 'price' },
      { title: $t('库存'), key: 'stock' },
      { title: $t('规格'), key: 'spec' },
      { title: $t('已售'), key: 'sold' },
    ]);
    return saveFile($t('商品信息.csv'), csv, CSV_FILTER);
  });
  h('products:import', async (replace) => {
    const rows = await openTable();
    if (!rows) return null;
    return store.importProducts(
      rows.map((r) => ({
        code: pick(r, ['商品编号', '编号', 'code']),
        name: pick(r, ['商品名称', '名称', 'name']),
        price: pick(r, ['价格', '单价', 'price']).replace(/[^\d.]/g, ''),
        stock: pick(r, ['库存', 'stock']),
        spec: pick(r, ['规格', 'spec']),
      })),
      replace
    );
  });

  // 统计
  h('stats:summary', ({ from, to }) => store.stats(Number(from), Number(to)));

  // 场次
  h('sessions:list', () => store.listSessions());
  h('sessions:current', () => store.currentSession());
  h('sessions:start', (name) => {
    const sess = store.startSession(name);
    grab.reset();
    log($t('开始新场次：{0}{1}', sess.name, store.settings.session.resetSerial ? $t('（流水已归零）') : ''), 'success');
    sendStats();
    send('session', sess);
    return sess;
  });
  h('sessions:end', () => {
    const sess = store.endSession();
    if (sess) log($t('场次结束：{0}', sess.name));
    send('session', null);
    return sess;
  });
  h('sessions:rename', ({ id, name }) => store.renameSession(id, name));

  // 取消 / 恢复订单
  h('history:cancel', (id) => cancelOrder(id, 'manual'));
  h('history:restore', (id) => {
    const rec = store.restoreRecord(id);
    if (rec) {
      log($t('已恢复订单：编号 {0}，{1}', rec.codeText, rec.nickname || rec.uniqueId));
      send('record', rec);
    }
    return rec;
  });

  // 发货汇总（对照表）
  h('summary:get', (q) => store.summary(q));
  h('summary:export', (q) => {
    const { customers } = store.summary(q);
    const csv = toCsv(customers, [
      { title: $t('编号'), key: 'codeText' },
      { title: $t('昵称'), key: 'nickname' },
      { title: $t('用户名'), key: 'uniqueId' },
      { title: $t('商品明细'), key: 'itemsText' },
      { title: $t('件数'), key: 'qty' },
      { title: $t('合计金额'), key: 'total' },
      { title: $t('新客户'), get: (r) => (r.isNew ? $t('是') : '') },
    ]);
    return saveFile($t('发货汇总_{0}.csv', q.name || fmtDate(Date.now()).slice(0, 10)).replace(/[\\/:*?"<>|]/g, '-'), csv, CSV_FILTER);
  });
  h('summary:pdf', async (q) => {
    const pdf = await renderSummaryPdf(q);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: $t('发货汇总_{0}.pdf', q.name || fmtDate(Date.now()).slice(0, 10)).replace(/[\\/:*?"<>|]/g, '-'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, pdf);
    return { ok: true, filePath };
  });
  h('summary:printA4', async (q) => {
    const w = await loadSummaryWindow(q);
    return new Promise((resolve) => {
      w.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
        w.destroy();
        resolve({ ok, error: ok ? '' : reason });
      });
    });
  });
  h('summary:printLabels', async ({ q, templateId }) => {
    const s = store.settings;
    const tpl = s.templates.find((t) => t.id === templateId) || store.activeTemplate();
    const { customers } = store.summary(q);
    let ok = 0;
    for (const c of customers) {
      const res = await printer.print(
        {
          codeText: c.codeText, nickname: c.nickname, uniqueId: c.uniqueId, content: c.itemsText, itemsText: c.itemsText,
          qty: c.qty, total: c.total, price: c.total, time: Date.now(), serial: '', note: s.hostNote, newbie: c.isNew ? s.newbieMark : '',
        },
        tpl,
        s.print
      );
      if (res.ok) ok++;
      else log($t('发货单打印失败（编号 {0}）：{1}', c.codeText, res.error), 'error');
    }
    log($t('发货单打印完成：{0} / {1} 张', ok, customers.length), ok === customers.length ? 'success' : 'warn');
    return { ok, total: customers.length };
  });

  // 备份 / 恢复
  h('data:backup', () => {
    store.flush();
    return saveFile($t('livenumber-备份-{0}.json', fmtDate(Date.now()).replace(/[: ]/g, '-')), JSON.stringify(store.data), [{ name: $t('备份'), extensions: ['json'] }]);
  });
  h('data:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { filters: [{ name: $t('备份'), extensions: ['json'] }], properties: ['openFile'] });
    if (canceled || !filePaths[0]) return false;
    clearTimeout(store.timer);
    store.timer = null;
    store.replaceAll(JSON.parse(fs.readFileSync(filePaths[0], 'utf8')));
    store.save = () => {}; // 重启前不要再写回旧数据
    app.relaunch();
    app.exit(0);
    return true;
  });

  // 主题：同步窗口标题栏颜色
  h('theme:apply', (theme) => applyTitleBar(theme));

  h('blacklist:list', () => store.data.blacklist);
  h('blacklist:add', ({ uniqueId, nickname, note }) => {
    const ok = store.addBlacklist(normalizeUser(uniqueId), nickname, note);
    if (ok) log($t('已拉黑 {0}（{1}）', nickname || uniqueId, uniqueId), 'warn');
    sendStats();
    return ok;
  });
  h('blacklist:note', ({ uniqueId, note }) => store.updateBlacklist(uniqueId, note));
  h('blacklist:remove', (uniqueId) => store.removeBlacklist(uniqueId));

  h('customers:list', () => store.listCustomers());
  h('customers:delete', (ids) => store.deleteCustomers(ids));
  h('customers:setCode', ({ uniqueId, code }) => store.setCustomerCode(uniqueId, code));
  h('customers:reset', () => {
    store.resetCustomers();
    sendStats();
  });
  h('customers:setNext', (n) => {
    store.setNextCode(n);
    sendStats();
  });
  h('customers:export', () => {
    const csv = toCsv(store.listCustomers(), [
      { title: $t('添加时间'), get: (r) => fmtDate(r.addedAt) },
      { title: $t('用户名'), key: 'uniqueId' },
      { title: $t('昵称'), key: 'nickname' },
      { title: $t('编号'), get: (r) => store.formatCode(r.code) },
    ]);
    return saveFile($t('客户编号.csv'), csv, CSV_FILTER);
  });
  h('customers:import', async (mode) => {
    const rows = await openTable($t('选择客户编号表（Excel / CSV）'));
    if (!rows) return null;
    const parsed = rows.map((r) => ({
      uniqueId: normalizeUser(pick(r, ['用户名', 'uniqueId', 'username', '账号', 'tiktok', 'id'])),
      nickname: pick(r, ['昵称', 'nickname', '名称', '客户']),
      code: pick(r, ['编号', '客户编号', 'code', '序号']),
    }));
    if (!parsed.some((x) => x.uniqueId)) throw new Error($t('没找到「用户名」列：表格第一行要有「用户名」和「编号」两列'));
    const res = store.importCustomers(parsed, mode);
    log($t('导入客户编号：新增 {0}，更新 {1}，跳过 {2}，无效 {3}{4}', res.added, res.updated, res.skipped, res.invalid, res.conflicts.length ? $t('，{0} 个编号重复', res.conflicts.length) : ''), res.conflicts.length ? 'warn' : 'success');
    sendStats();
    return res;
  });
  h('serial:reset', () => {
    store.resetSerial();
    sendStats();
  });

  h('share:apply', () => applyShareServer());
  h('share:ping', async () => {
    const r = await ping(store.settings.share.serverUrl, store.settings.share.key);
    return { ok: true, host: r.host };
  });

  h('template:export', (tpl) => saveFile(`${tpl.name || $t('模板')}.json`, JSON.stringify(tpl, null, 2), [{ name: $t('模板'), extensions: ['json'] }]));
  h('template:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { filters: [{ name: $t('模板'), extensions: ['json'] }], properties: ['openFile'] });
    if (canceled || !filePaths[0]) return null;
    return JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
  });

  h('print:test', () => {
    const s = store.settings;
    return printer.print(
      {
        codeText: store.formatCode(88), nickname: $t('Test 测试'), uniqueId: 'test_user', content: '50', time: Date.now(), serial: 1, note: s.hostNote,
        amount: 150000, bidCount: 3, productName: 'Áo thun', price: 120000, spec: 'L', newbie: s.newbieMark,
      },
      store.activeTemplate(),
      s.print
    );
  });
}

// ---------------- 窗口 ----------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 660,
    title: $t('LiveNumber 直播扣号打单'),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: store.settings.theme === 'light' ? '#f4f7fd' : '#060b16',
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLEBAR[store.settings.theme] || TITLEBAR.dark,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // 窗口被 OBS / 直播伴侣挡住时，倒计时和界面照常更新
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 界面崩溃 / 卡死：自动重新加载（打单在主进程里，不受影响）
  win.webContents.on('render-process-gone', (_e, d) => {
    fileLog?.write('fatal', `界面进程退出：${d.reason} ${d.exitCode}`);
    if (d.reason !== 'clean-exit' && win && !win.isDestroyed()) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.reload();
      }, 500);
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (fileLog && win.__loadedOnce) log($t('界面已自动恢复（打单没有中断）'), 'warn');
    win.__loadedOnce = true;
  });
  win.on('unresponsive', () => fileLog?.write('warn', '界面无响应'));
  win.on('close', (e) => {
    if (quitting || !store.settings.closeToTray || !tray) return;
    e.preventDefault();
    win.hide();
    fileLog?.write('info', '窗口已隐藏到托盘');
    if (!store.settings.trayTipShown) {
      tray.displayBalloon({
        iconType: 'info',
        title: $t('LiveNumber 还在运行'),
        content: $t('已最小化到右下角托盘，会继续收弹幕和打印。点托盘图标打开窗口，右键可以退出。'),
      });
      store.setSettings({ trayTipShown: true });
      send('settingsPatch', { trayTipShown: true });
    }
  });
  win.on('closed', () => {
    win = null;
    browserLive.close();
    bigScreen.close();
  });
}

// 冒烟测试：LN_SMOKE=<截图输出路径>，使用独立数据目录、不真实打印
// 数据目录固定为 %APPDATA%\livenumber（安装版的产品名不同，也要读到原来的数据）
app.setPath('userData', process.env.LN_DATA_DIR || path.join(app.getPath('appData'), 'livenumber')); // LN_DATA_DIR：测试安装版时用独立目录
const SMOKE = process.env.LN_SMOKE;
const SHOTS = process.env.LN_SHOTS; // 界面巡检截图目录
if (SMOKE || SHOTS) app.setPath('userData', path.join(app.getPath('temp'), 'livenumber-smoke'));

// 只允许开一个：两个程序同时写同一份数据会互相覆盖
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    log($t('程序已经在运行，已切换到这个窗口（不会重复打开）'), 'warn');
  });
}

// 兜底：任何没处理的错误只记日志，不让程序退出（直播中断单代价太大）
process.on('uncaughtException', (err) => {
  fileLog?.write('fatal', 'uncaughtException ' + (err?.stack || err));
  try {
    log($t('程序内部错误（已记录到日志，程序继续运行）：') + (err?.message || err), 'error');
  } catch {
    /* ignore */
  }
});
process.on('unhandledRejection', (reason) => {
  fileLog?.write('fatal', 'unhandledRejection ' + (reason?.stack || reason));
  try {
    log($t('程序内部错误（已记录到日志，程序继续运行）：') + (reason?.message || reason), 'error');
  } catch {
    /* ignore */
  }
});

app.whenReady().then(() => {
  if (!isPrimary) return;
  app.on('before-quit', () => {
    quitting = true;
  });
  fileLog = new FileLogger(path.join(app.getPath('userData'), 'logs'));
  fileLog.write('info', `==== 启动 v${app.getVersion()} ====`);
  app.on('child-process-gone', (_e, d) => fileLog.write('fatal', `子进程退出 ${d.type} ${d.reason} ${d.exitCode}`));
  store = new Store(path.join(app.getPath('userData'), 'data'));
  if (process.env.LN_LANG) store.setSettings({ lang: process.env.LN_LANG }); // 测试用：指定界面语言
  i18n.setLang(store.settings.lang);
  printer.numLocale = numLocale;
  if (SMOKE || SHOTS) store.setSettings({ print: { enabled: false } });
  registerIpc();
  createWindow();
  createTray();
  setInterval(shopAutoTick, 10000);
  if (store.settings.shop.everLoggedIn && !SMOKE && !SHOTS) setTimeout(() => shop.check().catch(() => {}), 3000);
  setInterval(() => {
    finishAuction(auction.tick());
    sendPanel();
  }, 250);
  refreshToday();
  if (store.settings.screen.obsEnabled) applyObs().catch((e) => log($t('OBS 大屏地址启动失败：') + e.message, 'error'));
  if (store.settings.share.hostEnabled) applyShareServer().catch((e) => log($t('共享编号主机启动失败：') + e.message, 'error'));
  if (SHOTS) require('./shots').run({ win, store, handleChat, dir: SHOTS });
  if (SMOKE) require('./smoke').run({ win, store, handleChat, printer, loadTikTok, auction, finishAuction, shareServer, applyShareServer, requestCode, SMOKE, bigScreen, applyObs, sendPanel, renderSummaryPdf, summaryHtml, runSelfCheck });
});

app.on('window-all-closed', async () => {
  fileLog?.write('info', '==== 退出 ====');
  if (tray && !tray.isDestroyed()) tray.destroy();
  await disconnectLive(false);
  shareServer.stop();
  bigScreen.stopObs();
  shop.close();
  store?.flush();
  app.quit();
});

app.on('before-quit', () => store?.flush());
