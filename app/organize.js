// 导出到 Obsidian + 交给 AI 整理。文件格式和提示词用插件那一份（extension\lib），CLI 引擎用桥接那一份（host\core.js）
const fs = require('fs'), path = require('path');
require('../extension/lib/note.js');
require('../extension/lib/prompt.js');
const N = globalThis.BN_note, P = globalThis.BN_prompt;
const core = require('../host/core.js');

// —— 笔记放哪、叫什么 ——
// <导出位置>\<分类>\<课程>\<序号 知识点>\<知识点>-大纲.md（规则在 note.js place；分类和课程名在 library.json）
// 随笔还是放在随笔位置（没设就是导出位置下的「随笔」），不分类
function where(store, settings, s) {
  const p = N.place(s, store.library()), jot = N.isJot(s);
  const root = jot ? (settings.jotRoot || path.join(settings.exportRoot, '随笔')) : settings.exportRoot;
  return { dir: path.join(root, ...(jot ? [] : p.parts), p.folder), name: p.base };
}
// 让 AI 给新视频挑分类时的候选
const BASE_CATS = ['材质与着色器', '程序化生成', '场景与地编', '新媒体与创意编程', '影视与动画', '游戏行业', '作品集与求职', '杂谈'];
function categories(store) {
  const set = new Set(BASE_CATS);
  for (const c of Object.values(store.library().courses)) if (c.cat) set.add(c.cat);
  for (const s of store.sessions()) if (s.cat) set.add(s.cat);
  return [...set];
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (p, dir) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep) || samePath(p, dir);
const mdHref = rel => rel.split(path.sep).join('/').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
const NAMED = ['', '-整理', '-大纲']; // 文件夹里以笔记名开头的文件：原始记录、AI 整理、大纲
function markOut(store, sid, dir, name) {
  const rec = store.load(sid);
  if (rec && !(rec.session.out && rec.session.out.dir === dir && rec.session.out.name === name)) store.patchSession(sid, { out: { dir, name } });
}
// 往上删空文件夹，到导出位置为止
function pruneEmpty(dir, stop) {
  while (dir && inside(dir, stop) && !samePath(dir, stop)) {
    try { if (fs.readdirSync(dir).length) return; fs.rmdirSync(dir); } catch (e) { return; }
    dir = path.dirname(dir);
  }
}
// 这条记录上次写到了哪：记下的 out；老记录没有，就看整理任务留下的路径，再不行按旧规则（列表名\视频标题）算
function lastOut(settings, s) {
  if (s.out && fs.existsSync(s.out.dir)) return s.out;
  const j = s.job || {}, d = j.dir || (j.outFile ? path.dirname(j.outFile) : '');
  if (d && fs.existsSync(d)) return { dir: d, name: path.basename(d) };
  const name = N.folderName(s);
  const root = N.isJot(s) ? (settings.jotRoot || path.join(settings.exportRoot, '随笔'))
    : s.group ? path.join(settings.exportRoot, N.safe(s.group)) : settings.exportRoot;
  const dir = path.join(root, name);
  return fs.existsSync(dir) ? { dir, name } : null;
}
// 名字或分类变了：把已经导出的文件夹搬到新位置、文件改成新名字，整理任务里记的路径跟着改（「在 Obsidian 打开」不会断）
function relocate(store, settings, sid) {
  const rec = store.load(sid);
  if (!rec) throw new Error('找不到这条记录');
  const s = rec.session, want = where(store, settings, s), cur = lastOut(settings, s);
  if (!cur || (cur.dir === want.dir && cur.name === want.name)) return want;
  if (!samePath(cur.dir, want.dir)) {
    fs.mkdirSync(path.dirname(want.dir), { recursive: true });
    if (!fs.existsSync(want.dir)) fs.renameSync(cur.dir, want.dir);
    else { // 新位置已经有同名文件夹：逐个搬进去，重名的用这条记录的覆盖
      const move = (a, b) => {
        if (fs.statSync(a).isDirectory() && fs.existsSync(b)) { for (const f of fs.readdirSync(a)) move(path.join(a, f), path.join(b, f)); fs.rmdirSync(a); }
        else { if (fs.existsSync(b)) fs.rmSync(b, { recursive: true, force: true }); fs.renameSync(a, b); }
      };
      for (const f of fs.readdirSync(cur.dir)) move(path.join(cur.dir, f), path.join(want.dir, f));
      fs.rmdirSync(cur.dir);
    }
  } else if (cur.dir !== want.dir) { // 只是大小写不同：Windows 上要先改成临时名
    const tmp = want.dir + '.~mv'; fs.renameSync(cur.dir, tmp); fs.renameSync(tmp, want.dir);
  }
  if (cur.name !== want.name) {
    for (const suf of NAMED) {
      const a = path.join(want.dir, cur.name + suf + '.md'), b = path.join(want.dir, want.name + suf + '.md');
      if (fs.existsSync(a) && a !== b) {
        if (samePath(a, b)) { fs.renameSync(a, a + '.~mv'); fs.renameSync(a + '.~mv', b); }
        else { if (fs.existsSync(b)) fs.unlinkSync(b); fs.renameSync(a, b); }
      }
    }
    // 文件里互相引用的 [[旧名…]] 改成新名
    for (const f of fs.readdirSync(want.dir).filter(f => f.endsWith('.md'))) {
      const p = path.join(want.dir, f), txt = fs.readFileSync(p, 'utf8'), fixed = txt.split('[[' + cur.name).join('[[' + want.name);
      if (fixed !== txt) fs.writeFileSync(p, fixed, 'utf8');
    }
  }
  pruneEmpty(path.dirname(cur.dir), settings.exportRoot);
  const re = p => {
    if (!p || !inside(p, cur.dir)) return p;
    let q = path.join(want.dir, path.relative(cur.dir, p));
    const b = path.basename(q);
    for (const suf of NAMED) if (b === cur.name + suf + '.md') q = path.join(path.dirname(q), want.name + suf + '.md');
    return q;
  };
  const patch = { out: want };
  if (s.job) patch.job = { ...s.job, dir: re(s.job.dir), outFile: re(s.job.outFile) };
  store.patchSession(sid, patch);
  return want;
}
// 一门课（播放列表）改了分类或名字：每个视频都搬，再重写总目录
function relocateGroup(store, settings, group) {
  const out = [];
  for (const s of store.sessions().filter(x => x.group === group)) { try { out.push(relocate(store, settings, s.id)); } catch (e) { /* 一条失败不影响别的 */ } }
  try { writeGroupIndex(store, settings, group); } catch (e) { /* 没有成员就没有总目录 */ }
  return out;
}
// AI 大纲顺带给的名字：知识点名只在还没有时用；播放列表第一次出大纲时定下课程名和分类；单个视频定分类
function adoptNames(store, settings, sid, o) {
  const s = store.load(sid).session, lib = store.library(), patch = {};
  if (!s.topic && o.topic) patch.topic = o.topic;
  if (s.group) {
    if (!lib.courses[s.group] && (o.course || o.cat)) {
      lib.courses[s.group] = { cat: o.cat || '', name: o.course || s.group };
      store.saveLibrary();
      if (Object.keys(patch).length) store.patchSession(sid, patch);
      relocateGroup(store, settings, s.group); // 同一批里先出完大纲的那几条也搬过去
      return;
    }
  } else if (!s.cat && !s.course && !N.isJot(s) && o.cat) patch.cat = o.cat;
  if (Object.keys(patch).length) store.patchSession(sid, patch);
}
// 界面里改「分类 / 课程 / 知识点」：在播放列表里的视频，分类和课程名是整门课一起改
function setPlace(store, settings, sid, v) {
  const rec = store.load(sid);
  if (!rec) throw new Error('找不到这条记录');
  const s = rec.session, clean = x => N.safe(String(x == null ? '' : x)).slice(0, 40).replace(/^未命名$/, '');
  const topic = clean(v.topic);
  if (topic !== (s.topic || '')) store.patchSession(sid, { topic });
  if (s.group) {
    const lib = store.library(), old = lib.courses[s.group] || {}, c = { cat: clean(v.cat), name: clean(v.course) || s.group };
    if (c.cat !== (old.cat || '') || c.name !== (old.name || s.group)) { lib.courses[s.group] = c; store.saveLibrary(); relocateGroup(store, settings, s.group); }
  } else store.patchSession(sid, { cat: clean(v.cat), course: clean(v.course) });
  const w = relocate(store, settings, sid);
  try { rewriteOutlineMd(store, settings, sid); } catch (e) { /* 没大纲 */ }
  for (const g of Object.keys(s.groups || {})) { try { writeGroupIndex(store, settings, g); } catch (e) { /* 没有成员 */ } }
  return w;
}

function exportFiles(store, sid, settings) {
  const rec = store.load(sid);
  if (!rec) throw new Error('找不到这条记录');
  const s = rec.session, marks = [...rec.marks].sort((a, b) => a.t - b.t), jot = N.isJot(s);
  const body = !jot && s.subs && s.subs.status === 'ok' ? store.subs(sid) : null; // 随笔不带字幕（取到了也不用）
  if (jot && !marks.length) throw new Error('这条随笔还没有截图');
  if (!marks.length && !(body && body.length)) throw new Error('这条记录还没有内容：没有记录点，也没有转写的文字');
  const { dir, name } = relocate(store, settings, sid);
  const imgs = N.imageNames(s, marks);
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  marks.forEach((m, i) => fs.copyFileSync(store.chosenFrame(sid, m), path.join(dir, 'img', imgs[i])));
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, name + '.md'), N.rawNote(s, marks, body, imgs, today), 'utf8');
  if (body) fs.writeFileSync(path.join(dir, '字幕.md'), N.transcript(s, body), 'utf8');
  fs.writeFileSync(path.join(dir, 'raw.json'), N.rawJson(s, marks, body, imgs), 'utf8');
  markOut(store, sid, dir, name);
  const outline = N.isScreen(s) ? null : store.outline(sid); // 网页视频和 B 站视频都可能有大纲
  if (outline) writeOutlineMd(store, sid, s, outline, dir, name, today);
  return { s, marks, body, imgs, name, dir, today, jot };
}

// 大纲.md：每章配一张转写时截下的画面（这一章开始后 1 分钟内最早的那张；没有就用开始前最近的一张）
function writeOutlineMd(store, sid, s, outline, dir, name, today) {
  const keys = store.keys(sid), used = new Set();
  fs.mkdirSync(dir, { recursive: true }); // 取字幕得到的文字没有截图，文件夹可能还没建
  const pic = c => {
    // 离章节开头最近、还没用过的一张：开头之后的优先（之后 1 秒算 1 分，之前 1 秒算 2 分），超过 180 分就不配
    let k = null, best = 1e9;
    for (const x of keys) {
      if (used.has(x)) continue; // 同一张图不配给两章
      const sc = x.t >= c.t ? x.t - c.t : (c.t - x.t) * 2;
      if (sc < best) { best = sc; k = x; }
    }
    if (!k || best > 180) return '';
    used.add(k);
    const file = `${N.isYT(s) ? "yt" : N.isVM(s) ? "vm" : N.isWeb(s) ? "pv" : "bl"}_key_${N.fmt(k.t).replace(/:/g, '')}.jpg`;
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    fs.copyFileSync(k.file, path.join(dir, 'img', file));
    return 'img/' + file;
  };
  const out = path.join(dir, name + '-大纲.md');
  fs.writeFileSync(out, P.outlineMd(s, outline, N.link, today, pic), 'utf8');
  markOut(store, sid, dir, name);
  return out;
}

// 生成大纲：把转写交给 AI，要回一份带时间的目录（JSON），存进记录，同时写一份「…-大纲.md」到导出文件夹
async function runOutline({ store, sid, settings, fetchFn, setJob }) {
  if (jobs.has(sid)) return { ok: false, detail: '这条视频正在处理中' };
  const rec = store.load(sid);
  if (!rec) return { ok: false, detail: '找不到这条记录' };
  const body = store.subs(sid) || [];
  if (body.length < 5) return { ok: false, detail: '转写的文字太少，先转写一部分再生成大纲' };
  const engine = settings.engine;
  if (engine === 'none') return { ok: false, detail: '设置里的整理引擎是「只导出」，生成大纲需要选 Claude Code、Codex 或 API' };
  jobs.add(sid);
  const label = '生成大纲 · ' + ({ claude: 'Claude Code', codex: 'Codex', api: 'API · ' + (settings.api.model || '?') }[engine] || engine);
  const t0 = Date.now(), secs = () => Math.round((Date.now() - t0) / 1000);
  setJob({ state: 'running', engine: label, step: '整理转写的文字…', startedAt: t0, detail: '', outFile: '', dir: '', log: '' });
  try {
    const s = rec.session, prompt = P.outlinePrompt(s, body, categories(store));
    let text;
    if (engine === 'claude' || engine === 'codex') {
      setJob({ step: '等待回复（两三个小时的课大约 1–3 分钟）…' });
      const r = await core.organize({ engine, jobId: sid, dir: store.dir(sid), raw: true, model: settings.cliModel[engine] || '', effort: settings.outlineEffort || 'medium', prompt, images: [] }, line => setJob({ step: line }));
      if (!r.ok) throw Object.assign(new Error(r.detail), { log: r.log });
      text = r.text;
    } else {
      const cfg = settings.api;
      if (!cfg.key || !cfg.model) throw new Error('还没填 API Key 或模型名（设置里）');
      setJob({ step: `发送给 ${label}，等待回复…` });
      text = await chat(fetchFn, cfg, '你是课程目录整理助手，只输出 JSON。', prompt, [], 16000);
    }
    const outline = { ...P.parseOutline(text), at: Date.now(), lines: body.length, until: body[body.length - 1].to };
    store.putOutline(sid, outline);
    adoptNames(store, settings, sid, outline);
    const today = new Date().toLocaleDateString('sv-SE'), { dir, name } = relocate(store, settings, sid);
    const outFile = writeOutlineMd(store, sid, s, outline, dir, name, today);
    setJob({ state: 'done', step: '', outFile, seconds: secs() });
    for (const g of Object.keys(s.groups || {})) { try { writeGroupIndex(store, settings, g); } catch (e) { /* 总目录写不了不影响这条 */ } }
    return { ok: true, outFile, outline };
  } catch (e) {
    setJob({ state: 'error', step: '', detail: String(e.message || e), log: e.log || '' });
    return { ok: false, detail: String(e.message || e) };
  } finally {
    jobs.delete(sid);
  }
}

// 截图比大纲晚到时：按现有截图重写一次「…-大纲.md」
function rewriteOutlineMd(store, settings, sid) {
  const rec = store.load(sid), outline = rec && store.outline(sid);
  if (!outline) return '';
  const s = rec.session, { dir, name } = relocate(store, settings, sid);
  return writeOutlineMd(store, sid, s, outline, dir, name, new Date().toLocaleDateString('sv-SE'));
}

// 大纲排队：批量时一下来几十条，同时最多跑 2 个，其余排队（排队时也显示在 job 上）
const OUTLINE_PAR = 2, outlineQ = [];
let outlineActive = 0;
function queueOutline(args) {
  if (jobs.has(args.sid) || outlineQ.some(q => q.args.sid === args.sid)) return Promise.resolve({ ok: false, detail: '这条视频已经在处理或排队中' });
  return new Promise(resolve => {
    outlineQ.push({ args, resolve });
    if (outlineActive >= OUTLINE_PAR) args.setJob({ state: 'running', engine: '生成大纲', step: `排队中（前面还有 ${outlineQ.length - 1 + outlineActive} 个）`, startedAt: Date.now(), detail: '', outFile: '', log: '' });
    pumpOutline();
  });
}
function pumpOutline() {
  while (outlineActive < OUTLINE_PAR && outlineQ.length) {
    const q = outlineQ.shift();
    outlineActive++;
    runOutline(q.args).catch(e => ({ ok: false, detail: String(e.message || e) })).then(r => { outlineActive--; q.resolve(r); pumpOutline(); });
  }
}
const outlineQueued = () => outlineQ.length + outlineActive;

// 播放列表总目录：同一组（session.groups 里有这个名字）的视频按列表顺序，每个视频一节：简介 + 章节 + 知识点，时间都能点
function writeGroupIndex(store, settings, group) {
  const list = store.sessions().filter(s => s.groups && s.groups[group] != null).sort((a, b) => a.groups[group] - b.groups[group]);
  if (!list.length) return null;
  const lib = store.library(), parts = N.place({ group, title: group }, lib).parts, cname = parts[parts.length - 1];
  const dir = path.join(settings.exportRoot, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toLocaleDateString('sv-SE');
  const done = list.filter(s => store.outline(s.id)).length;
  const L = ['---', `来源: ${JSON.stringify(group)}`, `视频数: ${list.length}`, `更新于: ${today}`, 'tags: [视频笔记, 大纲, 总目录]', '---',
    `# 总目录 · ${cname}`, '', ...(cname !== N.safe(group) ? [`> 原播放列表：${group}`, ''] : []), `> ${list.length} 个视频，${done} 个有大纲。每个视频的完整大纲在各自的文件夹里；时间可点，直接跳到那一秒。`, ''];
  L.push('## 目录', '');
  const head = s => N.safe(s.topic || s.title);
  list.forEach((s, i) => L.push(`${i + 1}. [[#${i + 1}. ${head(s)}|${s.topic || s.title}]]${s.duration ? ' · ' + N.fmt(s.duration) : ''}`));
  L.push('');
  list.forEach((s, i) => {
    const o = store.outline(s.id), w = where(store, settings, s);
    L.push(`## ${i + 1}. ${head(s)}`, '');
    if (s.topic) L.push(`原标题：${s.title}`, '');
    L.push(`[打开视频](${s.url})${s.duration ? ' · ' + N.fmt(s.duration) : ''}${s.part ? ' · 发布 ' + s.part : ''}${o ? ` · [完整大纲](${mdHref(path.relative(dir, path.join(w.dir, w.name + '-大纲.md')))})` : ''}`, '');
    if (!o) { L.push(`> 还没有大纲（${s.subs && s.subs.status === 'ok' ? '在排队生成' : '没有字幕，没取到文字'}）`, ''); return; }
    if (o.summary) L.push('> ' + o.summary.replace(/\n+/g, ' '), '');
    for (const c of o.chapters) {
      L.push(`- [${N.fmt(c.t)}](${N.link(s, c.t)}) **${c.title}**`);
      for (const p of c.points) L.push(`  - [${N.fmt(p.t)}](${N.link(s, p.t)}) ${p.text}`);
    }
    L.push('');
  });
  const file = path.join(dir, cname + '-总目录.md');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  // 换了位置 / 名字：删掉旧的总目录（以前记下的，和旧规则「列表名\列表名-总目录.md」）
  const legacy = path.join(settings.exportRoot, N.safe(group), N.safe(group) + '-总目录.md');
  for (const old of new Set([lib.indexFiles[group], legacy])) {
    if (old && !samePath(old, file) && fs.existsSync(old)) { fs.unlinkSync(old); pruneEmpty(path.dirname(old), settings.exportRoot); }
  }
  if (lib.indexFiles[group] !== file) { lib.indexFiles[group] = file; store.saveLibrary(); }
  return file;
}

// fetchFn：Electron 的 net.fetch（走系统代理）
async function chat(fetchFn, cfg, sys, text, pics, maxTokens = 16000) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15 * 60 * 1000);
  try {
    if (cfg.kind === 'anthropic') {
      const content = [{ type: 'text', text }];
      for (const p of pics) content.push({ type: 'text', text: p.label }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.data } });
      const official = /^https:\/\/api\.anthropic\.com$/.test(base);
      const headers = { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2026-10-21' };
      const req = { model: cfg.model, max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content }] };
      if (official) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; req.fallbacks = 'default'; }
      const r = await fetchFn(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(req), signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${j.error ? j.error.message : ''}`);
      if (j.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求' + (j.stop_details && j.stop_details.explanation ? '：' + j.stop_details.explanation : ''));
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const userContent = pics.length
      ? [{ type: 'text', text }, ...pics.flatMap(p => [{ type: 'text', text: p.label }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + p.data } }])]
      : text;
    const r = await fetchFn(base + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && (j.error.message || j.error)) || j.message || '';
      throw new Error(`HTTP ${r.status} ${typeof m === 'string' ? m : JSON.stringify(m)}${pics.length && /image|vision|multimodal|图片/i.test(String(m)) ? '（这个模型可能不支持看图：在设置里关掉“发送截图”，或换一个能看图的模型）' : ''}`);
    }
    return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('等了 15 分钟还没返回，已放弃');
    throw e;
  } finally { clearTimeout(timer); }
}

async function callApi(fetchFn, store, sid, cfg, ex) {
  if (!cfg.key) throw new Error('还没填 API Key（设置里）');
  if (!cfg.model) throw new Error('还没填模型名（设置里）');
  const pics = [];
  if (cfg.sendImages) {
    for (let i = 0; i < ex.marks.length && pics.length < cfg.maxImages; i++) {
      const m = ex.marks[i];
      pics.push({ label: `图 ${i + 1}：img/${ex.imgs[i]}（${N.label(ex.s, m)}）`, data: fs.readFileSync(store.chosenFrame(sid, m)).toString('base64') });
    }
  }
  return chat(fetchFn, cfg, P.system(ex.name, ex.today, ex.jot),P.material(ex.s, ex.marks, ex.body, ex.imgs, N.link), pics);
}

const jobs = new Set();

// setJob(patch)：把进度写到 session.job 并通知界面
async function runJob({ store, sid, settings, organizeToo, fetchFn, setJob }) {
  if (jobs.has(sid)) return { ok: false, detail: '这条视频正在处理中' };
  jobs.add(sid);
  const engine = organizeToo ? settings.engine : 'none';
  const label = { claude: 'Claude Code', codex: 'Codex', api: 'API · ' + (settings.api.model || '?'), none: '仅导出' }[engine];
  const t0 = Date.now(), secs = () => Math.round((Date.now() - t0) / 1000);
  setJob({ state: 'running', engine: label, step: '导出文件…', startedAt: t0, detail: '', outFile: '', dir: '', log: '' });
  try {
    const ex = exportFiles(store, sid, settings);
    const outFile = path.join(ex.dir, ex.name + '-整理.md');
    if (engine === 'none') {
      setJob({ state: 'exported', step: '', dir: ex.dir, seconds: secs() });
      return { ok: true, dir: ex.dir };
    }
    if (engine === 'claude' || engine === 'codex') {
      setJob({ step: `${label} 读取材料…`, dir: ex.dir });
      const r = await core.organize({
        engine, jobId: sid, dir: ex.dir, outFile, model: settings.cliModel[engine] || '',
        minChars: ex.jot ? 80 : 200, prompt: P.cli(ex.name, ex.today, ex.jot), images: ex.imgs.map(i => 'img\\' + i)
      }, line => setJob({ step: line }));
      if (!r.ok) throw Object.assign(new Error(r.detail), { log: r.log });
      setJob({ state: 'done', step: '', outFile: r.outFile, log: r.log || '', seconds: secs() });
      return { ok: true, outFile: r.outFile };
    }
    setJob({ step: `发送给 ${label}，等待返回（长视频可能要几分钟）…`, dir: ex.dir });
    const md = P.clean(await callApi(fetchFn, store, sid, settings.api, ex));
    if (md.length < (ex.jot ? 80 : 200)) throw new Error('模型返回的内容太短：' + md.slice(0, 120));
    core.writeFile(outFile, md, true);
    setJob({ state: 'done', step: '', outFile, seconds: secs() });
    return { ok: true, outFile };
  } catch (e) {
    setJob({ state: 'error', step: '', detail: String(e.message || e), log: e.log || '' });
    return { ok: false, detail: String(e.message || e) };
  } finally {
    jobs.delete(sid);
  }
}

module.exports = { N, P, core, where, relocate, relocateGroup, setPlace, categories, exportFiles, chat, runJob, runOutline, queueOutline, outlineQueued, writeGroupIndex, rewriteOutlineMd };
