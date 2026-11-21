// 视频页里跑：每秒存一张画面（只留最近 15 秒、去重），按快捷键时截图 + 记时间点 + 抓字幕
(() => {
  if (window.top !== window) return;
  const BUF_SEC = 15, CAND_W = 960, MAIN_W = 1920, SAME_T = 4, DIFF_T = 7, MAX_CAND = 6;
  let buf = [], bufKey = '', blocked = false, count = 0;
  let keys = { capture: 'Alt+S', 'capture-note': 'Alt+A' };
  const subsAsked = new Set(), infoCache = new Map();

  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  const sc = document.createElement('canvas'); sc.width = 32; sc.height = 18;
  const sctx = sc.getContext('2d', { willReadFrequently: true });

  const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, detail: String(e) }));

  // 电影 / 番剧 / 纪录片页：地址是 /bangumi/play/ep123（或 ss456，这时从页面里找集号）。集号要问一次接口才换得到 BV 号
  const eps = new Map(); // 集号 → 这一集的信息；null = 正在问
  function epId() {
    const m = location.pathname.match(/^\/bangumi\/play\/(ep|ss)(\d+)/);
    if (!m) return '';
    if (m[1] === 'ep') return m[2];
    const el = document.querySelector('meta[property="og:url"], link[rel="canonical"]');
    const k = String(el && (el.content || el.href) || '').match(/\/ep(\d+)/);
    return k ? k[1] : '';
  }
  function pageKey() {
    const ep = epId();
    if (ep) {
      if (!eps.has(ep)) {
        eps.set(ep, null);
        BN_bili.epInfo(ep).then(i => eps.set(ep, i), e => { console.warn('[FrameScribe] 查不到这一集', e); setTimeout(() => eps.delete(ep), 10000); });
      }
      const i = eps.get(ep);
      return i ? { bvid: i.bvid, p: 1, id: `${i.bvid}_p1`, ep: i } : null;
    }
    const u = new URL(location.href);
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    const bvid = m ? m[1] : u.searchParams.get('bvid');
    if (!bvid) return null;
    const p = parseInt(u.searchParams.get('p') || '1', 10) || 1;
    return { bvid, p, id: `${bvid}_p${p}` };
  }
  function video() {
    const vs = [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0);
    return vs.find(v => v.closest('#bilibili-player, .bpx-player-container')) || vs[0] || null;
  }
  function frame(v, maxW, q) {
    const w = Math.min(v.videoWidth, maxW), h = Math.round(v.videoHeight * w / v.videoWidth);
    cv.width = w; cv.height = h;
    ctx.drawImage(v, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', q);
  }
  function sig(v) {
    sctx.drawImage(v, 0, 0, 32, 18);
    const d = sctx.getImageData(0, 0, 32, 18).data, g = new Uint8Array(576);
    for (let i = 0; i < 576; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  }
  const bright = g => { let s = 0; for (let i = 0; i < g.length; i++) s += g[i]; return s / g.length; };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const fmt = t => {
    t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  };

  // —— 回看缓冲：播放中每秒一张，画面没变就不存 ——
  setInterval(() => {
    const k = pageKey(), v = video();
    if (!k || !v || blocked) return;
    if (k.id !== bufKey) { buf = []; bufKey = k.id; onNewVideo(k); }
    if (v.paused || v.readyState < 2 || v.mediaKeys) return;
    const t = v.currentTime;
    buf = buf.filter(f => f.t <= t + 0.5 && f.t >= t - BUF_SEC);
    try {
      const g = sig(v), last = buf[buf.length - 1];
      if (last && diff(last.sig, g) < SAME_T) return;
      buf.push({ t, sig: g, url: frame(v, CAND_W, 0.8) });
    } catch (e) {
      blocked = true;
      console.warn('[FrameScribe] 画面受保护，无法截取', e);
    }
  }, 1000);

  async function onNewVideo(k) {
    ui();
    const r = await send({ type: 'count', sessionId: k.id });
    count = (r && r.count) || 0;
    const s = await send({ type: 'shortcuts' });
    if (s && !s.detail) keys = { ...keys, ...s };
    renderPill();
  }

  async function sessionMeta(k) {
    if (k.ep) { const e = k.ep; return { id: k.id, bvid: e.bvid, p: 1, ep: e.id, aid: e.aid, cid: e.cid, title: e.title, part: e.part, owner: e.owner, duration: e.duration, url: e.url }; }
    let info = infoCache.get(k.bvid);
    if (!info) { try { info = await BN_bili.videoInfo(k.bvid); infoCache.set(k.bvid, info); } catch (e) { info = null; } }
    const page = info && info.pages && (info.pages[k.p - 1] || info.pages[0]);
    return {
      id: k.id, bvid: k.bvid, p: k.p, aid: info ? info.aid : 0, cid: page ? page.cid : (info ? info.cid : 0),
      title: info ? info.title : document.title.replace(/_哔哩哔哩_bilibili$/, ''),
      part: info && info.pages.length > 1 && page ? page.part : '',
      owner: info ? info.owner.name : '', duration: page ? page.duration : (info ? info.duration : 0),
      url: `https://www.bilibili.com/video/${k.bvid}/${k.p > 1 ? '?p=' + k.p : ''}`
    };
  }

  async function fetchSubs(aid, cid) {
    try { return await BN_bili.subtitles(aid, cid); }
    catch (e) { return { status: 'error', detail: String(e.message || e) }; }
  }

  // 截当前画面 + 从前 15 秒里挑候选。插件自己用，桌面软件来要图时也用
  function grab() {
    const k = pageKey(), v = video();
    if (!k) return { error: epId() ? '还在查这一集的编号，过两秒再按' : '这个页面认不出视频编号（BV 号）' };
    if (!v) return { error: '没找到正在播放的视频' };
    if (v.mediaKeys) return { error: '这个视频是加密播放的，浏览器不让截画面' }; // 加密视频画到画布上是一片黑，不如直接说
    const t = v.currentTime;
    let main, ms;
    try { main = frame(v, MAIN_W, 0.9); ms = sig(v); }
    catch (e) { return { error: '画面被浏览器保护，截不了（可能是加密的付费内容）' }; }

    // 从新到旧挑出和“现在”及彼此明显不同的画面
    const kept = [ms], cands = [];
    for (let i = buf.length - 1; i >= 0 && cands.length < MAX_CAND; i--) {
      const f = buf[i];
      if (f.t > t + 0.5) continue;
      if (kept.every(g => diff(g, f.sig) > DIFF_T)) { kept.push(f.sig); cands.push(f); }
    }
    cands.reverse();
    const frames = [...cands.map(f => ({ t: f.t, dataUrl: f.url })), { t, dataUrl: main, main: true }];
    let chosen = frames.length - 1;
    if (bright(ms) < 14) for (let i = cands.length - 1; i >= 0; i--) if (bright(cands[i].sig) >= 14) { chosen = i; break; }
    return { k, t, frames, chosen };
  }

  async function capture(withNote) {
    const g = grab();
    if (g.error) return flash(g.error);
    const { k, t, frames, chosen } = g;
    const toast = showToast(frames, t, withNote, chosen);

    const session = await sessionMeta(k);
    const r = await send({ type: 'mark', session, mark: { t, note: '', frames, chosen } });
    if (!r || !r.ok) return toast.fail(r && r.detail);
    count = r.count;
    renderPill();
    toast.ready(r.markId, session.id, r.count);

    if (!r.hasSubs && !subsAsked.has(k.id) && session.aid) {
      subsAsked.add(k.id);
      const subs = await fetchSubs(session.aid, session.cid);
      await send({ type: 'subs', sessionId: k.id, subs });
      if (subs.status !== 'ok' && !active) flash('字幕：' + subs.detail, 4000);
    }
  }

  // —— 桌面软件开着时：软件管快捷键和弹窗，这里只负责交出原画、时间点和字幕 ——
  const appSubsAsked = new Set();
  async function appCapture() {
    const g = grab();
    if (g.error) return { ok: false, reason: g.error };
    const session = await sessionMeta(g.k);
    if (!appSubsAsked.has(g.k.id) && session.aid) {
      appSubsAsked.add(g.k.id);
      fetchSubs(session.aid, session.cid).then(subs => send({ type: 'app-subs', sessionId: g.k.id, subs }));
    }
    return { ok: true, session, t: g.t, frames: g.frames, chosen: g.chosen };
  }
  // 叫醒后台去连软件：打开视频页、切回这个标签页时立刻试一次，平时每 15 秒一次
  const beat = () => { if (pageKey()) send({ type: 'hb' }); };
  setInterval(beat, 15000);
  document.addEventListener('visibilitychange', beat);
  beat();

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'cmd') { capture(msg.name === 'capture-note'); reply({ ok: true }); return; }
    if (msg.type === 'app-capture') { appCapture().then(reply, e => reply({ ok: false, reason: String(e.message || e) })); return true; }
    if (msg.type === 'app-saved') { const k = pageKey(); if (k && k.id === msg.sessionId) { count = msg.count; renderPill(); } return; }
    if (msg.type === 'fetch-subs') {
      (async () => {
        try {
          const info = await BN_bili.videoInfo(msg.bvid);
          const page = info.pages[msg.p - 1] || info.pages[0];
          reply(await fetchSubs(info.aid, page.cid));
        } catch (e) { reply({ status: 'error', detail: String(e.message || e) }); }
      })();
      return true;
    }
  });

  // —— 页面上的小界面（Shadow DOM，不受 B 站样式影响） ——
  let host, root, toastEl, pillEl, active = null;

  function ui() {
    if (root) return root;
    host = document.createElement('div');
    host.id = 'bilinotes-host';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      .toast { position: fixed; top: 76px; right: 16px; width: 440px; max-width: calc(100vw - 32px); z-index: 2147483647;
        background: #12151bf2; color: #e8ecf2; border: 1px solid #2a303b; border-left: 3px solid #ff7a2f; border-radius: 10px;
        padding: 10px 12px 12px; box-shadow: 0 10px 30px #0008; transition: opacity .2s, transform .2s; }
      .toast.hide { opacity: 0; transform: translateY(-6px); pointer-events: none; }
      .head { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 8px; }
      .tag { font: 600 11px/1 Consolas, monospace; color: #ff7a2f; letter-spacing: .08em; }
      .time { font: 600 14px Consolas, monospace; color: #fff; }
      .no { color: #8a93a3; }
      .sp { flex: 1; }
      .x { background: none; border: 0; color: #8a93a3; font-size: 16px; cursor: pointer; padding: 0 4px; }
      .strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
      .fr { position: relative; flex: 0 0 auto; width: 96px; cursor: pointer; border-radius: 5px; overflow: hidden; border: 2px solid transparent; opacity: .7; }
      .fr.on { border-color: #ff7a2f; opacity: 1; }
      .fr:hover { opacity: 1; }
      .fr img { display: block; width: 100%; aspect-ratio: 16/9; object-fit: cover; background: #000; }
      .fr span { position: absolute; left: 3px; bottom: 2px; font: 10px Consolas, monospace; color: #fff; text-shadow: 0 0 3px #000; }
      .solo { font-size: 11px; color: #8a93a3; align-self: center; padding-left: 4px; }
      input { width: 100%; margin-top: 8px; background: #0b0d11; color: #fff; border: 1px solid #333b48; border-radius: 6px; padding: 7px 9px; font-size: 13px; outline: none; }
      input:focus { border-color: #ff7a2f; }
      .hint { margin-top: 6px; font-size: 11px; color: #8a93a3; }
      .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; display: flex; align-items: center; gap: 8px;
        background: #12151be6; color: #e8ecf2; border: 1px solid #2a303b; border-radius: 999px; padding: 6px 12px; font-size: 12px;
        cursor: pointer; opacity: .45; transition: opacity .2s; user-select: none; }
      .pill:hover { opacity: 1; }
      .pill b { color: #ff7a2f; font: 700 13px Consolas, monospace; }
      .pill .keys { display: none; color: #8a93a3; }
      .pill:hover .keys { display: inline; }
      .msg { font-size: 13px; }
    </style><div class="toast hide"></div><div class="pill"></div>`;
    toastEl = root.querySelector('.toast');
    pillEl = root.querySelector('.pill');
    pillEl.addEventListener('click', () => { const k = pageKey(); send({ type: 'open-manager', sessionId: k && k.id }); });
    toastEl.addEventListener('mouseenter', () => active && clearTimeout(active.timer));
    toastEl.addEventListener('mouseleave', () => active && !active.input && arm(4000));
    const mount = () => (document.fullscreenElement || document.body || document.documentElement).appendChild(host);
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    document.addEventListener('fullscreenchange', mount);
    return root;
  }

  function renderPill() {
    if (!pillEl) return;
    pillEl.innerHTML = `📒 <b>${count}</b><span class="keys">${keys.capture || '未设置'} 截图 · ${keys['capture-note'] || '未设置'} 截图+一句话 · 点我打开笔记本</span>`;
  }

  function arm(ms) {
    clearTimeout(active.timer);
    active.timer = setTimeout(closeToast, ms);
  }
  function closeToast() {
    if (!active) return;
    clearTimeout(active.timer);
    if (active.input && active.input.value.trim()) saveNote();
    toastEl.classList.add('hide');
    active = null;
  }
  function saveNote() {
    if (!active || !active.input) return;
    const note = active.input.value.trim();
    active.pendingNote = note;
    if (active.markId) send({ type: 'note', markId: active.markId, sessionId: active.sessionId, note });
    active.input.value = '';
    active.input = null;
  }

  function flash(text, ms = 2500) {
    ui();
    if (active) closeToast();
    toastEl.innerHTML = '';
    const d = document.createElement('div'); d.className = 'msg'; d.textContent = text;
    toastEl.appendChild(d);
    toastEl.classList.remove('hide');
    active = { timer: 0 };
    arm(ms);
  }

  function showToast(frames, t, withNote, chosen0) {
    ui();
    if (active) closeToast();
    const n = frames.length;
    toastEl.innerHTML = `
      <div class="head"><span class="tag">MARK</span><span class="time">${fmt(t)}</span><span class="no">保存中…</span><span class="sp"></span><button class="x" title="关闭">×</button></div>
      <div class="strip">${frames.map((f, i) => `<div class="fr${i === chosen0 ? ' on' : ''}" data-i="${i}"><img src="${f.dataUrl}"><span>${i === n - 1 ? '现在' : '-' + Math.round(t - f.t) + 's'}</span></div>`).join('')}
        ${n === 1 ? '<span class="solo">前 15 秒画面没明显变化</span>' : ''}${chosen0 !== n - 1 ? '<span class="solo">按键时是黑场，已换成前一张</span>' : ''}</div>
      ${withNote ? '<input placeholder="写一句（回车保存，Esc 跳过）">' : ''}
      <div class="hint">${n > 1 ? '点缩略图换成更清楚的那一张 · ' : ''}视频不会暂停</div>`;
    toastEl.classList.remove('hide');
    const me = active = { timer: 0, markId: null, sessionId: null, input: toastEl.querySelector('input'), chosen: chosen0, chosen0 };
    toastEl.querySelector('.x').onclick = closeToast;
    toastEl.querySelectorAll('.fr').forEach(el => el.onclick = () => {
      me.chosen = +el.dataset.i;
      toastEl.querySelectorAll('.fr').forEach(x => x.classList.toggle('on', x === el));
      if (me.markId) send({ type: 'choose', markId: me.markId, sessionId: me.sessionId, idx: me.chosen });
    });
    if (me.input) { setTimeout(() => me.input && me.input.focus(), 0); arm(45000); }
    else arm(n > 1 ? 7000 : 3500);
    return {
      ready(markId, sessionId, no) {
        me.markId = markId; me.sessionId = sessionId;
        const el = toastEl.querySelector('.no'); if (el && active === me) el.textContent = `第 ${no} 条`;
        if (me.chosen !== me.chosen0) send({ type: 'choose', markId, sessionId, idx: me.chosen });
        if (me.pendingNote) send({ type: 'note', markId, sessionId, note: me.pendingNote });
      },
      fail(detail) { if (active === me) flash('保存失败：' + (detail || '未知错误'), 5000); }
    };
  }

  // 输入框有焦点时，按键别让 B 站播放器收到（空格暂停、F 全屏之类）
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, e => {
      if (!root || !root.activeElement || root.activeElement.tagName !== 'INPUT') return;
      e.stopImmediatePropagation();
      if (type !== 'keydown' || e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); saveNote(); closeToast(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (active && active.input) active.input.value = ''; closeToast(); }
    }, true);
  }
})();
