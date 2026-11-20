'use strict';
// 读表格文件（CSV / Excel），返回 [{表头: 值}]。导入客户编号、商品、名单共用。
const fs = require('node:fs');
const path = require('node:path');

/** 解析 CSV 文本（第一行是表头），支持带引号的字段 */
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return toObjects(rows);
}

function toObjects(rows) {
  const [head, ...body] = rows.filter((r) => r.some((x) => String(x ?? '').trim() !== ''));
  if (!head) return [];
  const keys = head.map((h) => String(h ?? '').trim());
  return body.map((r) => Object.fromEntries(keys.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

/** CSV 文件：先按 UTF-8 读，出现乱码就按 GBK（中文 Excel 默认另存的编码）再读 */
function readCsvFile(file) {
  const buf = fs.readFileSync(file);
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* 没有 GBK 解码器就用 UTF-8 结果 */
    }
  }
  return parseCsv(text);
}

/** Excel（.xlsx / .xls）：读第一个工作表 */
function readExcelFile(file) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return toObjects(rows);
}

function readTable(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return readExcelFile(file);
  return readCsvFile(file);
}

/** 按候选表头取值（忽略大小写、空格），如 pick(row, ['用户名', 'uniqueId', '账号']) */
function pick(row, names) {
  const norm = (k) => String(k).replace(/\s+/g, '').toLowerCase();
  // 表头可能是任何界面语言导出的：中文表头同时认它在各语言里的写法
  const wanted = names.flatMap((n) => require('./i18n/i18n').allForms(n)).map(norm);
  for (const [k, v] of Object.entries(row)) if (wanted.includes(norm(k))) return v;
  return '';
}

module.exports = { parseCsv, readTable, pick };
