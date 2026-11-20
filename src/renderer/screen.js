// 悬浮大屏页面：在 Electron 窗口里通过 preload 的 api 收数据；在 OBS 浏览器源里通过 /events（SSE）收数据。
// 按 key 增量更新 DOM：倒计时每秒变化时只改数字和圆环，卡片不会反复重建闪烁。
(function () {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const stage = $('stage');
  const hitsEl = $('hits');
  const inApp = !!window.api;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let numLocale = (window.api && window.api.i18n && window.api.i18n.numLocale) || (window.__LN_I18N && window.__LN_I18N.numLocale) || 'vi-VN';
  const money = (v) => (v == null || isNaN(Number(v)) ? v ?? '' : Number(v).toLocaleString(numLocale));
  const setText = (el, t) => {
    t = String(t);
    if (el.textContent !== t) el.textContent = t;
  };

  // ---------------- 倒计时圆环 ----------------
  const RING = 2 * Math.PI * 22;
  const RING_HTML = `<div class="ring"><svg viewBox="0 0 50 50">
      <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs>
      <circle class="bg" cx="25" cy="25" r="22" fill="none" stroke-width="5"/>
      <circle class="fg" cx="25" cy="25" r="22" fill="none" stroke-width="5" stroke-linecap="round" stroke-dasharray="${RING}" stroke-dashoffset="0"/>
    </svg><div class="sec"></div></div>`;
  function updateRing(el, left, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
    el.querySelector('.fg').setAttribute('stroke-dashoffset', String(RING * (1 - ratio)));
    setText(el.querySelector('.sec'), left);
    el.classList.toggle('urgent', left <= 5);
  }

  // ---------------- 主区域：视图切换 ----------------
  let view = ''; // 'idle' | 'slots' | 'auction'
  function useView(name, html) {
    if (view === name) return false;
    view = name;
    stage.innerHTML = html;
    return true;
  }

  function renderIdle(t1, t2, range) {
    useView('idle', '<div class="idle"><div class="t1"></div><div class="range"></div><div class="t2"></div></div>');
    setText(stage.querySelector('.t1'), t1);
    setText(stage.querySelector('.t2'), t2);
    const r = stage.querySelector('.range');
    setText(r, range || '');
    r.hidden = !range;
  }

  function renderGrab(st) {
    const g = st.grab || {};
    const slots = g.slots || [];
    if (!slots.length) return renderIdle(st.mode === 'grab' ? $t('扣号抢单中') : $t('下单中'), st.hint || $t('评论区发送号码即可下单'), st.rangeText);
    useView('slots', '');
    const keep = new Set(slots.map((s) => String(s.key)));
    for (const el of [...stage.children]) if (!keep.has(el.dataset.key)) el.remove();
    slots.forEach((s, i) => {
      const key = String(s.key);
      let el = stage.querySelector(`.slot[data-key="${CSS.escape(key)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'slot';
        el.dataset.key = key;
        el.innerHTML = `<div class="big">${esc(key)}</div><div class="info"><div class="label">${$t('号码')}</div><div class="count"><span class="n"></span><small class="lim"></small><span class="full">${$t('已抢完')}</span></div></div>${RING_HTML}`;
      }
      if (stage.children[i] !== el) stage.insertBefore(el, stage.children[i] || null); // 保持顺序（最新的在上）
      const full = st.mode === 'grab' && s.count >= g.limit;
      el.classList.toggle('hot', !full);
      setText(el.querySelector('.n'), s.count);
      setText(el.querySelector('.lim'), $t(' / {0} 人', g.limit));
      el.querySelector('.full').hidden = !full;
      updateRing(el.querySelector('.ring'), s.left, g.seconds);
    });
  }

  let lastAmount = null;
  function renderAuction(st) {
    const a = st.auction || {};
    if (!a.active) {
      lastAmount = null;
      return renderIdle($t('竞拍即将开始'), st.hint && !['评论区发送号码即可下单', $t('评论区发送号码即可下单')].includes(st.hint) ? st.hint : $t('评论区出价，价高者得'));
    }
    useView(
      'auction',
      `<div class="auction"><div class="label">${$t('当前最高价')}</div><div class="price"></div><div class="leader"></div>${RING_HTML}<div class="meta"></div></div>`
    );
    const price = stage.querySelector('.price');
    setText(price, a.amount ? money(a.amount) : '—');
    if (lastAmount !== null && a.amount !== lastAmount) {
      price.classList.remove('bump');
      void price.offsetWidth; // 重新触发动画
      price.classList.add('bump');
    }
    lastAmount = a.amount;
    setText(stage.querySelector('.leader'), a.leader ? '👑 ' + a.leader : $t('等待出价'));
    setText(stage.querySelector('.meta'), $t('{0} 次出价', a.count));
    updateRing(stage.querySelector('.ring'), a.left, a.total);
  }

  // ---------------- 最新下单 ----------------
  let hitsKey = null;
  let seenHits = new Set();
  function renderHits(hits) {
    const key = hits.map((h) => h.id).join(',');
    if (key === hitsKey) return;
    const first = hitsKey === null;
    hitsKey = key;
    hitsEl.innerHTML = hits.length
      ? hits
          .map((h) => {
            const fresh = !first && !seenHits.has(h.id);
            return `<li class="${fresh ? 'fresh' : ''}"><span class="code">${esc(h.codeText)}</span><span class="name">${esc(h.name)}</span>${
              h.isNew ? $t('<span class="new">新</span>') : ''
            }<span class="what">${esc(h.what)}</span></li>`;
          })
          .join('')
      : $t('<li class="empty">还没有订单</li>');
    seenHits = new Set(hits.map((h) => h.id));
  }

  // ---------------- 总渲染 ----------------
  let lastState = null;
  document.title = $t('悬浮大屏');
  const loadedLang = (window.LN_I18N && window.LN_I18N.getLang()) || 'zh';
  function render(st) {
    // 主程序切换了界面语言：重新加载页面拿新词典（窗口和 OBS 浏览器源都适用）
    if (st.lang && st.lang !== loadedLang) return location.reload();
    if (st.numLocale) numLocale = st.numLocale;
    lastState = st;
    const cls = 'style-' + (st.style || 'dark') + (inApp ? '' : ' obs');
    if (root.className !== cls) root.className = cls;
    document.documentElement.style.setProperty('--scale', st.scale || 1);
    setText($('title'), st.title || $t('LIVE 抢单'));
    $('liveDot').classList.toggle('on', st.status === 'connected');
    $('today').innerHTML = st.showToday ? `${$t('今日')} <b>${Number(st.today) || 0}</b> ${$t('单')}` : '';
    $('btnPin').classList.toggle('on', !!st.alwaysOnTop);
    $('hitsBox').hidden = !st.showHits;

    if (st.mode === 'auction') renderAuction(st);
    else renderGrab(st);
    renderHits(st.hits || []);
    renderDeal();
  }

  // 竞拍成交横幅：显示 6 秒
  function renderDeal() {
    const deal = lastState && lastState.deal;
    const show = !!deal && Date.now() - deal.time < 6000;
    $('deal').hidden = !show;
    if (show) {
      setText($('dealAmount'), money(deal.amount));
      setText($('dealName'), deal.name);
    }
  }
  setInterval(renderDeal, 500);

  // ---------------- 数据来源 ----------------
  if (inApp) {
    window.api.on('screen', render);
    window.api.invoke('screen:state').then(render);
    $('btnClose').onclick = () => window.api.invoke('screen:close');
    $('btnPin').onclick = () => window.api.invoke('screen:togglePin');
  } else {
    root.classList.add('obs');
    const es = new EventSource('/events');
    es.onmessage = (e) => render(JSON.parse(e.data));
  }
})();
