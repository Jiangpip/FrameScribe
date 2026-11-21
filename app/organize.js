// 导出到 Obsidian + 交给 AI 整理。文件格式和提示词用插件那一份（extension\lib），CLI 引擎用桥接那一份（host\core.js）
const fs = require('fs'), path = require('path');
require('../extension/lib/note.js');
require('../extension/lib/prompt.js');
const N = globalThis.BN_note, P = globalThis.BN_prompt;
const core = require('../host/core.js');

// 随笔导出到单独的文件夹（没设就是导出位置下的「随笔」）
// 批量取的播放列表（session.group）放进以列表命名的子文件夹
const rootFor = (s, settings) => N.isJot(s) ? (settings.jotRoot || path.join(settings.exportRoot, '随笔'))
  : s.group ? path.join(settings.exportRoot, N.safe(s.group)) : settings.exportRoot;

function exportFiles(store, sid, settings) {
  const rec = store.load(sid);
  if (!rec) throw new Error('找不到这条记录');
  const s = rec.session, marks = [...rec.marks].sort((a, b) => a.t - b.t), jot = N.isJot(s);
  const body = !jot && s.subs && s.subs.status === 'ok' ? store.subs(sid) : null; // 随笔不带字幕（取到了也不用）
  if (jot && !marks.length) throw new Error('这条随笔还没有截图');
  if (!marks.length && !(body && body.length)) throw new Error('这条记录还没有内容：没有记录点，也没有转写的文字');
  const name = N.folderName(s), dir = path.join(rootFor(s, settings), name);
  const imgs = N.imageNames(s, marks);
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  marks.forEach((m, i) => fs.copyFileSync(store.chosenFrame(sid, m), path.join(dir, 'img', imgs[i])));
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, name + '.md'), N.rawNote(s, marks, body, imgs, today), 'utf8');
  if (body) fs.writeFileSync(path.join(dir, '字幕.md'), N.transcript(s, body), 'utf8');
  fs.writeFileSync(path.join(dir, 'raw.json'), N.rawJson(s, marks, body, imgs), 'utf8');
  const outline = N.isWeb(s) ? store.outline(sid) : null;
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
    const file = `${N.isYT(s) ? "yt" : "pv"}_key_${N.fmt(k.t).replace(/:/g, '')}.jpg`;
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    fs.copyFileSync(k.file, path.join(dir, 'img', file));
    return 'img/' + file;
  };
  const out = path.join(dir, name + '-大纲.md');
  fs.writeFileSync(out, P.outlineMd(s, outline, N.link, today, pic), 'utf8');
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
    const s = rec.session, prompt = P.outlinePrompt(s, body);
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
    const today = new Date().toLocaleDateString('sv-SE'), name = N.folderName(s), dir = path.join(rootFor(s, settings), name);
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
  const s = rec.session, name = N.folderName(s), dir = path.join(rootFor(s, settings), name);
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
  const dir = path.join(settings.exportRoot, N.safe(group));
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toLocaleDateString('sv-SE');
  const done = list.filter(s => store.outline(s.id)).length;
  const L = ['---', `来源: ${JSON.stringify(group)}`, `视频数: ${list.length}`, `更新于: ${today}`, 'tags: [视频笔记, 大纲, 总目录]', '---',
    `# 总目录 · ${group}`, '', `> ${list.length} 个视频，${done} 个有大纲。每个视频的完整大纲在同文件夹的「…-大纲.md」；时间可点，直接跳到那一秒。`, ''];
  L.push('## 目录', '');
  list.forEach((s, i) => L.push(`${i + 1}. [[#${i + 1}. ${N.safe(s.title)}|${s.title}]]${s.duration ? ' · ' + N.fmt(s.duration) : ''}`));
  L.push('');
  list.forEach((s, i) => {
    const o = store.outline(s.id), name = N.folderName(s);
    L.push(`## ${i + 1}. ${N.safe(s.title)}`, '');
    L.push(`[打开视频](${s.url})${s.duration ? ' · ' + N.fmt(s.duration) : ''}${s.part ? ' · 发布 ' + s.part : ''}${o ? ` · [[${name}-大纲|完整大纲]]` : ''}`, '');
    if (!o) { L.push(`> 还没有大纲（${s.subs && s.subs.status === 'ok' ? '在排队生成' : '没有字幕，没取到文字'}）`, ''); return; }
    if (o.summary) L.push('> ' + o.summary.replace(/\n+/g, ' '), '');
    for (const c of o.chapters) {
      L.push(`- [${N.fmt(c.t)}](${N.link(s, c.t)}) **${c.title}**`);
      for (const p of c.points) L.push(`  - [${N.fmt(p.t)}](${N.link(s, p.t)}) ${p.text}`);
    }
    L.push('');
  });
  const file = path.join(dir, N.safe(group) + '-总目录.md');
  fs.writeFileSync(file, L.join('\n'), 'utf8');
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

module.exports = { N, P, core, exportFiles, chat, runJob, runOutline, queueOutline, outlineQueued, writeGroupIndex, rewriteOutlineMd };
