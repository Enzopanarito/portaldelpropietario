'use strict';
const fs = require('fs');
const path = require('path');

class StateStore {
  constructor(file) { this.file = file; this.ensure(); }
  ensure() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify({ version: 1, cycles: {} }, null, 2));
  }
  read() {
    this.ensure();
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { return { version: 1, cycles: {} }; }
  }
  write(state) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
  mutate(fn) {
    const state = this.read();
    const out = fn(state) || state;
    this.write(out);
    return out;
  }
}
module.exports = { StateStore };
