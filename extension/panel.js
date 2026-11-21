// 网页视频的「大纲」面板（插件这一半）：保利威直播回放页、YouTube 视频页
//   - 拿全文：YouTube 有字幕就直接取字幕（几秒）；没有字幕 / 保利威：从播放器取声音交给桌面软件转成文字（可倍速、可在后台、默认不出声），时间是视频进度
//   - 生成大纲：软件把文字交给 AI，回来一份带时间的目录；点哪条跳到哪
//   - 搜索：在文字里搜，点结果跳过去
//   - 软件的 Alt+S 截图：交出当前画面和视频时间
// 播放器在页面自己的环境里，由 page-main.js 负责；两边用 window.postMessage 说话
(() => {
  if (window.top !== window) return;
  const TAG = 'bn-polyv';
  const YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const ytId = () => YT && location.pathname === '/watch' ? (new URL(location.href).searchParams.get('v') || '') : '';
  const onVideo = () => !YT || !!ytId(); // YouTube 是单页应用：首页、搜索页也会跑这个脚本，只在视频页显示
  const KEY_GAP = 15, KEY_DIFF = 6, KEY_MAX = 600; // 转写时顺手存画面：视频里至少隔 15 秒、画面明显变了才存，一节课最多 600 张

  // —— 和页面里的播放器说话 ——
  let mseq = 0;
  const mwait = new Map();
  const main = (cmd, args = {}, ms = 3000) => new Promise(resolve => {
    const id = ++mseq;
    mwait.set(id, resolve);
    window.postMessage({ tag: TAG, dir: 'in', id, cmd, ...args }, '*');
    setTimeout(() => { if (mwait.delete(id)) resolve(null); }, ms);
  });
  window.addEventListener('message', e => {
    const m = e.data;
    if (e.source !== window || !m || m.tag !== TAG || m.dir !== 'out') return;
    if (m.re) { const w = mwait.get(m.re); if (w) { mwait.delete(m.re); w(m.r); } return; }
    if (m.ev === 'audio') onAudio(m);
    else if (m.ev === 'jump') onJump(m);
  });

  // —— 和桌面软件说话（经插件后台转一道） ——
  let port = null, pseq = 0;
  const pwait = new Map();
  function connect() {
    if (port) return port;
    try { port = chrome.runtime.connect({ name: 'polyv' }); } catch (e) { return null; } // 插件被重新加载过：这个页面要刷新
    port.onMessage.addListener(m => {
      if (m.re) { const w = pwait.get(m.re); if (w) { pwait.delete(m.re); w(m.r); } return; }
      if (m.push) onPush(m.push);
    });
    port.onDisconnect.addListener(() => { port = null; for (const w of pwait.values()) w(null); pwait.clear(); });
    return port;
  }
  const tell = msg => { const p = connect(); if (p) try { p.postMessage({ msg }); } catch (e) {} };
  const ask = (msg, ms = 20000) => new Promise(resolve => {
    const p = connect();
    if (!p) return resolve({ ok: false, detail: '插件被重新加载过，请刷新这个页面' });
    const id = ++pseq;
    pwait.set(id, resolve);
    try { p.postMessage({ ask: true, id, ms, msg }); } catch (e) { pwait.delete(id); resolve(null); }
    setTimeout(() => { if (pwait.delete(id)) resolve(null); }, ms + 1000);
  });
  const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, detail: String(e) }));

  // —— 这节回放是哪一节 ——
  const fmt = t => {
    t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  };
  function current() { // 「往期」列表里标着“播放中”的那一张卡片：标题 + 开始时间
    const tag = [...document.querySelectorAll('div, span, p')].find(el => el.childElementCount <= 2 && el.textContent.trim() === '播放中');
    for (let el = tag, i = 0; el && i < 8; el = el.parentElement, i++) {
      const lines = (el.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      if (lines.length < 2 || !lines.some(x => /^\d{1,2}:\d\d(:\d\d)?$/.test(x))) continue;
      const rest = lines.filter(x => x !== '播放中' && !/^\d{1,2}:\d\d(:\d\d)?$/.test(x));
      const title = rest.find(x => !/^开始时间/.test(x)) || '';
      const st = (rest.find(x => /^开始时间/.test(x)) || '').replace(/^开始时间[:：]\s*/, '');
      if (title) return { title, start: st };
    }
    return null;
  }
  function meta(st) {
    if (YT) {
      const v = ytId(), i = st && st.info && st.info.id === v ? st.info : null; // 换视频的一瞬间播放器里可能还是上一个
      return {
        id: ('yt_' + v.replace(/[^\w-]/g, '')).slice(0, 100), kind: 'web', site: 'youtube', siteName: 'YouTube',
        title: (i && i.title) || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim() || 'YouTube 视频',
        part: (i && i.date) || '', owner: (i && i.author) || '', url: 'https://www.youtube.com/watch?v=' + v,
        duration: st && st.dur && !st.ad ? Math.round(st.dur) : (i ? i.len : 0)
      };
    }
    const u = new URL(location.href), vid = u.searchParams.get('playBackVid') || u.searchParams.get('vid') || '';
    const ch = (location.pathname.match(/\/watch\/(\d+)/) || [])[1] || '';
    const cur = current();
    const part = cur && cur.start ? cur.start.slice(0, 16) : '';
    const key = vid || (ch + '_' + (part.replace(/\D/g, '') || 'live'));
    const url = location.origin + location.pathname + (vid ? '?playBackVid=' + encodeURIComponent(vid) : '');
    return {
      id: ('pv_' + key.replace(/[^\w.-]/g, '')).slice(0, 100), kind: 'web', site: 'polyv', siteName: '保利威回放',
      title: (cur && cur.title) || document.title.trim() || '保利威回放', part, url, duration: st && st.dur ? Math.round(st.dur) : 0
    };
  }

  // —— 打开带 bn_t=秒 的链接：播放器准备好以后跳到那里 ——
  const jumpTo = +(new URL(location.href).searchParams.get('bn_t') || NaN);
  // 保利威自己会“续播”（跳回上次看到的位置），可能发生在我们跳完之后，所以跳完再盯 15 秒，被拉走了就再跳
  if (jumpTo >= 0) {
    let tries = 0, jumpedAt = 0;
    const iv = setInterval(async () => {
      if (++tries > 120) return clearInterval(iv);
      const s = await main('state');
      if (!s || !s.ready || !s.dur) return;
      const off = s.vt / 1000 - jumpTo;
      if (jumpedAt && off > -2 && off < 20) { if (Date.now() - jumpedAt > 15000) clearInterval(iv); return; }
      if (!jumpedAt) flash('已跳到 ' + fmt(jumpTo));
      jumpedAt = Date.now();
      await main('seek', { ms: jumpTo * 1000 });
    }, 1000);
  }

  // —— 数据 ——
  let sid = '', data = null, st = null, appOk = false;
  let run = null; // 转写中：{ rate, mute, segStart, last, ranges, keys, lastKeyT, lastKeySig, lastProg }
  const covered = () => mergeRanges([...((data && data.session && data.session.lec && data.session.lec.covered) || []), ...(run ? run.ranges : []), ...(run && run.segStart != null ? [[run.segStart, run.last]] : [])]);
  function mergeRanges(rs) {
    const a = rs.filter(r => r && r[1] > r[0]).map(r => [+r[0], +r[1]]).sort((x, y) => x[0] - y[0]), o = [];
    for (const r of a) { const l = o[o.length - 1]; if (l && r[0] <= l[1] + 3) l[1] = Math.max(l[1], r[1]); else o.push(r); }
    return o;
  }
  const coveredSec = () => covered().reduce((n, r) => n + r[1] - r[0], 0);
  // 从 from 秒往后第一段还没转的：[开始, 结束]；全转完返回 null
  function nextGap(from, dur) {
    let t = Math.max(0, from);
    for (const r of covered()) {
      if (r[1] <= t) continue;
      if (r[0] > t + 2) return [t, r[0]];
      t = Math.max(t, r[1]);
    }
    return t < dur - 2 ? [t, dur] : null;
  }

  async function refresh() {
    st = await main('state');
    const m = meta(st);
    if (m.id !== sid) { sid = m.id; data = null; }
    const r = await ask({ type: 'lec-get', sid }, 8000);
    appOk = !!(r && r.ok);
    if (appOk) data = r.exists ? r : { session: null, body: [], outline: null };
    render();
  }

  // —— 转写 ——
  // YouTube 有字幕：直接取字幕全文交给软件（几秒），不用把视频放一遍
  let capsFailed = ''; // 取字幕失败过的视频：再点就改成听声音转写
  const hasCaps = () => YT && st && st.info && st.info.id === ytId() && st.info.caps > 0 && capsFailed !== ytId();
  async function takeSubs() {
    if (st && st.ad) return flash('正在放广告，广告放完再点');
    const m = meta(st);
    flash('正在取 YouTube 字幕…', 20000);
    const r = await main('subs', {}, 25000);
    if (!r || !r.ok) return { ok: false, detail: (r && r.detail) || '页面没回应，刷新一下再试' };
    if (r.vid !== ytId()) return { ok: false, detail: '视频换了，再点一次' };
    const a = await ask({ type: 'lec-subs', session: m, body: r.lines, lan: r.lang, lanDoc: `YouTube ${r.asr ? '自动字幕' : '字幕'} · ${r.name}` }, 20000);
    if (!a || !a.ok) return { ok: false, detail: (a && a.detail) || '没连上 FrameScribe 软件，先打开软件' };
    sid = m.id;
    await refresh();
    flash(`取到字幕：${r.name}${r.asr ? '（自动生成）' : ''}，${a.count} 句${ui.auto.checked ? '，正在生成大纲…' : ''}`, 5000);
    if (ui.auto.checked) makeOutline();
    if (shotsOn()) {
      const back = st ? st.vt : 0, wasPaused = st ? st.paused : true;
      await main('bg', { on: true });
      const n = await grabFrames(m.id, (st && st.dur) || 0, t => flash('配截图：' + t, 20000));
      await main('bg', { on: false });
      await main('seek', { ms: back });
      if (!wasPaused) main('play');
      flash(`截了 ${n} 张图，大纲每章会配一张`, 4000);
    }
    return { ok: true };
  }
  async function startRun() {
    st = await main('state');
    if (st && st.ad) return flash('正在放广告，广告放完再点');
    if (!st || !st.ready || !st.dur) return flash('播放器还没准备好：先点一下播放，等画面出来');
    if (hasCaps() && !(data && data.body && data.body.length)) {
      const r = await takeSubs();
      if (!r || r.ok) return;
      flash('取字幕失败：' + r.detail + '。再点一次「开始转写」会改成听声音转写', 8000);
      capsFailed = ytId();
      return;
    }
    const m = meta(st);
    const r = await ask({ type: 'lec-start', session: m }, 30000);
    if (!r || !r.ok) return flash('开始不了：' + ((r && r.detail) || '没连上 FrameScribe 软件，先打开软件'), 6000);
    sid = m.id;
    if (!data || !data.session) await refresh();
    const gap = nextGap(0, st.dur);
    if (!gap) { await ask({ type: 'lec-stop' }); return flash('这节课已经全部转写过了'); }
    const old = mergeRanges((data && data.session && data.session.lec && data.session.lec.covered) || []); // 开始时已经转过的部分，走到这些地方就跳过
    run = { old, rate: +ui.rate.value || 1.5, mute: ui.mute.checked, segStart: null, last: gap[0], ranges: [], lastAudio: Date.now(), nudged: 0, keys: 0, lastKeyT: -1e9, lastKeySig: null, lastProg: Date.now() };
    await main('seek', { ms: gap[0] * 1000 });
    await main('rate', { v: run.rate });
    const t = await main('tap', { on: true, mute: run.mute });
    if (!t || !t.ok) { await stopRun('没找到播放器的声音：先点播放，听到声音后再点「转写」'); return; }
    await main('bg', { on: true });
    await main('play');
    run.segStart = gap[0];
    render();
    flash(`开始转写 · ${run.rate} 倍速${run.mute ? ' · 静音' : ''}，可以切到别的标签页`);
  }
  async function stopRun(reason, finished) {
    if (!run) return;
    const r0 = run;
    run = null;
    await main('tap', { on: false });
    await main('bg', { on: false });
    await main('rate', { v: 1 });
    if (finished) await main('pause');
    const ranges = mergeRanges([...r0.ranges, ...(r0.segStart != null ? [[r0.segStart, r0.last]] : [])]);
    if (ranges.length) tell({ type: 'lec-progress', sid, ranges, rate: r0.rate });
    await ask({ type: 'lec-stop' }, 20000);
    await refresh();
    if (reason) flash(reason, 6000);
    if (finished && ui.auto.checked && !(data && data.outline)) makeOutline();
  }
  function closeSeg(at) {
    if (run.segStart != null && at > run.segStart) run.ranges.push([run.segStart, at]);
    run.segStart = null;
  }
  async function onAudio(m) {
    if (!run || (YT && 'yt_' + ytId() !== sid)) return; // YouTube 换了视频：新视频的声音别记到旧记录里（tick 会停掉转写）
    const vt = m.vt / 1000, rate = +m.rate || 1;
    if (vt > run.last + 0.01 || run.segStart == null) run.lastAudio = Date.now(); // 进度在走才算（卡住时也可能送来全是静音的包）
    if (run.segStart == null) run.segStart = Math.max(0, vt - 0.5 * rate);
    run.last = vt;
    tell({ type: 'lec-audio', pcm: b64(m.pcm), vt: m.vt, rate });
    if (Date.now() - run.lastProg > 5000) {
      run.lastProg = Date.now();
      tell({ type: 'lec-progress', sid, ranges: mergeRanges([...run.ranges, [run.segStart, run.last]]), rate });
      renderProgress();
    }
    keyframe(vt);
    // 走到了以前转过的地方：跳到下一段没转的；全转完就收工
    const dur = (st && st.dur) || m.dur || 0;
    const inOld = run.old.find(r => vt > r[0] + 1 && vt < r[1] - 1);
    if (dur && vt >= dur - 1.5) return stopRun('这节课转写完了' + (ui.auto.checked ? '，正在生成大纲…' : ''), true);
    if (inOld) {
      closeSeg(vt);
      const gap = nextGap(inOld[1], dur);
      if (!gap) return stopRun('这节课转写完了' + (ui.auto.checked ? '，正在生成大纲…' : ''), true);
      tell({ type: 'lec-cut' });
      await main('seek', { ms: gap[0] * 1000 });
    }
  }
  function onJump(m) {
    if (!run) return;
    closeSeg(m.from / 1000);
    tell({ type: 'lec-cut' });
  }
  function b64(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // —— 画面 ——
  const sc = document.createElement('canvas'); sc.width = 32; sc.height = 18;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  const cv = document.createElement('canvas'), cctx = cv.getContext('2d');
  const screenEl = () => YT ? document.querySelector('#movie_player video') : document.querySelector('canvas.plv__screen--canvas') || [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  function sig(c) {
    sctx.drawImage(c, 0, 0, 32, 18);
    const d = sctx.getImageData(0, 0, 32, 18).data, g = new Uint8Array(576);
    for (let i = 0; i < 576; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  }
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const bright = g => g.reduce((n, x) => n + x, 0) / g.length;
  function shot(c, maxW, q) {
    const cw = c.videoWidth || c.width, ch = c.videoHeight || c.height;
    const w = Math.min(cw, maxW), h = Math.round(ch * w / cw);
    cv.width = w; cv.height = h;
    cctx.drawImage(c, 0, 0, w, h);
    return cv.toDataURL('image/jpeg', q);
  }
  function keyframe(vt) {
    if (!run || run.keys >= KEY_MAX || vt - run.lastKeyT < KEY_GAP) return;
    const c = screenEl();
    if (!c || !(c.videoWidth || c.width)) return;
    try {
      const g = sig(c);
      if (bright(g) < 8) return; // 黑场
      if (run.lastKeySig && diff(g, run.lastKeySig) < KEY_DIFF) return;
      run.lastKeySig = g; run.lastKeyT = vt; run.keys++;
      tell({ type: 'lec-frame', sid, t: vt, b64: shot(c, 960, 0.75).split(',')[1] });
    } catch (e) { run.keys = KEY_MAX; } // 画面取不到就不再试
  }

  // —— 软件来要截图（Alt+S 等） ——
  async function appCapture() {
    const s = await main('state');
    if (!s || !s.ready || !onVideo()) return { ok: false, reason: '播放器还没准备好' };
    const c = screenEl();
    if (!c) return { ok: false, reason: '没找到播放器画面' };
    let url;
    try { url = shot(c, 1920, 0.9); } catch (e) { return { ok: false, reason: '画面取不到：' + e.message }; }
    const t = s.vt / 1000;
    return { ok: true, session: meta(s), t, frames: [{ t, dataUrl: url, main: true }], chosen: 0 };
  }
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'app-capture') { appCapture().then(reply, e => reply({ ok: false, reason: String(e.message || e) })); return true; }
    if (msg.type === 'cmd') { flash((YT ? 'YouTube' : '保利威回放') + '页的截图要开着 FrameScribe 软件（插件单独用时只支持 B 站）', 5000); reply({ ok: true }); }
  });

  function onPush(m) {
    if (m.sid && m.sid !== sid) return;
    if (m.type === 'lec-seg' && data) {
      const b = data.body || (data.body = []);
      let i = b.length; while (i > 0 && b[i - 1].from > m.line.from) i--;
      b.splice(i, 0, m.line);
      renderCount();
    } else if (m.type === 'lec-ended') {
      if (run) { run = null; main('tap', { on: false }); main('bg', { on: false }); main('rate', { v: 1 }); }
      flash('转写停了：' + m.reason, 6000); refresh();
    } else if (m.type === 'lec-outline-done') {
      flash(m.ok ? '大纲生成好了' : '生成大纲失败：' + m.detail, m.ok ? 3000 : 8000);
      refresh();
    }
  }
  async function makeOutline() {
    const r = await ask({ type: 'lec-outline', sid });
    if (!r || !r.ok) return flash('生成不了：' + ((r && r.detail) || '没连上 FrameScribe 软件'), 6000);
    if (data && data.session) data.session.job = { state: 'running', step: '生成大纲…', startedAt: Date.now() };
    render();
  }

  // —— 界面（Shadow DOM，不受页面样式影响） ——
  const ui = {};
  let host, root, tab = 'outline', open = false, query = '', flashTimer = 0, scrollCur = false;
  function build() {
    host = document.createElement('div');
    host.id = 'bilinotes-polyv';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
      .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; background: #12151be6; color: #e8ecf2; border: 1px solid #2a303b;
        border-radius: 999px; padding: 7px 14px; font-size: 13px; cursor: pointer; user-select: none; box-shadow: 0 6px 18px #0006; }
      .fab b { color: #ff7a2f; }
      .fab:hover { border-color: #ff7a2f; }
      .panel { position: fixed; top: 64px; right: 16px; bottom: 64px; width: 380px; max-width: calc(100vw - 32px); z-index: 2147483647; display: none; flex-direction: column;
        background: #12151bf5; color: #e8ecf2; border: 1px solid #2a303b; border-left: 3px solid #ff7a2f; border-radius: 10px; box-shadow: 0 12px 36px #000a; font-size: 13px; }
      .panel.on { display: flex; }
      .hd { padding: 10px 12px 8px; border-bottom: 1px solid #222833; }
      .row { display: flex; align-items: center; gap: 8px; }
      .tag { font: 700 11px/1 Consolas, monospace; color: #ff7a2f; letter-spacing: .08em; }
      .ttl { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .x { background: none; border: 0; color: #8a93a3; font-size: 18px; cursor: pointer; padding: 0 2px; }
      .sub { color: #8a93a3; font-size: 12px; margin-top: 4px; }
      .bar { position: relative; height: 8px; background: #1d222b; border-radius: 4px; margin: 8px 0 6px; overflow: hidden; cursor: pointer; }
      .bar i { position: absolute; top: 0; bottom: 0; background: #3cc8d8; }
      .bar u { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #ff7a2f; }
      button.b { background: #1d222b; color: #e8ecf2; border: 1px solid #333b48; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
      button.b:hover { border-color: #ff7a2f; }
      button.b.pri { background: #ff7a2f; border-color: #ff7a2f; color: #111; font-weight: 600; }
      button.b:disabled { opacity: .45; cursor: default; }
      select, input[type=text] { background: #0b0d11; color: #e8ecf2; border: 1px solid #333b48; border-radius: 6px; padding: 4px 6px; font-size: 12px; }
      label { color: #8a93a3; font-size: 12px; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
      .opts { flex-wrap: wrap; margin-top: 6px; }
      .tabs { display: flex; gap: 0; padding: 0 12px; border-bottom: 1px solid #222833; }
      .tabs span { padding: 7px 10px; cursor: pointer; color: #8a93a3; border-bottom: 2px solid transparent; }
      .tabs span.on { color: #fff; border-color: #ff7a2f; }
      .body { flex: 1; overflow-y: auto; padding: 8px 6px 12px 12px; }
      .sum { color: #b8c0cc; font-size: 12px; line-height: 1.6; margin: 2px 0 10px; padding-left: 8px; border-left: 2px solid #333b48; }
      .ch { margin-bottom: 8px; }
      .ch > .h { display: flex; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-weight: 600; }
      .ch.cur > .h { background: #ff7a2f22; }
      .h:hover, .pt:hover, .hit:hover { background: #ffffff10; }
      .t { font: 12px Consolas, monospace; color: #3cc8d8; flex: 0 0 auto; padding-top: 1px; }
      .pt { display: flex; gap: 8px; padding: 3px 6px 3px 16px; border-radius: 6px; cursor: pointer; color: #c9d0da; line-height: 1.5; }
      .hit { display: flex; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; line-height: 1.5; color: #c9d0da; }
      mark { background: #ff7a2f55; color: #fff; border-radius: 2px; }
      .empty { color: #8a93a3; padding: 12px 6px; line-height: 1.7; }
      .search { padding: 8px 12px 0; }
      .search input { width: 100%; padding: 6px 8px; font-size: 13px; }
      .job { color: #ffb37a; font-size: 12px; margin-top: 6px; }
      .toast { position: fixed; top: 76px; right: 412px; max-width: 360px; z-index: 2147483647; background: #12151bf2; color: #e8ecf2; border: 1px solid #2a303b;
        border-left: 3px solid #ff7a2f; border-radius: 10px; padding: 10px 12px; font-size: 13px; box-shadow: 0 10px 30px #0008; transition: opacity .2s; }
      .toast.hide { opacity: 0; pointer-events: none; }
      .panel:not(.on) ~ .toast { right: 16px; }
      .panel.pl .vid-only { display: none !important; }
      .panel:not(.pl) .pl-only { display: none !important; }
      .brow { margin-top: 6px; padding: 6px 8px; border-radius: 6px; background: #3cc8d81a; color: #9fe6ee; font-size: 12px; gap: 8px; }
      .brow .bnote { flex: 1; min-width: 0; }
    </style>
    <div class="fab">📒 <b>大纲</b></div>
    <div class="panel">
      <div class="hd">
        <div class="row"><span class="tag">${YT ? 'VIDEO' : 'COURSE'}</span><span class="ttl"></span><button class="x" title="收起">×</button></div>
        <div class="sub st"></div>
        <div class="bar vid-only" title="青色 = 已经转写的部分，橙线 = 现在播放的位置；点一下跳过去"></div>
        <div class="row pl-only" style="margin-top:8px">
          <button class="b pri bgo">开始批量</button>
          <button class="b bstop">停止批量</button>
        </div>
        <div class="row vid-only">
          <button class="b pri go">开始转写</button>
          <button class="b mk">生成大纲</button>
          <span style="flex:1"></span>
          <button class="b blist" style="display:none" title="打开这个播放列表的批量页：整个列表一个个取字幕、出大纲和总目录">批量这个列表</button>
          <button class="b nb" title="在桌面软件里打开这节课的记录">笔记本</button>
        </div>
        <div class="row opts">
          <label>倍速 <select class="rate"><option value="1">1</option><option value="1.25">1.25</option><option value="1.5" selected>1.5</option><option value="2">2</option></select></label>
          <label title="转写时不出声，你可以去看别的"><input type="checkbox" class="mute" checked>不出声</label>
          <label class="vid-only" title="整节转完自动交给 AI 生成大纲"><input type="checkbox" class="auto" checked>转完自动生成大纲</label>
          <label title="YouTube 取字幕时按间隔跳着截图（每个视频多约 1 分钟），大纲每章配一张"><input type="checkbox" class="shots" checked>配截图</label>
        </div>
        <div class="job vid-only"></div>
        <div class="row brow" style="display:none"><span class="bnote"></span><button class="b bstop2">停止批量</button></div>
      </div>
      <div class="tabs vid-only"><span data-t="outline" class="on">大纲</span><span data-t="search">搜索文字</span></div>
      <div class="search" style="display:none"><input type="text" placeholder="${YT ? '搜字幕 / 转写的文字，比如：Niagara、material' : '搜转写的文字，比如：材质、HDA、粗糙度'}"></div>
      <div class="body"></div>
    </div>
    <div class="toast hide"></div>`;
    const q = s => root.querySelector(s);
    Object.assign(ui, { fab: q('.fab'), panel: q('.panel'), ttl: q('.ttl'), st: q('.st'), bar: q('.bar'), go: q('.go'), mk: q('.mk'), nb: q('.nb'),
      rate: q('.rate'), mute: q('.mute'), auto: q('.auto'), shots: q('.shots'), job: q('.job'), body: q('.body'), search: q('.search'), input: q('.search input'), toast: q('.toast'),
      bgo: q('.bgo'), bstop: q('.bstop'), brow: q('.brow'), bnote: q('.bnote') });
    ui.bgo.onclick = startBatch;
    ui.bstop.onclick = () => stopBatch();
    q('.bstop2').onclick = () => stopBatch();
    try { const o = JSON.parse(localStorage.getItem('bn-polyv-opts') || '{}'); if (o.rate) ui.rate.value = o.rate; if (o.mute != null) ui.mute.checked = o.mute; if (o.auto != null) ui.auto.checked = o.auto; if (o.shots != null) ui.shots.checked = o.shots; } catch (e) {}
    const saveOpts = () => { try { localStorage.setItem('bn-polyv-opts', JSON.stringify({ rate: ui.rate.value, mute: ui.mute.checked, auto: ui.auto.checked, shots: ui.shots.checked })); } catch (e) {} };
    ui.rate.onchange = () => { saveOpts(); if (run) { run.rate = +ui.rate.value; main('rate', { v: run.rate }); } };
    ui.mute.onchange = saveOpts; ui.auto.onchange = saveOpts; ui.shots.onchange = saveOpts;
    ui.fab.onclick = () => toggle(true);
    q('.x').onclick = () => toggle(false);
    ui.go.onclick = () => run ? stopRun('已停止转写，下次从没转的地方接着转') : startRun();
    ui.mk.onclick = makeOutline;
    ui.nb.onclick = () => ask({ type: 'lec-open', sid });
    ui.blist = q('.blist');
    ui.blist.onclick = () => { const L = new URL(location.href).searchParams.get('list'); if (L) location.href = '/playlist?list=' + encodeURIComponent(L) + '#bn-batch'; };
    ui.bar.onclick = e => { if (!st || !st.dur || run) return; const r = ui.bar.getBoundingClientRect(); seek((e.clientX - r.left) / r.width * st.dur); };
    root.querySelectorAll('.tabs span').forEach(s => s.onclick = () => { tab = s.dataset.t; root.querySelectorAll('.tabs span').forEach(x => x.classList.toggle('on', x === s)); ui.search.style.display = tab === 'search' ? '' : 'none'; renderBody(); if (tab === 'search') ui.input.focus(); });
    ui.input.oninput = () => { query = ui.input.value.trim(); renderBody(); };
    // 输入框里打字时，别让播放器收到按键
    for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, e => { if (root.activeElement === ui.input) e.stopImmediatePropagation(); }, true);
    ui.body.addEventListener('click', e => { const el = e.target.closest('[data-t]'); if (el) seek(+el.dataset.t); });
    const mount = () => (document.fullscreenElement || document.body || document.documentElement).appendChild(host);
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
    document.addEventListener('fullscreenchange', mount);
    if (onPlaylist() && location.hash === '#bn-batch') setTimeout(() => toggle(true), 1500); // 从视频页点「批量这个列表」过来：直接打开批量面板
  }
  async function seek(t) {
    if (run) return flash('转写中不能跳：先点「停止转写」');
    await main('seek', { ms: Math.max(0, t) * 1000 });
    const s = await main('state'); if (s && s.paused) main('play');
    setTimeout(tick, 400);
  }
  function toggle(on) {
    open = on;
    ui.panel.classList.toggle('on', on);
    ui.fab.style.display = on ? 'none' : '';
    if (on) { scrollCur = true; if (onPlaylist()) loadPlaylistView(); else refresh(); }
  }
  function flash(text, ms = 3000) {
    if (!root) build();
    ui.toast.textContent = text;
    ui.toast.classList.remove('hide');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ui.toast.classList.add('hide'), ms);
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render() {
    if (!root) return;
    ui.panel.classList.toggle('pl', onPlaylist());
    ui.fab.innerHTML = onPlaylist() ? '📒 <b>批量大纲</b>' : '📒 <b>大纲</b>';
    renderBatchNote();
    if (onPlaylist()) { ui.search.style.display = 'none'; return renderPlaylist(); }
    if (tab === 'search') ui.search.style.display = '';
    const m = meta(st), s = data && data.session;
    ui.ttl.textContent = (s && s.title) || m.title;
    ui.ttl.title = ui.ttl.textContent + (m.part ? ' · ' + m.part : '');
    const n0 = data && data.body ? data.body.length : 0;
    ui.go.textContent = run ? '停止转写' : hasCaps() && !n0 ? '取字幕' : '开始转写';
    ui.go.title = run ? '' : hasCaps() && !n0 ? '这个视频有字幕：直接取字幕全文（几秒），不用把视频放一遍' : '从头按倍速把视频放一遍，在本机把声音转成文字';
    ui.go.classList.toggle('pri', !run);
    // 在播放列表里看视频（watch?v=…&list=…）时，给个入口去批量整个列表（批量面板在播放列表页上）
    const inList = YT && !!new URL(location.href).searchParams.get('list') && !/^(RD|LL|WL)/.test(new URL(location.href).searchParams.get('list'));
    ui.blist.style.display = inList && !(batch && batch.running) ? '' : 'none';
    const n = data && data.body ? data.body.length : 0, job = s && s.job;
    const jobRunning = job && job.state === 'running';
    ui.mk.disabled = !appOk || n < 5 || jobRunning;
    ui.mk.textContent = data && data.outline ? '重新生成大纲' : '生成大纲';
    ui.go.disabled = !appOk && !run;
    if (!run && n0 && s && s.subs && s.subs.lan && s.subs.lan !== 'asr') { ui.go.textContent = '已取字幕'; ui.go.disabled = true; ui.go.title = '全文来自视频字幕，不用再转写'; }
    ui.job.textContent = jobRunning ? `⏳ ${job.engine || 'AI'}：${job.step || '处理中…'}` : job && job.state === 'error' ? `✗ 上次处理失败：${job.detail || ''}` : '';
    renderProgress();
    renderBody();
  }
  function renderCount() { renderProgress(); if (tab === 'search' && query) renderBody(); }
  function renderProgress() {
    if (!root || onPlaylist()) return;
    const dur = (st && st.dur) || 0, cov = covered(), done = coveredSec(), n = data && data.body ? data.body.length : 0;
    if (!appOk) ui.st.textContent = '没连上 FrameScribe 软件：先打开软件（桌面快捷方式，或安装目录里的 FrameScribe.cmd），再点右上角 × 重新打开面板';
    else if (st && st.ad) ui.st.textContent = '正在放广告，等正片开始';
    else if (!dur) ui.st.textContent = '播放器还没准备好：先点一下播放';
    else if (!run && data && data.session && data.session.subs && data.session.subs.lan !== 'asr' && n) ui.st.textContent = `已取字幕：${data.session.subs.lanDoc || data.session.subs.lan} · ${n} 句`;
    else ui.st.textContent = `${run ? `● 转写中 ${run.rate} 倍速 · ` : ''}已转写 ${Math.min(100, Math.round(done / dur * 100))}%（${fmt(done)} / ${fmt(dur)}）· ${n} 句`;
    ui.bar.innerHTML = dur ? cov.map(r => `<i style="left:${r[0] / dur * 100}%;width:${(r[1] - r[0]) / dur * 100}%"></i>`).join('') + (st ? `<u style="left:${Math.min(100, st.vt / 10 / dur)}%"></u>` : '') : '';
  }
  function renderBody() {
    if (!root || !open || onPlaylist()) return;
    const b = ui.body;
    if (tab === 'outline') {
      const o = data && data.outline;
      if (!o) {
        const n = data && data.body ? data.body.length : 0;
        b.innerHTML = !n && hasCaps() ? '<div class="empty">这个视频有字幕。<br>点「取字幕」：几秒就拿到全文，不用把视频放一遍；取完自动生成大纲，之后点大纲里的任何一条就能跳过去。</div>' : `<div class="empty">${n ? `已经有 ${n} 句文字。点「生成大纲」让 AI 按这些文字出一份带时间的目录（转了一部分也能先生成）。` : '还没有转写。<br>点「开始转写」：插件会从头按倍速把这节课放一遍、在本机转成文字（默认不出声，可以切到别的标签页干别的）。<br>转完自动生成大纲，之后点大纲里的任何一条就能跳过去。'}</div>`;
        return;
      }
      const vt = st ? st.vt / 1000 : 0;
      let cur = -1; o.chapters.forEach((c, i) => { if (c.t <= vt) cur = i; });
      b.innerHTML = (o.summary ? `<div class="sum">${esc(o.summary)}</div>` : '') + o.chapters.map((c, i) => `<div class="ch${i === cur ? ' cur' : ''}">
        <div class="h" data-t="${c.t}"><span class="t">${fmt(c.t)}</span><span>${esc(c.title)}</span></div>
        ${c.points.map(p => `<div class="pt" data-t="${p.t}"><span class="t">${fmt(p.t)}</span><span>${esc(p.text)}</span></div>`).join('')}</div>`).join('')
        + (o.until && st && st.dur && o.until < st.dur - 60 ? `<div class="empty">这份大纲只覆盖到 ${fmt(o.until)}（生成时只转写到那里）。转写完后点「重新生成大纲」。</div>` : '');
      const c = scrollCur && b.querySelector('.ch.cur');
      if (c) { scrollCur = false; c.scrollIntoView({ block: 'start' }); } // 打开面板时滚到正在播的那一章
      return;
    }
    const body = (data && data.body) || [];
    if (!query) { b.innerHTML = `<div class="empty">${body.length ? `在 ${body.length} 句转写和大纲里搜。转写有同音错字，搜不到时换个说法试试（比如只搜两个字）。` : '还没有转写的文字。'}</div>`; return; }
    const ql = query.toLowerCase(), re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hl = s => esc(s).replace(re, x => `<mark>${x}</mark>`);
    const o = data && data.outline;
    const pts = o ? o.chapters.flatMap(c => [{ t: c.t, text: c.title }, ...c.points]).filter(p => p.text.toLowerCase().includes(ql)) : [];
    const lines = body.filter(x => x.text.toLowerCase().includes(ql));
    b.innerHTML = (pts.length ? `<div class="sub" style="margin:0 6px 4px">大纲里 ${pts.length} 条</div>` + pts.slice(0, 50).map(p => `<div class="hit" data-t="${p.t}"><span class="t">${fmt(p.t)}</span><span>${hl(p.text)}</span></div>`).join('') : '')
      + `<div class="sub" style="margin:8px 6px 4px">转写里 ${lines.length} 句${lines.length > 300 ? '（只显示前 300 句）' : ''}</div>`
      + lines.slice(0, 300).map(x => `<div class="hit" data-t="${Math.max(0, x.from - 2)}"><span class="t">${fmt(x.from)}</span><span>${hl(x.text)}</span></div>`).join('');
  }

  // —— YouTube 批量：把播放列表里的视频一个个打开、取字幕、交给软件排队生成大纲，最后出一份总目录 ——
  // 进度存在插件的 storage 里（换视频、刷新页面都不丢）；只由点「开始批量」的那个标签页来推进（sessionStorage 里的标记）
  // bn-batch: { running, owner, cur, wasMuted, lists: [{ id, title, channel, items: [{ v, title, idx, st, detail }] }] }
  //   st：'' 待处理 / 'ok' 取到了 / 'had' 以前就有 / 'nocaps' 没字幕 / 'fail' 失败
  const onPlaylist = () => YT && location.pathname === '/playlist' && !!new URL(location.href).searchParams.get('list');
  const BKEY = 'bn-batch';
  const bget = async () => { try { return (await chrome.storage.local.get(BKEY))[BKEY] || null; } catch (e) { return null; } };
  const bset = async b => { try { await chrome.storage.local.set({ [BKEY]: b }); } catch (e) {} batch = b; };
  const bupdate = async fn => { const b = (await bget()) || { running: false, lists: [], cur: 0 }; fn(b); await bset(b); return b; };
  const myToken = () => { try { let t = sessionStorage.getItem('bn-batch-owner'); if (!t) { t = Math.random().toString(36).slice(2); sessionStorage.setItem('bn-batch-owner', t); } return t; } catch (e) { return 'x'; } };
  const groupName = L => (L.channel ? L.channel + ' - ' : '') + L.title;
  const sleep = ms => YT ? main('sleep', { ms }, ms + 60000).then(r => r || new Promise(res => setTimeout(res, 50))) : new Promise(r => setTimeout(r, ms));
  const shotsOn = () => !ui.shots || ui.shots.checked;

  // YouTube 配截图：取字幕不用放视频，所以按间隔跳着截（最多约 30 张，画面没变的不要），大纲每章配一张
  // 在后台标签页里也能截（实测 1080p、每跳一次 2–4 秒）；note(进度文字)，stop() 返回 true 就停
  async function grabFrames(id, dur, note, stop) {
    const V = () => document.querySelector('#movie_player video');
    if (!V() || !dur) return 0;
    await main('quality');
    await main('pause');
    const step = Math.max(30, Math.ceil(dur / 30)), total = Math.max(1, Math.ceil((dur - 11) / step));
    let last = null, n = 0, k = 0;
    for (let t = 8; t < dur - 3; t += step) {
      k++;
      if (note) note(`截图 ${k}/${total}…`);
      if (stop && await stop()) break;
      await main('seek', { ms: t * 1000 });
      // 跳到中插广告的位置会触发广告：等广告放完（能跳就跳，最多 90 秒），再跳回这个位置
      let ok = false, adT = 0;
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        const st1 = await main('state', {}, 1500);
        if (st1 && st1.ad) {
          if (!adT) adT = Date.now();
          await main('adskip');
          if (note) note(`截图 ${k}/${total} · 碰到广告，等它放完…`);
          if (Date.now() - adT < 90000) { i = 0; continue; }
          break;
        }
        if (adT) { adT = 0; await main('seek', { ms: t * 1000 }); await main('pause'); continue; }
        const e = V();
        if (e && !e.seeking && e.readyState >= 2 && Math.abs(e.currentTime - t) < 2) { ok = true; break; }
      }
      if (!ok) continue;
      await sleep(250);
      const e = V();
      try {
        const g = sig(e);
        if (bright(g) < 8 || (last && diff(g, last) < KEY_DIFF)) continue; // 黑场、和上一张差不多
        last = g; n++;
        tell({ type: 'lec-frame', sid: id, t: +e.currentTime.toFixed(2), b64: shot(e, 1280, 0.82).split(',')[1] });
      } catch (err) { break; }
    }
    await ask({ type: 'lec-keys-done', sid: id }, 20000); // 大纲已经生成了的话，软件重写大纲.md 把图配上
    return n;
  }
  let batch = null, bBusy = false, bAgain = false, bNote = '', plItems = null, plHave = {};

  // 播放列表页：读出列表里的视频（顺序、标题）。正好 100 的倍数时往下滚，让页面把后面的也加载出来
  async function collectPlaylist() {
    const L = new URL(location.href).searchParams.get('list');
    const read = () => {
      const m = new Map();
      for (const a of document.querySelectorAll('a[href*="/watch?v="]')) {
        let u; try { u = new URL(a.href); } catch (e) { continue; }
        if (u.searchParams.get('list') !== L || !u.searchParams.get('index')) continue;
        const v = u.searchParams.get('v'), t = (a.getAttribute('title') || a.textContent || '').trim().replace(/\s+/g, ' ');
        const it = m.get(v) || { v, idx: +u.searchParams.get('index'), title: '' };
        if (t && !/^\d{1,2}(:\d\d){1,2}$/.test(t) && t.length > it.title.length) it.title = t;
        m.set(v, it);
      }
      return [...m.values()].sort((a, b) => a.idx - b.idx);
    };
    let items = read();
    for (let i = 0; i < 20 && items.length && items.length % 100 === 0; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight); await sleep(1500);
      const more = read(); if (more.length === items.length) break; items = more;
    }
    const chEl = [...document.querySelectorAll('a[href^="/@"]')].find(a => a.textContent.trim() && !a.closest('#masthead, ytd-masthead, #guide'));
    return { id: L, title: document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim(), channel: chEl ? chEl.textContent.trim() : '', items: items.map(x => ({ ...x, st: '', detail: '' })) };
  }
  async function loadPlaylistView() {
    plItems = await collectPlaylist();
    const r = await ask({ type: 'lec-have', ids: plItems.items.map(x => 'yt_' + x.v) }, 8000);
    appOk = !!(r && r.ok);
    plHave = (r && r.have) || {};
    batch = await bget();
    render();
  }
  async function startBatch() {
    if (!plItems || !plItems.items.length) await loadPlaylistView();
    if (!plItems.items.length) return flash('没读到列表里的视频：往下滚一下页面再试');
    const L = plItems;
    // 已经有大纲的直接算做完；有文字没大纲的照样过一遍（会补上大纲）
    for (const it of L.items) { const h = plHave['yt_' + it.v]; if (h && h.outline && (h.keys > 0 || !shotsOn())) it.st = 'had'; }
    const b = await bupdate(x => {
      const old = x.lists.findIndex(l => l.id === L.id);
      if (old >= 0) x.lists[old] = L; else x.lists.push(L);
      if (!x.running) { x.running = true; x.owner = myToken(); x.cur = x.lists.findIndex(l => l.id === L.id); x.wasMuted = null; }
    });
    if (b.owner !== myToken()) { flash('已加入批量队列（另一个标签页正在跑批量，做完前面的列表会接着做这个）', 6000); render(); return; }
    // 这个列表里已经有大纲的视频也要记进这个列表（总目录要列它们）
    for (const it of L.items) if (it.st === 'had') await ask({ type: 'lec-join', sid: 'yt_' + it.v, group: groupName(L), idx: it.idx });
    const first = L.items.find(x => !x.st);
    if (!first) { await ask({ type: 'lec-index', group: groupName(L) }); await bupdate(x => { x.running = false; }); return flash('这个列表的视频都有大纲了，总目录已更新', 6000); }
    flash('开始批量：这个标签页会一个个打开视频取字幕。可以切到别的标签页，别关这个', 6000);
    location.href = `/watch?v=${encodeURIComponent(first.v)}&list=${encodeURIComponent(L.id)}`;
  }
  async function stopBatch(msg) {
    const b = await bget();
    await bupdate(x => { x.running = false; });
    if (b && b.owner === myToken()) { if (b.wasMuted === false) await main('ytmute', { on: false }); await main('bg', { on: false }); }
    bNote = '';
    flash(msg || '批量已停止。回到播放列表页点「继续批量」可以接着做', 8000);
    render();
  }
  const setItem = (L, v, st, detail = '') => bupdate(x => { const l = x.lists.find(y => y.id === L.id); const it = l && l.items.find(y => y.v === v); if (it) { it.st = st; it.detail = detail; } });
  const stillMine = async () => { const b = await bget(); return !!(b && b.running && b.owner === myToken()); };
  async function batchTick() {
    if (!YT || bBusy || !ytId()) return;
    const b = await bget(); batch = b;
    if (!b || !b.running || b.owner !== myToken()) { if (bNote) { bNote = ''; renderBatchNote(); } return; }
    const L = b.lists[b.cur];
    if (!L) return finishBatch();
    const it = L.items.find(x => x.v === ytId());
    if (!it) { bNote = '批量暂停：现在这个视频不在列表里（回到列表里的视频会自动接着做）'; renderBatchNote(); return; }
    bBusy = true;
    bAgain = false;
    try { await batchOne(b, L, it); } catch (e) { await setItem(L, it.v, 'fail', String(e.message || e)); await batchNext(L); }
    finally { bBusy = false; }
    if (bAgain) { bAgain = false; return batchTick(); }
  }
  async function batchOne(b, L, it) {
    const pos = L.items.indexOf(it) + 1, head = `批量 · ${L.title} · ${pos}/${L.items.length}`;
    const note = s => { bNote = `${head} · ${s}`; renderBatchNote(); };
    if (it.st) return batchNext(L);
    if (b.wasMuted == null) { const r = await main('ytmute', { on: true }); await bupdate(x => { x.wasMuted = r ? !!r.was : false; }); }
    else await main('ytmute', { on: true });
    await main('bg', { on: true });
    const sid0 = 'yt_' + it.v;
    const have = await ask({ type: 'lec-get', sid: sid0 }, 8000);
    if (!have || !have.ok) { note('没连上 FrameScribe 软件，等它连上…'); await sleep(5000); return; }
    const needSubs = !(have.exists && have.body && have.body.length), needKeys = shotsOn() && !(have.keys > 0);
    if (!needSubs) { // 以前取过：记进这个列表，缺大纲就补；不缺截图就不用等视频了
      await ask({ type: 'lec-join', sid: sid0, group: groupName(L), idx: it.idx });
      if (!have.outline) await ask({ type: 'lec-outline', sid: sid0 });
      if (!needKeys) { await setItem(L, it.v, 'had'); return batchNext(L); }
    }
    let t0 = Date.now(), adSince = 0, s = null, lastPlay = 0, reloaded = false;
    for (;;) {
      if (!(await stillMine()) || ytId() !== it.v) return;
      s = await main('state', {}, 1500);
      if (s && s.ready && !s.ad && s.info && s.info.id === it.v) break;
      if (s && s.ad) {
        // 广告：能跳就跳；在后台停住太久就提醒切回来；一直卡着（4 分钟）就重新打开这个视频一次
        if (!adSince) adSince = Date.now();
        await main('adskip');
        const long = Date.now() - adSince > 90000;
        note(long && document.hidden ? '广告在后台停住了：切回这个标签页一下，广告放完会自动接着做' : '等广告放完…');
        if (Date.now() - adSince > 240000 && !reloaded) { reloaded = true; adSince = 0; location.reload(); return; }
        t0 = Date.now(); // 放广告不算“加载超时”
      } else {
        adSince = 0;
        note('等视频加载…');
        if (s && s.paused && Date.now() - lastPlay > 5000) { lastPlay = Date.now(); main('play'); }
        if (Date.now() - t0 > 180000) { await setItem(L, it.v, 'fail', '3 分钟还没开始播放'); return batchNext(L); }
      }
      await sleep(1000);
    }
    st = s;
    if (needSubs) {
    if (!s.info.caps) { await setItem(L, it.v, 'nocaps', '没有字幕'); return batchNext(L); }
    note('取字幕…');
    const r = await main('subs', {}, 25000);
    if (!r || !r.ok || r.vid !== it.v) { await setItem(L, it.v, 'fail', (r && r.detail) || '取字幕没回应'); return batchNext(L); }
    const L1 = L.channel ? L : { ...L, channel: s.info.author || '' };
    if (!L.channel && s.info.author) await bupdate(x => { const l = x.lists.find(y => y.id === L.id); if (l && !l.channel) l.channel = s.info.author; });
    const m = { ...meta(s), group: groupName(L1), groupIdx: it.idx };
    const a = await ask({ type: 'lec-subs', session: m, body: r.lines, lan: r.lang, lanDoc: `YouTube ${r.asr ? '自动字幕' : '字幕'} · ${r.name}` }, 20000);
    if (!a || !a.ok) { await setItem(L, it.v, 'fail', (a && a.detail) || '交给软件失败'); return batchNext(L); }
    await ask({ type: 'lec-outline', sid: m.id });
    }
    if (needKeys) {
      const n = await grabFrames(sid0, s.dur, note, async () => !(await stillMine()) || ytId() !== it.v);
      if (!(await stillMine()) || ytId() !== it.v) return;
      if (!n) note('这个视频没截到图');
    }
    await setItem(L, it.v, needSubs ? 'ok' : 'had');
    return batchNext(L);
  }
  async function batchNext(L0) {
    if (!(await stillMine())) return;
    const b = await bget(), L = b.lists.find(y => y.id === L0.id) || L0;
    const nxt = L.items.find(x => !x.st);
    if (nxt) {
      bNote = `批量 · ${L.title} · 下一个：${nxt.title || nxt.v}`; renderBatchNote();
      await main('goto', { v: nxt.v, list: L.id });
      for (let i = 0; i < 30 && ytId() !== nxt.v; i++) await sleep(500);
      await sleep(1500);
      bAgain = true;
      return;
    }
    // 这个列表做完：写总目录（大纲还在排队的，生成完会自动补进总目录），换下一个列表
    await ask({ type: 'lec-index', group: groupName(L) });
    const b2 = await bupdate(x => { x.cur = x.lists.findIndex(y => y.id === L.id) + 1; });
    const L2 = b2.lists[b2.cur];
    if (!L2) return finishBatch();
    const n2 = L2.items.find(x => !x.st);
    if (!n2) return batchNext(L2);
    if (document.hidden) flash('下一个播放列表要重新打开页面：如果停住了，切回这个标签页一下', 8000);
    location.href = `/watch?v=${encodeURIComponent(n2.v)}&list=${encodeURIComponent(L2.id)}`;
  }
  async function finishBatch() {
    const b = await bget();
    const all = (b ? b.lists : []).flatMap(l => l.items), n = s => all.filter(x => x.st === s).length;
    await stopBatch(`批量做完了：取到 ${n('ok')} 个，以前就有 ${n('had')} 个，没字幕 ${n('nocaps')} 个，失败 ${n('fail')} 个。大纲在软件里排队生成，生成完自动更新总目录`);
  }
  // 播放列表页的面板内容
  function renderPlaylist() {
    const L = plItems, b = batch;
    ui.ttl.textContent = L ? L.title : document.title;
    const inQ = b && L && b.lists.find(l => l.id === L.id);
    const items = (inQ || L || { items: [] }).items;
    const h = id => plHave['yt_' + id] || {};
    const has = items.filter(x => h(x.v).outline || x.st === 'had').length;
    ui.st.textContent = !appOk ? '没连上 FrameScribe 软件：先打开软件，再点右上角 × 重新打开面板' : `${items.length} 个视频 · 已有大纲 ${has} 个${b && b.running ? ` · 批量进行中（队列里 ${b.lists.length} 个列表）` : ''}`;
    ui.bgo.textContent = b && b.running ? (inQ ? '已在批量队列里' : '加入批量队列') : inQ && inQ.items.some(x => !x.st) ? '继续批量' : '开始批量';
    ui.bgo.disabled = !appOk || !L || !!(b && b.running && inQ);
    ui.bstop.style.display = b && b.running ? '' : 'none';
    const icon = x => x.st === 'ok' || x.st === 'had' || h(x.v).outline ? '✓' : x.st === 'nocaps' ? '—' : x.st === 'fail' ? '✗' : h(x.v).subs ? '…' : '○';
    ui.body.innerHTML = `<div class="empty">点「开始批量」：这个标签页会按顺序打开列表里的每个视频，等片头广告放完就取字幕，交给软件排队生成大纲（同时最多 2 个）。每个视频大约 0.5–1 分钟，可以切到别的标签页；做完写一份「总目录」到导出文件夹。<br>✓ 有大纲　… 有文字没大纲　○ 待处理　— 没字幕　✗ 失败</div>`
      + items.map(x => `<div class="hit" title="${esc(x.detail || '')}"><span class="t">${icon(x)} ${String(x.idx).padStart(2, '0')}</span><span>${esc(x.title || x.v)}</span></div>`).join('');
  }
  function renderBatchNote() { if (ui.bnote) { ui.bnote.textContent = bNote; ui.brow.style.display = bNote && !onPlaylist() ? '' : 'none'; } }

  // 面板开着时每秒更新播放位置；转写中每 5 秒更新进度
  let navBusy = false, infoKey = '', lastMode = '';
  async function tick() {
    if (YT) {
      if (host) host.style.display = onVideo() || onPlaylist() ? '' : 'none';
      // 在视频页和播放列表页之间换了（单页应用）：面板换内容
      const mode = onPlaylist() ? 'pl:' + new URL(location.href).searchParams.get('list') : 'v';
      if (mode !== lastMode) { lastMode = mode; if (root) { if (open && onPlaylist()) loadPlaylistView(); else render(); } }
      batchTick();
      // 单页应用里换了视频（或离开视频页）：停掉旧视频的转写，面板换成新视频的
      const want = ytId() ? 'yt_' + ytId() : '';
      if (sid && want !== sid && !navBusy) {
        navBusy = true;
        try { if (run) await stopRun('换了视频，上一个视频的转写停了（转好的部分已保存）'); else if (open && want) await refresh(); else { sid = ''; data = null; } }
        finally { navBusy = false; }
      }
    }
    if (!open && !run) return;
    const s = await main('state', {}, 1500);
    if (s) st = s;
    // YouTube 换视频后播放器信息晚一两秒才更新：更新了就重画标题和按钮（「取字幕」还是「开始转写」）
    if (YT && open) { const k = s && s.info ? s.info.id + ':' + s.info.caps : ''; if (k !== infoKey) { infoKey = k; render(); } }
    // YouTube 放久了会弹“视频已暂停，要继续观看吗？”：转写中停住了就点继续
    if (YT && run && s && s.ready && s.paused && Date.now() - run.lastAudio > 6000 && Date.now() - run.nudged > 8000) { run.nudged = Date.now(); main('play'); }
    // 看门狗：转写中 6 秒进度没动、播放器又不是暂停的，多半是卡住了（实测停在 0 秒时再跳到 0 秒不会开始加载）：往后推半秒
    if (run && s && s.ready && !s.paused && Date.now() - run.lastAudio > 6000 && Date.now() - run.nudged > 8000) {
      run.nudged = Date.now();
      main('seek', { ms: s.vt + 500 });
    }
    renderProgress();
    if (open && tab === 'outline' && data && data.outline) {
      const vt = st ? st.vt / 1000 : 0, chs = ui.body.querySelectorAll('.ch');
      let cur = -1; data.outline.chapters.forEach((c, i) => { if (c.t <= vt) cur = i; });
      chs.forEach((el, i) => el.classList.toggle('cur', i === cur));
    }
  }
  setInterval(tick, 1000);
  setInterval(() => { const j = data && data.session && data.session.job; if (open && j && j.state === 'running') refresh(); }, 4000);
  // 插件后台靠这个保持和软件的连接
  const beat = () => send({ type: 'hb' });
  setInterval(beat, 15000);
  beat();

  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build, { once: true });
})();
