// 笔记本窗口：浏览记录、换截图、改笔记、听口述、导出 / 整理、设置。数据都在主程序那边，这里只管显示
const N = globalThis.BN_note;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bg = msg => bn.call(msg);
let sessions = [], current = null, marks = [], body = null, refreshLater = false;
let stat = null, cfg = null;

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

// —— 设置与状态 ——
async function loadCfg() {
  cfg = await bg({ type: 'settings-get' });
  $('#engineChip').textContent = '整理：' + ENGINE_NAME[cfg.engine] + (cfg.engine === 'api' && cfg.api.model ? ' · ' + cfg.api.model : '');
  const key = (id, v) => { const el = $(id); if (el) el.textContent = v || '未设置'; }; // 有记录后空白页就不在了
  key('#k1', cfg.keys.capture); key('#k2', cfg.keys.note); key('#k3', cfg.keys.voice); key('#k4', cfg.keys.record);
  const jb = $('#jotBtn');
  jb.classList.toggle('on', !!cfg.jotDefault);
  jb.textContent = '随笔模式 · ' + (cfg.jotDefault ? '开' : '关');
}
$('#jotBtn').onclick = async () => {
  await bg({ type: 'jot-default', on: !cfg.jotDefault });
  await loadCfg();
  toast(cfg.jotDefault ? '随笔模式开：之后新建的记录不带字幕，整理成短随笔' : '随笔模式关：新记录照常带字幕、整理成学习笔记');
};
bn.on('nb:cfg', () => loadCfg()); // 托盘菜单里切换了随笔模式

async function loadStatus() {
  stat = await bg({ type: 'status' });
  const ext = $('#extStat'), n = stat.exts.length;
  ext.className = 'chip ' + (n ? 'ok' : 'off');
  ext.textContent = n ? '插件已连接' + (n > 1 ? ' ×' + n : '') : '插件未连接 · 截屏模式';
  ext.title = n ? stat.exts.map(e => e.browser).join('、') : '打开装了插件的浏览器并开着一个 B 站视频页，就会自动连上；没连上时按键截的是屏幕';
  const asr = $('#asrStat');
  asr.className = 'chip ' + (stat.asrModel ? 'ok' : 'bad');
  asr.textContent = stat.asrModel ? '语音就绪' : '语音模型缺失';
  renderRec();
  const badKeys = Object.entries(stat.keyState).filter(([, v]) => v !== 'ok');
  if (badKeys.length && !loadStatus.warned && (loadStatus.warned = true)) toast('快捷键没注册上：' + badKeys.map(([k, v]) => `${stat.keys[k] || k}（${v}）`).join('、') + '。在设置里改。', 8000);
}

// 右上角的听课按钮：听课中显示已听多久、转了多少句
let recTick = 0;
function renderRec() {
  const btn = $('#recBtn'), r = stat && stat.rec;
  clearInterval(recTick);
  btn.classList.toggle('on', !!r);
  if (!r) { btn.textContent = '● 开始听课'; return; }
  const draw = () => { btn.textContent = `■ 结束听课 ${N.fmt((Date.now() - r.startedAt) / 1000)} · ${r.count} 句`; };
  draw(); recTick = setInterval(draw, 1000);
}
$('#recBtn').onclick = async () => {
  if (!(stat && stat.rec) && !(stat.asrModel && stat.vadModel)) return toast('语音模型缺失，不能听课');
  $('#recBtn').disabled = true;
  await bg({ type: 'rec-toggle' });
  $('#recBtn').disabled = false;
  await loadStatus();
};

function renderStatDetail() {
  const row = (k, ok, v) => `<span>${k}</span><span class="${ok ? 'ok' : 'bad'}">${v}</span>`;
  const e = stat.engines;
  $('#statDetail').innerHTML =
    row('浏览器插件', stat.exts.length, stat.exts.length ? '已连接：' + esc(stat.exts.map(x => x.browser).join('、')) : '未连接（按键时截屏；B 站网页想要原画和字幕，需在浏览器里加载插件并开着视频页）') +
    row('插件连接端口', stat.portOk, stat.portOk ? '127.0.0.1:' + stat.port : stat.port + ' 被占用，插件连不上') +
    row('语音转写', stat.asrModel, stat.asrModel ? 'SenseVoice，本机运行' : '没找到模型文件：双击安装目录里的 setup.cmd 下载') +
    row('窗口识别', stat.win32, stat.win32 ? '正常' : '不可用，只能截整个屏幕') +
    row('数据位置', true, esc(stat.dataDir)) +
    row('版本', true, 'v' + esc(stat.version));
  const mark = (id, ok) => { const el = $(id); el.textContent = ok ? '本机已找到' : '本机没找到'; el.className = ok ? 'ok' : 'bad'; };
  mark('#eClaude', e.claude); mark('#eCodex', e.codex);
  const ks = (id, name) => { const el = $(id), v = stat.keyState[name]; el.textContent = v === 'ok' ? '已生效' : (v || ''); el.className = v === 'ok' ? 'ok' : 'bad'; };
  ks('#ksCapture', 'capture'); ks('#ksNote', 'note'); ks('#ksVoice', 'voice'); ks('#ksRecord', 'record');
}

function fillSettings() {
  $('#exportRoot').value = cfg.exportRoot;
  $('#jotRoot').value = cfg.jotRoot || '';
  $('#jotRoot').placeholder = cfg.exportRoot.replace(/\\+$/, '') + '\\随笔';
  $('#keyCapture').value = cfg.keys.capture; $('#keyNote').value = cfg.keys.note; $('#keyVoice').value = cfg.keys.voice; $('#keyRecord').value = cfg.keys.record;
  $('#crop').value = cfg.crop; $('#lang').value = cfg.voice.lang; $('#autoStop').checked = cfg.voice.autoStop;
  document.querySelectorAll('input[name=engine]').forEach(r => r.checked = r.value === cfg.engine);
  $('#mClaude').value = cfg.cliModel.claude || '';
  $('#mCodex').value = cfg.cliModel.codex || '';
  const a = cfg.api;
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
    jotRoot: $('#jotRoot').value.trim(),
    keys: { capture: $('#keyCapture').value.trim(), note: $('#keyNote').value.trim(), voice: $('#keyVoice').value.trim(), record: $('#keyRecord').value.trim() },
    crop: $('#crop').value,
    voice: { lang: $('#lang').value, autoStop: $('#autoStop').checked },
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
  if (s.jotRoot && !/^[a-zA-Z]:\\/.test(s.jotRoot)) { toast('随笔导出位置要写完整路径，或者留空'); return false; }
  const r = await bg({ type: 'settings-set', settings: s });
  await loadCfg();
  stat = await bg({ type: 'status' });
  renderStatDetail();
  const bad = Object.entries(r.keyState || {}).filter(([, v]) => v !== 'ok');
  if (bad.length) { toast('有快捷键没生效：' + bad.map(([k, v]) => `${s.keys[k] || k}（${v}）`).join('、'), 6000); return false; }
  if (!silent) toast('已保存');
  if (current) renderDetail();
  return true;
}

$('#openSettings').onclick = async () => { await loadCfg(); await loadStatus(); fillSettings(); renderStatDetail(); $('#settings').showModal(); };
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
const isScreen = s => s.kind === 'screen';
const isJot = s => s.mode === 'jot';
const kindTag = (s, jotTag = true) => (isScreen(s) ? '<span class="kind">截屏</span>' : s.kind === 'web' ? `<span class="kind web">${s.site === 'youtube' ? 'YouTube' : '回放'}</span>` : '<span class="kind bili">B站</span>') + (jotTag && isJot(s) ? '<span class="kind jot">随笔</span>' : '');

async function loadSessions() {
  sessions = await bg({ type: 'sessions' });
  const side = $('#sessions');
  side.innerHTML = sessions.length ? '' : '<div class="sess"><div class="m">暂无</div></div>';
  for (const s of sessions) {
    const d = document.createElement('div');
    d.className = 'sess' + (current && current.id === s.id ? ' on' : '');
    const st = s.job && s.job.state === 'done' ? ' · ✓整理' : s.job && s.job.state === 'running' ? ' · 整理中' : '';
    d.innerHTML = `<div class="t">${esc(s.title)}${s.part ? ' · ' + esc(s.part) : ''}</div>
      <div class="m">${kindTag(s)}<span><b>${s.count}</b> 条</span><span>${esc(isScreen(s) ? s.app : s.owner)}</span><span>${new Date(s.updatedAt).toLocaleDateString()}${st}</span></div>`;
    d.onclick = () => open(s.id);
    side.appendChild(d);
  }
}

async function open(id) {
  current = sessions.find(s => s.id === id) || null;
  if (!current) return;
  document.querySelectorAll('.sess').forEach((el, i) => el.classList.toggle('on', sessions[i] && sessions[i].id === id));
  await renderDetail();
}

function subsBadge(s) {
  const x = s.subs;
  if (s.recording) return `<span class="badge live" id="subsBadge">● 听课中 · 已转写 ${x ? x.count : 0} 句</span>`;
  if (s.transcribing) return `<span class="badge live" id="subsBadge">● 插件转写中 · ${x ? x.count : 0} 句</span>`;
  if (isScreen(s) && !(x && x.status === 'ok')) return '<span class="badge warn">屏幕记录 · 没开听课，没有文字</span>';
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
  const data = await bg({ type: 'session', id: current.id });
  if (!data) { current = null; $('#detail').innerHTML = ''; return; }
  const s = current = data.session, jot = isJot(s);
  marks = data.marks; body = jot ? null : data.body; // 随笔不显示字幕（取到了也只是存着，切回学习笔记还在）
  const head = isScreen(s)
    ? `<span>${esc(s.app || '屏幕')}</span><span>${esc(s.day || '')}</span>`
    : s.kind === 'web' ? `<a href="${esc(s.url)}" target="_blank">${esc(N.siteName(s))}</a><span>时长 ${N.fmt(s.duration || 0)}</span>${s.lec && s.duration ? `<span>已转写 ${Math.min(100, Math.round(s.lec.covered.reduce((n, r) => n + r[1] - r[0], 0) / s.duration * 100))}%</span>` : ''}`
    : `<a href="${esc(s.url)}" target="_blank">${esc(s.bvid)}${s.p > 1 ? ' P' + s.p : ''}</a><span>${esc(s.owner)}</span><span>时长 ${N.fmt(s.duration || 0)}</span>`;
  $('#detail').innerHTML = `
    <div class="vhead">
      <div style="flex:1;min-width:0">
        <h1><span class="ttl" id="ttl" contenteditable="plaintext-only" spellcheck="false" title="点一下可以改标题">${esc(s.title)}</span>${s.part ? ' <span style="color:var(--dim)">· ' + esc(s.part) + '</span>' : ''}</h1>
        <div class="meta">${kindTag(s, false)}${head}<span>${marks.length} 个记录点</span>${jot ? '<span class="badge jot">不带字幕</span>' : subsBadge(s)}
          <span class="seg" id="modeSeg" title="这条记录整理成什么：学习笔记带字幕、按主题整理；随笔只用截图和你写的话，整理成短随笔">
            <button data-m="study" class="${jot ? '' : 'on'}">学习笔记</button><button data-m="jot" class="${jot ? 'on' : ''}">随笔</button></span></div>
      </div>
      <div class="acts">
        ${isScreen(s) || jot || s.kind === 'web' ? '' : '<button id="refetch" class="ghost">重新取字幕</button>'}
        ${s.kind === 'web' && cfg.engine !== 'none' && body && body.length ? '<button id="outline" class="ghost" title="按转写的文字生成带时间的目录，写成「…-大纲.md」；网页上的大纲面板也会显示">生成大纲</button>' : ''}
        <button id="delSess" class="ghost danger">删除</button>
        <button id="exportOnly" class="ghost">仅导出</button>
        ${cfg.engine !== 'none' ? `<button id="organize" class="primary">${jot ? '导出并整理成随笔' : '导出并整理'} · ${esc(ENGINE_NAME[cfg.engine])}</button>` : ''}
      </div>
    </div>
    <div id="jobbar" class="jobbar" style="display:none"></div>
    ${!jot && (body && body.length || s.recording) ? `<details class="transcript" id="transcript"${s.recording || !marks.length ? ' open' : ''}>
      <summary>视频里说的话<small id="tcount">${body ? body.length : 0} 句 · ${esc(s.subs && (s.subs.lanDoc || s.subs.lan) || '')}</small></summary>
      <div class="tlines" id="tlines">${(body || []).map(tline).join('')}</div></details>` : ''}
    ${marks.length ? '' : `<div class="nomarks">${jot ? '随笔还没有截图。' : s.recording ? '听课中。想标重点时按 ' + esc(cfg.keys.capture) + ' 截图，不按也行，文字会一直记。' : (body && body.length ? '这节课没有手动记录点，可以直接「导出并整理」，会完全按上面的文字整理。' : '')}</div>`}
    <div id="marks"></div>`;
  const ttl = $('#ttl');
  ttl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ttl.blur(); } else if (e.key === 'Escape') { ttl.textContent = s.title; ttl.blur(); } };
  ttl.onblur = async () => {
    const t = ttl.textContent.replace(/\s+/g, ' ').trim();
    if (!t || t === s.title) { ttl.textContent = s.title; return; }
    const r = await bg({ type: 'session-rename', sid: s.id, title: t });
    if (r.ok) { s.title = t; loadSessions(); } else { ttl.textContent = s.title; toast(r.detail); }
  };
  const tl = $('#tlines');
  if (tl && s.recording) tl.scrollTop = tl.scrollHeight;
  if ($('#refetch')) $('#refetch').onclick = refetch;
  $('#modeSeg').querySelectorAll('button').forEach(b => b.onclick = async () => {
    if ((b.dataset.m === 'jot') === jot) return;
    await bg({ type: 'session-mode', sid: s.id, mode: b.dataset.m }); // 主程序会发 nb:changed，页面跟着重画
  });
  $('#delSess').onclick = async () => {
    if (!confirm(`删除「${s.title}」的全部 ${marks.length} 条记录？（已导出的文件不受影响）`)) return;
    await bg({ type: 'session-del', sid: s.id }); current = null;
    $('#detail').innerHTML = ''; await loadSessions();
    if (sessions[0]) open(sessions[0].id);
  };
  const run = type => async () => { const r = await bg({ type, sessionId: s.id }); if (!r.ok) toast(r.detail, 7000); };
  $('#exportOnly').onclick = run('export');
  if ($('#organize')) $('#organize').onclick = run('organize');
  if ($('#outline')) $('#outline').onclick = run('outline');
  renderJob();
  const box = $('#marks');
  marks.forEach((m, i) => box.appendChild(markCard(s, m, i)));
}

const tline = x => `<p><span class="tt">${N.fmt(x.from)}</span>${esc(x.text)}</p>`;
// 听课时每转出一句就追加一行，不重画整页（不打断正在打字的笔记）
bn.on('nb:seg', msg => {
  if (stat && stat.rec && stat.rec.sid === msg.sessionId) { stat.rec.count = msg.count; }
  if (!current || current.id !== msg.sessionId || isJot(current)) return;
  const tl = $('#tlines'), tc = $('#tcount'), badge = $('#subsBadge');
  if (!tl) return renderDetail();
  const atEnd = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;
  tl.insertAdjacentHTML('beforeend', tline(msg.line));
  if (atEnd) tl.scrollTop = tl.scrollHeight;
  if (tc) tc.textContent = `${msg.count} 句 · 本机转写`;
  if (badge) badge.textContent = `● 听课中 · 已转写 ${msg.count} 句`;
  if (body) body.push(msg.line);
});

function voiceRow(m) {
  const v = m.voice;
  if (!v) return '';
  const st = v.state === 'transcribing' ? '<span class="vs">转写中…</span>'
    : v.state === 'error' ? `<span class="vs bad" title="${esc(v.detail)}">转写失败</span>`
    : v.text ? '' : '<span class="vs bad">没识别出内容</span>';
  return `<div class="voice">🎙 口述 ${v.sec}s <button class="ghost play">▶ 听</button>${st}${v.state !== 'transcribing' ? '<button class="ghost retry">重新转写</button>' : ''}</div>`;
}

function markCard(s, m, i) {
  const el = document.createElement('article');
  el.className = 'mark';
  const ex = N.excerpt(body, m.t, i ? marks[i - 1].t : null);
  const last = m.frames.length - 1, shot = m.frames[m.chosen] || m.frames[last];
  const time = m.link ? `<a class="time" href="${esc(m.link)}" target="_blank">${esc(m.label)}</a>`
    : `<span class="time">${esc(m.label)}</span><span class="no">+${N.fmt(m.t)}</span>`;
  el.innerHTML = `
    <div>
      <img class="shot" src="${esc(shot.url)}">
      ${m.frames.length > 1 ? `<div class="strip">${m.frames.map((f, k) =>
        `<div class="fr${k === m.chosen ? ' on' : ''}" data-k="${k}"><img src="${esc(f.url)}"><span>${k === last ? '按键时' : '-' + Math.max(1, Math.round(m.t - f.t)) + 's'}</span></div>`).join('')}</div>` : ''}
    </div>
    <div class="side">
      <div class="mh"><span class="no">${String(i + 1).padStart(2, '0')}</span>${time}<span class="sp"></span>
        <button class="ghost danger del">删除</button></div>
      <textarea placeholder="${isJot(s) ? '这张图哪里打动你…（自动保存）' : '补一句笔记…（自动保存）'}">${esc(m.note)}</textarea>
      ${voiceRow(m)}
      ${ex ? `<div class="subs"><span class="lbl">字幕 ${N.fmt(ex.from)}–${N.fmt(ex.to)}</span>${esc(ex.text)}</div>` : ''}
    </div>`;
  el.querySelectorAll('.fr').forEach(fr => fr.onclick = async () => {
    const k = +fr.dataset.k;
    await bg({ type: 'mark-choose', sid: s.id, mid: m.id, idx: k });
    m.chosen = k;
    el.querySelector('.shot').src = m.frames[k].url;
    el.querySelectorAll('.fr').forEach(x => x.classList.toggle('on', x === fr));
  });
  const ta = el.querySelector('textarea');
  let timer;
  const save = () => bg({ type: 'mark-note', sid: s.id, mid: m.id, note: ta.value });
  ta.oninput = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  ta.onblur = () => { clearTimeout(timer); save(); if (refreshLater) { refreshLater = false; renderDetail(); } };
  el.querySelector('.del').onclick = async () => {
    if (!confirm(`删除 ${m.label} 这条？`)) return;
    await bg({ type: 'mark-del', sid: s.id, mid: m.id });
    await renderDetail(); loadSessions();
  };
  const play = el.querySelector('.play');
  if (play) play.onclick = () => new Audio(m.voiceUrl).play().catch(e => toast('放不了：' + e.message));
  const retry = el.querySelector('.retry');
  if (retry) retry.onclick = async () => { const r = await bg({ type: 'voice-retry', sid: s.id, mid: m.id }); if (!r.ok) toast('转写失败：' + r.detail, 6000); };
  return el;
}

async function refetch() {
  toast('正在通过浏览器插件取字幕…');
  const r = await bg({ type: 'refetch-subs', sessionId: current.id });
  toast(r.ok ? (r.status === 'ok' ? '字幕已更新' : '没取到：' + r.detail) : r.detail, 6000);
  await renderDetail();
}

bn.on('nb:changed', async msg => {
  await loadSessions();
  if (current && msg.sessionId === current.id) {
    if (msg.kind === 'job') { const s = sessions.find(x => x.id === current.id); if (s) { current = s; renderJob(); } return; }
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') refreshLater = true;
    else renderDetail();
  } else if (!current) open(msg.sessionId);
});
bn.on('nb:open', id => loadSessions().then(() => open(id)));
bn.on('nb:status', () => loadStatus());

// —— 第一次启动：欢迎引导（检查 + 导出位置 + 快捷键）——
function showWelcome() {
  const row = (k, ok, v) => `<span>${k}</span><span class="${ok ? 'ok' : 'bad'}">${v}</span>`;
  const e = stat.engines, picked = cfg.engine;
  const eng = picked === 'claude' || picked === 'codex'
    ? `已自动选 ${ENGINE_NAME[picked]}（用你的订阅）`
    : '没找到 Claude Code / Codex：可以先只导出，或在设置里选 API 填 Key（DeepSeek、通义、Kimi…）';
  $('#wCheck').innerHTML =
    row('AI 整理', e.claude || e.codex || picked === 'api', esc(eng)) +
    row('语音转写', stat.asrModel && stat.vadModel, stat.asrModel && stat.vadModel ? '模型就绪，本机运行、不联网' : '缺模型：双击安装目录里的 setup.cmd 下载（不影响截图和字幕）') +
    row('浏览器插件', stat.exts.length, stat.exts.length ? '已连接' : '还没连上：按 README 加载 extension 文件夹，再打开一个 B 站 / YouTube 视频页（不装也能截屏）');
  $('#wRoot').value = cfg.exportRoot;
  $('#wk1').textContent = cfg.keys.capture; $('#wk2').textContent = cfg.keys.note;
  $('#wk3').textContent = cfg.keys.voice; $('#wk4').textContent = cfg.keys.record;
  $('#welcome').showModal();
}
async function finishWelcome() {
  const root = $('#wRoot').value.trim();
  if (!/^[a-zA-Z]:\\/.test(root)) { toast('要写完整路径，比如 D:\\Obsidian库\\视频笔记'); return false; }
  await bg({ type: 'settings-set', settings: { exportRoot: root } });
  await bg({ type: 'welcome-done' });
  await loadCfg();
  $('#welcome').close();
  return true;
}
$('#wGo').onclick = async () => { if (await finishWelcome()) toast('好了。去打开一个视频，按 ' + cfg.keys.capture + ' 试试', 6000); };
$('#wSettings').onclick = async () => { if (await finishWelcome()) $('#openSettings').click(); };
$('#welcome').addEventListener('cancel', e => e.preventDefault()); // Esc 不关，必须点按钮（保证设置写盘）

(async () => {
  await loadCfg();
  await loadStatus();
  if (stat.welcome) showWelcome();
  await loadSessions();
  const want = new URLSearchParams(location.search).get('s');
  const first = sessions.find(s => s.id === want) || sessions[0];
  if (first) open(first.id);
})();
