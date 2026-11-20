'use strict';
// 冒烟测试（LN_SMOKE=<截图路径>）：独立数据目录、不真实打印，跑完截图并退出。
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { requestCode } = require('./share');
const { BrowserLive } = require('./browser-live');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 截图偶尔会报「display surface not available」，重试几次；仍失败就返回空图，不影响后面的检查
async function capImg(wc) {
  for (let i = 0; i < 6; i++) {
    try {
      return await wc.capturePage();
    } catch {
      await wait(400);
    }
  }
  return { toPNG: () => Buffer.alloc(0) };
}

async function run(ctx) {
  const { win, store, handleChat, printer, loadTikTok, SMOKE } = ctx;
  const out = (suffix) => SMOKE.replace(/\.png$/, suffix);
  const check = (name, cond, extra = '') => console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log('[renderer]', e.level, e.message);
  });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1500);

  try {
    // 0. 商品 + 新客户
    store.upsertProduct({ code: '15', name: 'Áo thun', price: 120000, stock: 1, spec: 'L' });
    // 1. 抢单 + 补缺编号
    for (const [u, n, c] of [['user_a', 'Anphong', '15'], ['user_b', 'ChauMyyy', '15'], ['user_c', 'Thảo', '16'], ['user_d', 'Bảo Ngọc', '7']]) {
      handleChat({ uniqueId: u, nickname: n, comment: c, simulated: true });
    }
    await wait(300);
    let codes = Object.fromEntries(store.listCustomers().map((c) => [c.uniqueId, c.code]));
    const r15 = store.queryHistory({ uniqueId: 'user_a' }).rows[0];
    check('商品匹配+新客户', r15 && r15.productName === 'Áo thun' && r15.price === 120000 && r15.isNew === true && r15.newbie === '新', JSON.stringify(r15 && [r15.productName, r15.price, r15.isNew]));
    check('库存扣减', store.findProduct(15).stock === 0 && store.findProduct(15).sold === 1);
    handleChat({ uniqueId: 'user_z', nickname: 'Z', comment: '15', simulated: true });
    await wait(200);
    check('售罄不打印', !store.queryHistory({ uniqueId: 'user_z' }).rows.length);
    store.setSettings({ listMode: 'whitelist' });
    handleChat({ uniqueId: 'not_white', nickname: 'NW', comment: '40', simulated: true });
    store.addToList('whitelist', 'white_1');
    handleChat({ uniqueId: 'white_1', nickname: 'W1', comment: '41', simulated: true });
    await wait(300);
    check('白名单模式', !store.queryHistory({ uniqueId: 'not_white' }).rows.length && store.queryHistory({ uniqueId: 'white_1' }).rows.length === 1);
    store.setSettings({ listMode: 'blacklist' });
    store.deleteCustomers(['white_1']);
    check('递增编号', codes.user_a === 1 && codes.user_c === 2 && codes.user_d === 3 && !codes.user_b, JSON.stringify(codes));
    store.deleteCustomers(['user_c']);
    store.setSettings({ code: { mode: 'fill' } });
    handleChat({ uniqueId: 'user_e', nickname: 'Eva', comment: '20', simulated: true });
    await wait(300);
    check('补缺编号复用 2', store.data.customers.user_e?.code === 2, String(store.data.customers.user_e?.code));

    // 2. 共享编号：本机开主机，客户端申请
    store.setSettings({ share: { hostEnabled: true, port: 18699, key: 'k1' } });
    const urls = await ctx.applyShareServer();
    const r1 = await requestCode('http://127.0.0.1:18699', 'k1', 'remote_1', 'Remote One');
    const r2 = await requestCode('http://127.0.0.1:18699', 'k1', 'remote_1', 'Remote One');
    check('共享主机分配编号', r1.code === r2.code && r1.code > 0, JSON.stringify(r1) + ' ' + urls.running);
    let denied = false;
    try {
      await requestCode('http://127.0.0.1:18699', 'wrong', 'x', 'x');
    } catch (e) {
      denied = /密码/.test(e.message);
    }
    check('共享密码校验', denied);
    store.setSettings({ code: { mode: 'shared' }, share: { serverUrl: '127.0.0.1:18699', key: 'k1' } });
    handleChat({ uniqueId: 'user_f', nickname: 'Phúc', comment: '30', simulated: true });
    await wait(500);
    const fRec = store.queryHistory({ uniqueId: 'user_f' }).rows[0];
    check('共享模式弹幕拿到主机编号', fRec && fRec.code > 0 && fRec.status === 'off', JSON.stringify(fRec && [fRec.codeText, fRec.status]));
    store.setSettings({ share: { serverUrl: '127.0.0.1:1', key: 'k1' } });
    handleChat({ uniqueId: 'user_g', nickname: 'Giang', comment: '31', simulated: true });
    await wait(3000);
    const gRec = store.queryHistory({ uniqueId: 'user_g' }).rows[0];
    check('主机连不上时记为失败', gRec && gRec.status === 'fail' && gRec.code == null, gRec && gRec.error);
    store.setSettings({ code: { mode: 'increment' }, share: { hostEnabled: false } });
    await ctx.applyShareServer();

    // 3. 竞拍
    // 通过界面切到竞拍（走真实的 设置→保存 流程）
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.seg button')].find(r => r.textContent.trim() === '竞拍')?.click(); true;`);
    await wait(700);
    check('界面切换竞拍模式已保存', store.settings.grab.mode === 'auction', store.settings.grab.mode);
    // 界面会整体保存设置，所以测试用的短时长要在界面保存之后再写入
    store.setSettings({ auction: { seconds: 2, startMode: 'auto', minPrice: 10, step: 5, extendSeconds: 0, kSuffix: true } });
    handleChat({ uniqueId: 'bid_1', nickname: 'Bidder 1', comment: '10', simulated: true });
    handleChat({ uniqueId: 'bid_2', nickname: 'Bidder 2', comment: '12', simulated: true });
    handleChat({ uniqueId: 'bid_2', nickname: 'Bidder 2', comment: '1k', simulated: true });
    await wait(800);
    const shot = await capImg(win.webContents);
    fs.writeFileSync(out('-auction.png'), shot.toPNG());
    await wait(2000);
    const aRec = store.queryHistory({ uniqueId: 'bid_2' }).rows[0];
    check('竞拍成交打印最高价', aRec && aRec.amount === 1000 && aRec.bidCount === 2, JSON.stringify(aRec && [aRec.content, aRec.codeText]));

    // 4. 浏览器模式：用合成的 TikTok WebSocket 帧测试解码
    const proto = await import('tiktok-live-proto/v3');
    // decode 空数据得到字段齐全的默认对象（直接 encode 普通对象会因缺字段报错）
    const empty = new Uint8Array();
    const chat = proto.WebcastChatMessage.decode(empty);
    chat.common = Object.assign(proto.CommonMessageData.decode(empty), { msgId: '987654321' });
    chat.user = Object.assign(proto.User.decode(empty), { displayId: 'browser_user', nickname: 'Từ Trình Duyệt' });
    chat.content = '15';
    const chatBytes = proto.WebcastChatMessage.encode(chat).finish();
    const item = Object.assign(proto.BaseProtoMessage.decode(empty), { method: 'WebcastChatMessage', payload: chatBytes });
    const fetchRes = Object.assign(proto.ProtoMessageFetchResult.decode(empty), { messages: [item] });
    const fetchBytes = proto.ProtoMessageFetchResult.encode(fetchRes).finish();
    const lib = await loadTikTok();
    const frameBytes = lib.createBaseWebcastPushFrame({ payload: Buffer.from(fetchBytes) }).finish();
    const got = [];
    const bl = new BrowserLive({ loadLib: loadTikTok, onChat: (c) => got.push(c), log: () => {}, onStatus: () => {} });
    await bl.handleFrame(await loadTikTok(), Buffer.from(frameBytes).toString('base64'));
    check('浏览器模式帧解码', got[0]?.uniqueId === 'browser_user' && got[0]?.comment === '15', JSON.stringify(got[0]));

    // 5. 带条码/二维码的模板渲染成 PDF
    store.setSettings({ grab: { mode: 'grab' } });
    const tpl = JSON.parse(JSON.stringify(store.activeTemplate()));
    tpl.width = 50;
    tpl.elements.push(
      { id: 'bc', type: 'barcode', x: 40, y: 1, w: 9, h: 12, field: 'code', showText: true },
      { id: 'qr', type: 'qrcode', x: 40, y: 15, w: 9, h: 9, field: 'username' }
    );
    await printer.render({ ...aRec, codeText: 'A45' }, tpl);
    const pdf = await printer.win.webContents.printToPDF({ pageSize: { width: 50 / 25.4, height: 30 / 25.4 }, margins: { marginType: 'none' }, printBackground: true });
    fs.writeFileSync(out('-label.pdf'), pdf);
    const svgCount = await printer.win.webContents.executeJavaScript('document.querySelectorAll("#label svg").length');
    check('条码和二维码渲染', svgCount === 2, 'svg=' + svgCount);
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    check('标签 PDF 单页', pages === 1, 'pages=' + pages);

    // 5b. 悬浮大屏 + OBS
    {
      const { bigScreen } = ctx;
      store.setSettings({ grab: { mode: 'grab' }, screen: { style: 'dark', maskNames: true, alwaysOnTop: false } });
      for (const [u, n, c] of [['scr_1', 'Nguyễn Thị Hoa', '21'], ['scr_2', 'Trần Minh', '22'], ['scr_3', 'Lê An', '21']]) handleChat({ uniqueId: u, nickname: n, comment: c, simulated: true });
      await wait(6200); // 让前面竞拍测试的成交横幅过期
      bigScreen.open();
      await new Promise((r) => bigScreen.win.webContents.once('did-finish-load', r));
      await wait(900);
      const shot = async (suffix) => fs.writeFileSync(out(suffix), (await capImg(bigScreen.win.webContents)).toPNG());
      const dealHiddenAtStart = await bigScreen.win.webContents.executeJavaScript('getComputedStyle(document.getElementById("deal")).display === "none"');
      check('无成交时不显示横幅', dealHiddenAtStart);
      const before = await bigScreen.win.webContents.executeJavaScript('window.__slot = document.querySelector(".slot"); window.__key = window.__slot && window.__slot.dataset.key; [...document.querySelectorAll(".slot")].map(e => e.dataset.key + ":" + e.querySelector(".sec").textContent).join(",")');
      await wait(1300);
      const after = await bigScreen.win.webContents.executeJavaScript('({ same: document.contains(window.__slot) && window.__slot === document.querySelector(`.slot[data-key="${window.__key}"]`), keys: [...document.querySelectorAll(".slot")].map(e => e.dataset.key + ":" + e.querySelector(".sec").textContent).join(",") })');
      check('大屏倒计时增量更新不重建', after.same, `${before} → ${after.keys}`);
      await shot('-screen-dark.png');
      const txt = await bigScreen.win.webContents.executeJavaScript('document.body.innerText');
      check('大屏显示抢单号码和打码昵称', /21/.test(txt) && /22/.test(txt) && /Ng\*\*\*/.test(txt) && !/Nguyễn Thị Hoa/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 120));
      store.setSettings({ screen: { style: 'green' } });
      ctx.sendPanel();
      await wait(500);
      await shot('-screen-green.png');
      // 竞拍状态 + 成交横幅
      store.setSettings({ grab: { mode: 'auction' }, auction: { seconds: 30, startMode: 'auto', minPrice: 1, step: 1, extendSeconds: 0, kSuffix: true }, screen: { style: 'dark' } });
      handleChat({ uniqueId: 'scr_4', nickname: 'Phạm Quang', comment: '250k', simulated: true });
      await wait(700);
      await shot('-screen-auction.png');
      const atxt = await bigScreen.win.webContents.executeJavaScript('document.body.innerText');
      check('大屏竞拍最高价', /250\.000/.test(atxt), atxt.replace(/\s+/g, ' ').slice(0, 80));
      ctx.finishAuction(ctx.auction.finish());
      await wait(700);
      await shot('-screen-deal.png');
      const dealShown = await bigScreen.win.webContents.executeJavaScript('!document.getElementById("deal").hidden');
      check('大屏成交横幅', dealShown);
      // OBS 浏览器源
      store.setSettings({ screen: { obsEnabled: true, obsPort: 18639 } });
      const { url } = await ctx.applyObs();
      const page = await (await fetch(url)).text();
      const ctrl = new AbortController();
      const res = await fetch(url + 'events', { signal: ctrl.signal });
      const reader = res.body.getReader();
      let sse = '';
      while (!sse.includes('data:')) sse += new TextDecoder().decode((await reader.read()).value);
      ctrl.abort();
      check('OBS 页面和数据流', /screen\.js/.test(page) && /"mode":"auction"/.test(sse), url);
      store.setSettings({ screen: { obsEnabled: false }, grab: { mode: 'grab' } });
      await ctx.applyObs();
      bigScreen.close();
    }

    // 5c. 场次 / 弹幕取消 / 号码计价 / 发货汇总
    {
      const sess = store.startSession('冒烟测试场');
      check('新场次流水归零', store.data.counters.serial === 0 && store.currentSession().id === sess.id);
      store.setSettings({
        grab: { mode: 'grab', limit: 1, seconds: 50 },
        cancel: { enabled: true, keywords: 'hủy, huỷ, huy, 取消', minutes: 120 },
        products: { enabled: true, requireMatch: false, blockOutOfStock: true, numberAsPrice: true, multiplier: 1000 },
        monitor: { limitMode: 'range', min: 1, max: 200, pureNumber: true },
      });
      store.upsertProduct({ code: '88', name: 'Váy hoa', price: 199000, stock: 1, spec: 'M' });
      handleChat({ uniqueId: 'buyer_a', nickname: 'Mai Anh', comment: '88', simulated: true });
      await wait(300);
      handleChat({ uniqueId: 'buyer_b', nickname: 'Thu Hà', comment: '88', simulated: true });
      await wait(200);
      check('售罄挡住第二人', !store.queryHistory({ uniqueId: 'buyer_b', sessionId: sess.id }).rows.length);
      handleChat({ uniqueId: 'buyer_a', nickname: 'Mai Anh', comment: 'hủy 88', simulated: true });
      await wait(200);
      const ca = store.queryHistory({ uniqueId: 'buyer_a', sessionId: sess.id }).rows[0];
      check('弹幕取消订单+退库存', ca && ca.cancelled && ca.cancelledBy === 'buyer' && store.findProduct(88).stock === 1, JSON.stringify(ca && [ca.cancelled, store.findProduct(88).stock]));
      handleChat({ uniqueId: 'buyer_b', nickname: 'Thu Hà', comment: '88', simulated: true });
      await wait(300);
      check('取消后名额让给别人', store.queryHistory({ uniqueId: 'buyer_b', sessionId: sess.id }).rows.length === 1);
      handleChat({ uniqueId: 'buyer_b', nickname: 'Thu Hà', comment: '150', simulated: true });
      handleChat({ uniqueId: 'buyer_c', nickname: 'Quốc Bảo', comment: '133', simulated: true });
      await wait(400);
      const p150 = store.queryHistory({ uniqueId: 'buyer_b', content: '150', exact: true }).rows[0];
      check('号码计价', p150 && p150.price === 150000, String(p150 && p150.price));
      const sm = store.summary({ sessionId: sess.id });
      const bRow = sm.customers.find((c) => c.uniqueId === 'buyer_b');
      check('发货汇总按客户合并', sm.totals.customers === 2 && bRow.qty === 2 && bRow.total === 349000 && !sm.customers.find((c) => c.uniqueId === 'buyer_a'), JSON.stringify(sm.totals) + ' ' + (bRow && bRow.itemsText));
      const pdf = await ctx.renderSummaryPdf({ sessionId: sess.id, name: sess.name });
      fs.writeFileSync(out('-summary.pdf'), pdf);
      {
        const tpl = store.settings.templates.find((t) => t.name.startsWith('发货单'));
        const c = store.summary({ sessionId: sess.id }).customers.find((x) => x.uniqueId === 'buyer_b');
        await printer.render({ codeText: c.codeText, nickname: c.nickname, uniqueId: c.uniqueId, itemsText: c.itemsText, qty: c.qty, total: c.total, time: Date.now() }, tpl);
        const lp = await printer.win.webContents.printToPDF({ pageSize: { width: 40 / 25.4, height: 30 / 25.4 }, margins: { marginType: 'none' }, printBackground: true });
        const txt = await printer.win.webContents.executeJavaScript('document.body.innerText');
        check('发货单模板', !!tpl && /Váy hoa/.test(txt) && /共2件/.test(txt) && /349\.000/.test(txt) && (lp.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length === 1, txt.replace(/\s+/g, ' '));
        const { BrowserWindow } = require('electron');
        const w = new BrowserWindow({ width: 400, height: 300, show: true, webPreferences: { sandbox: true } });
        await w.loadFile(require('node:path').join(__dirname, 'renderer', 'label.html'));
        await w.webContents.executeJavaScript(`document.body.style.zoom = 2.4; window.renderLabel(${JSON.stringify({ data: { codeText: c.codeText, nickname: c.nickname, itemsText: c.itemsText, qty: c.qty, total: c.total, time: Date.now() }, template: tpl })}).then(() => true)`);
        await wait(800);
        try {
          fs.writeFileSync(out('-shiplabel.png'), (await capImg(w.webContents)).toPNG());
        } catch (e) {
          console.log('[smoke] (截图跳过：' + e.message + ')');
        }
        w.destroy();
      }
      check('A4 汇总 PDF', pdf.length > 5000 && pdf.toString('latin1').includes('/MediaBox'), pdf.length + ' bytes');
      handleChat({ uniqueId: 'buyer_c', nickname: 'Quốc Bảo', comment: 'hủy', simulated: true });
      await wait(200);
      check('hủy 不带号码取消最近一单', store.queryHistory({ uniqueId: 'buyer_c', sessionId: sess.id }).rows[0].cancelled === true);
    }

    // 5e. 重复下单 / #号写法 / 共享主机自动密码 / 环境自检
    {
      store.setSettings({ grab: { mode: 'unlimited' }, dedupe: { mode: 'window', seconds: 60 } });
      handleChat({ uniqueId: 'dup_u', nickname: 'Dup', comment: '#140', simulated: true });
      await wait(250);
      handleChat({ uniqueId: 'dup_u', nickname: 'Dup', comment: '140!!', simulated: true });
      handleChat({ uniqueId: 'dup_u', nickname: 'Dup', comment: '140 140', simulated: true });
      await wait(250);
      check('#号写法命中 + 刷屏只算一单', store.queryHistory({ uniqueId: 'dup_u' }).rows.length === 1, String(store.queryHistory({ uniqueId: 'dup_u' }).rows.length));
      store.setSettings({ dedupe: { mode: 'none' } });
      handleChat({ uniqueId: 'dup_u', nickname: 'Dup', comment: '140', simulated: true });
      await wait(250);
      check('每条都算模式可买多件', store.queryHistory({ uniqueId: 'dup_u' }).rows.length === 2);
      store.setSettings({ dedupe: { mode: 'window', seconds: 60 }, grab: { mode: 'grab' } });

      store.setSettings({ share: { hostEnabled: true, port: 18698, key: '' } });
      await ctx.applyShareServer();
      const key = store.settings.share.key;
      let noKeyRejected = false;
      try {
        await requestCode('http://127.0.0.1:18698', '', 'k_test', 'K');
      } catch {
        noKeyRejected = true;
      }
      const withKey = await requestCode('http://127.0.0.1:18698', key, 'k_test', 'K').then(() => true, () => false);
      check('共享主机自动生成密码', /^[a-z0-9]{6}$/.test(key) && noKeyRejected && withKey, key);
      store.setSettings({ share: { hostEnabled: false } });
      await ctx.applyShareServer();

      const items = await ctx.runSelfCheck();
      const byName = Object.fromEntries(items.map((i) => [i.name, i]));
      check('环境自检', items.length >= 8 && byName['数据目录可写'].ok && byName['已选择打印机'] && byName['能访问 TikTok'], items.map((i) => `${i.ok ? '✓' : '✗'}${i.name}:${i.detail}`).join(' | '));
    }

    // 5d. 稳定性：崩溃兜底、界面崩溃自动恢复、打印窗口重建、语音队列、日志文件
    {
      const logDir = require('node:path').join(app.getPath('userData'), 'logs');
      process.emit('uncaughtException', new Error('smoke-boom-123'));
      await wait(200);
      const todayLog = () => {
        const f = fs.readdirSync(logDir).sort().pop();
        return f ? fs.readFileSync(require('node:path').join(logDir, f), 'utf8') : '';
      };
      check('未处理错误不退出且写入日志', /smoke-boom-123/.test(todayLog()) && !win.isDestroyed());
      check('运行日志写文件', /==== 启动/.test(todayLog()) && /编号/.test(todayLog()));

      win.webContents.forcefullyCrashRenderer();
      let back = false;
      for (let i = 0; i < 30 && !back; i++) {
        await wait(300);
        back = await win.webContents.executeJavaScript('!!document.querySelector(".shell")').catch(() => false);
      }
      check('界面崩溃后自动恢复', back);
      handleChat({ uniqueId: 'after_crash', nickname: 'AC', comment: '177', simulated: true });
      await wait(300);
      check('界面崩溃期间打单不受影响', store.queryHistory({ uniqueId: 'after_crash' }).rows.length === 1, JSON.stringify({ m: store.settings.monitor, g: store.settings.grab, d: store.settings.dedupe, l: store.settings.listMode, c: store.settings.code.mode, p: store.settings.products, cancel: store.settings.cancel.enabled }));

      await printer.ensureWindow();
      printer.win.webContents.forcefullyCrashRenderer();
      await wait(500);
      let reOk = false;
      try {
        await printer.render({ codeText: '9', nickname: 'X', content: '1', time: Date.now() }, store.activeTemplate());
        reOk = /9/.test(await printer.win.webContents.executeJavaScript('document.body.innerText'));
      } catch (e) {
        console.log('[smoke] printer re-render error', e.message);
      }
      check('打印窗口崩溃后自动重建', reOk);

      const v = await win.webContents.executeJavaScript(`(() => {
        const spoken = [];
        const orig = speechSynthesis.speak.bind(speechSynthesis);
        speechSynthesis.speak = (u) => spoken.push(u);
        for (let i = 1; i <= 10; i++) window.__lnTest.speakHit({ codeText: String(i), content: 'c' + i });
        const first = spoken.length;
        spoken[0].onend();
        const second = spoken.length;
        const secondText = spoken[1] && spoken[1].text;
        spoken[1] && spoken[1].onend();
        const third = spoken.length;
        speechSynthesis.speak = orig;
        return { first, second, secondText, third };
      })()`);
      check('语音只积压最新一条', v.first === 1 && v.second === 2 && /^10号/.test(v.secondText) && v.third === 2, JSON.stringify(v));
    }

    // 5f. 关闭窗口 = 隐藏到托盘，继续打单
    {
      store.setSettings({ closeToTray: true, grab: { mode: 'grab' } });
      win.close();
      await wait(400);
      const hidden = !win.isDestroyed() && !win.isVisible();
      handleChat({ uniqueId: 'tray_user', nickname: 'Tray', comment: '188', simulated: true });
      await wait(300);
      const stillWorks = store.queryHistory({ uniqueId: 'tray_user' }).rows.length === 1;
      check('关闭窗口隐藏到托盘、继续打单', hidden && stillWorks, JSON.stringify({ hidden, stillWorks, tipShown: store.settings.trayTipShown }));
      win.show();
      await wait(600);
      check('从托盘恢复窗口', win.isVisible());
    }

        // 6. 各页面截图（深色 + 浅色）
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.seg button')].find(r => r.textContent.trim() === '抢单')?.click(); true;`);
    await wait(500);
    const st = store.stats(0, Date.now() + 1);
    check('统计汇总', st.orders >= 5 && st.amount >= 120000 && st.hours.reduce((a, b) => a + b, 0) === st.orders, JSON.stringify({ o: st.orders, a: st.amount, b: st.buyers }));

    // 控制台重打：打印失败 → 弹幕流显示「打印失败」→ 点「重打」→ 成功（假打印机，不真实出纸）
    {
      const realPrint = printer.print;
      let calls = 0;
      printer.print = async () => (++calls, { ok: false, error: '测试：缺纸' });
      store.setSettings({ print: { enabled: true, retry: 0 } });
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('直播控制台'))?.click(); true;`);
      handleChat({ uniqueId: 'rp_user', nickname: 'Reprint', comment: '199', simulated: true });
      await wait(900);
      const rowText = () => win.webContents.executeJavaScript(`[...document.querySelectorAll('.stream .el-table__body tr')].find(tr => tr.textContent.includes('rp_user'))?.textContent || ''`);
      const failRow = await rowText();
      const rec = store.queryHistory({ uniqueId: 'rp_user' }).rows[0];
      check('打印失败显示在弹幕流', rec && rec.status === 'fail' && /打印失败/.test(failRow) && /重打/.test(failRow), failRow.replace(/\s+/g, ' ').slice(0, 80));
      printer.print = async () => (++calls, { ok: true });
      await win.webContents.executeJavaScript(`(() => { const tr = [...document.querySelectorAll('.stream .el-table__body tr')].find(tr => tr.textContent.includes('rp_user')); [...tr.querySelectorAll('button')].find(b => b.textContent.trim() === '重打').click(); return true; })()`);
      await wait(900);
      const after = store.getHistory(rec.id);
      const okRow = await rowText();
      const cardBtn = await win.webContents.executeJavaScript(`!![...document.querySelectorAll('.hit-card')].find(c => c.textContent.includes('rp_user'))?.querySelector('.h-reprint')`);
      check('弹幕流点重打成功', after.status === 'ok' && after.reprints === 1 && /已打印/.test(okRow) && cardBtn && calls === 2, JSON.stringify({ s: after.status, r: after.reprints, calls, cardBtn }));
      printer.print = realPrint;
      store.setSettings({ print: { enabled: false } });
    }
    const clickNav = (label) => win.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('${label}'))?.click(); true;`);
    let img = await capImg(win.webContents);
    fs.writeFileSync(SMOKE, img.toPNG());
    for (const [label, suffix] of [['数据统计', '-stats.png'], ['商品信息', '-products.png'], ['系统设置', '-settings.png'], ['发货汇总', '-summary.png'], ['打印历史', '-history.png'], ['客户编号', '-customers.png']]) {
      await clickNav(label);
      await wait(900);
      fs.writeFileSync(out(suffix), (await capImg(win.webContents)).toPNG());
    }
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.theme-toggle button')][1].click(); true;`);
    await clickNav('直播控制台');
    await wait(900);
    fs.writeFileSync(out('-light.png'), (await capImg(win.webContents)).toPNG());
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.theme-toggle button')][0].click(); true;`);
    await wait(300);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '设计')?.click(); true;`);
    await wait(800);
    // 选中第二个组件看属性面板
    await win.webContents.executeJavaScript(`(() => { const el = document.querySelectorAll('.design-el')[1]; const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 5 + 40, clientY: r.top + 5 }));
      window.dispatchEvent(new MouseEvent('mouseup', {})); return true; })()`);
    await wait(500);
    img = await capImg(win.webContents);
    fs.writeFileSync(out('-designer.png'), img.toPNG());
    const moved = store.activeTemplate();
    await wait(600);
    const el1 = store.activeTemplate().elements[1];
    check('设计器拖动组件', el1.x !== 8, `x=${el1.x}`);
    void moved;

    // 多语言：切到越南语 → 默认文字、模板名、托盘跟着换；界面重新加载后是越南语；再切回中文
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.el-dialog__headerbtn, .designer-done')].forEach((b) => b.click()); true;`);
    await wait(300);
    store.setSettings({ screen: { title: 'LIVE 抢单' } });
    await win.webContents.executeJavaScript(`window.api.invoke('lang:set', 'vi').then(() => location.reload())`);
    await wait(2500);
    const vi = {
      lang: store.settings.lang,
      title: store.settings.screen.title,
      tpl: store.settings.templates.map((t) => t.name).join('|'),
      nav: await win.webContents.executeJavaScript(`document.querySelector('.nav-item')?.textContent.trim()`),
      elBtn: await win.webContents.executeJavaScript(`!!window.ElementPlusLocaleVi`),
    };
    check('切换越南语', vi.lang === 'vi' && vi.title === 'LIVE CHỐT ĐƠN' && /Mẫu mặc định/.test(vi.tpl) && /Bảng điều khiển/.test(vi.nav || ''), JSON.stringify(vi));
    handleChat({ uniqueId: 'vi_user', nickname: 'Vi', comment: '1', simulated: true });
    await wait(500);
    const viRow = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.stream .el-table__body tr')].find(tr => tr.textContent.includes('vi_user'))?.textContent || ''`);
    check('越南语界面弹幕结果', /Chốt|Số đã|Đặt lại|Không có/.test(viRow), viRow.replace(/\s+/g, ' ').slice(0, 80));
    await win.webContents.executeJavaScript(`window.api.invoke('lang:set', 'zh').then(() => location.reload())`);
    await wait(2500);
    // 国家/站点：泰国 → 卖家中心域名、取消关键词、金额格式
    await win.webContents.executeJavaScript(`window.api.invoke('country:apply', 'TH').then(() => location.reload())`);
    await wait(2500);
    const th = {
      host: store.settings.shop.host,
      cancel: store.settings.cancel.keywords,
      money: await win.webContents.executeJavaScript(`window.api.i18n.numLocale + ' ' + Number(1234567).toLocaleString(window.api.i18n.numLocale)`),
    };
    check('切换国家到泰国', th.host === 'seller-th.tiktok.com' && /ยกเลิก/.test(th.cancel) && th.money === 'th-TH 1,234,567', JSON.stringify(th));
    await win.webContents.executeJavaScript(`window.api.invoke('country:apply', 'VN').then(() => location.reload())`);
    await wait(2500);
    check('切回越南站', store.settings.shop.host === 'seller-vn.tiktok.com' && store.settings.country === 'VN');
    check('切回中文', store.settings.lang === 'zh' && store.settings.screen.title === 'LIVE 抢单' && /默认模板/.test(store.settings.templates[0].name), store.settings.screen.title);
  } catch (e) {
    console.log('[smoke] ERROR', e.stack);
  }
  console.log('[smoke] done');
  app.quit();
}

module.exports = { run };
void pathToFileURL;
