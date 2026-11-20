'use strict';
// 把源码里的中文字符串包成 $t(...)。一次性迁移工具，可重复运行（已包过的不会再包）。
//   node build/i18n/transform.js js <file...>    JS 文件（AST 精确定位，跳过注释）
//   node build/i18n/transform.js vue <file...>   Vue 模板 HTML（index.html / screen.html）
const fs = require('node:fs');
const { parse } = require('@babel/parser');

const CJK = /[一-鿿　-〿＀-￯]/;
const T = '$t';

const q1 = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + "'";

// ---------------- Vue 模板 ----------------

/** 表达式里的中文单引号字符串 → $t('...')；已经是 $t( 参数的不动 */
function transformExpr(expr) {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'" || c === '`') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      const lit = expr.slice(i, j + 1);
      const body = expr.slice(i + 1, j);
      const before = out.replace(/\s+$/, '');
      if (CJK.test(body) && !before.endsWith(T + '(')) {
        if (c === '`' && body.includes('${')) {
          // `中文${a}中文` → $t('中文{0}中文', a)
          const args = [];
          const key = body.replace(/\$\{([^}]*)\}/g, (m, e) => `{${args.push(e.trim()) - 1}}`);
          out += `${T}(${q1(key)}${args.length ? ', ' + args.join(', ') : ''})`;
        } else out += `${T}(${q1(c === '`' ? body : body.replace(/\\'/g, "'"))})`;
      } else out += lit;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** 文本节点：中文片段 → {{ $t('...') }}，{{ }} 里的表达式也处理 */
function transformText(text) {
  return text
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part) => {
      if (part.startsWith('{{')) return '{{' + transformExpr(part.slice(2, -2)) + '}}';
      if (!CJK.test(part)) return part;
      // 首尾空白和 &nbsp; 留在外面
      const m = part.match(/^((?:\s|&nbsp;)*)([\s\S]*?)((?:\s|&nbsp;)*)$/);
      if (!CJK.test(m[2])) return part; // 只有全角空格之类的空白
      return `${m[1]}{{ ${T}(${q1(m[2].replace(/\s*\n\s*/g, ' '))}) }}${m[3]}`;
    })
    .join('');
}

/** 一个开始标签里的属性 */
function transformTag(tag) {
  return tag.replace(/(\s)([:@#]?[\w\-.:[\]]+)=("([^"]*)"|'([^']*)')/g, (all, sp, name, quoted, dv, sv) => {
    const v = dv !== undefined ? dv : sv;
    const qc = dv !== undefined ? '"' : "'";
    if (/^(:|@|#|v-)/.test(name)) {
      const nv = transformExpr(v);
      return nv === v ? all : `${sp}${name}=${qc}${nv}${qc}`;
    }
    if (!CJK.test(v) || /^(class|style|id|src|href|key)$/.test(name)) return all;
    return `${sp}:${name}="${T}(${q1(v).replace(/"/g, '&quot;')})"`;
  });
}

function transformVue(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const j = html.indexOf('-->', i);
      const end = j < 0 ? html.length : j + 3;
      out += html.slice(i, end);
      i = end;
    } else if (/^<(script|style|title)\b/i.test(html.slice(i, i + 8))) {
      // <title> 在 Vue 根节点外面，不会被渲染，不能放 {{ }}
      const name = html.slice(i + 1, i + 8).match(/^(script|style|title)/i)[1].toLowerCase();
      const j = html.toLowerCase().indexOf(`</${name}>`, i);
      const end = j < 0 ? html.length : j + name.length + 3;
      out += html.slice(i, end);
      i = end;
    } else if (html[i] === '<') {
      // 标签：到不在引号里的 >
      let j = i + 1;
      let q = null;
      while (j < html.length) {
        const c = html[j];
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
        j++;
      }
      out += transformTag(html.slice(i, j + 1));
      i = j + 1;
    } else {
      // 文本到下一个 <（{{ }} 里可能有 <，要跳过）
      let j = i;
      while (j < html.length && html[j] !== '<') {
        if (html.startsWith('{{', j)) {
          const k = html.indexOf('}}', j);
          j = k < 0 ? html.length : k + 2;
        } else j++;
      }
      out += transformText(html.slice(i, j));
      i = j;
    }
  }
  return out;
}

// ---------------- JS ----------------

const SKIP_CALLS = new Set(['pick', T, 'require', 'renderIdleRaw']);
const SKIP_MEMBER_CALLS = new Set(['console.log', 'console.warn', 'console.error', 'fileLog.write']);
const SKIP_VARS = new Set(['DEFAULT_SETTINGS']);
const SKIP_FUNCS = new Set(['defaultTemplate', 'shipTemplate']);

function calleeName(c) {
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if ((c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed) {
    const o = calleeName(c.object);
    return o ? `${o}.${c.property.name}` : '';
  }
  return '';
}

function skipByAncestors(anc, node, parent) {
  if (parent && (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && parent.key === node && !parent.computed) return true;
  if (parent && parent.type === 'TaggedTemplateExpression') return true;
  for (const a of anc) {
    if (a.type === 'CallExpression' || a.type === 'OptionalCallExpression' || a.type === 'NewExpression') {
      const n = calleeName(a.callee);
      if (SKIP_CALLS.has(n) || SKIP_MEMBER_CALLS.has(n) || /(^|\.)fileLog\??\.write$/.test(n)) return true;
    }
    if (a.type === 'VariableDeclarator' && a.id && SKIP_VARS.has(a.id.name)) return true;
    if (a.type === 'FunctionDeclaration' && a.id && SKIP_FUNCS.has(a.id.name)) return true;
  }
  return false;
}

/** HTML 片段的模板字符串：只把标签外的中文文字包成 ${$t('...')} */
function htmlTemplate(code, node, sub) {
  let inTag = false;
  let out = '`';
  node.quasis.forEach((qd, idx) => {
    const raw = qd.value.raw;
    let seg = '';
    let k = 0;
    const flush = () => {
      const m = seg.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (CJK.test(m[2])) {
        out += `${m[1]}\${${T}(${q1(m[2])})}${m[3]}`;
      } else out += seg;
      seg = '';
    };
    while (k < raw.length) {
      const c = raw[k];
      if (!inTag && c === '<') {
        flush();
        inTag = true;
        out += c;
      } else if (inTag) {
        if (c === '>') inTag = false;
        out += c;
      } else seg += c;
      k++;
    }
    flush();
    if (idx < node.expressions.length) {
      const e = node.expressions[idx];
      out += '${' + sub(e.start, e.end) + '}';
    }
  });
  return out + '`';
}

function transformJs(code, file) {
  const ast = parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });
  const targets = [];
  (function walk(node, anc) {
    if (!node || typeof node.type !== 'string') return;
    const parent = anc[anc.length - 1];
    if (node.type === 'StringLiteral' && CJK.test(node.value) && !skipByAncestors(anc, node, parent)) targets.push({ node, kind: 'str' });
    else if (node.type === 'TemplateLiteral' && node.quasis.some((x) => CJK.test(x.value.cooked)) && !skipByAncestors(anc, node, parent)) {
      const raw = code.slice(node.start, node.end);
      // designer.js 的 Vue 模板字符串
      const isVue = /<el-|v-model|@click|\{\{/.test(raw);
      targets.push({ node, kind: isVue ? 'vue' : /</.test(raw) ? 'html' : 'tpl' });
    }
    const next = anc.concat(node);
    for (const k of Object.keys(node)) {
      if (k === 'loc' || /Comments$/.test(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, next));
      else if (v && typeof v.type === 'string') walk(v, next);
    }
  })(ast.program, []);

  // 嵌套替换：区间内的直接子目标先替换
  const within = (s, e) => targets.filter((x) => x.node.start >= s && x.node.end <= e && !(x.node.start === s && x.node.end === e));
  function sub(s, e) {
    const inner = within(s, e).filter((x, _, arr) => !arr.some((y) => y !== x && y.node.start <= x.node.start && y.node.end >= x.node.end));
    inner.sort((a, b) => a.node.start - b.node.start);
    let out = '';
    let pos = s;
    for (const x of inner) {
      out += code.slice(pos, x.node.start) + replace(x);
      pos = x.node.end;
    }
    return out + code.slice(pos, e);
  }
  function replace(x) {
    const n = x.node;
    if (x.kind === 'str') return `${T}(${code.slice(n.start, n.end)})`;
    if (x.kind === 'vue') return '`' + transformVue(code.slice(n.start + 1, n.end - 1)) + '`';
    if (x.kind === 'html') return htmlTemplate(code, n, sub);
    const key = n.quasis.map((qd, i) => qd.value.cooked + (i < n.expressions.length ? `{${i}}` : '')).join('');
    const args = n.expressions.map((e) => sub(e.start, e.end));
    return `${T}(${q1(key)}${args.length ? ', ' + args.join(', ') : ''})`;
  }
  return { code: sub(0, code.length), count: targets.length };
}

if (require.main === module) {
  const [mode, ...files] = process.argv.slice(2);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const res = mode === 'vue' ? { code: transformVue(src), count: '-' } : transformJs(src, f);
    fs.writeFileSync(f, res.code);
    console.log(mode, res.count, f);
  }
}
module.exports = { transformVue, transformJs, transformExpr };
