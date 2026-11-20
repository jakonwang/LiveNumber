'use strict';
// 列出源码里还没包 $t() 的中文字符串（不含注释）。故意不翻译的（导入表头别名、默认设置、文件日志）会列出来供人工确认。
const { scan } = require('./scan');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
  'src/main.js', 'src/store.js', 'src/rules.js', 'src/shop.js', 'src/shopnote.js', 'src/share.js', 'src/screen.js', 'src/printer.js', 'src/browser-live.js',
  'src/renderer/app.js', 'src/renderer/designer.js', 'src/renderer/label-render.js', 'src/renderer/screen.js',
];
const out = [];
for (const f of FILES) {
  const { code, items } = scan(path.join(ROOT, f));
  for (const it of items) {
    const before = code.slice(Math.max(0, it.start - 40), it.start);
    if (/\$t\(\s*$/.test(before)) continue;
    const line = code.slice(0, it.start).split('\n').length;
    const lineText = code.split('\n')[line - 1];
    out.push({ at: `${f}:${line}`, text: code.slice(it.start, Math.min(it.end, it.start + 60)).replace(/\s+/g, ' '), ctx: lineText.trim().slice(0, 70) });
  }
}
if (require.main === module) for (const o of out) console.log(o.at, '|', o.text, '|', o.ctx);
module.exports = { leftovers: () => out };
