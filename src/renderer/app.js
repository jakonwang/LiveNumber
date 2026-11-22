/* global Vue, ElementPlus */
const { createApp, reactive, ref, computed, watch, nextTick, onMounted, toRaw } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;
// window.api 由 preload.js 注入，这里直接用全局的 api

const pad = (n) => String(n).padStart(2, '0');
const hms = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fullTime = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms(t)}`;
};
const NUM_LOCALE = (window.api && window.api.i18n && window.api.i18n.numLocale) || 'vi-VN';
const money = (v) => (v == null || v === '' || isNaN(Number(v)) ? v ?? '' : Number(v).toLocaleString(NUM_LOCALE));
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const STATUS_TEXT = { idle: $t('未连接'), connecting: $t('连接中'), connected: $t('直播中'), ended: $t('已下播'), error: $t('连接出错') };
const VN_NAMES = ['Nguyễn An', 'Trần Bình', 'Lê Chi', 'Phạm Dũng', 'Hoàng Giang', 'Võ Hà', 'Đặng Khoa', 'Bùi Lan'];
const RANGES = [
  { key: 'today', label: $t('今天') },
  { key: 'yesterday', label: $t('昨天') },
  { key: '7d', label: $t('近 7 天') },
  { key: '30d', label: $t('近 30 天') },
  { key: 'custom', label: $t('自定义') },
];

createApp({
  setup() {
    const ready = ref(false);
    const page = ref('console');
    const version = ref('');
    const now = ref(Date.now());
    const s = reactive({});
    const counters = reactive({ nextCode: 1, serial: 0 });
    const stats = reactive({ total: 0, failed: 0, queue: 0 });
    const status = reactive({ status: 'idle', user: '', mode: 'api', error: '' });
    const printers = ref([]);
    const userData = ref('');
    const logs = ref([]);
    const logBox = ref(null);
    const chats = ref([]);
    const hits = ref([]);
    const onlyHits = ref(false);
    const grabSlots = ref([]);
    document.title = 'LiveNumber · ' + $t('直播扣号打单');
    const showDesigner = ref(false);
    // ---------- 语言 / 国家 ----------
    const I18N = (window.api && window.api.i18n) || { lang: 'zh', langs: window.LN_I18N.LANGS, countries: [] };
    const LANGS = I18N.langs;
    const COUNTRIES = I18N.countries;
    const uiLang = ref(I18N.lang);
    async function changeLang(code) {
      if (code === I18N.lang) return;
      await flushSettings();
      await api.invoke('lang:set', code);
      location.reload(); // 重新加载拿新词典（打单在主进程，不受影响）
    }
    async function applyCountry(code) {
      const c = COUNTRIES.find((x) => x.code === code);
      if (!c || code === s.country) return;
      try {
        await ElMessageBox.confirm(
          $t('切换到「{0}」：\n· 金额格式：{1}\n· TikTok Shop 卖家中心：{2}\n· 取消关键词：{3}', c.name, Number(1234567).toLocaleString(c.numLocale), c.host, c.cancel),
          $t('国家 / 站点'),
          { type: 'info' }
        );
      } catch {
        return;
      }
      await flushSettings();
      await api.invoke('country:apply', code);
      const lang = LANGS.find((l) => l.code === c.lang);
      if (c.lang !== I18N.lang && lang) {
        const yes = await ElMessageBox.confirm($t('界面语言也改成 {0} 吗？', lang.label), $t('界面语言'), { type: 'info' }).then(() => true).catch(() => false);
        if (yes) {
          await api.invoke('lang:set', c.lang);
        }
      }
      location.reload(); // 金额格式按新国家显示
    }
    window.__lnTest = Object.assign(window.__lnTest || {}, { showDesigner });
    const auctionState = ref({ active: false });
    const lanUrls = ref([]);
    const shareRunning = ref(false);
    const screenOpen = ref(false);
    const obsUrl = ref('');
    const counts = reactive({ products: 0, blacklist: 0, whitelist: 0, customers: 0 });
    const today = reactive({ orders: 0, buyers: 0, newBuyers: 0, amount: 0 });

    const sim = reactive({ uniqueId: 'test_user', nickname: 'Test', comment: '' });
    const session = ref(null);
    const sessions = ref([]);
    const sm = reactive({ sessionId: '', range: null, search: '', templateId: '', data: { customers: [], totals: { customers: 0, qty: 0, amount: 0 } } });
    const hq = reactive({ sessionId: '', range: null, status: 'all', serial: '', code: '', uniqueId: '', nickname: '', content: '', exact: false });
    const history = reactive({ total: 0, rows: [] });
    const nl = reactive({ kind: 'blacklist', uniqueId: '', nickname: '', note: '', search: '', list: [] });
    const cs = reactive({ search: '', list: [], selected: [] });
    const pd = reactive({ search: '', list: [], selected: [], dialog: false, form: {} });
    const sp = reactive({
      status: { loggedIn: false, shop: null, host: '' }, fields: [], busy: false, loading: false, checking: false,
      orders: [], selected: [], filter: 'all', search: '', orderStatus: 'to_ship', loadedStatus: 'to_ship',
      cookieDialog: false, cookieText: '', cookieLoading: false,
      noteDialog: false, noteRow: null, noteText: '', noteOld: '', noteLoading: false, noteSaving: false,
    });
    window.__lnTest = Object.assign(window.__lnTest || {}, { sp }); // 界面巡检用
    const SHOP_STATUS = [
      { key: 'to_ship', label: $t('待发货') },
      { key: 'collect', label: $t('待揽收') },
      { key: 'shipped', label: $t('已发货（待收货）') },
    ];
    const SHOP_FILTERS = [
      { key: 'all', label: $t('全部') },
      { key: 'todo', label: $t('待备注') },
      { key: 'done', label: $t('已备注') },
      { key: 'bad', label: $t('未匹配') },
    ];
    const st = reactive({ range: 'today', custom: null, data: { orders: 0, buyers: 0, newBuyers: 0, amount: 0, failed: 0, hours: new Array(24).fill(0), topBuyers: [], topNumbers: [] } });

    const NAV = [
      { key: 'console', label: $t('直播控制台'), sub: $t('实时弹幕、命中与打印'), icon: 'live' },
      { key: 'history', label: $t('打印历史'), sub: $t('查询、重打、取消、导出订单记录'), icon: 'printer' },
      { key: 'summary', label: $t('发货汇总'), sub: $t('按客户合并订单，打包发货用的对照表'), icon: 'clipboard' },
      { key: 'shop', label: $t('订单备注'), sub: $t('TikTok Shop 待发货订单，按扣号自动写卖家备注'), icon: 'store' },
      { key: 'products', label: $t('商品信息'), sub: $t('号码对应商品，自动印名称和价格'), icon: 'package', badge: () => counts.products || '' },
      { key: 'names', label: $t('名单管理'), sub: $t('黑名单 / 白名单'), icon: 'shield', badge: () => (s.listMode === 'whitelist' ? $t('白') : counts.blacklist || '') },
      { key: 'customers', label: $t('客户编号'), sub: $t('每个买家固定一个编号'), icon: 'users', badge: () => counts.customers || '' },
      { key: 'stats', label: $t('数据统计'), sub: $t('订单、买家、销售额和高峰时段'), icon: 'chart' },
      { key: 'settings', label: $t('系统设置'), sub: $t('连接、提醒、共享主机、备份'), icon: 'settings' },
    ];
    const currentNav = computed(() => NAV.find((n) => n.key === page.value) || NAV[0]);
    // 侧边栏：手动设置优先，否则窗口窄于 1360px 自动收起
    const winWidth = ref(window.innerWidth);
    window.addEventListener('resize', () => (winWidth.value = window.innerWidth));
    const compact = computed(() => (typeof s.sidebarCollapsed === 'boolean' ? s.sidebarCollapsed : winWidth.value < 1360));
    function toggleSidebar() {
      s.sidebarCollapsed = !compact.value;
    }
    function togglePrint() {
      s.print.enabled = !s.print.enabled;
      ElMessage({ message: s.print.enabled ? $t('打印已开启') : $t('打印已暂停，命中仍会记录'), type: s.print.enabled ? 'success' : 'warning', duration: 1500 });
    }
    // 界面里的表单只是排版用，从不提交：拦住提交，否则会整页刷新回到首页
    document.addEventListener('submit', (e) => e.preventDefault(), true);
    // 快捷键：Ctrl+1~9 切页面，F9 暂停/开启打印
    window.addEventListener('keydown', (e) => {
      if (!ready.value || showDesigner.value) return;
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        go(NAV[Number(e.key) - 1].key);
        e.preventDefault();
      } else if (e.key === 'F9') {
        togglePrint();
        e.preventDefault();
      } else if (e.key === 'F8') {
        toggleScreen();
        e.preventDefault();
      }
    });

    // ---------- 计算属性 ----------
    const liveBusy = computed(() => ['connecting', 'connected'].includes(status.status));
    const statusShort = computed(() => (STATUS_TEXT[status.status] || status.status) + (status.status === 'connected' && status.mode === 'browser' ? $t(' · 浏览器') : ''));
    const statusText = computed(() => (status.user && status.status !== 'idle' ? $t('@{0}：{1}', status.user, statusShort.value) : statusShort.value));
    const shownChats = computed(() => (onlyHits.value ? chats.value.filter((c) => c.hit) : chats.value));
    const codeText = (n) => (s.code?.prefixEnabled ? s.code.prefix || '' : '') + n;
    const nextCodePreview = computed(() => (s.code?.mode === 'fill' ? $t('最小空号') : counters.nextCode));
    const filterBy = (list, q, keys) => {
      q = q.trim().toLowerCase();
      return q ? list.filter((x) => keys(x).toLowerCase().includes(q)) : list;
    };
    const shownNames = computed(() => filterBy(nl.list, nl.search, (b) => `${b.uniqueId} ${b.nickname} ${b.note}`));
    const shownCustomers = computed(() => filterBy(cs.list, cs.search, (c) => `${c.uniqueId} ${c.nickname} ${codeText(c.code)}`));
    const shownProducts = computed(() => filterBy(pd.list, pd.search, (p) => `${p.code} ${p.name} ${p.spec}`));
    const productSold = computed(() => pd.list.reduce((a, p) => a + (p.sold || 0), 0));
    const amountFont = computed(() => {
      const len = money(auctionState.value.amount || 0).length;
      return len > 5 ? Math.max(16, 30 - (len - 5) * 3) + 'px' : '';
    });
    const maxBuyer = computed(() => Math.max(1, ...st.data.topBuyers.map((b) => b.count)));
    const maxNumber = computed(() => Math.max(1, ...st.data.topNumbers.map((b) => b.count)));
    const demoHit = { codeText: '45', nickname: 'Dương Phước Huy', content: '15', productName: 'Áo thun' };

    // ---------- 日志 / 事件 ----------
    function pushLog(l) {
      logs.value.push(l);
      if (logs.value.length > 300) logs.value.splice(0, logs.value.length - 300);
      nextTick(() => {
        if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
      });
    }

    api.on('log', pushLog);
    api.on('status', (x) => Object.assign(status, { error: '', ...x }));
    api.on('chat', (c) => {
      chats.value.unshift(c);
      if (chats.value.length > 500) chats.value.length = 500;
    });
    api.on('record', (rec) => {
      const i = history.rows.findIndex((r) => r.id === rec.id);
      if (i >= 0) history.rows[i] = { ...rec };
      else if (page.value === 'history' && isDefaultQuery()) {
        history.rows.unshift({ ...rec });
        history.total += 1;
      }
      const j = hits.value.findIndex((h) => h.id === rec.id);
      if (j >= 0) hits.value[j] = { ...rec };
      linkChat(rec);
    });
    /** 弹幕流命中行 ← 打印记录（编号、打印状态），用于显示和「重打」 */
    function linkChat(rec) {
      if (!rec || rec.chatId == null) return;
      const c = chats.value.find((x) => x.id === rec.chatId);
      if (c) Object.assign(c, { recId: rec.id, codeText: rec.codeText, printStatus: rec.status, cancelled: !!rec.cancelled });
    }
    api.on('hit', (rec) => {
      linkChat(rec);
      hits.value.unshift({ ...rec });
      if (hits.value.length > 12) hits.value.length = 12;
      if (rec.isNew) counts.customers += 1;
      notifyHit(rec);
      refreshTodaySoon();
    });
    api.on('stats', (x) => {
      Object.assign(stats, { total: x.total, failed: x.failed, queue: x.queue });
      if (x.counters) Object.assign(counters, x.counters);
    });
    api.on('session', (x) => {
      session.value = x;
      loadSessions();
    });
    // 主进程改了设置（如自动生成的共享密码），同步到界面，避免被界面里的旧值覆盖回去
    const mergeInto = (target, patch) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeInto(target[k], v);
        else target[k] = v;
      }
    };
    api.on('settingsPatch', (patch) => {
      applyingRemote = true;
      mergeInto(s, patch);
      nextTick(() => (applyingRemote = false)); // watch 在同一轮里触发，下一轮再恢复
    });
    api.on('screenWin', (open) => (screenOpen.value = open));
    api.on('screenPin', (v) => {
      if (!s.screen) return;
      applyingRemote = true;
      s.screen.alwaysOnTop = v;
      nextTick(() => (applyingRemote = false));
    });
    api.on('grab', (p) => {
      grabSlots.value = p.slots;
      auctionState.value = p.auction;
    });

    // ---------- 命中提醒 ----------
    let audio = null;
    function playChime() {
      try {
        audio = audio || new AudioContext();
        const t = audio.currentTime;
        [880, 1320].forEach((f, i) => {
          const o = audio.createOscillator();
          const g = audio.createGain();
          o.type = 'sine';
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t + i * 0.09);
          g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.09 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.25);
          o.connect(g).connect(audio.destination);
          o.start(t + i * 0.09);
          o.stop(t + i * 0.09 + 0.3);
        });
      } catch {
        /* 没有音频设备 */
      }
    }
    // 语音队列：正在念的念完，后面只保留最新 1 条（高峰时不会排几分钟的旧单）
    const voiceQueue = [];
    let speaking = false;
    function speakNext() {
      if (speaking || !voiceQueue.length) return;
      const u = voiceQueue.shift();
      speaking = true;
      const done = () => {
        speaking = false;
        speakNext();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
      setTimeout(() => speaking && done(), 8000); // 某些语音引擎不触发 onend，兜底
    }
    function speakHit(rec) {
      if (!('speechSynthesis' in window)) return;
      const text = String(s.notify?.voiceText || $t('{code}号 {content}'))
        .replace(/\{code\}/g, rec.codeText || '')
        .replace(/\{nickname\}/g, rec.nickname || rec.uniqueId || '')
        .replace(/\{content\}/g, rec.auction ? money(rec.amount) : rec.content || '')
        .replace(/\{product\}/g, rec.productName || '');
      const u = new SpeechSynthesisUtterance(text);
      const zh = speechSynthesis.getVoices().find((v) => /zh[-_]CN/i.test(v.lang));
      if (zh) u.voice = zh;
      u.lang = zh ? zh.lang : 'zh-CN';
      u.rate = 1.15;
      voiceQueue.length = 0; // 丢掉还没念的旧单
      voiceQueue.push(u);
      speakNext();
    }
    window.__lnTest = Object.assign(window.__lnTest || {}, { speakHit }); // 冒烟测试用
    function notifyHit(rec) {
      if (s.notify?.sound) playChime();
      if (s.notify?.voice) speakHit(rec);
    }

    // ---------- 订单备注（TikTok Shop） ----------
    const shopTplInput = ref(null);
    const shopIs = (o, k) =>
      k === 'all' ||
      (k === 'todo' && o.match === 'ok' && o.note !== o.noted) ||
      (k === 'done' && !!o.noted) ||
      (k === 'bad' && o.match !== 'ok' && !o.noted);
    const shopCount = (k) => sp.orders.filter((o) => shopIs(o, k)).length;
    const shownShopOrders = computed(() => filterBy(sp.orders.filter((o) => shopIs(o, sp.filter)), sp.search, (o) => `${o.id} ${o.buyer} ${o.user || ''} ${o.nickname || ''}`));
    const shopPreview = computed(() => {
      const f = { accname: 'buyer_demo', nickname: 'Buyer Demo', fixedno: 1271, sortno: codeText(1271), seqno: '35,36', prtremark: s.hostNote || '', message: '15,22', orderid: '580000000000000001', ordertime: '11-20 18:28', amount: '39.200₫' };
      return String(s.shop?.template || '').replace(/\{(\w+)\}/g, (m, k) => (k in f ? f[k] : m)).trim();
    });
    function insertShopField(key) {
      const el = shopTplInput.value?.input;
      const t = s.shop.template || '';
      const pos = el && typeof el.selectionStart === 'number' ? el.selectionStart : t.length;
      s.shop.template = t.slice(0, pos) + '{' + key + '}' + t.slice(pos);
      nextTick(() => el && (el.focus(), el.setSelectionRange(pos + key.length + 2, pos + key.length + 2)));
    }
    async function loadShopStatus() {
      const r = await api.invoke('shop:status');
      sp.fields = r.fields;
      sp.busy = r.busy;
      Object.assign(sp.status, r);
    }
    async function shopCheck() {
      sp.checking = true;
      try {
        Object.assign(sp.status, await api.invoke('shop:check'));
        if (!sp.status.loggedIn) ElMessage.warning($t('店铺未登录'));
      } finally {
        sp.checking = false;
      }
    }
    async function shopCookie() {
      sp.cookieLoading = true;
      try {
        const st2 = await api.invoke('shop:cookie', sp.cookieText);
        Object.assign(sp.status, st2);
        sp.cookieDialog = false;
        sp.cookieText = '';
        ElMessage.success($t('登录成功：') + (st2.shop?.name || ''));
      } catch (e) {
        ElMessage.error(cleanErr(e));
      } finally {
        sp.cookieLoading = false;
      }
    }
    async function shopLogout() {
      try {
        await ElMessageBox.confirm($t('退出后需要重新登录店铺才能备注。'), $t('退出店铺登录'), { type: 'warning' });
      } catch {
        return;
      }
      await api.invoke('shop:logout');
      sp.orders = [];
      s.shop.auto = false;
    }
    async function loadShopOrders() {
      sp.loading = true;
      try {
        const status = sp.orderStatus;
        sp.orders = await api.invoke('shop:orders', status);
        sp.loadedStatus = status;
        sp.selected = [];
        const ok = sp.orders.filter((o) => o.match === 'ok').length;
        const label = (SHOP_STATUS.find((x) => x.key === status) || SHOP_STATUS[0]).label;
        ElMessage.success($t('读取到 {0} 张{1}订单，匹配上 {2} 张', sp.orders.length, label, ok));
      } catch (e) {
        ElMessage.error(cleanErr(e));
      } finally {
        sp.loading = false;
      }
    }
    let replanTimer = null;
    function replanShop() {
      clearTimeout(replanTimer);
      replanTimer = setTimeout(async () => {
        if (!sp.orders.length) return;
        await flushSettings();
        sp.orders = await api.invoke('shop:replan');
      }, 500);
    }
    watch(
      () => s.shop && JSON.stringify([s.shop.template, s.shop.merge, s.shop.backMin, s.shop.fwdMin, s.shop.serial, s.shop.allowRepeat]),
      (v, old) => old !== undefined && replanShop()
    );
    async function noteBatch(selectedOnly) {
      const list = selectedOnly ? sp.selected : sp.orders;
      const ok = list.filter((o) => o.match === 'ok').length;
      try {
        await ElMessageBox.confirm(
          $t('将给 {0} 张订单写卖家备注（匹配上 {1} 张，其余跳过）。\n方式：{2}{3}。', list.length, ok, s.shop.mode === 'append' ? $t('追加到原有备注后面') : $t('完全覆盖原有备注'), s.shop.merge ? $t('，合并订单') : ''),
          selectedOnly ? $t('备注选中订单') : $t('批量备注'),
          { type: 'info', confirmButtonText: $t('开始备注') }
        );
      } catch {
        return;
      }
      try {
        await flushSettings();
        await api.invoke('shop:noteBatch', selectedOnly ? list.map((o) => o.id) : null);
      } catch (e) {
        ElMessage.error(cleanErr(e));
      }
    }
    async function openShopNote(row) {
      sp.noteRow = row;
      sp.noteText = row.note || row.noted || '';
      sp.noteOld = '';
      sp.noteDialog = true;
      sp.noteLoading = true;
      try {
        sp.noteOld = await api.invoke('shop:getNote', row.id);
        if (!sp.noteText) sp.noteText = sp.noteOld;
      } catch (e) {
        sp.noteOld = $t('读取失败：') + cleanErr(e);
      } finally {
        sp.noteLoading = false;
      }
    }
    async function saveShopNote() {
      sp.noteSaving = true;
      try {
        await api.invoke('shop:noteOne', sp.noteRow.id, sp.noteText);
        sp.noteRow.noted = sp.noteText.trim();
        sp.noteRow.hasNote = true;
        sp.noteDialog = false;
        ElMessage.success($t('备注已保存'));
      } catch (e) {
        ElMessage.error(cleanErr(e));
      } finally {
        sp.noteSaving = false;
      }
    }
    api.on('shop', (x) => {
      if (x.type === 'status') Object.assign(sp.status, { loggedIn: x.loggedIn, shop: x.shop, host: x.host });
      else if (x.type === 'busy') {
        sp.busy = x.busy;
        if (!x.busy && sp.orders.length) api.invoke('shop:replan').then((r) => (sp.orders = r));
      } else if (x.type === 'noted') {
        const o = sp.orders.find((r) => r.id === x.orderId);
        if (o) Object.assign(o, { noted: x.text, hasNote: true });
      }
    });

    // ---------- 设置自动保存 ----------
    let saveTimer = null;
    let applyingRemote = false; // 正在合并主进程推来的设置：不要再回存（否则会把整份旧设置写回去）
    const snapshot = () => JSON.parse(JSON.stringify(toRaw(s)));
    function watchSettings() {
      watch(
        s,
        () => {
          if (applyingRemote) return;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => api.invoke('settings:set', snapshot()), 300);
        },
        { deep: true }
      );
    }
    async function flushSettings() {
      clearTimeout(saveTimer);
      await api.invoke('settings:set', snapshot());
    }

    // ---------- 主题 ----------
    function applyThemeDom(t) {
      document.documentElement.dataset.theme = t;
      document.documentElement.classList.toggle('dark', t === 'dark');
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* ignore */
      }
      api.invoke('theme:apply', t);
    }
    function setTheme(t) {
      s.theme = t;
      applyThemeDom(t);
    }

    // ---------- 导航 ----------
    function go(key) {
      page.value = key;
      if (key === 'history') {
        loadSessions();
        loadHistory();
      }
      if (key === 'summary') {
        loadSessions().then(() => {
          if (sm.sessionId === '' && !sm.range && sessions.value.length) sm.sessionId = sessions.value[0].id;
          loadSummary();
        });
      }
      if (key === 'names') loadNames();
      if (key === 'shop') loadShopStatus();
      if (key === 'customers') loadCustomers();
      if (key === 'products') loadProducts();
      if (key === 'stats') nextTick(loadStats);
    }

    // ---------- 直播 ----------
    async function connect() {
      if (!String(s.liveUser || '').trim()) return ElMessage.warning($t('请先填写直播间用户名'));
      await flushSettings();
      api.invoke('live:connect').catch((e) => ElMessage.error(cleanErr(e)));
    }
    function disconnect() {
      api.invoke('live:disconnect');
    }

    // ---------- 模拟弹幕 ----------
    async function sendSim() {
      if (!sim.comment.trim()) return;
      await flushSettings();
      await api.invoke('sim:comment', { uniqueId: sim.uniqueId.trim() || 'test_user', nickname: sim.nickname, comment: sim.comment });
      sim.comment = '';
    }
    async function randomSim() {
      const i = Math.floor(Math.random() * VN_NAMES.length);
      await flushSettings();
      if (s.grab.mode === 'auction') {
        const base = auctionState.value.active ? auctionState.value.amount : s.auction.minPrice;
        return api.invoke('sim:comment', { uniqueId: 'user_' + (i + 1), nickname: VN_NAMES[i], comment: String(base + (s.auction.step || 1) * (1 + Math.floor(Math.random() * 3))) });
      }
      const max = s.monitor.limitMode === 'range' ? s.monitor.max : 50;
      const min = s.monitor.limitMode === 'range' ? s.monitor.min : 1;
      await api.invoke('sim:comment', { uniqueId: 'user_' + (i + 1), nickname: VN_NAMES[i], comment: String(min + Math.floor(Math.random() * Math.min(10, max - min + 1))) });
    }

    // ---------- 打印 ----------
    async function refreshPrinters() {
      printers.value = await api.invoke('printers');
      ElMessage.success($t('找到 {0} 台打印机', printers.value.length));
    }
    async function testPrint() {
      if (!s.print.printer) return ElMessage.warning($t('请先选择打印机'));
      await flushSettings();
      const res = await api.invoke('print:test');
      res.ok ? ElMessage.success($t('已发送到打印机')) : ElMessage.error($t('打印失败：') + res.error);
    }
    async function setNextCode() {
      const { value } = await ElMessageBox.prompt($t('下一个新客户的编号从多少开始？'), $t('设置客户编号'), {
        inputValue: String(counters.nextCode),
        inputPattern: /^\d+$/,
        inputErrorMessage: $t('请输入数字'),
      }).catch(() => ({}));
      if (value) await api.invoke('customers:setNext', Number(value));
    }
    async function resetCustomers() {
      const ok = await ElMessageBox.confirm($t('清空所有客户编号，下一个从 1 开始。老客户再下单会分配新编号。确定吗？'), $t('客户编号归零'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      await api.invoke('customers:reset');
      counts.customers = 0;
      loadCustomers();
      ElMessage.success($t('已归零'));
    }
    async function resetSerial() {
      const ok = await ElMessageBox.confirm($t('流水号归零？'), $t('提示'), { type: 'warning' }).catch(() => false);
      if (ok) await api.invoke('serial:reset');
    }

    // ---------- 共享编号 ----------
    async function applyShare() {
      await flushSettings();
      try {
        const r = await api.invoke('share:apply');
        shareRunning.value = r.running;
        if (r.urls) lanUrls.value = r.urls;
        if (r.running) ElMessage.success($t('共享编号主机已开启'));
      } catch (e) {
        shareRunning.value = false;
        ElMessage.error(cleanErr(e));
      }
    }
    async function pingShare() {
      if (!String(s.share.serverUrl || '').trim()) return ElMessage.warning($t('请填写主机地址'));
      await flushSettings();
      try {
        const r = await api.invoke('share:ping');
        ElMessage.success($t('连接成功：主机 ') + r.host);
      } catch (e) {
        ElMessage.error($t('连接失败：') + cleanErr(e));
      }
    }

    // ---------- 历史 ----------
    function isDefaultQuery() {
      return !hq.range && !hq.sessionId && hq.status === 'all' && !hq.serial && !hq.code && !hq.uniqueId && !hq.nickname && !hq.content;
    }
    function historyQuery() {
      return {
        from: hq.range?.[0] ? new Date(hq.range[0]).getTime() : '',
        to: hq.range?.[1] ? new Date(hq.range[1]).getTime() : '',
        status: hq.status,
        serial: hq.serial,
        code: String(hq.code).replace(/^\D+/, ''),
        uniqueId: hq.uniqueId,
        nickname: hq.nickname,
        content: hq.content,
        exact: hq.exact,
        sessionId: hq.sessionId || '',
        limit: 2000,
      };
    }
    async function loadHistory() {
      const res = await api.invoke('history:query', historyQuery());
      history.total = res.total;
      history.rows = res.rows;
    }
    async function exportHistory() {
      const res = await api.invoke('history:export', historyQuery());
      if (res.ok) ElMessage.success($t('已导出：') + res.filePath);
    }
    async function reprint(row) {
      let res;
      try {
        res = await api.invoke('history:reprint', row.id);
      } catch (e) {
        return ElMessage.error($t('重打失败：') + cleanErr(e));
      }
      res.ok ? ElMessage.success($t('编号 {0} 已重打', row.codeText)) : ElMessage.error($t('打印失败：') + res.error);
    }
    const reprintChat = (row) => reprint({ id: row.recId, codeText: row.codeText });
    /** 弹幕流里没命中的弹幕，手动打印一单（不过监控规则） */
    async function printChat(row) {
      if (row.manualPrinting || row.recId) return;
      row.manualPrinting = true;
      let res;
      try {
        res = await api.invoke('chat:print', { chatId: row.id, uniqueId: row.uniqueId, nickname: row.nickname, comment: row.comment, time: row.time, simulated: !!row.simulated });
      } catch (e) {
        return ElMessage.error($t('打印失败：') + cleanErr(e));
      } finally {
        row.manualPrinting = false;
      }
      row.hit = true;
      row.result = $t('手动打印');
      res.ok ? ElMessage.success($t('编号 {0} 已打印', res.codeText)) : ElMessage.error($t('打印失败：') + res.error);
    }

    // ---------- 名单 ----------
    async function loadNames() {
      nl.list = await api.invoke('names:list', nl.kind);
      counts[nl.kind] = nl.list.length;
    }
    function switchNames(kind) {
      nl.kind = kind;
      loadNames();
    }
    async function blacklistUser(row) {
      const ok = await ElMessageBox.confirm($t('拉黑 {0}（@{1}）？之后这个用户的弹幕不会打印。', row.nickname || row.uniqueId, row.uniqueId), $t('拉黑'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      const added = await api.invoke('names:add', { kind: 'blacklist', uniqueId: row.uniqueId, nickname: row.nickname, note: '' });
      added ? ElMessage.success($t('已拉黑')) : ElMessage.info($t('已在黑名单中'));
      if (added) counts.blacklist += 1;
      if (page.value === 'names') loadNames();
    }
    async function addName() {
      if (!nl.uniqueId.trim()) return ElMessage.warning($t('请填写用户名'));
      const added = await api.invoke('names:add', { kind: nl.kind, uniqueId: nl.uniqueId, nickname: nl.nickname, note: nl.note });
      added ? ElMessage.success($t('已添加')) : ElMessage.info($t('已在名单中'));
      Object.assign(nl, { uniqueId: '', nickname: '', note: '' });
      loadNames();
    }
    async function importNames() {
      const n = await api.invoke('names:import', nl.kind);
      if (n != null) {
        ElMessage.success($t('导入 {0} 人', n));
        loadNames();
      }
    }
    async function noteName(row) {
      const { value } = await ElMessageBox.prompt($t('备注'), $t('编辑备注'), { inputValue: row.note || '' }).catch(() => ({}));
      if (value === undefined) return;
      await api.invoke('names:note', { kind: nl.kind, uniqueId: row.uniqueId, note: value });
      loadNames();
    }
    async function removeName(row) {
      const ok = await ElMessageBox.confirm($t('把 @{0} 移出{1}名单？', row.uniqueId, nl.kind === 'whitelist' ? $t('白') : $t('黑')), $t('移除'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      await api.invoke('names:remove', { kind: nl.kind, uniqueId: row.uniqueId });
      loadNames();
    }

    // ---------- 客户编号 ----------
    async function loadCustomers() {
      cs.list = await api.invoke('customers:list');
      counts.customers = cs.list.length;
    }
    async function deleteCustomers() {
      const ok = await ElMessageBox.confirm($t('删除选中的 {0} 个客户编号？', cs.selected.length), $t('批量删除'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      await api.invoke('customers:delete', cs.selected.map((c) => c.uniqueId));
      loadCustomers();
    }
    async function importCustomers() {
      const mode = await ElMessageBox.confirm(
        $t('支持 Excel（.xlsx / .xls）和 CSV。第一行是表头，需要「用户名」和「编号」两列，「昵称」可选（可以先「导出」一份当模板，旧软件导出的表一般也能直接用）。\n\n表里的客户如果已经有编号：'),
        $t('导入客户编号'),
        { confirmButtonText: $t('用表里的编号覆盖'), cancelButtonText: $t('保留现有，只加新客户'), distinguishCancelAndClose: true, type: 'info' }
      )
        .then(() => 'overwrite')
        .catch((a) => (a === 'cancel' ? 'skip' : null));
      if (!mode) return;
      let r;
      try {
        r = await api.invoke('customers:import', mode);
      } catch (e) {
        return ElMessage.error(cleanErr(e));
      }
      if (!r) return;
      loadCustomers();
      const msg = $t('新增 {0} 位，更新 {1} 位，跳过 {2} 位{3}', r.added, r.updated, r.skipped, r.invalid ? $t('，{0} 行无效（缺用户名或编号）', r.invalid) : '');
      if (r.conflicts.length) {
        const list = r.conflicts.slice(0, 8).map((c) => $t('编号 {0}：{1}', c.code, c.users.join($t('、')))).join('\n');
        ElMessageBox.alert($t('{0}\n\n以下编号有多人重复，请在列表里「改编号」：\n{1}{2}', msg, list, r.conflicts.length > 8 ? $t('\n……共 {0} 个', r.conflicts.length) : ''), $t('导入完成（有重复编号）'), { type: 'warning' });
      } else ElMessage.success($t('导入完成：') + msg);
    }
    async function editCustomerCode(row) {
      const { value } = await ElMessageBox.prompt($t('@{0} 的新编号', row.uniqueId), $t('修改编号'), {
        inputValue: String(row.code),
        inputPattern: /^\d+$/,
        inputErrorMessage: $t('请输入数字'),
      }).catch(() => ({}));
      if (!value) return;
      const taken = cs.list.find((c) => c.code === Number(value) && c.uniqueId !== row.uniqueId);
      if (taken) {
        const ok = await ElMessageBox.confirm($t('编号 {0} 已经是 {1}（@{2}）的，两个人用同一个编号打包时容易弄混。仍然改吗？', value, taken.nickname || taken.uniqueId, taken.uniqueId), $t('编号重复'), { type: 'warning', confirmButtonText: $t('仍然改') }).catch(() => false);
        if (!ok) return;
      }
      await api.invoke('customers:setCode', { uniqueId: row.uniqueId, code: Number(value) });
      loadCustomers();
    }

    // ---------- 商品 ----------
    async function loadProducts() {
      pd.list = await api.invoke('products:list');
      counts.products = pd.list.length;
    }
    function editProduct(row) {
      pd.form = row
        ? { ...row, originalCode: String(row.code), price: row.price ?? undefined, stock: row.stock ?? undefined }
        : { code: String(Math.max(0, ...pd.list.map((p) => Number(p.code) || 0)) + 1), name: '', price: undefined, stock: undefined, spec: '' };
      pd.dialog = true;
    }
    async function saveProduct() {
      try {
        await api.invoke('products:save', JSON.parse(JSON.stringify({ ...pd.form, price: pd.form.price ?? null, stock: pd.form.stock ?? null })));
        pd.dialog = false;
        ElMessage.success($t('已保存'));
        loadProducts();
      } catch (e) {
        ElMessage.error(cleanErr(e));
      }
    }
    async function deleteProducts(rows) {
      const ok = await ElMessageBox.confirm($t('删除 {0} 个商品？', rows.length), $t('删除商品'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      await api.invoke('products:delete', rows.map((r) => r.code));
      loadProducts();
    }
    async function importProducts() {
      const replace = await ElMessageBox.confirm(
        $t('CSV 第一行需要表头：商品编号, 商品名称, 价格, 库存, 规格（可以先「导出」一份当模板）。\n\n导入方式：合并（同编号覆盖）还是清空后导入？'),
        $t('导入商品'),
        { confirmButtonText: $t('合并导入'), cancelButtonText: $t('清空后导入'), distinguishCancelAndClose: true, type: 'info' }
      )
        .then(() => false)
        .catch((a) => (a === 'cancel' ? true : null));
      if (replace === null) return;
      const n = await api.invoke('products:import', replace);
      if (n != null) {
        ElMessage.success($t('导入 {0} 个商品', n));
        loadProducts();
      }
    }

    // ---------- 统计 ----------
    function rangeTimes() {
      const t0 = startOfDay();
      switch (st.range) {
        case 'yesterday':
          return [t0 - 86400_000, t0 - 1];
        case '7d':
          return [t0 - 6 * 86400_000, Date.now()];
        case '30d':
          return [t0 - 29 * 86400_000, Date.now()];
        case 'custom':
          return st.custom ? [new Date(st.custom[0]).getTime(), new Date(st.custom[1]).getTime()] : [t0, Date.now()];
        default:
          return [t0, Date.now() + 60_000];
      }
    }
    async function loadStats() {
      const [from, to] = rangeTimes();
      st.data = await api.invoke('stats:summary', { from, to });
      measureChart();
    }
    function setRange(k) {
      st.range = k;
      if (k !== 'custom') loadStats();
    }
    async function loadToday() {
      Object.assign(today, await api.invoke('stats:summary', { from: startOfDay(), to: Date.now() + 60_000 }));
    }
    let todayTimer = null;
    function refreshTodaySoon() {
      clearTimeout(todayTimer);
      todayTimer = setTimeout(loadToday, 800);
    }

    // 每小时订单柱状图（单序列，SVG 按实际像素宽度绘制，文字不变形）
    const chartWrap = ref(null);
    const chartWidth = ref(900);
    const tip = reactive({ show: false, x: 0, y: 0, h: 0, v: 0 });
    function measureChart() {
      nextTick(() => {
        if (chartWrap.value) chartWidth.value = Math.max(300, chartWrap.value.clientWidth - 32);
      });
    }
    window.addEventListener('resize', measureChart);
    const chart = computed(() => {
      const w = chartWidth.value;
      const h = 240;
      const pl = 36, pr = 8, pt = 12, pb = 26;
      const data = st.data.hours || [];
      const max = Math.max(...data, 0);
      const step = max <= 4 ? 1 : Math.ceil(max / 4 / Math.pow(10, Math.floor(Math.log10(max / 4)))) * Math.pow(10, Math.floor(Math.log10(max / 4)));
      const top = Math.max(step * 4, step * Math.ceil(max / step), 1);
      const plotH = h - pt - pb;
      const slot = (w - pl - pr) / 24;
      const gap = Math.max(2, slot * 0.28);
      const bw = slot - gap;
      const base = pt + plotH;
      const ticks = [];
      for (let v = 0; v <= top; v += step) ticks.push({ v, y: base - (v / top) * plotH });
      const bars = data.map((v, i) => {
        const x = pl + i * slot + gap / 2;
        const bh = (v / top) * plotH;
        const y = base - bh;
        const r = Math.min(4, bw / 2, bh);
        const d = v > 0 ? `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z` : '';
        return { h: i, v, x, y, bw, gap, d };
      });
      return { w, h, pl, pr, pt, pb, ticks, bars };
    });
    function showTip(b) {
      tip.show = true;
      tip.h = b.h;
      tip.v = b.v;
      tip.x = b.x + b.bw / 2 + 16;
      tip.y = Math.min(b.y, 200);
    }

    // ---------- 场次 ----------
    const sessionMinutes = computed(() => {
      if (!session.value) return '';
      const m = Math.floor((now.value - session.value.startAt) / 60000);
      return m < 60 ? $t('已进行 {0} 分钟', m) : $t('已进行 {0} 小时 {1} 分', Math.floor(m / 60), m % 60);
    });
    async function loadSessions() {
      sessions.value = await api.invoke('sessions:list');
    }
    async function startSession() {
      const { value } = await ElMessageBox.prompt($t('场次名称（可不填，默认用日期时间）'), $t('开始新场次'), {
        inputPlaceholder: $t('如 11-20 晚场 · 秋冬新款'),
        confirmButtonText: $t('开始'),
      }).catch(() => ({ value: null }));
      if (value === null) return;
      session.value = await api.invoke('sessions:start', value);
      ElMessage.success($t('新场次已开始'));
    }
    async function endSession() {
      const ok = await ElMessageBox.confirm($t('结束「{0}」？之后的新订单会自动开新场次。', session.value.name), $t('结束场次'), { type: 'warning' }).catch(() => false);
      if (!ok) return;
      await api.invoke('sessions:end');
      session.value = null;
    }
    async function renameSession() {
      const { value } = await ElMessageBox.prompt($t('场次名称'), $t('改名'), { inputValue: session.value.name }).catch(() => ({}));
      if (!value) return;
      await api.invoke('sessions:rename', { id: session.value.id, name: value });
      session.value = { ...session.value, name: value };
      loadSessions();
    }

    // ---------- 取消 / 恢复订单 ----------
    async function cancelRow(row) {
      const ok = await ElMessageBox.confirm($t('取消编号 {0}（{1}，{2}）这一单？库存会退回。', row.codeText, row.nickname || row.uniqueId, row.content), $t('取消订单'), { type: 'warning' }).catch(() => false);
      if (ok) await api.invoke('history:cancel', row.id);
    }
    async function restoreRow(row) {
      await api.invoke('history:restore', row.id);
    }

    // ---------- 发货汇总 ----------
    function summaryQuery() {
      const x = sessions.value.find((v) => v.id === sm.sessionId);
      if (sm.sessionId) return { sessionId: sm.sessionId, name: x ? x.name : '' };
      const [a, b] = sm.range || [startOfDay(), Date.now()];
      return { from: new Date(a).getTime(), to: new Date(b).getTime(), name: fullTime(a).slice(0, 10) };
    }
    async function loadSummary() {
      sm.data = await api.invoke('summary:get', summaryQuery());
      if (!sm.templateId) sm.templateId = (s.templates.find((t) => (t.name.startsWith('发货单') || t.name.startsWith($t('发货单')))) || {}).id || s.activeTemplate;
    }
    const shownSummary = computed(() => filterBy(sm.data.customers, sm.search, (c) => `${c.codeText} ${c.nickname} ${c.uniqueId} ${c.itemsText}`));
    function openSummary(sess) {
      sm.sessionId = sess ? sess.id : '';
      page.value = 'summary';
      loadSessions().then(loadSummary);
    }
    async function summaryAction(kind) {
      if (!sm.data.customers.length) return ElMessage.warning($t('这个范围内没有订单'));
      const r = await api.invoke('summary:' + kind, summaryQuery()).catch((e) => ({ ok: false, error: cleanErr(e) }));
      if (r?.filePath) ElMessage.success($t('已保存：') + r.filePath);
      else if (r && r.ok === false && r.error) ElMessage.error(r.error);
    }
    async function printSummaryLabels() {
      if (!sm.data.customers.length) return ElMessage.warning($t('这个范围内没有订单'));
      if (!s.print.printer) return ElMessage.warning($t('请先在控制台选择打印机'));
      const tpl = s.templates.find((t) => t.id === sm.templateId);
      const ok = await ElMessageBox.confirm($t('用模板「{0}」给 {1} 位客户各打印一张发货单？', tpl ? tpl.name : '', sm.data.customers.length), $t('打印发货单'), { type: 'info' }).catch(() => false);
      if (!ok) return;
      await flushSettings();
      const r = await api.invoke('summary:printLabels', { q: summaryQuery(), templateId: sm.templateId });
      r.ok === r.total ? ElMessage.success($t('已打印 {0} 张', r.ok)) : ElMessage.warning($t('打印 {0} / {1} 张，失败的看运行日志', r.ok, r.total));
    }

    // ---------- 环境自检 ----------
    const check = reactive({ running: false, items: [], at: 0 });
    async function runSelfCheck() {
      check.running = true;
      await flushSettings();
      try {
        check.items = await api.invoke('selfcheck:run');
        check.at = Date.now();
      } finally {
        check.running = false;
      }
    }

    // ---------- 悬浮大屏 ----------
    async function toggleScreen() {
      await flushSettings();
      screenOpen.value = await api.invoke('screen:toggle');
    }
    async function applyObs() {
      await flushSettings();
      try {
        obsUrl.value = (await api.invoke('screen:applyObs')).url;
        if (obsUrl.value) ElMessage.success($t('OBS 地址已开启'));
      } catch (e) {
        obsUrl.value = '';
        ElMessage.error(cleanErr(e));
      }
    }
    async function copyText(t) {
      try {
        await navigator.clipboard.writeText(t);
        ElMessage.success($t('已复制'));
      } catch {
        ElMessage.info(t);
      }
    }

    // ---------- 备份 ----------
    async function backup() {
      const r = await api.invoke('data:backup');
      if (r?.ok) ElMessage.success($t('已备份：') + r.filePath);
    }
    async function restore() {
      const ok = await ElMessageBox.confirm($t('用备份文件覆盖当前全部数据？程序会自动重启。'), $t('从备份恢复'), { type: 'warning' }).catch(() => false);
      if (ok) api.invoke('data:restore').catch((e) => ElMessage.error(cleanErr(e)));
    }

    function chatRowClass({ row }) {
      return row.hit ? 'row-hit' : '';
    }

    onMounted(async () => {
      const init = await api.invoke('init');
      Object.assign(s, init.snapshot.settings);
      Object.assign(counters, init.snapshot.counters);
      Object.assign(stats, init.stats);
      Object.assign(status, init.status);
      Object.assign(counts, {
        products: init.snapshot.productCount,
        blacklist: init.snapshot.blacklistCount,
        whitelist: init.snapshot.whitelistCount,
        customers: init.snapshot.customerCount,
      });
      printers.value = init.printers;
      userData.value = init.userData;
      version.value = init.version;
      lanUrls.value = init.lanUrls;
      shareRunning.value = init.shareRunning;
      if (!s.print.printer) {
        const deli = init.printers.find((p) => /deli|label|标签|xprinter|gprinter/i.test(p.name));
        const def = init.printers.find((p) => p.isDefault);
        if (deli || def) s.print.printer = (deli || def).name;
      }
      applyThemeDom(s.theme || 'dark');
      session.value = init.session;
      const si = await api.invoke('screen:info');
      screenOpen.value = si.open;
      obsUrl.value = si.obsUrl;
      watchSettings();
      ready.value = true;
      loadToday();
      setInterval(() => (now.value = Date.now()), 1000);
      setInterval(loadToday, 60_000);
      pushLog({ time: Date.now(), level: 'info', text: $t('程序启动 v{0}，数据目录：{1}', init.version, init.userData) });
      if (!init.printers.length) pushLog({ time: Date.now(), level: 'warn', text: $t('没有检测到打印机') });
    });

    return {
      check, runSelfCheck, session, sessions, sm, sessionMinutes, startSession, endSession, renameSession, cancelRow, restoreRow, loadSummary, shownSummary,
      openSummary, summaryAction, printSummaryLabels,
      api, ready, page, version, compact, toggleSidebar, togglePrint, screenOpen, obsUrl, toggleScreen, applyObs, copyText, now, s, counters, stats, status, printers, userData, logs, logBox, chats, hits, onlyHits, grabSlots,
      LANGS, COUNTRIES, uiLang, changeLang, applyCountry,
      sp, SHOP_STATUS, SHOP_FILTERS, shopTplInput, shopCount, shownShopOrders, shopPreview, insertShopField, shopCheck, shopCookie, shopLogout, loadShopOrders, noteBatch, openShopNote, saveShopNote,
      showDesigner, auctionState, lanUrls, shareRunning, counts, today, sim, hq, history, nl, cs, pd, st, NAV, RANGES, currentNav,
      liveBusy, statusShort, statusText, shownChats, nextCodePreview, shownNames, shownCustomers, shownProducts, productSold, amountFont,
      maxBuyer, maxNumber, demoHit, chartWrap, chart, tip,
      hms, fullTime, money, codeText, go, setTheme, connect, disconnect, sendSim, randomSim, refreshPrinters, testPrint, setNextCode,
      resetCustomers, resetSerial, applyShare, pingShare, loadHistory, exportHistory, reprint,
      switchNames, blacklistUser, addName, importNames, noteName, removeName,
      deleteCustomers, editCustomerCode, importCustomers, editProduct, saveProduct, deleteProducts, importProducts,
      setRange, loadStats, showTip, backup, restore, chatRowClass, playChime, speakHit, reprintChat, printChat,
    };
  },
})
  .component('LabelDesigner', window.LabelDesigner)
  .component('UiIcon', window.UiIcon)
  .use(ElementPlus, {
    locale: (() => {
      const cur = window.LN_I18N.LANGS.find((l) => l.code === window.LN_I18N.getLang()) || window.LN_I18N.LANGS[0];
      return window['ElementPlusLocale' + cur.el[0].toUpperCase() + cur.el.slice(1)];
    })(),
  })
  // 模板里的 $t 要挂在全局属性上（Vue 模板不会去 window 上找 $ 开头的名字）
  .use({ install: (app) => (app.config.globalProperties.$t = window.$t) })
  .mount('#app');
