// 记录都存成普通文件：<数据目录>\sessions\<视频 id>\ 下的 session.json、marks.json、subs.json、f\*.jpg、voice\*.wav
const fs = require('fs'), path = require('path'), crypto = require('crypto');

class Store {
  constructor(root) {
    this.root = root;
    this.sdir = path.join(root, 'sessions');
    fs.mkdirSync(this.sdir, { recursive: true });
    this.cache = new Map();
  }

  dir(id) {
    if (typeof id !== 'string' || !/^[\w.-]{1,120}$/.test(id) || id.startsWith('.')) throw new Error('非法的记录 id：' + id);
    return path.join(this.sdir, id);
  }
  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  }
  _write(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }

  // 一条视频的全部数据：{ session, marks }；没有返回 null
  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const d = this.dir(id), session = this._read(path.join(d, 'session.json'), null);
    if (!session) return null;
    const rec = { session, marks: this._read(path.join(d, 'marks.json'), []) };
    this.cache.set(id, rec);
    return rec;
  }
  save(id) {
    const rec = this.cache.get(id), d = this.dir(id);
    if (!rec) return;
    fs.mkdirSync(d, { recursive: true });
    this._write(path.join(d, 'session.json'), rec.session);
    this._write(path.join(d, 'marks.json'), rec.marks);
  }

  sessions() {
    const out = [];
    for (const name of fs.readdirSync(this.sdir)) {
      let rec; try { rec = this.load(name); } catch (e) { continue; }
      if (rec) out.push({ ...rec.session, count: rec.marks.length });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // 建立或更新一条视频的信息（不动已有的字幕、整理状态）
  upsertSession(meta) {
    let rec = this.load(meta.id);
    if (!rec) { rec = { session: { createdAt: Date.now(), subs: null, ...meta }, marks: [] }; this.cache.set(meta.id, rec); }
    else Object.assign(rec.session, meta);
    rec.session.updatedAt = Date.now();
    this.save(meta.id);
    return rec;
  }
  patchSession(id, patch) {
    const rec = this.load(id);
    if (!rec) return null;
    Object.assign(rec.session, patch);
    this.save(id);
    return rec.session;
  }

  // frames: [{ t, main, buf: Buffer(jpeg) }]
  addMark(sid, mark, frames) {
    const rec = this.load(sid), d = this.dir(sid);
    const id = crypto.randomUUID();
    fs.mkdirSync(path.join(d, 'f'), { recursive: true });
    const saved = frames.map((f, k) => {
      const file = `${id}_${k}.jpg`;
      fs.writeFileSync(path.join(d, 'f', file), f.buf);
      return { t: f.t, main: !!f.main, file };
    });
    const chosen = Number.isInteger(mark.chosen) && mark.chosen >= 0 && mark.chosen < saved.length ? mark.chosen : saved.length - 1;
    const m = { id, t: mark.t, wall: mark.wall, note: mark.note || '', frames: saved, chosen, createdAt: Date.now() };
    rec.marks.push(m);
    rec.session.updatedAt = Date.now();
    this.save(sid);
    return m;
  }
  mark(sid, mid) {
    const rec = this.load(sid);
    return rec ? rec.marks.find(m => m.id === mid) || null : null;
  }
  updateMark(sid, mid, fn) {
    const m = this.mark(sid, mid);
    if (!m) return null;
    fn(m);
    this.save(sid);
    return m;
  }
  delMark(sid, mid) {
    const rec = this.load(sid), d = this.dir(sid);
    if (!rec) return;
    const m = rec.marks.find(x => x.id === mid);
    if (!m) return;
    for (const f of m.frames) fs.rmSync(path.join(d, 'f', f.file), { force: true });
    if (m.voice && m.voice.file) fs.rmSync(path.join(d, m.voice.file), { force: true });
    rec.marks = rec.marks.filter(x => x.id !== mid);
    this.save(sid);
  }
  delSession(sid) {
    fs.rmSync(this.dir(sid), { recursive: true, force: true });
    this.cache.delete(sid);
  }

  framePath(sid, f) { return path.join(this.dir(sid), 'f', f.file); }
  chosenFrame(sid, m) { return this.framePath(sid, m.frames[m.chosen] || m.frames[m.frames.length - 1]); }

  subs(sid) { return this._read(path.join(this.dir(sid), 'subs.json'), null); }
  putSubs(sid, body) { this._write(path.join(this.dir(sid), 'subs.json'), body); }

  // 网页回放的大纲（AI 按转写生成的带时间目录）
  outline(sid) { return this._read(path.join(this.dir(sid), 'outline.json'), null); }
  putOutline(sid, o) { this._write(path.join(this.dir(sid), 'outline.json'), o); }

  // 转写网页回放时顺手截的画面：k\<视频毫秒>.jpg，画面明显变了才存一张
  addKey(sid, t, buf) {
    const d = path.join(this.dir(sid), 'k');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, Math.round(t * 1000) + '.jpg'), buf);
  }
  keys(sid) {
    let names = [];
    try { names = fs.readdirSync(path.join(this.dir(sid), 'k')); } catch (e) {}
    return names.filter(n => /^\d+\.jpg$/.test(n)).map(n => ({ t: parseInt(n, 10) / 1000, file: path.join(this.dir(sid), 'k', n) })).sort((a, b) => a.t - b.t);
  }

  // 16 kHz 单声道 Float32 → 16 位 wav，返回相对路径
  saveVoice(sid, mid, samples) {
    const d = path.join(this.dir(sid), 'voice');
    fs.mkdirSync(d, { recursive: true });
    const n = samples.length, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    fs.writeFileSync(path.join(d, mid + '.wav'), buf);
    return 'voice/' + mid + '.wav';
  }
  readVoice(sid, rel) {
    const buf = fs.readFileSync(path.join(this.dir(sid), rel));
    const n = (buf.length - 44) >> 1, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32768;
    return out;
  }
}

module.exports = { Store };
