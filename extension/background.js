importScripts('lib/db.js', 'lib/note.js', 'lib/prompt.js');
const db = globalThis.BN_db, N = globalThis.BN_note, P = globalThis.BN_prompt;

// —— 设置 ——
const DEFAULTS = {
  exportRoot: '',               // 空 = 我的文档\FrameScribe（由桥接程序给出本机路径）
  engine: 'claude',              // claude | codex | api | none
  cliModel: { claude: '', codex: '' },
  api: { kind: 'openai', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', key: '', model: '', sendImages: true, maxImages: 24 }
};
async function settings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(s || {}), cliModel: { ...DEFAULTS.cliModel, ...(s && s.cliModel) }, api: { ...DEFAULTS.api, ...(s && s.api) } };
}

// —— 桌面软件（安装目录的 app\）开着时：快捷键、弹窗、存盘都归它，插件只供原画 / 时间点 / 字幕 ——
// 软件没开时连不上，插件照旧自己干活
const APP_URL = 'ws://127.0.0.1:38917';
let appWs = null, appTry = 0, appQ = 0, lastAppTab = 0;
const appWait = new Map();
function browserName() {
  const b = (navigator.userAgentData && navigator.userAgentData.brands || []).map(x => x.brand);
  return ['Microsoft Edge', 'Brave', 'Opera', 'Google Chrome', 'Chromium'].find(n => b.includes(n)) || 'Chrome';
}
function ensureApp() {
  if (appWs || Date.now() - appTry < 5000) return;
  appTry = Date.now();
  let ws;
  try { ws = new WebSocket(APP_URL); } catch (e) { return; }
  ws.onopen = () => { appWs = ws; ws.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version, browser: browserName() })); };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onApp(m).catch(() => {}); };
  ws.onclose = () => { if (appWs === ws) appWs = null; for (const r of appWait.values()) r(null); appWait.clear(); };
  ws.onerror = () => {};
}
function appSend(m) {
  try { if (appWs) { appWs.send(JSON.stringify(m)); return true; } } catch (e) {}
  return false;
}
function appAsk(m, ms = 1500) {
  return new Promise(resolve => {
    if (!appWs) return resolve(null);
    const q = ++appQ;
    appWait.set(q, resolve);
    appSend({ ...m, q });
    setTimeout(() => { if (appWait.delete(q)) resolve(null); }, ms);
  });
}
const PV = /^https:\/\/[^/]+\.polyv\.cn\//; // 保利威直播回放页
const YTW = /^https:\/\/www\.youtube\.com\/watch\?/; // YouTube 视频页
const videoTab = url => /^https:\/\/www\.bilibili\.com\//.test(url || '') || PV.test(url || '') || YTW.test(url || '');
async function onApp(m) {
  if (m.a && appWait.has(m.a)) { const r = appWait.get(m.a); appWait.delete(m.a); return r(m); }
  if (m.type === 'ping') { appSend({ type: 'pong' }); return; } // 软件每 20 秒发一次：有来往，后台就不会休眠断线
  if (typeof m.type === 'string' && m.type.startsWith('lec-')) { for (const p of pvPorts) { try { p.postMessage({ push: m }); } catch (e) {} } return; }
  if (m.type === 'capture') {
    // 只有浏览器窗口在最前面、当前标签页是 B 站视频时才交图；否则软件自己截屏
    let out = { ok: false, reason: 'no-video-tab' };
    try {
      const w = await chrome.windows.getLastFocused();
      if (!w || !w.focused) out = { ok: false, reason: 'browser-not-focused' };
      else {
        const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
        if (tab && videoTab(tab.url)) {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'app-capture' });
          if (r) { out = r; if (r.ok) lastAppTab = tab.id; }
        }
      }
    } catch (e) { out = { ok: false, reason: String(e.message || e) }; }
    appSend({ ...out, rid: m.rid });
  } else if (m.type === 'saved') {
    if (lastAppTab) chrome.tabs.sendMessage(lastAppTab, { type: 'app-saved', sessionId: m.sessionId, count: m.count }).catch(() => {});
  } else if (m.type === 'fetch-subs') {
    let subs = null;
    for (const t of await chrome.tabs.query({ url: 'https://www.bilibili.com/*' })) {
      try { subs = await chrome.tabs.sendMessage(t.id, { type: 'fetch-subs', bvid: m.bvid, p: m.p }); if (subs) break; } catch (e) { /* 这个标签页没有内容脚本 */ }
    }
    appSend({ rid: m.rid, subs });
  }
}
// —— 保利威回放页：内容脚本用长连接把转写的声音、进度交给软件；软件推回来的消息（转出一句、大纲好了）转给它们 ——
const pvPorts = new Set();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'polyv') return;
  pvPorts.add(port);
  ensureApp();
  port.onMessage.addListener(async m => {
    if (!m || !m.msg) return;
    if (!m.ask) { if (!appSend(m.msg)) ensureApp(); return; }
    if (!appWs) { ensureApp(); await new Promise(r => setTimeout(r, 1200)); } // 刚醒来：给连接一点时间
    const r = await appAsk(m.msg, m.ms || 20000);
    try { port.postMessage({ re: m.id, r: r || { ok: false, detail: appWs ? '软件没有回应' : '没连上 FrameScribe 软件：先打开软件' } }); } catch (e) {}
  });
  port.onDisconnect.addListener(() => pvPorts.delete(port));
});

// 连上之后靠软件的心跳保持；没连上时每 30 秒试一次（软件后启动、或重启过，也能自己接上）
chrome.alarms.create('bn-app', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'bn-app') ensureApp(); });
chrome.runtime.onStartup.addListener(ensureApp);
ensureApp();

// —— 快捷键 / 打开笔记本 ——
chrome.commands.onCommand.addListener(async (name, tab) => {
  if (appSend({ type: 'hotkey', name })) return; // 软件开着：交给软件
  tab = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || !videoTab(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, { type: 'cmd', name }).catch(() => {});
});
chrome.action.onClicked.addListener(() => openManager());
async function openManager() {
  const url = chrome.runtime.getURL('manager.html');
  const [t] = await chrome.tabs.query({ url: url + '*' });
  if (t) { await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); }
  else await chrome.tabs.create({ url });
}

const notify = (sessionId, kind = 'data') => chrome.runtime.sendMessage({ type: 'changed', sessionId, kind }).catch(() => {});
const toBlob = async dataUrl => (await fetch(dataUrl)).blob();
async function b64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// —— 本地桥接程序（Native Messaging）。连着的时候后台不会被浏览器休眠 ——
const HOST = 'com.framescribe.host';
let port = null, seq = 0, idleTimer = 0;
const pending = new Map();
function hostPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(m => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { p.onProgress && p.onProgress(m.line); return; }
    pending.delete(m.id);
    p.resolve(m);
    armIdle();
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : '桥接程序断开';
    port = null;
    for (const p of pending.values()) p.resolve({ ok: false, detail: hostHint(err) });
    pending.clear();
  });
  return port;
}
function hostHint(err) {
  return /not found|forbidden|Specified native messaging host/i.test(err)
    ? '没连上本地桥接程序。请双击 FrameScribe 安装目录里的 setup.cmd（或单独运行 host\\install-host.ps1）后重启浏览器。（' + err + '）'
    : err;
}
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!pending.size && port) { port.disconnect(); port = null; } }, 30000);
}
function host(msg, onProgress) {
  return new Promise(resolve => {
    const id = ++seq;
    pending.set(id, { resolve, onProgress });
    clearTimeout(idleTimer);
    try { hostPort().postMessage({ ...msg, id }); }
    catch (e) { pending.delete(id); resolve({ ok: false, detail: hostHint(String(e.message || e)) }); }
  });
}

// —— 字幕 ——
async function saveSubs(sessionId, r) {
  await db.update('sessions', sessionId, s => {
    s.subs = { status: r.status, lan: r.lan || '', lanDoc: r.lanDoc || '', detail: r.detail || '', count: r.body ? r.body.length : 0, at: Date.now() };
  });
  if (r.status === 'ok') await db.put('subs', { sessionId, body: r.body });
  notify(sessionId);
}

// —— 导出到绝对路径（经桥接程序写文件） ——
const join = (a, b) => a.replace(/[\\/]+$/, '') + '\\' + b;
async function exportViaHost(sessionId) {
  const st = await settings();
  const s = await db.get('sessions', sessionId);
  const marks = (await db.marksOf(sessionId)).sort((a, b) => a.t - b.t);
  if (!marks.length) throw new Error('这条视频还没有记录点');
  const body = (await db.get('subs', sessionId))?.body || null;
  const root = st.exportRoot || (await host({ type: 'ping' })).defaultRoot;
  if (!root) throw new Error('先在设置里填导出位置');
  const name = N.folderName(s), dir = join(root, name);
  const imgs = N.imageNames(s, marks);
  const write = async (file, data) => {
    const r = await host({ type: 'write', path: join(dir, file), ...data });
    if (!r.ok) throw new Error(r.detail);
  };
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i], f = m.frames[m.chosen] || m.frames[m.frames.length - 1];
    await write('img\\' + imgs[i], { b64: await b64(f.blob) });
  }
  const today = new Date().toLocaleDateString('sv-SE');
  await write(name + '.md', { text: N.rawNote(s, marks, body, imgs, today) });
  if (body) await write('字幕.md', { text: N.transcript(s, body) });
  await write('raw.json', { text: N.rawJson(s, marks, body, imgs) });
  return { s, marks, body, imgs, name, dir, today };
}

// —— 调各家 API ——
async function callApi(cfg, ex) {
  const { s, marks, body, imgs, name, today } = ex;
  if (!cfg.key) throw new Error('还没填 API Key（设置里）');
  if (!cfg.model) throw new Error('还没填模型名（设置里）');
  const sys = P.system(name, today);
  const text = P.material(s, marks, body, imgs, N.link);
  const pics = [];
  if (cfg.sendImages) {
    for (let i = 0; i < marks.length && pics.length < cfg.maxImages; i++) {
      const m = marks[i], f = m.frames[m.chosen] || m.frames[m.frames.length - 1];
      pics.push({ label: `图 ${i + 1}：img/${imgs[i]}（${N.fmt(m.t)}）`, data: await b64(f.blob) });
    }
  }
  return chat(cfg, sys, text, pics);
}

async function chat(cfg, sys, text, pics, maxTokens = 16000) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15 * 60 * 1000);
  try {
    if (cfg.kind === 'anthropic') {
      const content = [{ type: 'text', text }];
      for (const p of pics) content.push({ type: 'text', text: p.label }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.data } });
      const official = /^https:\/\/api\.anthropic\.com$/.test(base);
      const headers = { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' };
      const req = { model: cfg.model, max_tokens: maxTokens, system: sys, messages: [{ role: 'user', content }] };
      if (official) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; req.fallbacks = 'default'; }
      const r = await fetch(base + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(req), signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${j.error ? j.error.message : ''}`);
      if (j.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求' + (j.stop_details && j.stop_details.explanation ? '：' + j.stop_details.explanation : ''));
      if (j.stop_reason === 'max_tokens') console.warn('输出达到上限，可能被截断');
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const userContent = pics.length
      ? [{ type: 'text', text }, ...pics.flatMap(p => [{ type: 'text', text: p.label }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + p.data } }])]
      : text;
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && (j.error.message || j.error)) || j.message || '';
      throw new Error(`HTTP ${r.status} ${m}${pics.length && /image|vision|multimodal|图片/i.test(String(m)) ? '（这个模型可能不支持看图：在设置里关掉“发送截图”，或换一个能看图的模型）' : ''}`);
    }
    return j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('等了 15 分钟还没返回，已放弃');
    throw e;
  } finally { clearTimeout(timer); }
}

// —— 整理任务：状态存在 session.job 上，笔记本页实时显示 ——
const jobs = new Set();
async function setJob(sessionId, patch) {
  await db.update('sessions', sessionId, s => { s.job = { ...(s.job || {}), ...patch }; });
  notify(sessionId, 'job');
}

async function runJob(sessionId, organizeToo) {
  if (jobs.has(sessionId)) return { ok: false, detail: '这条视频正在处理中' };
  jobs.add(sessionId);
  const st = await settings();
  const engine = organizeToo ? st.engine : 'none';
  const label = { claude: 'Claude Code', codex: 'Codex', api: 'API · ' + (st.api.model || '?'), none: '仅导出' }[engine];
  const t0 = Date.now();
  await setJob(sessionId, { state: 'running', engine: label, step: '导出文件…', startedAt: t0, detail: '', outFile: '', dir: '', log: '' });
  try {
    const ex = await exportViaHost(sessionId);
    const outFile = join(ex.dir, ex.name + '-整理.md');
    if (engine === 'none') {
      await setJob(sessionId, { state: 'exported', step: '', dir: ex.dir, seconds: Math.round((Date.now() - t0) / 1000) });
      return { ok: true, dir: ex.dir };
    }
    if (engine === 'claude' || engine === 'codex') {
      await setJob(sessionId, { step: `${label} 读取材料…`, dir: ex.dir });
      const r = await host({
        type: 'organize', engine, jobId: sessionId, dir: ex.dir, outFile, model: st.cliModel[engine] || '',
        prompt: P.cli(ex.name, ex.today), images: ex.imgs.map(i => 'img\\' + i)
      }, line => setJob(sessionId, { step: line }));
      if (!r.ok) throw Object.assign(new Error(r.detail), { log: r.log });
      await setJob(sessionId, { state: 'done', step: '', outFile: r.outFile, log: r.log || '', seconds: Math.round((Date.now() - t0) / 1000) });
      return { ok: true, outFile: r.outFile };
    }
    await setJob(sessionId, { step: `发送给 ${label}，等待返回（长视频可能要几分钟）…`, dir: ex.dir });
    const md = P.clean(await callApi(st.api, ex));
    if (md.length < 200) throw new Error('模型返回的内容太短：' + md.slice(0, 120));
    const w = await host({ type: 'write', path: outFile, text: md, backup: true });
    if (!w.ok) throw new Error(w.detail);
    await setJob(sessionId, { state: 'done', step: '', outFile, seconds: Math.round((Date.now() - t0) / 1000) });
    return { ok: true, outFile };
  } catch (e) {
    await setJob(sessionId, { state: 'error', step: '', detail: String(e.message || e), log: e.log || '' });
    return { ok: false, detail: String(e.message || e) };
  } finally {
    jobs.delete(sessionId);
    armIdle();
  }
}

// 浏览器重启后，之前没跑完的任务标成中断
(async () => {
  for (const s of await db.all('sessions')) {
    if (s.job && s.job.state === 'running') await db.update('sessions', s.id, x => { x.job.state = 'error'; x.job.detail = '浏览器关闭或扩展重载，任务中断了，请重新整理'; });
  }
})();

async function handle(msg) {
  switch (msg.type) {
    case 'mark': {
      const s = msg.session;
      const old = await db.get('sessions', s.id);
      await db.put('sessions', { createdAt: Date.now(), subs: null, ...(old || {}), ...s, updatedAt: Date.now() });
      const frames = await Promise.all(msg.mark.frames.map(async f => ({ t: f.t, main: !!f.main, blob: await toBlob(f.dataUrl) })));
      const id = crypto.randomUUID();
      await db.put('marks', { id, sessionId: s.id, t: msg.mark.t, note: msg.mark.note || '', frames, chosen: Number.isInteger(msg.mark.chosen) && msg.mark.chosen < frames.length ? msg.mark.chosen : frames.length - 1, createdAt: Date.now() });
      notify(s.id);
      return { ok: true, markId: id, count: await db.countOf(s.id), hasSubs: old?.subs?.status === 'ok' };
    }
    case 'note':
      await db.update('marks', msg.markId, m => { m.note = msg.note; });
      notify(msg.sessionId);
      return { ok: true };
    case 'choose':
      await db.update('marks', msg.markId, m => { m.chosen = msg.idx; });
      notify(msg.sessionId);
      return { ok: true };
    case 'subs':
      await saveSubs(msg.sessionId, msg.subs);
      return { ok: true };
    case 'hb':
      ensureApp();
      return { app: !!appWs };
    case 'app-subs':
      appSend({ type: 'subs', sessionId: msg.sessionId, subs: msg.subs });
      return { ok: true };
    case 'count': {
      const r = await appAsk({ type: 'count', sessionId: msg.sessionId });
      return { count: r ? r.count : await db.countOf(msg.sessionId) };
    }
    case 'shortcuts': {
      const cmds = await chrome.commands.getAll();
      return Object.fromEntries(cmds.filter(c => c.name !== '_execute_action').map(c => [c.name, c.shortcut || '']));
    }
    case 'open-manager':
      if (!appSend({ type: 'open-notebook', sessionId: msg.sessionId })) await openManager();
      return { ok: true };
    case 'refetch-subs': {
      const s = await db.get('sessions', msg.sessionId);
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/*' });
      for (const t of tabs) {
        try {
          const r = await chrome.tabs.sendMessage(t.id, { type: 'fetch-subs', bvid: s.bvid, p: s.p });
          if (r) { await saveSubs(s.id, r); return { ok: true, status: r.status, detail: r.detail }; }
        } catch (e) { /* 这个标签页没有内容脚本，换下一个 */ }
      }
      return { ok: false, detail: '需要先打开任意一个 B 站视频页（字幕要用你的登录状态去取）' };
    }
    case 'host-ping':
      return host({ type: 'ping' });
    case 'reveal':
      return host({ type: 'reveal', path: msg.path });
    case 'export':
      return runJob(msg.sessionId, false);
    case 'organize':
      return runJob(msg.sessionId, true);
    case 'cancel':
      return host({ type: 'cancel', jobId: msg.sessionId });
    case 'test-api': {
      const cfg = (await settings()).api;
      if (!cfg.key || !cfg.model) return { ok: false, detail: '先填 API Key 和模型名' };
      try {
        const out = await chat(cfg, '你是连接测试助手。', '只回复两个字：收到', [], 50);
        return { ok: true, detail: '连通，模型回复：' + String(out || '').trim().slice(0, 40) };
      } catch (e) { return { ok: false, detail: String(e.message || e) }; }
    }
  }
  return { ok: false, detail: 'unknown ' + msg.type };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'changed') return;
  handle(msg).then(reply, e => reply({ ok: false, detail: String(e) }));
  return true;
});
