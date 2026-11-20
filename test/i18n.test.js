'use strict';
// 多语言：源码里每个 $t('…') 在 5 种语言词典里都要有翻译，占位符 {0} 要一致
const assert = require('node:assert');
const { collect, check } = require('../build/i18n/extract');
const i18n = require('../src/i18n/i18n');

const keys = collect();
const report = check(keys);
for (const [lang, r] of Object.entries(report)) {
  assert.strictEqual(r.missing, 0, `${lang} 缺 ${r.missing} 个翻译（node build/i18n/extract.js --missing ${lang}）`);
  assert.deepStrictEqual(r.badHoles, [], `${lang} 占位符不一致`);
}
// t()：中文原样、其他语言查词典、参数替换
i18n.setLang('zh');
assert.strictEqual(i18n.t('编号 {0} 已重打', 12), '编号 12 已重打');
i18n.setLang('en');
assert.strictEqual(i18n.t('编号 {0} 已重打', 12), 'Code 12 reprinted');
assert.strictEqual(i18n.t('没有的key {0}', 'x'), '没有的key x'); // 查不到显示中文
i18n.setLang('vi');
assert.ok(i18n.allForms('用户名').includes('Tên người dùng'));
i18n.setLang('zh');
console.log(`i18n.test.js：${keys.length} 个 key × 5 种语言，全部通过`);
