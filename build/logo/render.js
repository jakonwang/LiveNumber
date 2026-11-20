'use strict';
// 把 sheet.html 渲染成 options.png
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const page = process.argv[2] || 'sheet.html';
  const w = new BrowserWindow({ width: 1500, height: 720, show: false, webPreferences: { offscreen: true } });
  await w.loadFile(path.join(__dirname, page));
  await new Promise((r) => setTimeout(r, 800));
  const h = await w.webContents.executeJavaScript('document.body.scrollHeight');
  w.setContentSize(1500, h + 30);
  await new Promise((r) => setTimeout(r, 500));
  const img = await w.webContents.capturePage();
  const out = path.join(__dirname, page.replace('.html', '.png'));
  fs.writeFileSync(out, img.toPNG());
  console.log('written', out, img.getSize());
  app.quit();
});
