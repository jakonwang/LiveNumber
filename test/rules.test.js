'use strict';
const assert = require('node:assert/strict');
const { retryDelaySeconds, duplicateReason } = require('../src/rules');
const { matchComment, GrabEngine, parseNumberList, parseBid, AuctionEngine, chatFromWebcast, matchCancel } = require('../src/rules');

const base = { pureNumber: true, numberWithText: false, keywordEnabled: false, limitMode: 'range', min: 1, max: 200 };

// 纯数字 + 区间
assert.deepEqual(matchComment('15', base), { key: '15', content: '15', number: 15 });
assert.deepEqual(matchComment(' １２ ', base)?.number, 12);
assert.equal(matchComment('201', base), null);
assert.equal(matchComment('0', base), null);
assert.equal(matchComment('lấy 15', base), null);
assert.equal(matchComment('', base), null);

// 数字+文字
const withText = { ...base, numberWithText: true };
assert.equal(matchComment('lấy 15 nha', withText).number, 15);
assert.equal(matchComment('lấy 15 nha', withText).content, 'lấy 15 nha');
assert.equal(matchComment('size 999', withText), null);

// 不限制 / 特定号码
assert.equal(matchComment('5000', { ...base, limitMode: 'none' }).number, 5000);
assert.equal(matchComment('7', { ...base, limitMode: 'specific', specific: '3,7,10-12' }).number, 7);
assert.equal(matchComment('8', { ...base, limitMode: 'specific', specific: '3,7,10-12' }), null);
assert.deepEqual(parseNumberList('1, 3-5，9'), [1, 3, 4, 5, 9]);

// 关键字
const kw = { ...base, pureNumber: false, keywordEnabled: true, keywords: 'chốt, lấy' };
assert.equal(matchComment('Chốt đơn', kw).key, 'kw:chốt');
assert.equal(matchComment('hello', kw), null);
assert.equal(matchComment('chốt đơn', { ...kw, keywordExact: true }), null);

// 抢单：限 1 位，50 秒内
let now = 0;
const g = new GrabEngine(() => now);
const grab = { mode: 'grab', limit: 1, seconds: 50 };
assert.equal(g.offer('a', '15', grab).ok, true);
assert.equal(g.offer('b', '15', grab).ok, false);
assert.equal(g.offer('a', '15', grab).ok, false);
assert.equal(g.offer('b', '16', grab).ok, true);
assert.equal(g.active()[0].key, '16');
now = 50_000;
assert.equal(g.offer('b', '15', grab).ok, true, '窗口过期后号码重新开放');

// 限 2 位
const g2 = new GrabEngine(() => 0);
const grab2 = { mode: 'grab', limit: 2, seconds: 10 };
assert.equal(g2.offer('a', '1', grab2).ok, true);
assert.equal(g2.offer('b', '1', grab2).ok, true);
assert.equal(g2.offer('c', '1', grab2).ok, false);

// 无限制
assert.equal(new GrabEngine().offer('a', '1', { mode: 'unlimited' }).ok, true);

// 出价解析
assert.equal(parseBid('150'), 150);
assert.equal(parseBid('150k'), 150000);
assert.equal(parseBid('1.5K'), 1500);
assert.equal(parseBid('1,5k'), 1500);
assert.equal(parseBid('1.5'), null);
assert.equal(parseBid('giá 150k nha'), null);
assert.equal(parseBid('giá 150k nha', { allowText: true }), 150000);
assert.equal(parseBid('150k', { kSuffix: false }), null);
assert.equal(parseBid('abc'), null);

// 竞拍：自动开始、加价、延时、结算
{
  let t = 0;
  const a = new AuctionEngine(() => t);
  const cfg = { seconds: 30, startMode: 'auto', minPrice: 10, step: 5, extendSeconds: 10 };
  assert.equal(a.bid('u1', 'A', 5, cfg).ok, false, '低于起拍价');
  assert.equal(a.bid('u1', 'A', 10, cfg).ok, true);
  assert.equal(a.bid('u2', 'B', 12, cfg).ok, false, '加价不足');
  assert.equal(a.bid('u2', 'B', 15, cfg).ok, true);
  assert.equal(a.status().amount, 15);
  t = 25_000;
  assert.equal(a.bid('u3', 'C', 100, cfg).ok, true);
  assert.equal(a.status().left, 10, '最后 10 秒出价延时');
  t = 34_000;
  assert.equal(a.tick(), null);
  t = 35_000;
  const r = a.tick();
  assert.equal(r.best.user, 'u3');
  assert.equal(r.best.amount, 100);
  assert.equal(r.count, 3);
  assert.equal(a.status().active, false);
}
{
  const a = new AuctionEngine(() => 0);
  const cfg = { seconds: 30, startMode: 'manual', minPrice: 1, step: 1 };
  assert.equal(a.bid('u1', 'A', 5, cfg).ok, false, '手动模式未开始');
  a.start(cfg);
  assert.equal(a.bid('u1', 'A', 5, cfg).ok, true);
  assert.equal(a.finish().best.amount, 5);
  a.start(cfg);
  assert.equal(a.finish().best, null, '无人出价');
}

// 弹幕字段映射（connector v2 原始 proto / 旧格式）
assert.deepEqual(chatFromWebcast({ content: '15', user: { displayId: 'abc', nickname: 'A' }, common: { msgId: '99' } }), { uniqueId: 'abc', nickname: 'A', comment: '15', msgId: '99' });
assert.deepEqual(chatFromWebcast({ comment: '7', user: { uniqueId: 'xyz', nickname: 'X' }, common: { msgId: '0' } }), { uniqueId: 'xyz', nickname: 'X', comment: '7', msgId: '' });

// 取消订单弹幕
const KW = 'hủy, huỷ, huy, 取消';
assert.deepEqual(matchCancel('hủy', KW), { number: null });
assert.deepEqual(matchCancel('Hủy 15', KW), { number: 15 });
assert.deepEqual(matchCancel('huỷ đơn 7', KW), { number: 7 });
assert.deepEqual(matchCancel('取消15号', KW), { number: 15 });
assert.equal(matchCancel('hủy rồi à', KW), null);
assert.equal(matchCancel('15', KW), null);
assert.equal(matchCancel('hủy', ''), null);

// 释放抢单名额
{
  const g = new GrabEngine(() => 0);
  const cfg = { mode: 'grab', limit: 1, seconds: 50 };
  assert.equal(g.offer('a', '15', cfg).ok, true);
  assert.equal(g.offer('b', '15', cfg).ok, false);
  g.release('a', '15');
  assert.equal(g.offer('b', '15', cfg).ok, true, '取消后别人可以抢');
}

// 重连退避
assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(retryDelaySeconds), [10, 20, 40, 80, 160, 300, 300]);

// 更多纯数字写法
for (const c of ['#15', '# 15', '15.', '15!!', '15 15', '15  15 15', '15。', ' 15 ~']) assert.equal(matchComment(c, base)?.number, 15, c);
assert.equal(matchComment('15 16', base), null, '两个不同号码不算');
assert.equal(matchComment('1.5', base), null);
assert.equal(matchComment('15k', base), null);

// 重复下单规则
{
  const now = 100_000;
  const recent = [
    { uniqueId: 'a', number: 15, time: 50_000, sessionId: 's1' },
    { uniqueId: 'b', number: 15, time: 95_000, sessionId: 's1' },
    { uniqueId: 'a', number: 16, time: 98_000, sessionId: 's1', cancelled: true },
  ];
  const W = { mode: 'window', seconds: 60 };
  assert.equal(duplicateReason('a', 15, 's1', recent, W, now), '60 秒内重复下单');
  assert.equal(duplicateReason('a', 15, 's1', recent, { mode: 'window', seconds: 30 }, now), null, '超过时间窗口');
  assert.equal(duplicateReason('a', 16, 's1', recent, W, now), null, '取消的不算');
  assert.equal(duplicateReason('a', 15, 's1', recent, { mode: 'session' }, now), '本场已下过这个号');
  assert.equal(duplicateReason('a', 15, 's2', recent, { mode: 'session' }, now), null, '换场次可以再下');
  assert.equal(duplicateReason('a', 15, 's1', recent, { mode: 'none' }, now), null);
  assert.equal(duplicateReason('a', null, 's1', recent, W, now), null, '关键字单不判断');
}

console.log('rules: all tests passed');
