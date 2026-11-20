/* global JsBarcode, qrcode */
// 标签模板渲染：打印窗口、模板设计器、预览共用。
// 模板：{ id, name, width, height, dateFormat, elements: [{ id, type, x, y, w, h, ...props }] }，坐标单位 mm。
(function () {
  const FIELDS = {
    username: { label: $t('用户名'), sample: 'huannguyen647', get: (d) => d.uniqueId },
    nickname: { label: $t('昵称'), sample: 'Dương Phước Huy', get: (d) => d.nickname || d.uniqueId },
    content: { label: $t('弹幕信息'), sample: '50', get: (d) => d.content },
    date: { label: $t('日期'), sample: '', get: (d, tpl) => formatDate(d.time, tpl.dateFormat) },
    serial: { label: $t('流水序号'), sample: '12', get: (d) => d.serial },
    code: { label: $t('客户编号'), sample: '45', get: (d) => d.codeText },
    note: { label: $t('主播备注'), sample: 'Sale', get: (d) => d.note },
    amount: { label: $t('竞拍金额'), sample: '150.000', get: (d) => money(d.amount) },
    productName: { label: $t('商品名称'), sample: 'Áo thun', get: (d) => d.productName },
    price: { label: $t('商品价格'), sample: '120.000', get: (d) => money(d.price) },
    spec: { label: $t('商品规格'), sample: 'L', get: (d) => d.spec },
    newbie: { label: $t('新人'), sample: $t('新'), get: (d) => d.newbie },
    itemsText: { label: $t('商品清单'), sample: $t('15 Áo thun，18×2'), get: (d) => d.itemsText },
    qty: { label: $t('件数'), sample: '3', get: (d) => d.qty },
    total: { label: $t('合计金额'), sample: '360.000', get: (d) => money(d.total) },
    bidCount: { label: $t('出价次数'), sample: '8', get: (d) => d.bidCount },
  };

  // 组件面板：type + 默认属性
  const PALETTE = [
    { type: 'text', label: $t('文本'), w: 20, h: 5, props: { text: $t('文本'), fontSize: 3 } },
    { type: 'field', label: $t('客户编号'), w: 20, h: 8, props: { field: 'code', fontSize: 7, bold: true, align: 'center' } },
    { type: 'field', label: $t('用户名'), w: 30, h: 5, props: { field: 'username', fontSize: 3 } },
    { type: 'field', label: $t('昵称'), w: 30, h: 5, props: { field: 'nickname', fontSize: 3.2, bold: true } },
    { type: 'field', label: $t('弹幕信息'), w: 25, h: 7, props: { field: 'content', fontSize: 5, bold: true } },
    { type: 'field', label: $t('日期'), w: 30, h: 5, props: { field: 'date', fontSize: 2.8 } },
    { type: 'field', label: $t('流水序号'), w: 15, h: 5, props: { field: 'serial', fontSize: 3, prefix: '#' } },
    { type: 'field', label: $t('主播备注'), w: 25, h: 5, props: { field: 'note', fontSize: 3 } },
    { type: 'field', label: $t('竞拍金额'), w: 25, h: 6, props: { field: 'amount', fontSize: 4, bold: true } },
    { type: 'field', label: $t('商品名称'), w: 30, h: 5, props: { field: 'productName', fontSize: 3, bold: true } },
    { type: 'field', label: $t('商品价格'), w: 20, h: 5, props: { field: 'price', fontSize: 3.2, bold: true, suffix: 'đ' } },
    { type: 'field', label: $t('商品规格'), w: 15, h: 5, props: { field: 'spec', fontSize: 3 } },
    { type: 'field', label: $t('新人'), w: 6, h: 6, props: { field: 'newbie', fontSize: 4, bold: true, align: 'center', border: true } },
    { type: 'field', label: $t('商品清单'), w: 38, h: 9, props: { field: 'itemsText', fontSize: 2.8, wrap: true } },
    { type: 'field', label: $t('件数'), w: 12, h: 5, props: { field: 'qty', fontSize: 3.2, bold: true, prefix: $t('共'), suffix: $t('件') } },
    { type: 'field', label: $t('合计金额'), w: 22, h: 5, props: { field: 'total', fontSize: 3.4, bold: true, suffix: 'đ' } },
    { type: 'barcode', label: $t('条形码'), w: 30, h: 10, props: { field: 'code', showText: false } },
    { type: 'qrcode', label: $t('二维码'), w: 12, h: 12, props: { field: 'username' } },
    { type: 'image', label: $t('图片'), w: 12, h: 12, props: { src: '' } },
    { type: 'hline', label: $t('横线'), w: 30, h: 1, props: { lineWidth: 0.25 } },
    { type: 'vline', label: $t('竖线'), w: 1, h: 15, props: { lineWidth: 0.25 } },
    { type: 'rect', label: $t('矩形'), w: 20, h: 10, props: { lineWidth: 0.25 } },
    { type: 'ellipse', label: $t('椭圆'), w: 15, h: 10, props: { lineWidth: 0.25 } },
  ];

  const DATE_FORMATS = ['MM/DD HH:mm:ss', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'MM-DD HH:mm', 'DD/MM HH:mm', 'HH:mm:ss'];

  // 金额按越南习惯分组：120000 → 120.000
  function money(v) {
    if (v === '' || v == null || isNaN(Number(v))) return v ?? '';
    return Number(v).toLocaleString(window.LN_NUM_LOCALE || 'vi-VN');
  }
  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function formatDate(t, fmt) {
    const d = new Date(t || Date.now());
    const map = { YYYY: d.getFullYear(), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
    return String(fmt || 'MM/DD HH:mm:ss').replace(/YYYY|MM|DD|HH|mm|ss/g, (k) => map[k]);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fieldValue(field, data, tpl) {
    const f = FIELDS[field];
    return f ? f.get(data, tpl) ?? '' : '';
  }

  function sampleData() {
    return { uniqueId: 'huannguyen647', nickname: 'Dương Phước Huy', content: '50', time: Date.now(), serial: 12, codeText: '45', note: 'Sale', amount: 150000, bidCount: 8, productName: 'Áo thun', price: 120000, spec: 'L', newbie: $t('新'), itemsText: $t('15 Áo thun，18×2'), qty: 3, total: 360000 };
  }

  function barcodeSvg(value) {
    if (typeof JsBarcode === 'undefined' || !value) return '';
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      JsBarcode(svg, String(value), { format: 'CODE128', displayValue: false, margin: 0, height: 100, width: 2 });
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      return svg.outerHTML;
    } catch {
      return '';
    }
  }

  function qrSvg(value) {
    if (typeof qrcode === 'undefined' || !value) return '';
    try {
      if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      const qr = qrcode(0, 'M');
      qr.addData(String(value));
      qr.make();
      const n = qr.getModuleCount();
      let path = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c},${r}h1v1h-1z`;
      return `<svg viewBox="0 0 ${n} ${n}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"><path d="${path}" fill="#000"/></svg>`;
    } catch {
      return '';
    }
  }

  /** 单个组件内部 HTML（不含定位外框） */
  function elementInner(el, data, tpl) {
    const lw = (Number(el.lineWidth) || 0.25) + 'mm';
    switch (el.type) {
      case 'text':
        return textBox(el, el.text);
      case 'field': {
        const v = fieldValue(el.field, data, tpl);
        // 字段为空时整个组件留空（不印前后缀），比如老客户不印「新」
        return v === '' || v == null ? textBox(el, '') : textBox(el, (el.prefix || '') + v + (el.suffix || ''));
      }
      case 'barcode': {
        const v = fieldValue(el.field, data, tpl) || el.text;
        const svg = barcodeSvg(v);
        return `<div class="lb-code"><div class="lb-bars">${svg}</div>${el.showText ? `<div class="lb-codetext">${esc(v)}</div>` : ''}</div>`;
      }
      case 'qrcode':
        return qrSvg(el.field === 'custom' ? el.text : fieldValue(el.field, data, tpl));
      case 'image':
        return el.src ? `<img src="${esc(el.src)}" style="width:100%;height:100%;object-fit:contain">` : $t('<div class="lb-empty">图片</div>');
      case 'hline':
        return `<div style="position:absolute;left:0;right:0;top:50%;border-top:${lw} solid #000;transform:translateY(-50%)"></div>`;
      case 'vline':
        return `<div style="position:absolute;top:0;bottom:0;left:50%;border-left:${lw} solid #000;transform:translateX(-50%)"></div>`;
      case 'rect':
        return `<div style="position:absolute;inset:0;border:${lw} solid #000"></div>`;
      case 'ellipse':
        return `<div style="position:absolute;inset:0;border:${lw} solid #000;border-radius:50%"></div>`;
      default:
        return '';
    }
  }

  function textBox(el, text) {
    const justify = { left: 'flex-start', center: 'center', right: 'flex-end' }[el.align || 'left'];
    const style = [
      `font-size:${Number(el.fontSize) || 3}mm`,
      `font-weight:${el.bold ? 800 : 400}`,
      `justify-content:${justify}`,
      `text-align:${el.align || 'left'}`,
      el.wrap ? 'white-space:normal;word-break:break-word;align-items:flex-start' : 'white-space:nowrap',
      el.border && text !== '' ? 'border:0.25mm solid #000;border-radius:0.6mm' : '',
    ].join(';');
    return `<div class="lb-text" style="${style}"><span>${esc(text)}</span></div>`;
  }

  function elementStyle(el) {
    return `left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm`;
  }

  /** 整张标签 HTML */
  function templateHtml(tpl, data) {
    return (tpl.elements || []).map((el) => `<div class="lb-el" style="${elementStyle(el)}">${elementInner(el, data, tpl)}</div>`).join('');
  }

  window.LabelRender = { FIELDS, PALETTE, DATE_FORMATS, formatDate, elementInner, templateHtml, sampleData };
})();
