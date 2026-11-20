'use strict';
// 国家/站点预设：选择国家后自动切换 TikTok Shop 卖家中心域名、金额格式、取消关键词、默认界面语言。
(function (root) {
  const COUNTRIES = [
    { code: 'VN', name: '越南', host: 'seller-vn.tiktok.com', numLocale: 'vi-VN', currency: '₫', cancel: 'hủy, huỷ, huy, 取消', lang: 'vi', multiplier: 1000 },
    { code: 'TH', name: '泰国', host: 'seller-th.tiktok.com', numLocale: 'th-TH', currency: '฿', cancel: 'ยกเลิก, cancel', lang: 'th', multiplier: 1 },
    { code: 'ID', name: '印度尼西亚', host: 'seller-id.tiktok.com', numLocale: 'id-ID', currency: 'Rp', cancel: 'batal, cancel', lang: 'id', multiplier: 1000 },
    { code: 'MY', name: '马来西亚', host: 'seller-my.tiktok.com', numLocale: 'ms-MY', currency: 'RM', cancel: 'batal, cancel', lang: 'ms', multiplier: 1 },
    { code: 'PH', name: '菲律宾', host: 'seller-ph.tiktok.com', numLocale: 'en-PH', currency: '₱', cancel: 'cancel, kansel', lang: 'en', multiplier: 1 },
    { code: 'SG', name: '新加坡', host: 'seller-sg.tiktok.com', numLocale: 'en-SG', currency: 'S$', cancel: 'cancel, 取消', lang: 'en', multiplier: 1 },
  ];
  const byCode = (code) => COUNTRIES.find((c) => c.code === code) || COUNTRIES[0];
  const api = { COUNTRIES, byCode };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LN_COUNTRIES = api;
})(typeof window !== 'undefined' ? window : globalThis);
