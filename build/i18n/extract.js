'use strict';
// 收集源码里所有 $t('…') 的 key，并检查各语言词典：缺翻译、多余 key、占位符 {0} 不一致。
//   node build/i18n/extract.js            → 写 build/i18n/keys.json 并打印检查结果
//   node build/i18n/extract.js --missing vi  → 打印 vi 缺的 key（JSON 数组）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
  'src/main.js', 'src/store.js', 'src/rules.js', 'src/shop.js', 'src/shopnote.js', 'src/share.js', 'src/screen.js', 'src/printer.js', 'src/browser-live.js', 'src/table.js',
  'src/renderer/app.js', 'src/renderer/designer.js', 'src/renderer/label-render.js', 'src/renderer/screen.js', 'src/renderer/index.html', 'src/renderer/screen.html',
];
// 动态 key（$t(变量)）：国家名、切换语言时跟着换的默认文字
const EXTRA = ['越南', '泰国', '印度尼西亚', '马来西亚', '菲律宾', '新加坡', 'LIVE 抢单', '评论区发送号码即可下单', '新', '{code}号 {content}', '默认模板(40*30)', '发货单(40*30)', '共', '件', '文本'];
const LANGS = ['vi', 'en', 'th', 'id', 'ms'];

function unquote(q, body) {
  // eslint-disable-next-line no-new-func
  return Function(`return ${q}${body}${q}`)();
}

function collect() {
  const keys = new Set(EXTRA);
  for (const f of FILES) {
    let text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f.endsWith('.html')) text = text.replace(/&quot;/g, '\\"');
    const re = /\$t\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(text))) keys.add(unquote(m[1], m[2]));
  }
  return [...keys].sort();
}

const holes = (s) => (String(s).match(/\{\d+\}/g) || []).sort().join(',');

function check(keys) {
  const report = {};
  for (const l of LANGS) {
    const file = path.join(ROOT, 'src', 'i18n', 'locales', l + '.json');
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (fs.existsSync(file)) report[l] = { error: e.message };
    }
    const missing = keys.filter((k) => !(k in d));
    const extra = Object.keys(d).filter((k) => !keys.includes(k));
    const badHoles = keys.filter((k) => k in d && holes(k) !== holes(d[k]));
    report[l] = { total: keys.length, missing: missing.length, extra: extra.length, badHoles };
    if (process.argv.includes('--verbose')) report[l].extraKeys = extra;
  }
  return report;
}

if (require.main === module) {
  const keys = collect();
  const mi = process.argv.indexOf('--missing');
  if (mi > 0) {
    const l = process.argv[mi + 1];
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', l + '.json'), 'utf8'));
    } catch {
      /* 还没有 */
    }
    console.log(JSON.stringify(keys.filter((k) => !(k in d)), null, 0));
  } else {
    fs.writeFileSync(path.join(__dirname, 'keys.json'), JSON.stringify(keys, null, 1));
    console.log('keys:', keys.length);
    console.log(JSON.stringify(check(keys), null, 1));
  }
}
module.exports = { collect, check };
