'use strict';
// 列出模板文字里 $t('…') 之外还残留中文的行（HTML 页面、设计器模板、A4 汇总），注释行除外。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const TARGETS = [
  ['src/renderer/index.html'],
  ['src/renderer/screen.html'],
  ['src/renderer/designer.js', 'template: `', '`,'],
  ['src/main.js', 'function summaryHtml', '\n}'],
];
const CJK = /[一-鿿]/;
const stripT = (l) => l.replace(/\$t\('(?:[^'\\]|\\.)*'/g, '').replace(/\$t\("(?:[^"\\]|\\.)*"/g, '');
for (const [f, startMark, endMark] of TARGETS) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  let s = 0;
  let e = text.length;
  if (startMark) {
    s = text.indexOf(startMark);
    e = text.indexOf(endMark, s + startMark.length);
  }
  const before = text.slice(0, s).split('\n').length;
  text
    .slice(s, e)
    .split('\n')
    .forEach((l, i) => {
      const st = stripT(l).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/, '');
      if (CJK.test(st)) console.log(`${f}:${before + i}`, st.trim().slice(0, 150));
    });
}
