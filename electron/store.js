'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  opacity: 1,
  alwaysOnTop: true,
  clickThrough: false,
  autoLaunch: false,
  mini: false,
  importantOnly: false,
  notify: true,
  watch: [],
  groups: ['cn', 'etf', 'global', 'metal', 'futures'],
  quoteInterval: 5000,
  flashInterval: 8000,
  quoteHeight: null,
  bounds: null,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      // 去掉可能的 UTF-8 BOM：带 BOM 的文件 JSON.parse 会直接抛错
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.data = { ...DEFAULTS, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[store] 读取设置失败，使用默认值:', err.message);
        try {
          fs.copyFileSync(file, `${file}.broken-${Date.now()}`);
        } catch {
          /* 备份失败就算了 */
        }
      }
    }
  }

  get(key) {
    return key === undefined ? this.data : this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] 保存设置失败:', err.message);
    }
  }
}

module.exports = { Store, DEFAULTS };