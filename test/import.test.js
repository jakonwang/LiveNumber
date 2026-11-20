'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { readTable, pick } = require('../src/table');
const { Store } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-import-'));

// 1. UTF-8 CSV（本软件导出的格式，带 BOM 和序号头）
fs.writeFileSync(path.join(dir, 'a.csv'), '\ufeff添加时间,用户名,昵称,编号\r\n2026-11-01 10:00:00,nguyen_an,"Nguyễn, An",A12\r\n2026-11-01 10:00:00,@tran_b,Trần B,7\r\n');
let rows = readTable(path.join(dir, 'a.csv'));
assert.equal(rows.length, 2);
assert.equal(pick(rows[0], ['用户名']), 'nguyen_an');
assert.equal(pick(rows[0], ['昵称']), 'Nguyễn, An');
assert.equal(pick(rows[0], ['编号']), 'A12');

// 2. GBK 编码的 CSV（中文 Excel 另存为 CSV 的默认编码）：用户名,编号\r\nabc,5
const gbk = Buffer.concat([Buffer.from([0xd3, 0xc3, 0xbb, 0xa7, 0xc3, 0xfb]), Buffer.from(','), Buffer.from([0xb1, 0xe0, 0xba, 0xc5]), Buffer.from('\r\nabc,5\r\n')]);
fs.writeFileSync(path.join(dir, 'gbk.csv'), gbk);
rows = readTable(path.join(dir, 'gbk.csv'));
assert.equal(pick(rows[0], ['用户名']), 'abc', 'GBK 表头能识别');
assert.equal(pick(rows[0], ['编号']), '5');

// 3. Excel .xlsx（表头别名：账号 / 客户编号；数字单元格）
const ws = XLSX.utils.aoa_to_sheet([['账号', '昵称', '客户编号'], ['le_chi', 'Lê Chi', 1267], ['', '', ''], ['pham_d', 'Phạm D', 45]]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
fs.writeFileSync(path.join(dir, 'b.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
rows = readTable(path.join(dir, 'b.xlsx'));
assert.equal(rows.length, 2, '空行跳过');
assert.equal(pick(rows[0], ['用户名', '账号']), 'le_chi');
assert.equal(pick(rows[0], ['编号', '客户编号']), '1267');

// 4. 导入规则
{
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ln-cust-')));
  s.allocate('old_user', 'Old'); // 已有客户：编号 1
  let r = s.importCustomers(
    [
      { uniqueId: 'old_user', nickname: 'Old New', code: '88' },
      { uniqueId: 'new_1', nickname: 'N1', code: 'A12' },
      { uniqueId: 'new_2', nickname: 'N2', code: '12' }, // 和 new_1 撞号
      { uniqueId: '', code: '5' },
      { uniqueId: 'bad', code: 'abc' },
      { uniqueId: 'new_1', code: '99' }, // 表里重复的用户只取第一行
    ],
    'skip'
  );
  assert.deepEqual([r.added, r.updated, r.skipped, r.invalid], [2, 0, 1, 3]);
  assert.equal(s.data.customers.old_user.code, 1, 'skip 模式不改已有客户');
  assert.equal(s.data.customers.new_1.code, 12, '序号头 A 被去掉');
  assert.deepEqual(r.conflicts, [{ code: 12, users: ['new_1', 'new_2'] }]);
  assert.equal(s.data.counters.nextCode, 13, '下一个编号排到最大编号之后');
  r = s.importCustomers([{ uniqueId: 'old_user', nickname: 'Old New', code: '88' }], 'overwrite');
  assert.equal(r.updated, 1);
  assert.equal(s.data.customers.old_user.code, 88);
  assert.equal(s.data.customers.old_user.nickname, 'Old New');
  assert.equal(s.data.counters.nextCode, 89);
  assert.equal(s.allocate('brand_new', 'B').code, 89, '新客户不会撞到导入的编号');
}

console.log('import: all tests passed');
