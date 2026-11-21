// 笔记本页面：浏览记录、换截图、改笔记、导出 / 整理、设置
const db = globalThis.BN_db, N = globalThis.BN_note;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bg = msg => chrome.runtime.sendMessage(msg);
let sessions = [], current = null, marks = [], body = null, urls = [], refreshLater = false;
let hostInfo = null, cfg = null;

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex', api: 'API', none: '只导出' };
const PRESETS = {
  deepseek: { kind: 'openai', baseUrl: 'https://api.deepseek.com', hint: '模型名以 DeepSeek 控制台为准；文字模型看不了图时，关掉“发送截图”。' },
  qwen: { kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '看图选 qwen-vl 系列，纯文字选 qwen 系列；以百炼控制台的模型列表为准。' },
  kimi: { kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', hint: '以 Kimi 开放平台的模型列表为准。' },
  zhipu: { kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '看图选带 V 的 GLM 模型；以智谱开放平台为准。' },
  siliconflow: { kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', hint: '一个 Key 可用很多开源模型（含 DeepSeek、Qwen-VL），模型名照平台上的完整写法填。' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', hint: '以 OpenAI 平台的模型列表为准。注意：API 额度和 ChatGPT 订阅是分开计费的。' },
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', hint: '一个 Key 用各家模型，模型名形如 厂商/模型。' },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', hint: '默认 claude-opus-5-5；想省钱可改 claude-sonnet-5-5 或 claude-haiku-5-5。' },
  custom: { hint: '任何 OpenAI 兼容接口（含本地 Ollama / LM Studio：http://127.0.0.1:端口/v1）。' }
};

function toast(text, ms = 3500) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hide');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hide'), ms);
}

// —— 设置与桥接状态 ——
async function loadCfg() {
  const { settings } = await chrome.storage.local.get('settings');
  cfg = settings || {};
  cfg.api = cfg.api || {};
  cfg.cliModel = cfg.cliModel || {};
  if (!cfg.engine) cfg.engine = 'claude';
  if (!cfg.exportRoot) cfg.exportRoot = (hostInfo && hostInfo.defaultRoot) || '';
  $('#engineChip').textContent = '整理：' + ENGINE_NAME[cfg.engine] + (cfg.engine === 'api' && cfg.api.model ? ' · ' + cfg.api.model : '');
}

async function checkHost() {
  hostInfo = await bg({ type: 'host-ping' }).catch(e => ({ ok: false, detail: String(e) }));
  const el = $('#hostStat');
  el.className = 'hoststat ' + (hostInfo.ok ? 'ok' : 'bad');
  el.textContent = hostInfo.ok ? '桥接已连接' : '桥接未连接';
  el.title = hostInfo.ok ? '' : hostInfo.detail;
  if (current) renderJob();
}

function renderHostDetail() {
  const d = $('#hostDetail');
  if (hostInfo && hostInfo.ok) {
    const e = hostInfo.engines;
    d.innerHTML = `✅ 已连接（v${esc(hostInfo.version)}，Node ${esc(hostInfo.node)}）<br>
      Claude Code：${e.claude ? '找到（经 ' + esc(e.claude) + '）' : '没找到'} · Codex：${e.codex ? '找到' : '没找到'}`;
  } else {
    d.innerHTML = `❌ 没连上。在 PowerShell 里运行一次：<br>双击 FrameScribe 安装目录里的 <code>setup.cmd</code>（只想注册桥接就运行 <code>host\\install-host.ps1</code>），<br>然后完全关闭再打开浏览器。<br><span class="hint">${esc(hostInfo && hostInfo.detail)}</span>`;
  }
  const mark = (id, ok) => { const el = $(id); el.textContent = ok ? '本机已找到' : '本机没找到'; el.className = ok ? 'ok' : 'bad'; };
  mark('#eClaude', hostInfo && hostInfo.ok && hostInfo.engines.claude);
  mark('#eCodex', hostInfo && hostInfo.ok && hostInfo.engines.codex);
}

function fillSettings() {
  $('#exportRoot').value = cfg.exportRoot;
  document.querySelectorAll('input[name=engine]').forEach(r => r.checked = r.value === cfg.engine);
  $('#mClaude').value = cfg.cliModel.claude || '';
  $('#mCodex').value = cfg.cliModel.codex || '';
  const a = { kind: 'openai', preset: 'deepseek', baseUrl: PRESETS.deepseek.baseUrl, key: '', model: '', sendImages: true, maxImages: 24, ...cfg.api };
  $('#preset').value = a.preset; $('#kind').value = a.kind; $('#baseUrl').value = a.baseUrl;
  $('#apiKey').value = a.key; $('#model').value = a.model;
  $('#sendImages').checked = a.sendImages; $('#maxImages').value = a.maxImages;
  $('#modelHint').textContent = (PRESETS[a.preset] || {}).hint || '';
  syncEngineUI();
}
function syncEngineUI() {
  const e = (document.querySelector('input[name=engine]:checked') || {}).value;
  $('#apiBox').style.display = e === 'api' ? '' : 'none';
  document.querySelectorAll('.cli-only').forEach(x => x.style.display = (e === 'claude' || e === 'codex') ? '' : 'none');
}
function readSettings() {
  return {
    exportRoot: $('#exportRoot').value.trim(),
    engine: (document.querySelector('input[name=engine]:checked') || {}).value || 'claude',
    cliModel: { claude: $('#mClaude').value.trim(), codex: $('#mCodex').value.trim() },
    api: {
      preset: $('#preset').value, kind: $('#kind').value, baseUrl: $('#baseUrl').value.trim(),
      key: $('#apiKey').value.trim(), model: $('#model').value.trim(),
      sendImages: $('#sendImages').checked, maxImages: Math.max(0, +$('#maxImages').value || 0)
    }
  };
}
async function saveSettings(silent) {
  const s = readSettings();
  if (!/^[a-zA-Z]:\\/.test(s.exportRoot)) { toast('导出位置要写完整路径，比如 D:\\Obsidian库\\FrameScribe'); return false; }
  if (s.engine === 'api' && s.api.baseUrl) {
    try {
      const origin = new URL(s.api.baseUrl).origin + '/*';
      const ok = await chrome.permissions.request({ origins: [origin] });
      if (!ok) { toast('没有授权访问 ' + origin + '，API 调用会失败'); return false; }
    } catch (e) { toast('接口地址格式不对'); return false; }
  }
  await chrome.storage.local.set({ settings: s });
  await loadCfg();
  if (!silent) toast('已保存');
  if (current) renderDetail();
  return true;
}

$('#openSettings').onclick = async () => { await checkHost(); await loadCfg(); fillSettings(); renderHostDetail(); $('#settings').showModal(); };
$('#engines').onchange = syncEngineUI;
$('#preset').onchange = () => {
  const p = PRESETS[$('#preset').value];
  if (p.kind) $('#kind').value = p.kind;
  if (p.baseUrl) $('#baseUrl').value = p.baseUrl;
  if (p.model && !$('#model').value) $('#model').value = p.model;
  $('#modelHint').textContent = p.hint || '';
};
$('#saveSettings').onclick = async () => { if (await saveSettings()) $('#settings').close(); };
$('#testApi').onclick = async () => {
  if (!await saveSettings(true)) return;
  $('#testOut').textContent = '测试中…';
  const r = await bg({ type: 'test-api' });
  $('#testOut').textContent = (r.ok ? '✅ ' : '❌ ') + r.detail;
};

// —— 列表与详情 ——
async function loadSessions() {
  sessions = (await db.all('sessions')).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sessions) s.count = await db.countOf(s.id);
  const side = $('#sessions');
  side.innerHTML = sessions.length ? '' : '<div class="sess"><div class="m">暂无</div></div>';
  for (const s of sessions) {
    const d = document.createElement('div');
    d.className = 'sess' + (current && current.id === s.id ? ' on' : '');
    const st = s.job && s.job.state === 'done' ? ' · ✓整理' : s.job && s.job.state === 'running' ? ' · 整理中' : '';
    d.innerHTML = `<div class="t">${esc(s.title)}${s.part ? ' · ' + esc(s.part) : ''}</div>
      <div class="m"><span><b>${s.count}</b> 条</span><span>${esc(s.owner)}</span><span>${new Date(s.updatedAt).toLocaleDateString()}${st}</span></div>`;
    d.onclick = () => open(s.id);
    side.appendChild(d);
  }
}

async function open(id) {
  current = sessions.find(s => s.id === id) || await db.get('sessions', id);
  if (!current) return;
  history.replaceState(null, '', '?s=' + encodeURIComponent(id));
  document.querySelectorAll('.sess').forEach((el, i) => el.classList.toggle('on', sessions[i] && sessions[i].id === id));
  await renderDetail();
}

function subsBadge(s) {
  const x = s.subs;
  if (!x) return '<span class="badge warn">字幕未获取</span>';
  if (x.status === 'ok') return `<span class="badge ok">字幕 · ${esc(x.lanDoc || x.lan)} · ${x.count} 句</span>`;
  return `<span class="badge bad" title="${esc(x.detail)}">无字幕：${esc(x.detail || x.status)}</span>`;
}

const mmss = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
let jobTick = 0;
function renderJob() {
  const box = $('#jobbar');
  if (!box || !current) return;
  const j = current.job;
  clearInterval(jobTick);
  if (!j) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.className = 'jobbar ' + j.state;
  const reveal = p => `<a data-reveal="${esc(p)}">打开文件夹</a>`;
  if (j.state === 'running') {
    const draw = () => {
      box.innerHTML = `<span class="spin"></span><span class="st">整理中</span><span>${esc(j.engine)} · ${mmss(Math.round((Date.now() - j.startedAt) / 1000))}</span>
        <span class="step">${esc(j.step)}</span><span class="sp"></span><a id="cancelJob">取消</a>`;
      const c = $('#cancelJob'); if (c) c.onclick = () => bg({ type: 'cancel', sessionId: current.id });
    };
    draw(); jobTick = setInterval(draw, 1000);
  } else if (j.state === 'done') {
    box.innerHTML = `<span class="st">✓ 整理完成</span><span>${esc(j.engine)} · 用时 ${mmss(j.seconds || 0)}</span><span class="sp"></span>
      <a href="obsidian://open?path=${encodeURIComponent(j.outFile)}">在 Obsidian 打开</a>${reveal(j.outFile)}`;
  } else if (j.state === 'exported') {
    box.innerHTML = `<span class="st">✓ 已导出</span><span class="step">${esc(j.dir)}</span><span class="sp"></span>${reveal(j.dir)}`;
  } else {
    box.innerHTML = `<span class="st">✗ 失败</span><span>${esc(j.engine)}</span><span class="step" title="${esc(j.detail)}">${esc(j.detail)}</span><span class="sp"></span>
      ${j.log ? `<a data-reveal="${esc(j.log)}">看日志</a>` : ''}`;
  }
  box.querySelectorAll('[data-reveal]').forEach(a => a.onclick = () => bg({ type: 'reveal', path: a.dataset.reveal }));
}

async function renderDetail() {
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  const s = current = await db.get('sessions', current.id);
  marks = (await db.marksOf(s.id)).sort((a, b) => a.t - b.t);
  body = (await db.get('subs', s.id))?.body || null;
  const hostOk = hostInfo && hostInfo.ok;
  const main = $('#detail');
  main.innerHTML = `
    <div class="vhead">
      <div style="flex:1;min-width:0">
        <h1>${esc(s.title)}${s.part ? ' <span style="color:var(--dim)">· ' + esc(s.part) + '</span>' : ''}</h1>
        <div class="meta"><a href="${esc(s.url)}" target="_blank">${esc(s.bvid)}${s.p > 1 ? ' P' + s.p : ''}</a>
          <span>${esc(s.owner)}</span><span>时长 ${N.fmt(s.duration || 0)}</span><span>${marks.length} 个记录点</span>${subsBadge(s)}</div>
      </div>
      <div class="acts">
        <button id="refetch" class="ghost">重新取字幕</button>
        <button id="delSess" class="ghost danger">删除</button>
        ${hostOk ? '<button id="exportOnly" class="ghost">仅导出</button>' : '<button id="exportPick" class="ghost">导出到文件夹（手选）</button>'}
        ${cfg.engine !== 'none' ? `<button id="organize" class="primary">导出并整理 · ${esc(ENGINE_NAME[cfg.engine])}</button>` : ''}
      </div>
    </div>
    <div id="jobbar" class="jobbar" style="display:none"></div>
    <div id="marks"></div>`;
  $('#refetch').onclick = refetch;
  $('#delSess').onclick = async () => {
    if (!confirm(`删除「${s.title}」的全部 ${marks.length} 条记录？（已导出的文件不受影响）`)) return;
    await db.deleteSession(s.id); current = null;
    $('#detail').innerHTML = ''; await loadSessions();
    if (sessions[0]) open(sessions[0].id);
  };
  const run = type => async () => {
    if (!hostOk) { await checkHost(); if (!hostInfo.ok) return toast('桥接程序没连上，点右上角“设置”看安装方法', 6000); }
    const r = await bg({ type, sessionId: s.id });
    if (!r.ok) toast(r.detail, 7000);
  };
  if ($('#exportOnly')) $('#exportOnly').onclick = run('export');
  if ($('#organize')) $('#organize').onclick = run('organize');
  if ($('#exportPick')) $('#exportPick').onclick = () => exportPicked().catch(e => toast('导出失败：' + e.message, 6000));
  renderJob();
  const box = $('#marks');
  marks.forEach((m, i) => box.appendChild(markCard(s, m, i)));
}

function markCard(s, m, i) {
  const el = document.createElement('article');
  el.className = 'mark';
  const srcs = m.frames.map(f => { const u = URL.createObjectURL(f.blob); urls.push(u); return u; });
  const ex = N.excerpt(body, m.t, i ? marks[i - 1].t : null);
  const last = m.frames.length - 1;
  el.innerHTML = `
    <div>
      <img class="shot" src="${srcs[m.chosen] || srcs[last]}">
      ${m.frames.length > 1 ? `<div class="strip">${m.frames.map((f, k) =>
        `<div class="fr${k === m.chosen ? ' on' : ''}" data-k="${k}"><img src="${srcs[k]}"><span>${k === last ? '按键时' : '-' + Math.round(m.t - f.t) + 's'}</span></div>`).join('')}</div>` : ''}
    </div>
    <div class="side">
      <div class="mh"><span class="no">${String(i + 1).padStart(2, '0')}</span>
        <a class="time" href="${N.link(s, m.t)}" target="_blank">${N.fmt(m.t)}</a><span class="sp"></span>
        <button class="ghost danger del">删除</button></div>
      <textarea placeholder="补一句笔记…（自动保存）">${esc(m.note)}</textarea>
      ${ex ? `<div class="subs"><span class="lbl">字幕 ${N.fmt(ex.from)}–${N.fmt(ex.to)}</span>${esc(ex.text)}</div>` : ''}
    </div>`;
  el.querySelectorAll('.fr').forEach(fr => fr.onclick = async () => {
    const k = +fr.dataset.k;
    await db.update('marks', m.id, x => { x.chosen = k; });
    m.chosen = k;
    el.querySelector('.shot').src = srcs[k];
    el.querySelectorAll('.fr').forEach(x => x.classList.toggle('on', x === fr));
  });
  const ta = el.querySelector('textarea');
  let timer;
  ta.oninput = () => { clearTimeout(timer); timer = setTimeout(() => db.update('marks', m.id, x => { x.note = ta.value; }), 500); };
  ta.onblur = () => { clearTimeout(timer); db.update('marks', m.id, x => { x.note = ta.value; }); if (refreshLater) { refreshLater = false; renderDetail(); } };
  el.querySelector('.del').onclick = async () => {
    if (!confirm(`删除 ${N.fmt(m.t)} 这条？`)) return;
    await db.del('marks', m.id);
    await renderDetail(); loadSessions();
  };
  return el;
}

async function refetch() {
  toast('正在用 B 站页面取字幕…');
  const r = await bg({ type: 'refetch-subs', sessionId: current.id });
  toast(r.ok ? (r.status === 'ok' ? '字幕已更新' : '没取到：' + r.detail) : r.detail, 5000);
  await renderDetail();
}

// —— 没装桥接程序时的备用导出：浏览器文件夹选择器 ——
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
async function exportPicked() {
  const s = current;
  if (!marks.length) return toast('这条视频还没有记录点');
  let root = await db.get('kv', 'exportDir');
  if (root && (await root.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await root.requestPermission({ mode: 'readwrite' })) !== 'granted') root = null;
  if (!root) { root = await window.showDirectoryPicker({ id: 'bilinotes', mode: 'readwrite' }); await db.put('kv', root, 'exportDir'); }
  const name = N.folderName(s);
  const dir = await root.getDirectoryHandle(name, { create: true });
  const img = await dir.getDirectoryHandle('img', { create: true });
  const imgs = N.imageNames(s, marks);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i], f = m.frames[m.chosen] || m.frames[m.frames.length - 1];
    await writeFile(img, imgs[i], f.blob);
  }
  const today = new Date().toLocaleDateString('sv-SE');
  await writeFile(dir, name + '.md', N.rawNote(s, marks, body, imgs, today));
  if (body) await writeFile(dir, '字幕.md', N.transcript(s, body));
  await writeFile(dir, 'raw.json', N.rawJson(s, marks, body, imgs));
  toast(`已导出到 ${root.name}/${name}/\n在 Claude Code 里用 /framescribe-notes 整理（技能在安装目录 skills 文件夹）`, 9000);
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'changed') return;
  loadSessions();
  if (current && msg.sessionId === current.id) {
    db.get('sessions', current.id).then(s => {
      current = s;
      if (msg.kind === 'job') { renderJob(); return; }
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') refreshLater = true;
      else renderDetail();
    });
  } else if (!current) open(msg.sessionId);
});

(async () => {
  try {
    const k = await bg({ type: 'shortcuts' });
    $('#k1').textContent = k.capture || '未设置';
    $('#k2').textContent = k['capture-note'] || '未设置';
  } catch (e) { /* 忽略 */ }
  await loadCfg();
  await checkHost();
  await loadSessions();
  const want = new URLSearchParams(location.search).get('s');
  const first = sessions.find(s => s.id === want) || sessions[0];
  if (first) open(first.id);
})();
