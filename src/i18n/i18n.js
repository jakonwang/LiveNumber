'use strict';
// 多语言：t('中文原文', 参数...)。中文原文就是 key，其他语言在 locales/<lang>.json 里查，查不到就显示中文。
// 参数用 {0} {1} 占位，如 t('编号 {0} 已重打', code)。
// 主进程 require 这个文件；界面窗口用 <script> 引入，词典由 preload 同步拿到（window.api.i18n）。
(function (root) {
  const LANGS = [
    { code: 'zh', label: '中文', el: 'zhCn', locale: 'zh-CN' },
    { code: 'vi', label: 'Tiếng Việt', el: 'vi', locale: 'vi-VN' },
    { code: 'en', label: 'English', el: 'en', locale: 'en-US' },
    { code: 'th', label: 'ไทย', el: 'th', locale: 'th-TH' },
    { code: 'id', label: 'Bahasa Indonesia', el: 'id', locale: 'id-ID' },
    { code: 'ms', label: 'Bahasa Melayu', el: 'ms', locale: 'ms-MY' },
  ];

  const state = { lang: 'zh', dict: {} };
  const has = Object.prototype.hasOwnProperty;

  function format(s, args) {
    if (!args.length) return s;
    return s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined || args[i] === null ? '' : String(args[i])));
  }

  function t(key, ...args) {
    key = String(key);
    const s = state.dict && has.call(state.dict, key) ? state.dict[key] : key;
    return format(String(s), args);
  }

  function setDict(lang, dict) {
    state.lang = LANGS.some((l) => l.code === lang) ? lang : 'zh';
    state.dict = dict || {};
  }

  const api = { t, LANGS, setDict, getLang: () => state.lang, format };

  if (typeof module === 'object' && module.exports) {
    // ---- 主进程 ----
    const fs = require('node:fs');
    const path = require('node:path');
    const cache = {};
    api.dictFor = (lang) => {
      if (!lang || lang === 'zh') return {};
      if (!cache[lang]) {
        try {
          cache[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', lang + '.json'), 'utf8'));
        } catch {
          cache[lang] = {};
        }
      }
      return cache[lang];
    };
    api.setLang = (lang) => setDict(lang, api.dictFor(lang));
    /** 某个中文原文在所有语言里的写法（导入表格时，表头可能是任何语言） */
    api.allForms = (key) => [key, ...LANGS.filter((l) => l.code !== 'zh').map((l) => api.dictFor(l.code)[key]).filter(Boolean)];
    module.exports = api;
  } else {
    // ---- 界面窗口 ----
    const init = (root.api && root.api.i18n) || root.__LN_I18N || null;
    if (init) setDict(init.lang, init.dict);
    root.$t = t;
    root.LN_I18N = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
