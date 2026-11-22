'use strict';
const { t: $t } = require('./i18n/i18n');
// TikTok Shop 订单备注：订单 ↔ 扣号记录匹配 + 备注模板（纯逻辑，不依赖 Electron，方便测试）
//
// 卖家后台的订单只给打码后的买家用户名，如 "p*********5"（首字母 + 尾字母 + 总长度）。
// 匹配方法：拿这个打码格式去客户编号表里找客户 → 客户编号；时间窗内的扣号记录只用来补充字段 / 消除歧义。

/** 打码用户名是否对得上：长度相同，没打码的字符逐个相同（不分大小写） */
function maskMatch(masked, uniqueId) {
  masked = String(masked || '').trim().replace(/^@/, '');
  uniqueId = String(uniqueId || '').trim().replace(/^@/, '');
  if (!masked || !uniqueId) return false;
  const a = [...masked.toLowerCase()];
  const b = [...uniqueId.toLowerCase()];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== '*' && a[i] !== b[i]) return false;
  return true;
}

const NOTE_FIELDS = () => [
  { key: 'accname', label: $t('用户名') },
  { key: 'nickname', label: $t('昵称') },
  { key: 'fixedno', label: $t('客户编号') },
  { key: 'seqno', label: $t('流水序号') },
  { key: 'prtremark', label: $t('主播备注') },
  { key: 'message', label: $t('弹幕信息') },
  { key: 'orderid', label: $t('订单编号') },
  { key: 'ordertime', label: $t('下单时间') },
  { key: 'amount', label: $t('订单金额') },
  { key: 'sortno', label: $t('分拣号') },
];

function pad(n) {
  return String(n).padStart(2, '0');
}
function fmtTime(t) {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 渲染备注模板，如 "【{fixedno}】{accname}" */
function renderNote(tpl, f) {
  return String(tpl || '')
    .replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(f, k) ? String(f[k] ?? '') : m))
    .trim();
}

const uniq = (arr) => [...new Set(arr.filter((x) => x !== undefined && x !== null && String(x) !== ''))];

/** 由订单和命中的扣号记录生成模板字段 */
function noteFields(order, recs) {
  const r0 = recs[0] || {};
  return {
    accname: r0.uniqueId || '',
    nickname: r0.nickname || '',
    fixedno: r0.code ?? '',
    sortno: r0.codeText || r0.code || '',
    seqno: uniq(recs.map((r) => r.serial)).join(','),
    prtremark: uniq(recs.map((r) => r.note)).join(' '),
    message: uniq(recs.map((r) => r.content)).join(','),
    orderid: order.id,
    ordertime: order.createTime ? fmtTime(order.createTime) : '',
    amount: order.amountText || order.amount || '',
  };
}

/**
 * 给一批订单规划备注。
 * 主匹配：订单的打码昵称 → 客户编号表（先按用户名比，对不上再按昵称比）→ 客户编号。
 * 扣号记录只是补充：时间窗内该用户的扣号记录用来填流水序号 / 弹幕等字段；多个客户对得上同一个打码时，
 * 用时间窗内有扣号的那一个来定。
 * orders:    [{ id, createTime(ms), buyer(打码昵称), amount, amountText }]
 * records:   扣号记录 [{ id, time, uniqueId, nickname, code, codeText, serial, content, note, cancelled }]
 * opt: { customers: [{uniqueId, nickname, code}], formatCode(code), template, backMin, fwdMin,
 *        serial: 'all'|'min'|'max', allowRepeat, merge, used: Set(recordId) }
 * 返回 [{ orderId, status: 'ok'|'nomatch'|'ambiguous', note, user, nickname, code, recIds, candidates, merged }]
 */
function planNotes(orders, records, opt = {}) {
  const back = (Number(opt.backMin) || 0) * 60000;
  const fwd = (Number(opt.fwdMin) || 0) * 60000;
  const fmt = opt.formatCode || ((c) => String(c));
  // used：Set(记录id) 或 Map(记录id → 用过它的订单号)；同一张订单自己用过的不算
  const usedMap = opt.used instanceof Map ? new Map(opt.used) : new Map([...(opt.used || [])].map((id) => [id, null]));
  const isUsed = (rid, oid) => usedMap.has(rid) && usedMap.get(rid) !== oid;
  const live = records.filter((r) => r && !r.cancelled && r.uniqueId && r.status !== 'blocked');
  const customers = (opt.customers || []).filter((c) => c && c.uniqueId && c.code !== undefined && c.code !== null);
  const plans = [];
  // 按下单时间先后处理：不合并、不允许重复时，前一张订单用掉的扣号，后一张不再用
  const sorted = orders.slice().sort((a, b) => a.createTime - b.createTime);
  for (const o of sorted) {
    const from = o.createTime - back;
    const to = o.createTime + fwd;
    const inWin = live.filter((r) => r.time >= from && r.time <= to);
    // 1) 客户编号表：用户名对得上的优先，没有再看昵称
    let cands = customers.filter((c) => maskMatch(o.buyer, c.uniqueId));
    if (!cands.length) cands = customers.filter((c) => maskMatch(o.buyer, c.nickname));
    // 2) 时间窗内有扣号、但还不在客户表里的用户（理论上很少）也算候选
    for (const r of inWin) {
      if (!cands.some((c) => c.uniqueId === r.uniqueId) && (maskMatch(o.buyer, r.uniqueId) || maskMatch(o.buyer, r.nickname))) {
        cands.push({ uniqueId: r.uniqueId, nickname: r.nickname || '', code: r.code });
      }
    }
    const base = { orderId: o.id, order: o, note: '', user: '', nickname: '', code: null, recIds: [], candidates: cands.map((c) => c.uniqueId) };
    if (!cands.length) {
      plans.push({ ...base, status: 'nomatch' });
      continue;
    }
    // 多个客户对得上：只保留时间窗内扣过号的
    if (cands.length > 1) {
      const active = cands.filter((c) => inWin.some((r) => r.uniqueId === c.uniqueId));
      if (active.length !== 1) {
        plans.push({ ...base, status: 'ambiguous', candidates: (active.length ? active : cands).map((c) => c.uniqueId) });
        continue;
      }
      cands = active;
    }
    const cust = cands[0];
    let mine = inWin.filter((r) => r.uniqueId === cust.uniqueId).sort((a, b) => a.time - b.time || a.id - b.id);
    if (!opt.allowRepeat) mine = mine.filter((r) => !isUsed(r.id, o.id));
    if (opt.serial === 'min') mine = mine.slice(0, 1);
    else if (opt.serial === 'max') mine = mine.slice(-1);
    // 客户编号以客户表为准；没有扣号记录时，用客户表信息补一条“虚拟记录”给模板用
    const head = { uniqueId: cust.uniqueId, nickname: cust.nickname || (mine[0] && mine[0].nickname) || '', code: cust.code, codeText: fmt(cust.code) };
    const recs = mine.length ? mine.map((r, i) => (i === 0 ? { ...r, ...head } : r)) : [head];
    plans.push({ ...base, status: 'ok', user: cust.uniqueId, nickname: head.nickname, code: cust.code, recIds: mine.map((r) => r.id), recs });
    if (!opt.allowRepeat && !opt.merge) for (const r of mine) usedMap.set(r.id, o.id);
  }
  // 合并订单：同一个买家的多张订单写同一条备注（流水号、弹幕合在一起）
  if (opt.merge) {
    const byUser = new Map();
    for (const p of plans) if (p.status === 'ok') byUser.set(p.user, [...(byUser.get(p.user) || []), p]);
    for (const group of byUser.values()) {
      if (group.length < 2) continue;
      const all = group.flatMap((p) => p.recs);
      const real = [...new Map(all.filter((r) => r.id !== undefined).map((r) => [r.id, r])).values()].sort((a, b) => a.time - b.time || a.id - b.id);
      const head = all[0];
      const recs = real.length ? real.map((r, i) => (i === 0 ? { ...r, uniqueId: head.uniqueId, nickname: head.nickname, code: head.code, codeText: head.codeText } : r)) : [head];
      for (const p of group) {
        p.recs = recs;
        p.recIds = real.map((r) => r.id);
        p.merged = group.length;
      }
    }
  }
  for (const p of plans) {
    if (p.status !== 'ok') continue;
    p.note = renderNote(opt.template || $t('【{fixedno}】{accname}'), noteFields(p.order, p.recs)).slice(0, 500);
    delete p.recs;
  }
  return plans;
}

/** 追加模式：已有备注里已经包含这段内容就不重复写 */
function combineNote(oldText, newText, mode) {
  oldText = String(oldText || '').trim();
  newText = String(newText || '').trim();
  if (mode !== 'append' || !oldText) return newText;
  if (oldText.includes(newText)) return oldText;
  return `${oldText} ${newText}`.slice(0, 500);
}

module.exports = { maskMatch, renderNote, noteFields, planNotes, combineNote, NOTE_FIELDS, fmtTime };
