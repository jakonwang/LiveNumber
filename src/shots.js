'use strict';
// 界面巡检：LN_SHOTS=<输出目录>，按几种常见窗口尺寸、两种主题截下每个页面。
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ win, store, handleChat, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1200);
  const js = (code) => win.webContents.executeJavaScript(code);
  // 造一些数据
  store.upsertProduct({ code: '15', name: 'Áo thun cổ tròn oversize', price: 120000, stock: 5, spec: 'L / Trắng' });
  store.upsertProduct({ code: '16', name: 'Quần jean', price: 259000, stock: 0, spec: '29' });
  const people = [['nguyen_an', 'Nguyễn Văn An 🌸'], ['tran_binh', 'Trần Bình'], ['le_chi_9999_long_username', 'Lê Thị Chi rất dài tên hiển thị'], ['pham_d', 'Phạm Dũng']];
  people.forEach(([u, n], i) => handleChat({ uniqueId: u, nickname: n, comment: String(15 + i), simulated: true }));
  handleChat({ uniqueId: 'x1', nickname: 'X', comment: 'hello shop', simulated: true });
  await wait(800);

  // 订单备注页：塞几张假订单看排版
  await js(`(() => { const st = window.__lnTest;
    st.sp.status.loggedIn = true; st.sp.status.shop = { id: '1234567890123456789', name: 'Demo Shop', region: 'VN' };
    const mk = (i, match, extra) => ({ id: '58729' + (1000000000000 + i), createTime: Date.now() - i * 60000, buyer: 'p*********' + i, amount: 39200, amountText: '39.200₫', items: [{ name: '#41 Bông Tai Khoen Nữ Đính 2 Đá Zircon, Thiết Kế Tối Giản', sellerSku: 'A-278', qty: 1 }], hasNote: false, match, user: match === 'ok' ? 'phuong1234' + i : '', code: 40 + i, note: match === 'ok' ? '【' + (40 + i) + '】phuong1234' + i : '', candidates: ['a', 'b'], merged: 0, noted: '', ...extra });
    st.sp.orders = [mk(1, 'ok'), mk(2, 'ok', { noted: '【42】phuong12342' }), mk(3, 'ambiguous'), mk(4, 'nomatch'), mk(5, 'used'), mk(6, 'ok', { merged: 2 })];
    return true; })()`);
  // LN_CLICKTEST=<文件>：打开模板设计器，把「完成」按钮的屏幕坐标写到文件，等外部用真实鼠标点击，再写结果
  if (process.env.LN_CLICKTEST) {
    const f = process.env.LN_CLICKTEST;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 820);
    win.center();
    win.show();
    win.focus();
    await js(`window.__lnTest.showDesigner.value = true; true;`);
    await wait(1200);
    const r = await js(`(() => { const b = document.querySelector('.designer-done').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    const cb = win.getContentBounds();
    fs.writeFileSync(f, JSON.stringify({ x: Math.round(cb.x + r.x), y: Math.round(cb.y + r.y) }));
    for (let i = 0; i < 40 && !fs.existsSync(f + '.clicked'); i++) await wait(500);
    await wait(800);
    fs.writeFileSync(f + '.result', JSON.stringify({ closed: await js(`!window.__lnTest.showDesigner.value`) }));
    app.quit();
    return;
  }
  const shots = [];
  for (const [w, h] of [[1440, 820], [1280, 720], [1024, 660]]) {
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(w, h);
    await wait(400);
    console.log('[shots] size', w, h, '→ inner', await js('window.innerWidth + "x" + window.innerHeight'));
    for (const theme of ['dark', 'light']) {
      await js(`[...document.querySelectorAll('.theme-toggle button')][${theme === 'dark' ? 0 : 1}].click(); true;`);
      // 按侧边栏位置点（任何界面语言都适用）
      const NAVS = [['直播控制台', 0], ['打印历史', 1], ['发货汇总', 2], ['订单备注', 3], ['商品信息', 4], ['名单管理', 5], ['数据统计', 7], ['系统设置', 8]];
      for (const [nav, idx] of NAVS) {
        if (theme === 'light' && !['直播控制台', '数据统计'].includes(nav)) continue;
        await js(`document.querySelectorAll('.nav-item')[${idx}]?.click(); true;`);
        await wait(700);
        // 记录有没有横向溢出
        const overflow = await js(`(() => { const p = document.querySelector('.page'); const t = document.querySelector('.topbar'); return { page: p.scrollWidth - p.clientWidth, topbar: t.scrollWidth - t.clientWidth }; })()`);
        const file = path.join(dir, `${process.env.LN_LANG || 'zh'}-${w}x${h}-${theme}-${nav}.png`);
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        shots.push(`${path.basename(file)} overflow=${JSON.stringify(overflow)}`);
      }
    }
  }
  if (process.env.LN_LANG && process.env.LN_LANG !== 'zh') {
    console.log('[shots]\n' + shots.join('\n'));
    return app.quit(); // 下面的检查按中文文字找按钮，只在中文界面跑
  }
  // 表单里的按钮不能触发整页刷新：系统设置 → 悬浮大屏风格点「绿幕」
  await js(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('系统设置'))?.click(); window.__noReload = 1; true;`);
  await wait(600);
  await js(`[...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '绿幕').click(); true;`);
  await wait(800);
  const after = await js(`({ noReload: window.__noReload === 1, page: document.querySelector('.page-title')?.textContent, greenOn: [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '绿幕')?.classList.contains('on') })`);
  shots.push('screen style click ' + JSON.stringify(after));
  await js(`[...document.querySelectorAll('.seg button')].find(b => b.textContent.trim() === '深色玻璃').click(); true;`);
  // 模板设计器（全屏弹窗）：右上角会被窗口按钮挡住，要能看到「完成」按钮
  win.setContentSize(1440, 820);
  await wait(300);
  await js(`window.__lnTest.showDesigner.value = true; true;`);
  await wait(900);
  const doneBtn = await js(`(() => { const b = document.querySelector('.designer-done'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: innerWidth }; })()`);
  fs.writeFileSync(path.join(dir, 'designer.png'), (await win.webContents.capturePage()).toPNG());
  shots.push('designer done-button ' + JSON.stringify(doneBtn));
  await js(`document.querySelector('.designer-done').click(); true;`);
  await wait(500);
  shots.push('designer closed by button: ' + (await js(`!window.__lnTest.showDesigner.value`)));
  console.log('[shots]\n' + shots.join('\n'));
  app.quit();
}

module.exports = { run };
