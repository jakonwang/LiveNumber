'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ln-store-'));
const rec = (i, extra = {}) => ({ time: Date.now() - 1000 + i, uniqueId: 'u' + i, nickname: 'N' + i, content: String(i), number: i, code: i, codeText: String(i), status: 'ok', ...extra });

// 1. 写入后重新加载，数据一致；data.json 不含历史
{
  const dir = tmpDir();
  const s = new Store(dir);
  const a = s.addHistory(rec(1));
  const b = s.addHistory(rec(2));
  s.updateHistory(a.id, { status: 'fail', error: 'x' });
  s.upsertProduct({ code: '2', name: 'P', price: 10, stock: 5 });
  s.data.history.find((h) => h.id === b.id).productCode = '2';
  s.updateHistory(b.id, {});
  s.cancelRecord(b.id, 'buyer');
  s.flush();
  const s2 = new Store(dir);
  assert.equal(s2.data.history.length, 2);
  assert.equal(s2.getHistory(a.id).status, 'fail');
  assert.equal(s2.getHistory(b.id).cancelled, true);
  assert.equal(s2.findProduct(2).stock, 6, '取消退回的库存已保存');
  const dataJson = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(dataJson.history, undefined, 'data.json 不再保存历史');
  assert.equal(fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').length, 2, '启动时整理成每条一行');
}

// 2. 断电：日志最后一行写了一半；data.json 里的计数器比日志旧
{
  const dir = tmpDir();
  const s = new Store(dir);
  s.addHistory(rec(1));
  s.flush(); // data.json 记录 nextHistoryId = 2
  s.addHistory(rec(2)); // id 2 只进了日志，data.json 没来得及写
  fs.appendFileSync(path.join(dir, 'history.jsonl'), '{"id":3,"time":1,"uniq'); // 半行
  const s2 = new Store(dir);
  assert.deepEqual(s2.data.history.map((h) => h.id), [1, 2], '半行被跳过');
  const c = s2.addHistory(rec(3));
  assert.equal(c.id, 3, '编号计数按实际记录修正，不会重复');
}

// 3. 旧版数据（历史在 data.json 里）自动迁移
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ settings: {}, history: [{ id: 7, ...rec(7) }], counters: { nextHistoryId: 8 } }));
  const s = new Store(dir);
  assert.equal(s.getHistory(7).content, '7');
  assert.ok(fs.existsSync(path.join(dir, 'history.jsonl')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')).history, undefined, '迁移后 data.json 瘦身');
  assert.equal(new Store(dir).getHistory(7).content, '7', '迁移后再次启动仍在');
}

// 4. 清空历史
{
  const dir = tmpDir();
  const s = new Store(dir);
  s.addHistory(rec(1));
  s.clearHistory();
  assert.equal(new Store(dir).data.history.length, 0);
}

// 5. 性能：已有 6 万条时，新增一条的耗时
{
  const dir = tmpDir();
  const s = new Store(dir);
  for (let i = 0; i < 60000; i++) s.data.history.push({ id: i + 1, ...rec(i, { productName: 'Áo thun cổ tròn', price: 120000, sessionId: 's1' }) });
  s.data.counters.nextHistoryId = 60001;
  s.byId = new Map(s.data.history.map((h) => [h.id, h]));
  s.compactHistory();
  let t = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    const r = s.addHistory(rec(i));
    s.updateHistory(r.id, { status: 'ok' });
  }
  s.flush();
  const perOrderMs = Number(process.hrtime.bigint() - t) / 1e6 / 200;
  t = process.hrtime.bigint();
  const s2 = new Store(dir);
  const loadMs = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(s2.data.history.length, 60200);
  const dataKB = fs.statSync(path.join(dir, 'data.json')).size / 1024;
  console.log(`store perf: ${perOrderMs.toFixed(2)} ms/单（写入+更新），启动加载 ${loadMs.toFixed(0)} ms，data.json ${dataKB.toFixed(0)} KB`);
  assert.ok(perOrderMs < 5, '每单落盘应远小于 5ms');
}

console.log('store: all tests passed');
