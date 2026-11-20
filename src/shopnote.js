'use strict';
const { t: $t } = require('./i18n/i18n');
// TikTok Shop 订单备注：订单 ↔ 扣号记录匹配 + 备注模板（纯逻辑，不依赖 Electron，方便测试）
//
// 卖家后台的订单只给打码后的买家用户名，如 "p*********5"（首字母 + 尾字母 + 总长度）。
// 匹配方法：在下单时间前后的时间窗内，找用户名能对上这个打码格式的扣号记录。

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
 * orders:  [{ id, createTime(ms), buyer(打码用户名), amount, amountText }]
 * records: 扣号记录 [{ id, time, uniqueId, nickname, code, codeText, serial, content, note, cancelled }]
 * opt: { template, backMin, fwdMin, serial: 'all'|'min'|'max', allowRepeat, merge, used: Set(recordId) }
 * 返回 [{ orderId, status: 'ok'|'nomatch'|'ambiguous'|'used', note, user, nickname, code, recIds, candidates, merged }]
 */
function planNotes(orders, records, opt = {}) {
  const back = (Number(opt.backMin) || 0) * 60000;
  const fwd = (Number(opt.fwdMin) || 0) * 60000;
  // used：Set(记录id) 或 Map(记录id → 用过它的订单号)；同一张订单自己用过的不算
  const usedMap = opt.used instanceof Map ? new Map(opt.used) : new Map([...(opt.used || [])].map((id) => [id, null]));
  const isUsed = (rid, oid) => usedMap.has(rid) && usedMap.get(rid) !== oid;
  const live = records.filter((r) => r && !r.cancelled && r.uniqueId && r.status !== 'blocked');
  const plans = [];
  // 按下单时间先后处理：不合并、不允许重复时，前一张订单用掉的扣号，后一张不再用
  const sorted = orders.slice().sort((a, b) => a.createTime - b.createTime);
  for (const o of sorted) {
    const from = o.createTime - back;
    const to = o.createTime + fwd;
    const hits = live.filter((r) => r.time >= from && r.time <= to && maskMatch(o.buyer, r.uniqueId));
    const users = uniq(hits.map((r) => r.uniqueId));
    const base = { orderId: o.id, order: o, note: '', user: '', nickname: '', code: null, recIds: [], candidates: users };
    if (!users.length) {
      plans.push({ ...base, status: 'nomatch' });
      continue;
    }
    if (users.length > 1) {
      plans.push({ ...base, status: 'ambiguous' });
      continue;
    }
    let mine = hits.sort((a, b) => a.time - b.time || a.id - b.id);
    if (!opt.allowRepeat) mine = mine.filter((r) => !isUsed(r.id, o.id));
    if (!mine.length) {
      plans.push({ ...base, status: 'used', user: users[0], nickname: hits[0].nickname || '', code: hits[0].code });
      continue;
    }
    if (opt.serial === 'min') mine = [mine[0]];
    else if (opt.serial === 'max') mine = [mine[mine.length - 1]];
    plans.push({ ...base, status: 'ok', user: users[0], nickname: mine[0].nickname || '', code: mine[0].code, recIds: mine.map((r) => r.id), recs: mine });
    if (!opt.allowRepeat && !opt.merge) for (const r of mine) usedMap.set(r.id, o.id);
  }
  // 合并订单：同一个买家的多张订单写同一条备注（流水号、弹幕合在一起）
  if (opt.merge) {
    const byUser = new Map();
    for (const p of plans) if (p.status === 'ok') byUser.set(p.user, [...(byUser.get(p.user) || []), p]);
    for (const group of byUser.values()) {
      if (group.length < 2) continue;
      const recs = uniq(group.flatMap((p) => p.recs)).sort((a, b) => a.time - b.time || a.id - b.id);
      for (const p of group) {
        p.recs = recs;
        p.recIds = recs.map((r) => r.id);
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
