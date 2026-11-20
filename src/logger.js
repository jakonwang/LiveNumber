'use strict';
// 运行日志写文件：logs/YYYY-MM-DD.log，每天一个，保留最近 N 天。直播后排查「为什么没打印」用。
const fs = require('node:fs');
const path = require('node:path');

const LEVEL = { info: 'INFO', success: 'OK  ', warn: 'WARN', error: 'ERR ', fatal: 'FATL' };
const pad = (n) => String(n).padStart(2, '0');

class FileLogger {
  constructor(dir, keepDays = 14) {
    this.dir = dir;
    this.keepDays = keepDays;
    fs.mkdirSync(dir, { recursive: true });
    this.cleanup();
  }

  fileFor(d) {
    return path.join(this.dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
  }

  write(level, text) {
    const d = new Date();
    const line = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')} ${LEVEL[level] || level} ${String(text).replace(/\r?\n/g, '\n    ')}\n`;
    try {
      fs.appendFileSync(this.fileFor(d), line);
    } catch {
      /* 磁盘满等情况：日志写不进去也不能影响打单 */
    }
  }

  cleanup() {
    const cutoff = Date.now() - this.keepDays * 86400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (m && new Date(+m[1], +m[2] - 1, +m[3]).getTime() < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = { FileLogger };
