'use strict';
const { t: $t } = require('./i18n/i18n');
// 局域网共享客户编号：一台电脑当主机（开 HTTP 服务），其他电脑向它申请编号，保证多台电脑编号不重复。
const http = require('node:http');
const os = require('node:os');

class ShareServer {
  /** @param {(uniqueId:string, nickname:string) => {code:number, codeText:string}} allocate */
  constructor(allocate, log) {
    this.allocate = allocate;
    this.log = log;
    this.server = null;
    this.port = 0;
    this.key = '';
  }

  get running() {
    return !!this.server;
  }

  start(port, key) {
    this.stop();
    this.key = key || '';
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', (err) => {
        this.server = null;
        reject(err.code === 'EADDRINUSE' ? new Error($t('端口 {0} 已被占用', port)) : err);
      });
      server.listen(Number(port), '0.0.0.0', () => {
        this.server = server;
        this.port = Number(port);
        resolve(lanAddresses().map((ip) => `http://${ip}:${this.port}`));
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  handle(req, res) {
    const reply = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (this.key && req.headers['x-share-key'] !== this.key) return reply(403, { error: $t('共享密码错误') });
    if (req.method === 'GET' && req.url === '/api/ping') return reply(200, { ok: true, host: os.hostname() });
    if (req.method === 'POST' && req.url === '/api/code') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { uniqueId, nickname } = JSON.parse(body || '{}');
          if (!uniqueId) return reply(400, { error: $t('缺少 uniqueId') });
          reply(200, this.allocate(String(uniqueId), String(nickname || '')));
        } catch (e) {
          reply(400, { error: e.message });
        }
      });
      return;
    }
    reply(404, { error: 'not found' });
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out.length ? out : ['127.0.0.1'];
}

function normalizeUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

async function requestJson(url, key, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Share-Key': key } : {}) },
    signal: AbortSignal.timeout(3000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** 客户端：向主机申请编号，失败重试 2 次 */
async function requestCode(serverUrl, key, uniqueId, nickname) {
  const base = normalizeUrl(serverUrl);
  if (!base) throw new Error($t('未填写共享主机地址'));
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await requestJson(base + '/api/code', key, { method: 'POST', body: JSON.stringify({ uniqueId, nickname }) });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error($t('共享编号主机连接失败：') + (lastErr?.message || ''));
}

async function ping(serverUrl, key) {
  return requestJson(normalizeUrl(serverUrl) + '/api/ping', key);
}

module.exports = { ShareServer, requestCode, ping, lanAddresses };
