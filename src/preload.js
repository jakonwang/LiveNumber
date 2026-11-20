'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['log', 'status', 'chat', 'record', 'stats', 'grab', 'hit', 'screen', 'screenWin', 'screenPin', 'session', 'settingsPatch', 'shop'];

// 界面文字的词典：同步拿到，页面脚本运行前就能用 $t()
let i18n = null;
try {
  i18n = ipcRenderer.sendSync('i18n:get');
} catch {
  /* 主进程还没准备好：用中文 */
}

contextBridge.exposeInMainWorld('api', {
  i18n,
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error('unknown event ' + event);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
