'use strict';
const { t: $t } = require('./i18n/i18n');
// TikTok Shop 卖家中心：店铺登录（浏览器 / Cookie）、读待发货订单、读写卖家备注。
//
// 请求在一个隐藏窗口里发出：窗口停在卖家中心域名下（同源 + 登录 Cookie），和卖家后台网页自己发的请求一样。
// 用到的接口（2026-11 在卖家中心实测）：
//   POST /api/fulfillment/order/list         待发货订单（买家用户名是打码的）
//   POST /api/v1/trade/orders/note/list      {main_order_id} → 卖家备注
//   POST /api/v1/trade/orders/note/set       {main_order_id, seller_note_value:{note_text, seller_note_flag}}
//   POST /api/v1/seller/workbench/get_all_sellers  店铺名称 / ID（顺便判断是否登录）
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:tiktokshop';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 订单列表筛选条件（2026-11 在卖家中心实测：search_tab 101 = To ship，102 = Shipped）
const ORDER_STATUS = {
  to_ship: { order_status: { value: ['1'] }, search_tab: { value: ['101'] } }, // 待发货
  collect: { order_status: { value: ['2'] }, search_tab: { value: ['101'] } }, // 待揽收
  shipped: { search_tab: { value: ['102'] } }, // 已发货 / 待收货
};

class ShopClient {
  constructor({ getHost, onLog = () => {}, onStatus = () => {} } = {}) {
    this.getHost = getHost || (() => 'seller-vn.tiktok.com');
    this.onLog = onLog;
    this.onStatus = onStatus;
    this.win = null; // 隐藏的请求窗口
    this.winHost = '';
    this.loginWin = null;
    this.shop = null; // { id, name, region }
    this.loggedIn = false;
  }

  get ses() {
    const s = session.fromPartition(PARTITION);
    if (!s.__lnUa) {
      s.setUserAgent(UA);
      s.__lnUa = true;
    }
    return s;
  }

  get host() {
    return String(this.getHost() || 'seller-vn.tiktok.com')
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .trim();
  }

  status() {
    return { loggedIn: this.loggedIn, shop: this.shop, host: this.host };
  }

  /**
   * 隐藏窗口：打开卖家中心真实页面，之后在里面 fetch。
   * 必须是真页面：卖家中心的安全 SDK 会改写 window.fetch，给请求自动加 msToken / X-Bogus / X-Gnarly。
   * 订单列表等接口没有签名会返回 code 10000（get_all_sellers 不校验，所以光看登录状态看不出来）。
   */
  async ensureWin() {
    const host = this.host;
    if (this.win && !this.win.isDestroyed() && this.winHost === host) return this.win;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, backgroundThrottling: false, javascript: true },
    });
    this.win.webContents.setAudioMuted(true);
    this.winHost = host;
    try {
      await this.win.loadURL(`https://${host}/order?tab=to_ship`);
    } catch (e) {
      // SPA 跳转可能让 loadURL 报 ERR_ABORTED，只要停在这个域名下就行
      if (!this.win.webContents.getURL().includes(host)) throw new Error($t('打不开卖家中心：') + e.message);
    }
    // 等安全 SDK 把 fetch 包一层（最多 15 秒）
    const deadline = Date.now() + 15000;
    let signed = false;
    while (Date.now() < deadline && !this.win.isDestroyed()) {
      try {
        signed = await this.win.webContents.executeJavaScript('!/\\[native code\\]/.test(Function.prototype.toString.call(window.fetch))', true);
      } catch {}
      if (signed) break;
      await sleep(500);
    }
    if (!signed) this.onLog($t('卖家中心页面的请求签名没有就绪，部分接口可能失败'), 'warn');
    return this.win;
  }

  /** 在卖家中心页面里 POST 一个接口，返回 JSON */
  async post(apiPath, body) {
    const w = await this.ensureWin();
    const params = new URLSearchParams({ aid: '4068', locale: 'en', language: 'en' });
    if (this.shop && this.shop.id) {
      params.set('oec_seller_id', this.shop.id);
      params.set('seller_id', this.shop.id);
    }
    const url = `${apiPath}?${params}`;
    const js = `fetch(${JSON.stringify(url)}, {method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body:${JSON.stringify(JSON.stringify(body || {}))}})
      .then(async (r) => { const t = await r.text(); try { return { status: r.status, json: JSON.parse(t) }; } catch (e) { return { status: r.status, text: t.slice(0, 300) }; } })
      .catch((e) => ({ error: String(e && e.message || e) }))`;
    const r = await w.webContents.executeJavaScript(js, true);
    if (r.error) throw new Error($t('网络错误：') + r.error);
    if (!r.json) throw new Error($t('卖家中心返回异常（HTTP {0}）', r.status));
    return r.json;
  }

  /** 检查登录状态，顺便取店铺信息 */
  async check() {
    let ok = false;
    try {
      this.shop = null;
      const j = await this.post('/api/v1/seller/workbench/get_all_sellers', {});
      if (j.code === 0 && j.data) {
        const sellers = Object.values(j.data.sellers_data || {});
        const list = sellers.flatMap((g) => (g.global_seller && g.global_seller.seller_map) || []);
        const region = (this.host.match(/seller-(\w+)\./) || [])[1];
        const pickOne = list.find((x) => region && String(x.region).toLowerCase() === region.toLowerCase()) || list[0];
        if (pickOne) {
          this.shop = { id: String(pickOne.seller_id), name: pickOne.shop_name || '', region: pickOne.region || '' };
          ok = true;
        }
      }
    } catch (e) {
      this.onLog($t('检查店铺登录失败：') + e.message, 'warn');
    }
    this.loggedIn = ok;
    this.onStatus(this.status());
    return this.status();
  }

  /** 浏览器登录：打开卖家中心登录页，登录成功后自动关闭 */
  openLogin() {
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.show();
      this.loginWin.focus();
      return;
    }
    const host = this.host;
    const w = new BrowserWindow({
      width: 1200,
      height: 820,
      title: $t('登录 TikTok Shop 卖家中心（登录成功后会自动关闭）'),
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true },
    });
    this.loginWin = w;
    w.loadURL(`https://${host}/account/login`);
    let done = false;
    const tryDone = async () => {
      if (done || w.isDestroyed()) return;
      const url = w.webContents.getURL();
      if (/\/account\/(login|register)|passport|verify/i.test(url)) return;
      const st = await this.check();
      if (st.loggedIn && !done && !w.isDestroyed()) {
        done = true;
        this.onLog($t('店铺登录成功：{0}', st.shop.name), 'success');
        w.close();
      }
    };
    w.webContents.on('did-navigate', tryDone);
    w.webContents.on('did-navigate-in-page', tryDone);
    w.on('closed', () => {
      this.loginWin = null;
      if (!done) this.check();
    });
  }

  /**
   * Cookie 登录。支持：
   *  - JSON 数组（Cookie-Editor / EditThisCookie 导出）[{name, value, domain, path, ...}]
   *  - {cookies: [...]}
   *  - 请求头格式 "a=1; b=2"
   */
  async importCookies(text) {
    text = String(text || '').trim();
    if (!text) throw new Error($t('请先粘贴 Cookie'));
    let list = [];
    if (/^[[{]/.test(text)) {
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error($t('Cookie 不是有效的 JSON'));
      }
      list = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : [];
    } else {
      list = text
        .split(/;\s*/)
        .map((kv) => {
          const i = kv.indexOf('=');
          return i > 0 ? { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() } : null;
        })
        .filter(Boolean);
    }
    list = list.filter((c) => c && c.name && c.value !== undefined);
    if (!list.length) throw new Error($t('没有读到 Cookie'));
    const ses = this.ses;
    let n = 0;
    for (const c of list) {
      const domain = c.domain || '.tiktok.com';
      const bare = domain.replace(/^\./, '');
      if (!/tiktok|tiktokshop|ttwstatic|byteoversea|ibytedtos/i.test(bare)) continue;
      const details = {
        url: `https://${bare}${c.path || '/'}`,
        name: String(c.name),
        value: String(c.value),
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
      };
      // 没写域名的（a=1; b=2 格式）按 .tiktok.com 处理，seller-xx.tiktok.com 也能用到；JSON 里 hostOnly 的保持原样
      if (!c.hostOnly) details.domain = domain;
      const exp = c.expirationDate ?? c.expires ?? c.expiry;
      if (exp && Number(exp) > 0) details.expirationDate = Number(exp) > 1e12 ? Number(exp) / 1000 : Number(exp);
      else details.expirationDate = Date.now() / 1000 + 30 * 86400;
      const ss = String(c.sameSite || '').toLowerCase();
      details.sameSite = ss.includes('strict') ? 'strict' : ss.includes('lax') ? 'lax' : 'no_restriction';
      if (details.sameSite === 'no_restriction') details.secure = true;
      try {
        await ses.cookies.set(details);
        n++;
      } catch (e) {
        this.onLog($t('Cookie {0} 写入失败：{1}', c.name, e.message), 'warn');
      }
    }
    await ses.cookies.flushStore();
    if (!n) throw new Error($t('没有可用的 TikTok Cookie（域名要是 tiktok.com）'));
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    const st = await this.check();
    if (!st.loggedIn) throw new Error($t('已写入 {0} 个 Cookie，但卖家中心没有登录成功（Cookie 过期或不完整，请重新导出）', n));
    this.onLog($t('Cookie 登录成功：{0}（写入 {1} 个 Cookie）', st.shop.name, n), 'success');
    return st;
  }

  async logout() {
    await this.ses.clearStorageData();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loggedIn = false;
    this.shop = null;
    this.onStatus(this.status());
  }

  /**
   * 读订单（分页读完），返回整理好的订单。
   * status: 'to_ship' 待发货 | 'collect' 待揽收（已安排发货、快递未取件）| 'shipped' 已发货（运输中，待买家收货）
   */
  async listToShip({ pageDelay = 800, maxPages = 20, sinceMs = 0, status = 'to_ship' } = {}) {
    if (!this.loggedIn) await this.check();
    if (!this.loggedIn) throw new Error($t('店铺还没登录'));
    const condition = ORDER_STATUS[status] || ORDER_STATUS.to_ship;
    const out = [];
    const count = 50;
    for (let page = 0; page < maxPages; page++) {
      const j = await this.post('/api/fulfillment/order/list', {
        search_condition: { condition_list: condition },
        offset: page * count,
        count,
        sort_info: '11',
        search_cursor: '',
        pagination_type: 0,
      });
      if (j.code !== 0) {
        this.onLog(`order/list → ${JSON.stringify(j).slice(0, 500)}`, 'warn');
        throw new Error($t('读取订单失败：{0}', j.message || j.msg || j.code));
      }
      const rows = (j.data && j.data.main_orders) || [];
      out.push(...rows.map(parseOrder));
      const total = Number(j.data && j.data.total_count) || 0;
      if (!rows.length || out.length >= total) break;
      if (sinceMs && rows.every((r) => parseOrder(r).createTime < sinceMs)) break;
      await sleep(pageDelay);
    }
    return sinceMs ? out.filter((o) => o.createTime >= sinceMs) : out;
  }

  /** 订单当前的卖家备注（最新一条） */
  async getNote(orderId) {
    const j = await this.post('/api/v1/trade/orders/note/list', { main_order_id: String(orderId) });
    if (j.code !== 0) throw new Error($t('读取备注失败：{0}', j.message || j.code));
    const notes = (j.data && j.data.notes) || [];
    notes.sort((a, b) => Number(b.update_time_unix || 0) - Number(a.update_time_unix || 0));
    const v = notes[0] && notes[0].seller_note_value;
    return v ? String(v.note_text || '') : '';
  }

  /** 写卖家备注（覆盖） */
  async setNote(orderId, text) {
    const body = { main_order_id: String(orderId), seller_note_value: { note_text: String(text), seller_note_flag: 0 } };
    const j = await this.post('/api/v1/trade/orders/note/set', body);
    if (j.code !== 0) throw new Error(j.message || j.msg || $t('错误码 {0}', j.code));
    return true;
  }

  close() {
    for (const w of [this.win, this.loginWin]) if (w && !w.isDestroyed()) w.destroy();
    this.win = null;
    this.loginWin = null;
  }
}

/** 订单接口返回 → 界面用的订单 */
function parseOrder(o) {
  const t = o.trade_order_module || {};
  const price = (o.price_module && o.price_module.grand_total) || {};
  const skus = o.sku_module || o.fulfill_line_module || [];
  const buyer = o.buyer_info_module || {};
  return {
    id: String(o.main_order_id),
    createTime: Number(t.create_time || 0) * 1000,
    buyer: String(buyer.buyer_nickname || ''),
    avatar: (buyer.avatar && buyer.avatar.url_list && buyer.avatar.url_list[0]) || '',
    amount: Number(price.price_val || 0),
    amountText: price.format_price || '',
    payMethod: t.pay_method || '',
    items: skus.map((s) => ({ name: s.product_name || '', sku: s.sku_name || '', sellerSku: s.seller_sku_name || '', qty: Number(s.quantity || 1) })),
    hasNote: !!(o.note_module && o.note_module.has_seller_note),
    hasBuyerNote: !!(o.note_module && o.note_module.has_buyer_note),
  };
}

module.exports = { ShopClient, parseOrder, PARTITION };
