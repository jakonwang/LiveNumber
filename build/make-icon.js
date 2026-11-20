'use strict';
// 从 src/assets/logo.svg（大）和 logo-small.svg（16–32px 用）生成：
//   build/icon.ico、build/icon.png（安装包用）
//   src/assets/icon.ico、src/assets/icon.png（窗口 / 任务栏用）
//   build/logo/preview.png（各尺寸预览）
// 用法：npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SMALL_MAX = 32; // ≤32px 用粗线版

/** 多尺寸 ICO：每个尺寸直接放 PNG 数据（Windows Vista 起支持） */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<html><body></body></html>');
  const svgs = {
    big: fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8'),
    small: fs.readFileSync(path.join(ASSETS, 'logo-small.svg'), 'utf8'),
  };
  // 在页面里用 canvas 按目标尺寸直接栅格化（比先画大图再缩小更清楚）
  const result = await w.webContents.executeJavaScript(`(async () => {
    const svgs = ${JSON.stringify(svgs)};
    const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(src); });
    const big = await load(svgs.big), small = await load(svgs.small);
    const out = {};
    for (const s of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(s <= ${SMALL_MAX} ? small : big, 0, 0, s, s);
      out[s] = c.toDataURL('image/png').split(',')[1];
    }
    const c = document.createElement('canvas'); c.width = c.height = 512;
    c.getContext('2d').drawImage(big, 0, 0, 512, 512);
    out[512] = c.toDataURL('image/png').split(',')[1];
    return out;
  })()`);
  const png = (s) => Buffer.from(result[s], 'base64');

  const ico = buildIco(SIZES.map((size) => ({ size, png: png(size) })));
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png(512));
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), png(256));

  // 预览：每个尺寸放大到 4 倍（像素化显示）看清实际效果
  const previewHtml = `<html><body style="margin:0;padding:24px;background:#e9edf3;font-family:Microsoft YaHei,sans-serif">
    ${['#060b16', '#f8fafc'].map((bg) => `<div style="display:flex;gap:22px;align-items:flex-end;background:${bg};padding:20px;border-radius:14px;margin-bottom:16px">
      ${SIZES.map((s) => `<div style="text-align:center;color:${bg === '#060b16' ? '#94a3b8' : '#64748b'};font-size:12px">
        <img src="data:image/png;base64,${result[s]}" style="width:${Math.min(s * 3, 192)}px;image-rendering:pixelated;display:block;margin-bottom:6px">${s}px</div>`).join('')}
    </div>`).join('')}
    <div style="color:#475569;font-size:13px">实际像素放大显示：≤32px 为粗线版，48px 起为标准版</div></body></html>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(previewHtml));
  await new Promise((r) => setTimeout(r, 500));
  const height = await w.webContents.executeJavaScript('document.body.scrollHeight');
  w.setContentSize(1500, height + 10);
  await new Promise((r) => setTimeout(r, 400));
  fs.mkdirSync(path.join(__dirname, 'logo'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'logo', 'preview.png'), (await w.webContents.capturePage()).toPNG());
  console.log('icons written:', SIZES.join(', '), '→ build/icon.ico, src/assets/icon.ico, build/logo/preview.png');
  app.quit();
});
