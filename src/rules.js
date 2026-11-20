'use strict';
const { t: $t } = require('./i18n/i18n');
// 纯逻辑：弹幕匹配 + 抢单窗口。不依赖 Electron，方便单元测试。

const FULLWIDTH_DIGITS = /[０-９]/g;

function normalize(text) {
  return String(text || '')
    .replace(FULLWIDTH_DIGITS, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .trim();
}

function parseNumberList(str) {
  return String(str || '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      const m = s.match(/^(\d+)-(\d+)$/);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        const out = [];
        for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 10000; i++) out.push(i);
        return out;
      }
      return /^\d+$/.test(s) ? [Number(s)] : [];
    });
}

function numberAllowed(n, monitor) {
  switch (monitor.limitMode) {
    case 'range':
      return n >= Number(monitor.min) && n <= Number(monitor.max);
    case 'specific':
      return parseNumberList(monitor.specific).includes(n);
    case 'none':
    default:
      return true;
  }
}

/**
 * 判断一条弹幕是否命中监控规则。
 * @returns {null | {key: string, content: string, number: number|null}}
 */
function matchComment(comment, monitor) {
  const text = normalize(comment);
  if (!text) return null;

  if (monitor.pureNumber) {
    // 「15」「#15」「15.」「15!!」「15 15」都算纯数字（重复同一个号码也算）
    const t = text.replace(/[\s.!。！~～,，、]+$/u, '').replace(/^#\s*/, '');
    let m = t.match(/^(\d{1,6})$/);
    if (!m) {
      const rep = t.match(/^(\d{1,6})(?:\s+\1)+$/);
      if (rep) m = rep;
    }
    if (m) {
      const n = Number(m[1]);
      if (numberAllowed(n, monitor)) return { key: String(n), content: String(n), number: n };
    }
  }

  if (monitor.numberWithText) {
    const m = text.match(/(?:^|\D)(\d{1,6})(?!\d)/);
    if (m) {
      const n = Number(m[1]);
      if (numberAllowed(n, monitor)) return { key: String(n), content: text, number: n };
    }
  }

  if (monitor.keywordEnabled) {
    const words = String(monitor.keywords || '')
      .split(/[,，\n]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const lower = text.toLowerCase();
    const hit = monitor.keywordExact
      ? words.find((w) => lower === w.toLowerCase())
      : words.find((w) => lower.includes(w.toLowerCase()));
    if (hit) return { key: 'kw:' + hit.toLowerCase(), content: text, number: null };
  }

  return null;
}

/**
 * 抢单引擎：同一个号码在 seconds 秒内最多 limit 个不同用户抢到。
 * mode = 'unlimited' 时全部放行。
 */
class GrabEngine {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.seq = 0;
    this.windows = new Map(); // key -> {start, users:Set, content}
  }

  offer(user, key, cfg) {
    if (cfg.mode !== 'grab') return { ok: true };
    const limit = Math.max(1, Number(cfg.limit) || 1);
    const ms = Math.max(1, Number(cfg.seconds) || 1) * 1000;
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= ms) {
      w = { start: t, users: new Set(), ms, seq: ++this.seq };
      this.windows.set(key, w);
    }
    if (w.users.has(user)) return { ok: false, reason: $t('重复抢同一号码') };
    if (w.users.size >= limit) return { ok: false, reason: $t('号码已被抢完（限 {0} 位）', limit) };
    w.users.add(user);
    return { ok: true };
  }

  /** 最近仍在倒计时的号码，最多 n 个，用于右侧大数字面板 */
  active(n = 3) {
    const t = this.now();
    const out = [];
    for (const [key, w] of this.windows) {
      const left = Math.ceil((w.start + w.ms - t) / 1000);
      if (left <= 0) {
        this.windows.delete(key);
        continue;
      }
      out.push({ key: key.startsWith("kw:") ? key.slice(3) : key, count: w.users.size, left, seq: w.seq });
    }
    return out.sort((a, b) => b.seq - a.seq).slice(0, n);
  }

  reset() {
    this.windows.clear();
  }

  /** 取消订单时释放名额：这个用户在该号码的抢单位置让出来 */
  release(user, key) {
    const w = this.windows.get(String(key));
    if (w) w.users.delete(user);
  }
}

/**
 * 解析出价："150" → 150；开启 kSuffix 时 "150k" / "1.5k" → 150000 / 1500。
 * allowText：允许 "giá 150k nha" 这样带文字的出价。
 */
function parseBid(comment, { kSuffix = true, allowText = false } = {}) {
  const text = normalize(comment).toLowerCase();
  const re = kSuffix ? /(\d+(?:[.,]\d+)?)\s*(k)?/ : /(\d+)/;
  const m = allowText ? text.match(new RegExp('(?:^|[^\\d])' + re.source + '(?![\\d])')) : text.match(new RegExp('^' + re.source + '$'));
  if (!m) return null;
  let n = Number(m[1].replace(',', '.'));
  if (kSuffix && m[2]) n = Math.round(n * 1000);
  else if (!Number.isInteger(n)) return null; // 没有 k 的小数不算出价
  return n > 0 ? n : null;
}

/**
 * 竞拍引擎：倒计时内收出价，只接受比当前最高价至少高 step 的出价；
 * 时间到后 tick() 返回结果（最高出价者）。
 */
class AuctionEngine {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.state = null; // {startedAt, endsAt, best, count}
  }

  start(cfg) {
    const t = this.now();
    this.state = { startedAt: t, endsAt: t + Math.max(1, Number(cfg.seconds) || 30) * 1000, best: null, count: 0 };
    return this.state;
  }

  cancel() {
    const s = this.state;
    this.state = null;
    return s;
  }

  /** 提前结束：立即结算 */
  finish() {
    if (!this.state) return null;
    this.state.endsAt = this.now();
    return this.tick();
  }

  bid(user, nickname, amount, cfg) {
    if (!this.state) {
      if (cfg.startMode !== 'auto') return { ok: false, reason: $t('竞拍未开始') };
      this.start(cfg);
    }
    const s = this.state;
    const t = this.now();
    if (t >= s.endsAt) return { ok: false, reason: $t('竞拍已结束') };
    const min = Number(cfg.minPrice) || 0;
    const step = Math.max(0, Number(cfg.step) || 0);
    if (amount < min) return { ok: false, reason: $t('低于起拍价 {0}', min) };
    if (s.best && amount < s.best.amount + Math.max(step, 1e-9)) return { ok: false, reason: $t('需高于当前最高价 {0}', s.best.amount) };
    s.best = { user, nickname, amount, time: t };
    s.count += 1;
    const ext = Number(cfg.extendSeconds) || 0;
    if (ext > 0 && s.endsAt - t < ext * 1000) s.endsAt = t + ext * 1000;
    return { ok: true };
  }

  /** 到时间返回 {best, count}，否则 null */
  tick() {
    const s = this.state;
    if (!s || this.now() < s.endsAt) return null;
    this.state = null;
    return { best: s.best, count: s.count, startedAt: s.startedAt };
  }

  status() {
    const s = this.state;
    if (!s) return { active: false };
    return {
      active: true,
      left: Math.max(0, Math.ceil((s.endsAt - this.now()) / 1000)),
      amount: s.best ? s.best.amount : 0,
      leader: s.best ? s.best.nickname || s.best.user : '',
      count: s.count,
    };
  }
}

/**
 * 识别取消订单的弹幕：「hủy」「hủy 15」「取消15」。
 * @returns {null | {number: number|null}} 不是取消弹幕返回 null；number 为要取消的号码（没写号码则 null，表示最近一单）
 */
function matchCancel(comment, keywords) {
  const text = normalize(comment).toLowerCase();
  if (!text) return null;
  const words = String(keywords || '')
    .split(/[,，\n]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const w of words) {
    if (!text.startsWith(w)) continue;
    const rest = text.slice(w.length).trim();
    if (!rest) return { number: null };
    const m = rest.match(/^(?:đơn|don|单|号|#)?\s*(\d{1,6})\s*(?:号)?$/);
    if (m) return { number: Number(m[1]) };
    return null; // 「hủy rồi à」之类不算
  }
  return null;
}

/**
 * 把 WebcastChatMessage 转成 {uniqueId, nickname, comment, msgId}。
 * tiktok-live-connector v2 的 chat 事件给的是原始 proto：内容在 content、用户名在 user.displayId；
 * 旧版 / 文档写的是 comment、user.uniqueId，两种都兼容。
 */
function chatFromWebcast(data) {
  const u = (data && data.user) || {};
  return {
    uniqueId: String(u.uniqueId || u.displayId || ''),
    nickname: String(u.nickname || ''),
    comment: String((data && (data.comment ?? data.content)) || ''),
    msgId: data && data.common && data.common.msgId && data.common.msgId !== '0' ? String(data.common.msgId) : '',
  };
}

/** 第 n 次重连前等待的秒数：10、20、40、80、160，最长 300 秒 */
function retryDelaySeconds(n) {
  return Math.min(300, 10 * 2 ** Math.max(0, n));
}

/**
 * 重复下单判断：同一个用户、同一个号码。
 * rule.mode：
 *  - 'window'  N 秒内重复发同一个号码只算一单（防刷屏，默认）
 *  - 'session' 同一场只算一单
 *  - 'none'    每条都算（同一个人可以买多件）
 * @param {Array<{uniqueId, number, time, sessionId, cancelled}>} recent 最近的订单（新的在后）
 * @returns {null | string} 是重复单就返回原因
 */
function duplicateReason(uniqueId, number, sessionId, recent, rule, now = Date.now()) {
  if (!rule || rule.mode === 'none' || number == null) return null;
  const since = rule.mode === 'window' ? now - Math.max(1, Number(rule.seconds) || 60) * 1000 : -Infinity;
  for (let i = recent.length - 1; i >= 0; i--) {
    const h = recent[i];
    if (h.time < since) break;
    if (h.cancelled || h.uniqueId !== uniqueId || Number(h.number) !== Number(number)) continue;
    if (rule.mode === 'session' && h.sessionId !== sessionId) continue;
    return rule.mode === 'session' ? $t('本场已下过这个号') : $t('{0} 秒内重复下单', rule.seconds);
  }
  return null;
}

module.exports = { duplicateReason, retryDelaySeconds, normalize, parseNumberList, matchComment, GrabEngine, parseBid, AuctionEngine, chatFromWebcast, matchCancel };
