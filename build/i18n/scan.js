'use strict';
// 统计/列出 JS 源码里含中文的字符串字面量和模板字符串（不含注释）。用法：node build/i18n/scan.js src/main.js ...
const fs = require('node:fs');
const { parse } = require('@babel/parser');

const CJK = /[一-鿿　-〿＀-￯]/;

function scan(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true, plugins: [] });
  const out = [];
  (function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'StringLiteral' && CJK.test(node.value)) out.push({ kind: 'str', start: node.start, end: node.end, value: node.value, parent: parent && parent.type });
    if (node.type === 'TemplateLiteral' && node.quasis.some((q) => CJK.test(q.value.cooked))) out.push({ kind: 'tpl', start: node.start, end: node.end, parent: parent && parent.type });
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node));
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  })(ast.program, null);
  return { code, items: out };
}

if (require.main === module) {
  let total = 0;
  for (const f of process.argv.slice(2)) {
    const { items } = scan(f);
    total += items.length;
    console.log(items.length, f);
  }
  console.log('total', total);
}
module.exports = { scan, CJK };
