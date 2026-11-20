'use strict';
const { t: $t } = require('./i18n/i18n');
// 本地 JSON 存储：设置、打印历史、客户编号、黑名单、计数器。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  lang: 'zh', // 界面语言：zh vi en th id ms
  country: 'VN', // 国家/站点：VN TH ID MY PH SG（卖家中心域名、金额格式、取消关键词）
  liveUser: '',
  signApiKey: '',
  autoReconnect: true,
  grab: { mode: 'grab', limit: 1, seconds: 50 },
  monitor: {
    pureNumber: true,
    numberWithText: false,
    keywordEnabled: false,
    keywordExact: false,
    keywords: '',
    limitMode: 'range',
    min: 1,
    max: 200,
    specific: '',
  },
  print: {
    enabled: true,
    printer: '',
    copies: 1,
    retry: 1, // 打印失败自动重试次数
  },
  // 打印模板（见 src/renderer/label-render.js）
  templates: [],
  activeTemplate: '',
  hostNote: '',
  code: {
    mode: 'increment', // increment 递增 | fill 补缺 | shared 共享（向局域网主机申请编号）
    prefixEnabled: false,
    prefix: 'A',
    maxDigits: 4,
  },
  auction: {
    seconds: 30,
    startMode: 'auto', // auto：第一次出价自动开始；manual：手动点开始
    minPrice: 1,
    step: 1,
    extendSeconds: 0, // 最后 N 秒内有人出价，倒计时延长到 N 秒
    kSuffix: true, // "150k" 识别为 150000
  },
  share: {
    hostEnabled: false, // 本机作为共享编号主机
    port: 18620,
    serverUrl: '', // 作为客户端时，主机地址，如 http://192.168.1.10:18620
    key: '', // 共享密码（可选）
  },
  listMode: 'blacklist', // blacklist：黑名单用户不打印；whitelist：只打印白名单用户
  products: {
    enabled: true, // 命中号码时按「商品编号」匹配商品，把商品名/价格印到标签
    requireMatch: false, // 只打印有对应商品的号码
    blockOutOfStock: true, // 库存为 0 时不再打印
    numberAsPrice: false, // 没有对应商品时按号码计价：金额 = 号码 × multiplier
    multiplier: 1000,
  },
  cancel: {
    enabled: true, // 买家发「hủy」「hủy 15」取消自己的订单
    keywords: 'hủy, huỷ, huy, 取消',
    minutes: 120, // 只能取消多少分钟内的订单
  },
  session: {
    resetSerial: true, // 开新场次时流水号归零
  },
  dedupe: {
    mode: 'window', // window：N 秒内同一人同一号码只算一单 | session：同一场只算一单 | none：每条都算
    seconds: 60,
  },
  newbieMark: '新', // 第一次下单的客户，标签「新人」组件显示这个
  notify: { sound: true, voice: false, voiceText: '{code}号 {content}' },
  theme: 'dark',
  closeToTray: true, // 点窗口关闭按钮：true 最小化到托盘继续运行；false 直接退出
  trayTipShown: false, // 第一次隐藏到托盘时提示过了
  screen: {
    alwaysOnTop: true,
    opacity: 1,
    style: 'dark', // dark 深色玻璃 | green 绿幕（OBS 抠像）| transparent 透明
    scale: 1,
    title: 'LIVE 抢单',
    hint: '评论区发送号码即可下单',
    showHits: true,
    showToday: true,
    maskNames: true, // 昵称打码：Nguyễn → Ng***，直播画面里保护买家隐私
    hitsCount: 5,
    obsEnabled: false,
    obsPort: 18630,
    bounds: null,
  },
  // TikTok Shop 订单备注
  shop: {
    host: 'seller-vn.tiktok.com', // 卖家中心域名（越南站）
    template: '【{fixedno}】{accname}',
    mode: 'overwrite', // overwrite 完全覆盖原有备注 | append 追加到原有备注后面
    merge: true, // 同一买家的多张订单写同一条备注（流水号合在一起）
    backMin: 5, // 向前回溯：先扣号后下单，扣号在下单前 N 分钟内
    fwdMin: 0, // 向后回溯：先下单后扣号，扣号在下单后 N 分钟内
    serial: 'all', // 同一买家窗口内多条扣号：all 全部 | min 最早一条 | max 最新一条
    allowRepeat: false, // 一条扣号记录可以用在多张订单上
    skipNoted: false, // 跳过已经有备注（不是本软件写的）的订单
    pageDelay: 800, // 翻页 / 每条备注之间的间隔（毫秒），太快可能被限流
    auto: false, // 自动备注：定时读新订单，匹配上就写
    autoSeconds: 60,
    autoHours: 24, // 自动备注只看最近 N 小时的订单
    everLoggedIn: false,
  },
  browserMode: false, // true：用内置浏览器打开直播间抓弹幕；false：第三方签名服务
  historyDays: 30,
};

let idSeq = 0;
function uid() {
  return Date.now().toString(36) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 默认 40×30 模板：ID + 大号编号 / 昵称 / ma: 内容 / 时间 */
function defaultTemplate(old = {}) {
  const el = (type, x, y, w, h, props) => ({ id: uid(), type, x, y, w, h, ...props });
  const els = [];
  if (old.title) els.push(el('text', 1, 0.5, 38, 4, { text: old.title, fontSize: 3, bold: true, align: 'center' }));
  const top = old.title ? 4.5 : 0.5;
  els.push(
    el('text', 1, top, 7, 8, { text: 'ID', fontSize: 3 }),
    el('field', 8, top, 31, 8, { field: 'code', fontSize: 7, bold: true, align: 'center' }),
    el('hline', 1, top + 8, 38, 1, { lineWidth: 0.2 }),
    el('field', 1, top + 9, 38, 5, { field: 'nickname', fontSize: 3.2, bold: true }),
    el('hline', 1, top + 14, 38, 1, { lineWidth: 0.2 }),
    el('text', 1, top + 15, 7, 7, { text: old.contentLabel ?? 'ma:', fontSize: 3.2 }),
    el('field', 8, top + 15, 31, 7, { field: 'content', fontSize: 5.5, bold: true }),
    el('field', 1, top + 23, 38, 5, { field: 'date', fontSize: 2.8 })
  );
  return { id: uid(), name: '默认模板(40*30)', width: old.width || 40, height: old.height || 30, dateFormat: 'MM/DD HH:mm:ss', elements: els };
}

/** 发货单模板 40×30：编号 + 昵称 / 商品清单 / 件数 + 合计 */
function shipTemplate() {
  const el = (type, x, y, w, h, props) => ({ id: uid(), type, x, y, w, h, ...props });
  return {
    id: uid(),
    name: '发货单(40*30)',
    width: 40,
    height: 30,
    dateFormat: 'MM/DD HH:mm',
    elements: [
      el('field', 1, 0.5, 14, 7, { field: 'code', fontSize: 6.5, bold: true }),
      el('field', 15, 0.5, 24, 4, { field: 'nickname', fontSize: 3, bold: true, align: 'right' }),
      el('field', 15, 4, 24, 3, { field: 'date', fontSize: 2.4, align: 'right' }),
      el('hline', 1, 7.2, 38, 1, { lineWidth: 0.2 }),
      el('field', 1, 8.2, 38, 14, { field: 'itemsText', fontSize: 2.8, wrap: true }),
      el('hline', 1, 22.5, 38, 1, { lineWidth: 0.2 }),
      el('field', 1, 23.5, 14, 5.5, { field: 'qty', fontSize: 3.2, bold: true, prefix: '共', suffix: '件' }),
      el('field', 15, 23.5, 24, 5.5, { field: 'total', fontSize: 3.6, bold: true, align: 'right', suffix: 'đ' }),
    ],
  };
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const k of Object.keys(extra)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k], extra[k]) : extra[k];
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'data.json');
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* 首次运行或文件损坏：用默认值 */
    }
    this.historyFile = path.join(dir, 'history.jsonl');
    const fromLog = this.readHistoryLog();
    this.data = {
      settings: deepMerge(DEFAULT_SETTINGS, raw.settings),
      // 历史记录单独存在 history.jsonl（追加写入）；旧版数据在 data.json 里，首次启动迁移过去
      history: fromLog || (Array.isArray(raw.history) ? raw.history : []),
      customers: raw.customers && typeof raw.customers === 'object' ? raw.customers : {},
      blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
      whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [],
      products: Array.isArray(raw.products) ? raw.products : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      counters: { nextCode: 1, serial: 0, nextHistoryId: 1, ...(raw.counters || {}) },
      shopNoted: raw.shopNoted && typeof raw.shopNoted === 'object' ? raw.shopNoted : {}, // 本软件写过的订单备注 {订单号: {text, recIds, user, time}}
    };
    this.pruneShopNoted();
    // 旧版 label 设置迁移成模板
    const st = this.data.settings;
    if (!Array.isArray(st.templates) || !st.templates.length) {
      st.templates = [defaultTemplate((raw.settings && raw.settings.label) || {})];
    }
    delete st.label;
    if (!st.shipTemplateAdded) {
      st.templates.push(shipTemplate());
      st.shipTemplateAdded = true;
    }
    if (!st.templates.some((t) => t.id === st.activeTemplate)) st.activeTemplate = st.templates[0].id;
    this.pruneHistory();
    this.byId = new Map(this.data.history.map((h) => [h.id, h]));
    // 程序意外退出时 data.json 可能比历史日志旧，编号计数以实际记录为准，避免重复 id
    const maxId = this.data.history.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
    if (this.data.counters.nextHistoryId <= maxId) this.data.counters.nextHistoryId = maxId + 1;
    this.timer = null;
    this.compactHistory(); // 启动时整理一次：去掉过期和被覆盖的旧行
    if (!fs.existsSync(this.file) || Array.isArray(raw.history)) this.flush(); // 迁移后把 data.json 瘦身
  }

  // ---------- 历史日志（JSON Lines，每行一条完整记录，同 id 以最后一行为准） ----------
  readHistoryLog() {
    let text;
    try {
      text = fs.readFileSync(this.historyFile, 'utf8');
    } catch {
      return null; // 还没有日志文件
    }
    const map = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id != null) map.set(r.id, r);
      } catch {
        /* 最后一行可能因断电只写了一半，跳过 */
      }
    }
    this.logLines = text.length ? text.split('\n').length : 0;
    return [...map.values()].sort((a, b) => a.time - b.time || a.id - b.id);
  }

  /** 追加一条记录的最新状态（很小的同步写，断电也最多丢最后一行） */
  persist(h) {
    if (!h) return;
    fs.appendFileSync(this.historyFile, JSON.stringify(h) + '\n');
    this.logLines = (this.logLines || 0) + 1;
  }

  /** 重写历史日志：只保留当前记录 */
  compactHistory() {
    const tmp = this.historyFile + '.tmp';
    fs.writeFileSync(tmp, this.data.history.map((h) => JSON.stringify(h)).join('\n') + (this.data.history.length ? '\n' : ''));
    fs.renameSync(tmp, this.historyFile);
    this.logLines = this.data.history.length;
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch) {
    this.data.settings = deepMerge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    const { history, ...rest } = this.data; // eslint-disable-line no-unused-vars
    fs.writeFileSync(tmp, JSON.stringify(rest));
    fs.renameSync(tmp, this.file);
  }

  /** 完整数据（含历史），用于备份 */
  exportAll() {
    return this.data;
  }

  pruneHistory() {
    const days = Number(this.data.settings.historyDays) || 30;
    const cutoff = Date.now() - days * 86400_000;
    this.data.history = this.data.history.filter((h) => h.time >= cutoff);
  }

  // ---------- 客户编号 ----------
  formatCode(n) {
    const c = this.data.settings.code;
    return (c.prefixEnabled ? c.prefix || '' : '') + String(n);
  }

  activeTemplate() {
    const st = this.data.settings;
    return st.templates.find((t) => t.id === st.activeTemplate) || st.templates[0];
  }

  /**
   * 同一个用户名永远拿同一个编号。新用户：
   *  - increment 递增：从 nextCode 往后找第一个没被占用的，超过位数上限从 1 重新开始
   *  - fill 补缺：从 1 开始找最小的空号（删掉的编号会被重新使用）
   */
  customerCode(uniqueId, nickname, mode) {
    return this.allocate(uniqueId, nickname, mode).code;
  }

  /** @returns {{code:number, isNew:boolean}} isNew：这个用户第一次分配编号（新客户） */
  allocate(uniqueId, nickname, mode = this.data.settings.code.mode) {
    const existing = this.data.customers[uniqueId];
    if (existing) {
      if (nickname && existing.nickname !== nickname) {
        existing.nickname = nickname;
        this.save();
      }
      return { code: existing.code, isNew: false };
    }
    const max = 10 ** (Number(this.data.settings.code.maxDigits) || 4) - 1;
    const used = new Set(Object.values(this.data.customers).map((c) => c.code));
    let n;
    if (mode === 'fill') {
      n = 1;
      while (n <= max && used.has(n)) n++;
      if (n > max) n = 1;
      if (n >= this.data.counters.nextCode) this.data.counters.nextCode = n + 1;
    } else {
      n = this.data.counters.nextCode;
      for (let i = 0; i < max && (n > max || used.has(n)); i++) n = n > max ? 1 : n + 1;
      if (n > max) n = 1;
      this.data.counters.nextCode = n + 1;
    }
    this.data.customers[uniqueId] = { code: n, nickname: nickname || '', addedAt: Date.now() };
    this.save();
    return { code: n, isNew: true };
  }

  /** 共享模式下从主机拿到的编号，缓存到本地方便查看 */
  rememberCustomer(uniqueId, nickname, code) {
    const c = this.data.customers[uniqueId];
    if (c) Object.assign(c, { code, nickname: nickname || c.nickname });
    else this.data.customers[uniqueId] = { code, nickname: nickname || '', addedAt: Date.now() };
    this.save();
  }

  /**
   * 导入客户编号。rows: [{uniqueId, nickname, code}]
   * mode: 'overwrite' 已有客户用表里的编号覆盖 | 'skip' 已有客户不动，只加新客户
   * 编号里的非数字（如序号头 A123）会去掉。导入后「下一个编号」排到最大编号之后，避免撞号。
   */
  importCustomers(rows, mode = 'overwrite') {
    const res = { added: 0, updated: 0, skipped: 0, invalid: 0, conflicts: [] };
    const max = 10 ** (Number(this.data.settings.code.maxDigits) || 4) - 1;
    const seen = new Set();
    for (const r of rows) {
      const uid = String(r.uniqueId || '').trim();
      const code = parseInt(String(r.code ?? '').replace(/\D+/g, ''), 10);
      if (!uid || !(code > 0) || code > max * 100 || seen.has(uid)) {
        res.invalid++;
        continue;
      }
      seen.add(uid);
      const c = this.data.customers[uid];
      if (c) {
        if (mode === 'skip' || c.code === code) {
          res.skipped++;
          continue;
        }
        c.code = code;
        if (r.nickname) c.nickname = String(r.nickname);
        res.updated++;
      } else {
        this.data.customers[uid] = { code, nickname: String(r.nickname || ''), addedAt: Date.now() };
        res.added++;
      }
    }
    // 编号重复检查（两个人同一个编号）
    const byCode = new Map();
    for (const [uid, c] of Object.entries(this.data.customers)) {
      if (!byCode.has(c.code)) byCode.set(c.code, []);
      byCode.get(c.code).push(uid);
    }
    for (const [code, users] of byCode) if (users.length > 1) res.conflicts.push({ code, users });
    const maxCode = Math.max(0, ...Object.values(this.data.customers).map((c) => c.code));
    if (this.data.counters.nextCode <= maxCode) this.data.counters.nextCode = maxCode + 1;
    this.save();
    return res;
  }

  listCustomers() {
    return Object.entries(this.data.customers)
      .map(([uniqueId, c]) => ({ uniqueId, ...c }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  setCustomerCode(uniqueId, code) {
    const c = this.data.customers[uniqueId];
    if (c) c.code = Number(code);
    this.save();
  }

  deleteCustomers(ids) {
    for (const id of ids) delete this.data.customers[id];
    this.save();
  }

  resetCustomers() {
    this.data.customers = {};
    this.data.counters.nextCode = 1;
    this.save();
  }

  setNextCode(n) {
    this.data.counters.nextCode = Math.max(1, Number(n) || 1);
    this.save();
  }

  // ---------- 流水 ----------
  nextSerial() {
    this.data.counters.serial += 1;
    this.save();
    return this.data.counters.serial;
  }

  resetSerial() {
    this.data.counters.serial = 0;
    this.save();
  }

  // ---------- 订单备注 ----------
  markNoted(orderId, entry) {
    this.data.shopNoted[String(orderId)] = { ...entry, time: Date.now() };
    this.save();
  }

  /** 已经用过的扣号记录：记录 id → 订单号 */
  usedRecords() {
    const m = new Map();
    for (const [oid, e] of Object.entries(this.data.shopNoted)) for (const id of e.recIds || []) m.set(id, oid);
    return m;
  }

  pruneShopNoted(days = 45) {
    const cut = Date.now() - days * 86400000;
    for (const [k, v] of Object.entries(this.data.shopNoted)) if (!v || v.time < cut) delete this.data.shopNoted[k];
  }

  // ---------- 打印历史 ----------
  addHistory(rec) {
    const item = { id: this.data.counters.nextHistoryId++, ...rec };
    this.data.history.push(item);
    this.byId.set(item.id, item);
    this.persist(item);
    this.save(); // 计数器在 data.json
    return item;
  }

  /** 更新一条记录（patch 可以为空：调用方已直接改了对象，只需要落盘） */
  updateHistory(id, patch) {
    const item = this.byId.get(id);
    if (item) {
      Object.assign(item, patch);
      this.persist(item);
    }
    return item;
  }

  getHistory(id) {
    return this.byId.get(id);
  }

  queryHistory(q = {}) {
    const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
    const inc = (field, v) => String(field ?? '').toLowerCase().includes(String(v).trim().toLowerCase());
    let list = this.data.history.filter((h) => {
      if (has(q.from) && h.time < Number(q.from)) return false;
      if (has(q.to) && h.time > Number(q.to)) return false;
      if (q.status === 'cancelled') {
        if (!h.cancelled) return false;
      } else if (has(q.status) && q.status !== 'all' && h.status !== q.status) return false;
      if (has(q.sessionId) && h.sessionId !== q.sessionId) return false;
      if (has(q.uniqueId) && !inc(h.uniqueId, q.uniqueId)) return false;
      if (has(q.nickname) && !inc(h.nickname, q.nickname)) return false;
      if (has(q.content)) {
        if (q.exact ? String(h.content) !== String(q.content).trim() : !inc(h.content, q.content)) return false;
      }
      if (has(q.code) && String(h.code) !== String(q.code).trim()) return false;
      if (has(q.serial) && String(h.serial) !== String(q.serial).trim()) return false;
      return true;
    });
    list = list.slice().reverse();
    return { total: list.length, rows: list.slice(0, Number(q.limit) || 1000) };
  }

  clearHistory() {
    this.data.history = [];
    this.byId.clear();
    this.compactHistory();
  }

  // ---------- 黑名单 / 白名单（kind = 'blacklist' | 'whitelist'） ----------
  listOf(kind) {
    return kind === 'whitelist' ? this.data.whitelist : this.data.blacklist;
  }

  inList(kind, uniqueId) {
    return this.listOf(kind).some((b) => b.uniqueId === uniqueId);
  }

  isBlacklisted(uniqueId) {
    return this.inList('blacklist', uniqueId);
  }

  /** 按当前名单模式判断这个用户能不能打印；返回原因或 '' */
  blockReason(uniqueId) {
    if (this.data.settings.listMode === 'whitelist') return this.inList('whitelist', uniqueId) ? '' : $t('不在白名单');
    return this.isBlacklisted(uniqueId) ? $t('黑名单') : '';
  }

  addToList(kind, uniqueId, nickname = '', note = '') {
    if (!uniqueId || this.inList(kind, uniqueId)) return false;
    this.listOf(kind).unshift({ uniqueId, nickname, note, addedAt: Date.now() });
    this.save();
    return true;
  }

  addBlacklist(uniqueId, nickname, note) {
    return this.addToList('blacklist', uniqueId, nickname, note);
  }

  noteInList(kind, uniqueId, note) {
    const b = this.listOf(kind).find((x) => x.uniqueId === uniqueId);
    if (b) b.note = note;
    this.save();
  }

  removeFromList(kind, uniqueId) {
    const list = this.listOf(kind);
    const i = list.findIndex((b) => b.uniqueId === uniqueId);
    if (i >= 0) list.splice(i, 1);
    this.save();
  }

  // ---------- 商品 ----------
  /** 商品编号和弹幕号码对应：弹幕 "15" → 编号 "15" 的商品 */
  findProduct(number) {
    if (number == null) return null;
    const key = String(number);
    return this.data.products.find((p) => String(p.code).trim() === key) || null;
  }

  upsertProduct(p) {
    const code = String(p.code ?? '').trim();
    if (!code) throw new Error($t('商品编号不能为空'));
    const item = {
      code,
      name: String(p.name ?? '').trim(),
      price: p.price === '' || p.price == null ? null : Number(p.price),
      stock: p.stock === '' || p.stock == null ? null : Math.max(0, Math.floor(Number(p.stock))),
      spec: String(p.spec ?? '').trim(),
      updatedAt: Date.now(),
    };
    const i = this.data.products.findIndex((x) => String(x.code) === (p.originalCode ?? code));
    if (i >= 0) this.data.products[i] = { ...this.data.products[i], ...item };
    else this.data.products.push({ ...item, sold: 0, addedAt: Date.now() });
    this.save();
    return item;
  }

  deleteProducts(codes) {
    const set = new Set(codes.map(String));
    this.data.products = this.data.products.filter((p) => !set.has(String(p.code)));
    this.save();
  }

  /** 卖出一件：库存 -1（不限库存时只计数） */
  sellProduct(code) {
    const p = this.findProduct(code);
    if (!p) return null;
    p.sold = (p.sold || 0) + 1;
    if (p.stock != null) p.stock = Math.max(0, p.stock - 1);
    this.save();
    return p;
  }

  importProducts(rows, replace) {
    if (replace) this.data.products = [];
    let n = 0;
    for (const r of rows) {
      try {
        this.upsertProduct(r);
        n++;
      } catch {
        /* 跳过没有编号的行 */
      }
    }
    return n;
  }

  // ---------- 场次 ----------
  currentSession() {
    const s = this.data.sessions[this.data.sessions.length - 1];
    return s && !s.endAt ? s : null;
  }

  /** 没有进行中的场次就自动开一场（第一次命中时调用） */
  ensureSession() {
    return this.currentSession() || this.startSession();
  }

  startSession(name) {
    const cur = this.currentSession();
    if (cur) cur.endAt = Date.now();
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const sess = {
      id: 's' + Date.now().toString(36),
      name: String(name || '').trim() || $t('{0}-{1} {2}:{3} 场', p(d.getMonth() + 1), p(d.getDate()), p(d.getHours()), p(d.getMinutes())),
      startAt: Date.now(),
      endAt: null,
    };
    this.data.sessions.push(sess);
    if (this.data.sessions.length > 500) this.data.sessions.splice(0, this.data.sessions.length - 500);
    if (this.data.settings.session.resetSerial) this.data.counters.serial = 0;
    this.save();
    return sess;
  }

  endSession() {
    const cur = this.currentSession();
    if (cur) cur.endAt = Date.now();
    this.save();
    return cur;
  }

  renameSession(id, name) {
    const s = this.data.sessions.find((x) => x.id === id);
    if (s && String(name).trim()) s.name = String(name).trim();
    this.save();
  }

  listSessions() {
    const count = new Map();
    for (const h of this.data.history) if (h.sessionId && !h.cancelled && h.code != null) count.set(h.sessionId, (count.get(h.sessionId) || 0) + 1);
    return this.data.sessions
      .map((x) => ({ ...x, orders: count.get(x.id) || 0 }))
      .reverse();
  }

  // ---------- 取消订单 ----------
  /** 找到用户最近一单（可指定号码），只在 minutes 分钟内 */
  findCancelTarget(uniqueId, number, minutes) {
    const since = Date.now() - (Number(minutes) || 120) * 60_000;
    for (let i = this.data.history.length - 1; i >= 0; i--) {
      const h = this.data.history[i];
      if (h.time < since) break;
      if (h.uniqueId !== uniqueId || h.cancelled) continue;
      if (number != null && Number(h.number) !== Number(number)) continue;
      return h;
    }
    return null;
  }

  cancelRecord(id, by = 'manual') {
    const h = this.getHistory(id);
    if (!h || h.cancelled) return h;
    h.cancelled = true;
    h.cancelledAt = Date.now();
    h.cancelledBy = by;
    if (h.productCode != null) {
      const p = this.findProduct(h.productCode);
      if (p) {
        if (p.stock != null) p.stock += 1;
        p.sold = Math.max(0, (p.sold || 0) - 1);
      }
    }
    this.persist(h);
    this.save();
    return h;
  }

  restoreRecord(id) {
    const h = this.getHistory(id);
    if (!h || !h.cancelled) return h;
    h.cancelled = false;
    delete h.cancelledAt;
    delete h.cancelledBy;
    if (h.productCode != null) this.sellProduct(h.productCode);
    this.persist(h);
    this.save();
    return h;
  }

  // ---------- 发货汇总（对照表） ----------
  /** 按客户汇总订单：同一个人的多个号码 / 商品合并到一行 */
  summary({ sessionId, from, to } = {}) {
    const rows = this.data.history.filter((h) => {
      if (h.cancelled || h.code == null) return false;
      if (sessionId) return h.sessionId === sessionId;
      return h.time >= (Number(from) || 0) && h.time <= (Number(to) || Date.now() + 60_000);
    });
    const map = new Map();
    for (const r of rows) {
      let c = map.get(r.uniqueId);
      if (!c) {
        c = { uniqueId: r.uniqueId, nickname: r.nickname, code: r.code, codeText: r.codeText, isNew: false, items: [], qty: 0, total: 0, firstTime: r.time, lastTime: r.time, recordIds: [] };
        map.set(r.uniqueId, c);
      }
      c.nickname = r.nickname || c.nickname;
      c.codeText = r.codeText || c.codeText;
      c.isNew = c.isNew || !!r.isNew;
      c.lastTime = r.time;
      c.recordIds.push(r.id);
      const label = r.auction ? $t('竞拍 {0}', r.amount) : r.productName ? `${r.content} ${r.productName}${r.spec ? '(' + r.spec + ')' : ''}` : String(r.content);
      const price = Number(r.price ?? r.amount) || 0;
      const item = c.items.find((i) => i.label === label && i.price === price);
      if (item) item.count += 1;
      else c.items.push({ label, price, count: 1 });
      c.qty += 1;
      c.total += price;
    }
    const customers = [...map.values()].sort((a, b) => (a.code ?? 1e9) - (b.code ?? 1e9));
    for (const c of customers) c.itemsText = c.items.map((i) => (i.count > 1 ? `${i.label}×${i.count}` : i.label)).join($t('，'));
    return {
      customers,
      totals: { customers: customers.length, qty: rows.length, amount: customers.reduce((a, c) => a + c.total, 0) },
    };
  }

  // ---------- 统计 ----------
  stats(from, to) {
    const rows = this.data.history.filter((h) => h.time >= from && h.time <= to && h.code != null && !h.cancelled);
    const buyers = new Map();
    const numbers = new Map();
    const hours = new Array(24).fill(0);
    let amount = 0;
    let newCount = 0;
    for (const r of rows) {
      const v = Number(r.price ?? r.amount) || 0;
      amount += v;
      if (r.isNew) newCount++;
      const b = buyers.get(r.uniqueId) || { uniqueId: r.uniqueId, nickname: r.nickname, codeText: r.codeText, count: 0, amount: 0 };
      b.count += 1;
      b.amount += v;
      b.nickname = r.nickname || b.nickname;
      buyers.set(r.uniqueId, b);
      const key = r.productName ? `${r.content} ${r.productName}` : String(r.content);
      numbers.set(key, (numbers.get(key) || 0) + 1);
      hours[new Date(r.time).getHours()] += 1;
    }
    return {
      orders: rows.length,
      buyers: buyers.size,
      newBuyers: newCount,
      amount,
      failed: rows.filter((r) => r.status === 'fail').length,
      hours,
      topBuyers: [...buyers.values()].sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, 10),
      topNumbers: [...numbers.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  // ---------- 备份 ----------
  replaceAll(raw) {
    if (!raw || typeof raw !== 'object' || !raw.settings) throw new Error($t('不是有效的备份文件'));
    const tmp = this.file + '.restore';
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, this.file);
    // 备份里带着 history：删掉日志文件，下次启动从 data.json 迁移
    try {
      fs.unlinkSync(this.historyFile);
    } catch {
      /* ignore */
    }
  }

  snapshot() {
    return {
      settings: this.data.settings,
      counters: this.data.counters,
      blacklistCount: this.data.blacklist.length,
      whitelistCount: this.data.whitelist.length,
      productCount: this.data.products.length,
      customerCount: Object.keys(this.data.customers).length,
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS, defaultTemplate, uid };
