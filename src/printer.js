'use strict';
const { t: $t } = require('./i18n/i18n');
// 标签打印：用一个隐藏窗口渲染 label.html，然后静默打印到指定打印机。按队列串行执行。
const path = require('node:path');
const { BrowserWindow } = require('electron');

class LabelPrinter {
  constructor() {
    this.win = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const w = this.win;
    // 渲染进程崩溃：销毁窗口，下一张标签会自动重建
    w.webContents.on('render-process-gone', () => {
      if (!w.isDestroyed()) w.destroy();
    });
    this.ready = w.loadFile(path.join(__dirname, 'renderer', 'label.html'));
    return this.ready;
  }

  async listPrinters(webContents) {
    const list = await webContents.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
  }

  /** 加入打印队列；返回 Promise<{ok, error?}> */
  print(data, template, printCfg) {
    this.pending += 1;
    const job = this.queue.then(() => this.printNow(data, template, printCfg));
    this.queue = job.catch(() => {}).finally(() => {
      this.pending -= 1;
    });
    return job;
  }

  /** 把标签渲染到隐藏窗口（打印和导出 PDF 共用） */
  async render(data, template) {
    await this.ensureWindow();
    const payload = JSON.stringify({ data, template });
    const loc = JSON.stringify(this.numLocale ? this.numLocale() : 'vi-VN');
    await this.win.webContents.executeJavaScript(`window.LN_NUM_LOCALE = ${loc}; window.renderLabel(${payload}).then(() => true)`);
    // 等一帧，确保字体和布局完成
    await this.win.webContents.executeJavaScript('new Promise(r => setTimeout(() => r(true), 60))');
  }

  async printNow(data, template, printCfg) {
    await this.render(data, template);
    const w = Math.max(10, Number(template.width) || 40);
    const h = Math.max(10, Number(template.height) || 30);
    return new Promise((resolve) => {
      this.win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: printCfg.printer || undefined,
          copies: Math.max(1, Number(printCfg.copies) || 1),
          margins: { marginType: 'none' },
          pageSize: { width: w * 1000, height: h * 1000 }, // 微米
          landscape: false,
        },
        (success, failureReason) => resolve(success ? { ok: true } : { ok: false, error: failureReason || $t('打印失败') })
      );
    });
  }
}

module.exports = { LabelPrinter };
