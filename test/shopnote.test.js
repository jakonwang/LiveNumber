'use strict';
const assert = require('node:assert');
const { maskMatch, renderNote, planNotes, combineNote } = require('../src/shopnote');

let n = 0;
const t = (name, fn) => {
  fn();
  n++;
};

t('maskMatch：首尾字母 + 长度', () => {
  assert.ok(maskMatch('p*********5', 'phuong12345'));
  assert.ok(maskMatch('P*********5', '@phuong12345'));
  assert.ok(!maskMatch('p*********5', 'phuong1234')); // 长度不同
  assert.ok(!maskMatch('p*********5', 'xhuong12345'));
  assert.ok(!maskMatch('p*********5', 'phuong12346'));
  assert.ok(maskMatch('buyer_demo', 'buyer_demo')); // 没打码就精确比
  assert.ok(!maskMatch('', 'a'));
  assert.ok(maskMatch('1******e', '1abcdeee'));
});

t('renderNote：模板字段，未知字段原样保留', () => {
  assert.strictEqual(renderNote('【{fixedno}】{accname}', { fixedno: 1271, accname: 'buyer_demo' }), '【1271】buyer_demo');
  assert.strictEqual(renderNote('{x}-{fixedno}', { fixedno: 3 }), '{x}-3');
});

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const min = 60000;
const rec = (id, uniqueId, dt, extra = {}) => ({ id, uniqueId, nickname: uniqueId.toUpperCase(), time: T0 + dt, code: 10 + id, codeText: 'A' + (10 + id), serial: id, content: String(id * 5), note: '', ...extra });
const order = (id, buyer, dt = 0) => ({ id, buyer, createTime: T0 + dt, amount: 39200, amountText: '39.200₫' });

t('planNotes：时间窗内匹配、超出窗口不匹配', () => {
  const recs = [rec(1, 'phuong12345', -3 * min), rec(2, 'phuong12345', -20 * min)];
  const [p] = planNotes([order('o1', 'p*********5')], recs, { backMin: 5, fwdMin: 0 });
  assert.strictEqual(p.status, 'ok');
  assert.deepStrictEqual(p.recIds, [1]);
  assert.strictEqual(p.note, '【11】phuong12345');
  const [q] = planNotes([order('o1', 'p*********5')], recs, { backMin: 30 });
  assert.deepStrictEqual(q.recIds, [2, 1]); // 全部，按时间
  const [after] = planNotes([order('o1', 'p*********5', -10 * min)], [rec(1, 'phuong12345', -8 * min)], { backMin: 0, fwdMin: 0 });
  assert.strictEqual(after.status, 'nomatch');
  const [after2] = planNotes([order('o1', 'p*********5', -10 * min)], [rec(1, 'phuong12345', -8 * min)], { backMin: 0, fwdMin: 5 });
  assert.strictEqual(after2.status, 'ok');
});

t('planNotes：多人对上同一个打码 → ambiguous；取消的不算', () => {
  const recs = [rec(1, 'phuong12345', -1 * min), rec(2, 'pxxxxxxxxx5', -2 * min)];
  const [p] = planNotes([order('o1', 'p*********5')], recs, { backMin: 5 });
  assert.strictEqual(p.status, 'ambiguous');
  assert.strictEqual(p.candidates.length, 2);
  recs[1].cancelled = true;
  assert.strictEqual(planNotes([order('o1', 'p*********5')], recs, { backMin: 5 })[0].status, 'ok');
});

t('planNotes：流水策略 min / max / all，seqno 和 message', () => {
  const recs = [rec(1, 'phuong12345', -4 * min), rec(2, 'phuong12345', -2 * min), rec(3, 'phuong12345', -1 * min)];
  const o = [order('o1', 'p*********5')];
  const tpl = '{seqno}|{message}';
  assert.strictEqual(planNotes(o, recs, { backMin: 5, serial: 'min', template: tpl })[0].note, '1|5');
  assert.strictEqual(planNotes(o, recs, { backMin: 5, serial: 'max', template: tpl })[0].note, '3|15');
  assert.strictEqual(planNotes(o, recs, { backMin: 5, serial: 'all', template: tpl })[0].note, '1,2,3|5,10,15');
});

t('planNotes：不允许重复 → 别的订单用过的记录跳过；自己用过的仍可用', () => {
  const recs = [rec(1, 'phuong12345', -1 * min)];
  const o = [order('o2', 'p*********5')];
  const usedElsewhere = planNotes(o, recs, { backMin: 5, used: new Map([[1, 'o1']]) })[0];
  assert.strictEqual(usedElsewhere.status, 'ok'); // 客户编号照样能写，只是不带这条扣号的流水
  assert.deepStrictEqual(usedElsewhere.recIds, []);
  assert.strictEqual(usedElsewhere.code, 11);
  assert.deepStrictEqual(planNotes(o, recs, { backMin: 5, used: new Map([[1, 'o2']]) })[0].recIds, [1]);
  assert.strictEqual(planNotes(o, recs, { backMin: 5, used: new Map([[1, 'o1']]), allowRepeat: true })[0].status, 'ok');
});

t('planNotes：同批两张订单，不合并时前一张用掉的后一张不用', () => {
  const recs = [rec(1, 'phuong12345', -1 * min), rec(2, 'phuong12345', 1 * min)];
  const orders = [order('o2', 'p*********5', 2 * min), order('o1', 'p*********5', 0)];
  const plans = planNotes(orders, recs, { backMin: 5, merge: false });
  const by = Object.fromEntries(plans.map((p) => [p.orderId, p]));
  assert.deepStrictEqual(by.o1.recIds, [1]);
  assert.deepStrictEqual(by.o2.recIds, [2]);
});

t('planNotes：合并模式 → 同一买家的订单同一条备注', () => {
  const recs = [rec(1, 'phuong12345', -1 * min), rec(2, 'phuong12345', 1 * min)];
  const orders = [order('o1', 'p*********5', 0), order('o2', 'p*********5', 2 * min)];
  const plans = planNotes(orders, recs, { backMin: 5, merge: true, template: '{fixedno}/{seqno}' });
  assert.strictEqual(plans[0].note, plans[1].note);
  assert.strictEqual(plans[0].note, '11/1,2');
  assert.strictEqual(plans[0].merged, 2);
});

t('planNotes：按客户编号表匹配（不需要扣号记录）', () => {
  const customers = [
    { uniqueId: 'kimanh_9902', nickname: 'Kim Anh', code: 333 },
    { uniqueId: 'phuong12345', nickname: 'Phương', code: 7 },
  ];
  const [p] = planNotes([order('o1', 'k*********2')], [], { customers, formatCode: (c) => 'A' + c, template: '【{fixedno}】{accname}|{nickname}|{sortno}|{seqno}' });
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.code, 333);
  assert.strictEqual(p.note, '【333】kimanh_9902|Kim Anh|A333|');
  // 用户名对不上时按昵称匹配
  const [q] = planNotes([order('o1', 'K*****h')], [], { customers });
  assert.strictEqual(q.code, 333);
  // 客户表里没有
  assert.strictEqual(planNotes([order('o1', 'z***9')], [], { customers })[0].status, 'nomatch');
});

t('planNotes：客户表多人对得上 → 用时间窗内的扣号定人；客户编号以客户表为准', () => {
  const customers = [
    { uniqueId: 'phuong12345', nickname: 'P1', code: 7 },
    { uniqueId: 'pxxxxxxxxx5', nickname: 'P2', code: 8 },
  ];
  assert.strictEqual(planNotes([order('o1', 'p*********5')], [], { customers })[0].status, 'ambiguous');
  const recs = [rec(1, 'pxxxxxxxxx5', -1 * min)]; // 记录里的 code 是 11，客户表是 8
  const [p] = planNotes([order('o1', 'p*********5')], recs, { customers, backMin: 5, template: '{fixedno}/{seqno}/{message}' });
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.note, '8/1/5');
});

t('planNotes：时间窗内定不了人 → 看下单前 24 小时谁扣过号', () => {
  const customers = [
    { uniqueId: 'phuong12345', nickname: 'P1', code: 7 },
    { uniqueId: 'pxxxxxxxxx5', nickname: 'P2', code: 8 },
    { uniqueId: 'pyyyyyyyyy5', nickname: 'P3', code: 9 },
  ];
  const o = [order('o1', 'p*********5')];
  // 只有 P2 在 1 小时前扣过号（超出 5 分钟回溯） → 定为 P2
  assert.strictEqual(planNotes(o, [rec(1, 'pxxxxxxxxx5', -60 * min)], { customers, backMin: 5 })[0].code, 8);
  // 两人都在 24 小时内扣过号，5 分钟内只有 P3 → P3
  assert.strictEqual(planNotes(o, [rec(1, 'pxxxxxxxxx5', -60 * min), rec(2, 'pyyyyyyyyy5', -2 * min)], { customers, backMin: 5 })[0].code, 9);
  // 两人都只在 24 小时内扣过号 → 仍然多人对得上
  const amb = planNotes(o, [rec(1, 'pxxxxxxxxx5', -60 * min), rec(2, 'pyyyyyyyyy5', -30 * min)], { customers, backMin: 5 })[0];
  assert.strictEqual(amb.status, 'ambiguous');
  assert.strictEqual(amb.candidates.length, 2);
  // 先下单、10 分钟后才扣号 → 也能定人；3 小时后的不算
  assert.strictEqual(planNotes(o, [rec(1, 'pxxxxxxxxx5', 10 * min)], { customers, backMin: 5 })[0].code, 8);
  assert.strictEqual(planNotes(o, [rec(1, 'pxxxxxxxxx5', 180 * min)], { customers, backMin: 5 })[0].status, 'ambiguous');
  // 超过 24 小时的不算
  assert.strictEqual(planNotes(o, [rec(1, 'pxxxxxxxxx5', -25 * 60 * min)], { customers, backMin: 5 })[0].status, 'ambiguous');
});

t('combineNote：覆盖 / 追加 / 不重复追加', () => {
  assert.strictEqual(combineNote('old', 'new', 'overwrite'), 'new');
  assert.strictEqual(combineNote('old', 'new', 'append'), 'old new');
  assert.strictEqual(combineNote('old new', 'new', 'append'), 'old new');
  assert.strictEqual(combineNote('', 'new', 'append'), 'new');
});

console.log(`shopnote.test.js：${n} 项通过`);
