// 网页播放器那一半：在“页面自己的环境”里跑（manifest 里 world: MAIN，document_start）。现在支持三种页面：
//   - 保利威直播回放（*.polyv.cn）：自家 WASM 播放器，画面画在 canvas 上、声音走 WebAudio，没有普通的 <video>
//   - YouTube（www.youtube.com/watch）：普通 <video> + 页面里的 movie_player 接口；另外能取 YouTube 自己的字幕
//   - Vimeo（vimeo.com/<id>、player.vimeo.com/video/<id>）：普通 <video>（MSE）；字幕是页面上 <track> 指向的 VTT
//   - B 站视频页：普通 <video>；字幕由插件那一半用 B 站接口取（content.js / lib/bili.js，带登录状态），这里只管播放器和声音
// 做的事：
//   1. 找到播放器（读进度、跳转、倍速、播放 / 暂停）
//   2. 把它的声音接一路出来，降到 16 kHz 单声道交给插件（转写时可以不出声）
//   3. 转写期间标签页切到后台也不降速（浏览器会把后台网页的定时器限到每秒一次，播放器就卡住了）
//   4. YouTube / Vimeo：取字幕全文
// 和插件那一半（panel.js）用 window.postMessage 说话，消息都带 tag: 'bn-polyv'
(() => {
  if (window.__bnPage) return;
  window.__bnPage = 1;
  const TAG = 'bn-polyv';
  const YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const VM = /(^|\.)vimeo\.com$/.test(location.hostname);
  const BL = /(^|\.)bilibili\.com$/.test(location.hostname);
  const GEN = VM || BL; // 普通 <video>，没有站点自己的播放器接口
  const VID = YT || GEN; // 普通 <video> 播放器
  const out = (m, transfer) => window.postMessage({ tag: TAG, dir: 'out', ...m }, '*', transfer || []);
  const sleep = ms => new Promise(r => window.setTimeout(r, ms));

  // —— 1. 播放器 ——
  // 保利威：currentTime 等是原型上的取值器，播放器每帧都会读，借这个机会记下 this
  let player = null;
  const pvAlive = p => p && !p.destroyed && (!p.$canvas || document.contains(p.$canvas));
  function hookPlayer() {
    const W = window.PolyvWasmPlayer;
    if (!W) return false;
    if (W.__bn) return true;
    W.__bn = 1;
    let P = W.prototype;
    while (P && !Object.getOwnPropertyDescriptor(P, 'currentTime')) P = Object.getPrototypeOf(P);
    if (!P) return true;
    for (const k of ['currentTime', 'seeking', 'playbackRate']) {
      const d = Object.getOwnPropertyDescriptor(P, k);
      if (!d || !d.get) continue;
      const get = d.get;
      Object.defineProperty(P, k, { ...d, get() { if (this !== player && !this.destroyed && !pvAlive(player)) player = this; return get.call(this); } });
    }
    return true;
  }
  if (!VID && !hookPlayer()) { const iv = setInterval(() => { if (hookPlayer()) clearInterval(iv); }, 300); }

  // YouTube：包一层，接口和保利威播放器一样（currentTime 毫秒、duration 秒、seek(毫秒)…）
  const mp = () => document.getElementById('movie_player');
  const vEl = () => { const m = mp(); return (m && m.querySelector('video')) || null; };
  const isAd = () => { const m = mp(); return !!(m && m.classList.contains('ad-showing')); };
  const pr = () => { const m = mp(); try { return (m && m.getPlayerResponse && m.getPlayerResponse()) || null; } catch (e) { return null; } };
  const dismiss = () => { const b = document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button'); if (b && b.offsetParent) b.click(); }; // “视频已暂停，要继续观看吗？”
  const ytp = {
    get currentTime() { const v = vEl(); return v ? v.currentTime * 1000 : 0; },
    get duration() { const v = vEl(); if (v && !isAd() && isFinite(v.duration)) return v.duration; const r = pr(); return r && r.videoDetails ? +r.videoDetails.lengthSeconds || 0 : 0; },
    get paused() { const v = vEl(); return !v || v.paused; },
    get status() { return isAd() ? 'ad' : ''; },
    seek(ms) { const m = mp(); if (m && m.seekTo) m.seekTo(ms / 1000, true); else { const v = vEl(); if (v) v.currentTime = ms / 1000; } },
    play() { dismiss(); const m = mp(); if (m && m.playVideo) m.playVideo(); else { const v = vEl(); if (v) v.play(); } },
    pause() { const m = mp(); if (m && m.pauseVideo) m.pauseVideo(); else { const v = vEl(); if (v) v.pause(); } },
    get playbackRate() { const v = vEl(); return v ? v.playbackRate : 1; },
    set playbackRate(x) { const m = mp(); if (m && m.setPlaybackRate) m.setPlaybackRate(x); const v = vEl(); if (v) v.playbackRate = x; }
  };
  // Vimeo：页面上可能有好几个 <video>（推荐视频的预览之类），取有时长、画面最大的那个
  const vmVideo = () => {
    if (BL) { // B 站：播放器里的那个（页面上还可能有推荐视频的预览）
      const v = document.querySelector('#bilibili-player video, .bpx-player-container video, .bpx-player-video-wrap video');
      if (v && isFinite(v.duration) && v.duration > 0) return v;
    }
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const a = (v.videoWidth || v.clientWidth) * (v.videoHeight || v.clientHeight);
      if (isFinite(v.duration) && v.duration > 0 && a >= area) { best = v; area = a; }
    }
    return best;
  };
  const vmId = () => (location.pathname.match(/^\/(?:video\/)?(\d{5,})(?:\/|$)/) || [])[1] || '';
  const vmp = {
    get currentTime() { const v = vmVideo(); return v ? v.currentTime * 1000 : 0; },
    get duration() { const v = vmVideo(); return v ? v.duration : 0; },
    get paused() { const v = vmVideo(); return !v || v.paused; },
    get status() { return ''; },
    seek(ms) { const v = vmVideo(); if (v) v.currentTime = ms / 1000; },
    play() { const v = vmVideo(); if (v) v.play().catch(() => {}); },
    pause() { const v = vmVideo(); if (v) v.pause(); },
    get playbackRate() { const v = vmVideo(); return v ? v.playbackRate : 1; },
    set playbackRate(x) { const v = vmVideo(); if (v) v.playbackRate = x; }
  };
  // Vimeo 的标题、作者、日期：页面标签 + oEmbed（vimeo.com 自己的公开接口），每个视频查一次
  const vmMeta = {};
  function vmInfo() {
    const id = vmId();
    if (!id) return null;
    if (!vmMeta[id]) {
      vmMeta[id] = { title: '', author: '', date: '' };
      fetch('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/' + id))
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j) Object.assign(vmMeta[id], { title: j.title || '', author: j.author_name || '', date: String(j.upload_date || '').slice(0, 10) }); })
        .catch(() => {});
    }
    const og = document.querySelector('meta[property="og:title"]');
    const m = vmMeta[id], v = vmVideo();
    return {
      id, title: m.title || (og && og.content) || document.title.replace(/\s*(\|[^|]*)?\s*on Vimeo$/i, '').trim(),
      author: m.author, date: m.date, len: v ? Math.round(v.duration) : 0, caps: vmTracks().length
    };
  }
  const alive = p => YT ? !!vEl() : GEN ? !!vmVideo() : pvAlive(p);
  const P = () => YT ? (vEl() ? ytp : null) : GEN ? (vmVideo() ? vmp : null) : (pvAlive(player) ? player : null);
  function state() {
    const p = P();
    if (!p) return { ready: false };
    let vt = 0, rate = 1;
    try { vt = +p.currentTime || 0; rate = +p.playbackRate || 1; } catch (e) {}
    const s = { ready: true, vt, dur: +p.duration || 0, paused: !!p.paused, rate, status: String(p.status || '') };
    if (VID && tap.on) s.locked = locked();
    if (YT) {
      const r = pr(), d = r && r.videoDetails;
      if (isAd()) { s.ready = false; s.ad = true; } // 广告时 <video> 放的是广告，进度不是正片的
      s.info = d ? {
        id: d.videoId, title: d.title, author: d.author, len: +d.lengthSeconds || 0,
        date: String((r.microformat && r.microformat.playerMicroformatRenderer && r.microformat.playerMicroformatRenderer.publishDate) || '').slice(0, 10),
        caps: ((r.captions && r.captions.playerCaptionsTracklistRenderer && r.captions.playerCaptionsTracklistRenderer.captionTracks) || []).length
      } : null;
    }
    if (VM) s.info = vmInfo();
    return s;
  }

  // —— 2. 声音 ——
  const tap = { on: false, mute: true, sps: new Map() }; // sps：每个 AudioContext 一个采样节点
  const oc = AudioNode.prototype.connect, od = AudioNode.prototype.disconnect;
  // 保利威：记下所有接到扬声器的节点；转写时把它们改接到我们的 ScriptProcessor 上
  const outs = []; // { node, ctx }
  // B 站：播放器可能自己已经把 <video> 接进了 WebAudio（音量均衡之类），同一个 <video> 不能再接第二次，
  // 所以也记下页面接到扬声器的节点、页面给 <video> 建的源节点；转写时从页面的源节点取声音，不出声就断开页面接扬声器的那几个
  if (!VID || BL) {
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest instanceof AudioDestinationNode && !this.__bnTap) {
        const ent = { node: this, ctx: dest.context };
        if (!outs.some(e => e.node === this)) outs.push(ent);
        if (tap.on && (!VID || (ya && ya.page && ya.ctx === ent.ctx))) { if (!VID) attach(ent); if (tap.mute) return dest; } // 转写中又接了新的：接到我们这 / 不出声
      }
      return oc.call(this, dest, ...rest);
    };
  }
  const pageSrc = new WeakMap(); // <video> → 页面自己建的 MediaElementAudioSourceNode
  if (BL) {
    const cm = BaseAudioContext.prototype.createMediaElementSource || AudioContext.prototype.createMediaElementSource;
    const host = BaseAudioContext.prototype.createMediaElementSource ? BaseAudioContext.prototype : AudioContext.prototype;
    host.createMediaElementSource = function (el) { const n = cm.call(this, el); if (!this.__bnOwn) pageSrc.set(el, n); return n; };
  }

  let acc = new Float32Array(16000), accN = 0, frac = 0, sum = 0, sumN = 0, lastVt = null, lastAt = 0;
  const CHUNK = 8000; // 0.5 秒（16 kHz）
  function onAudio(e) {
    for (let c = 0; c < e.outputBuffer.numberOfChannels; c++) e.outputBuffer.getChannelData(c).fill(0);
    const st = state();
    if (!st.ready || st.paused) return;
    const d = e.inputBuffer.getChannelData(0), step = e.inputBuffer.sampleRate / 16000;
    for (let i = 0; i < d.length; i++) {
      sum += d[i]; sumN++; frac += 1;
      if (frac >= step) {
        frac -= step;
        acc[accN++] = sum / sumN; sum = 0; sumN = 0;
        if (accN === CHUNK) flushChunk(st);
      }
    }
  }
  function flushChunk(st) {
    const vt = st.vt, now = performance.now();
    const pcm = new Int16Array(accN);
    for (let i = 0; i < accN; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(acc[i] * 32767)));
    accN = 0;
    // 进度和声音对不上（被拖动了）：这一包前后两段话混在一起，丢掉，告诉插件另起一句
    if (lastVt != null) {
      const expect = (now - lastAt) * st.rate;
      if (Math.abs(vt - lastVt - expect) > 2500) { out({ ev: 'jump', from: lastVt, to: vt }); lastVt = vt; lastAt = now; return; }
    }
    lastVt = vt; lastAt = now;
    out({ ev: 'audio', pcm: pcm.buffer, vt, rate: st.rate, dur: st.dur }, [pcm.buffer]);
  }
  function spFor(ctx) {
    let sp = tap.sps.get(ctx);
    if (!sp) {
      sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.__bnTap = 1;
      sp.onaudioprocess = onAudio; // 输出缓冲保持全 0：接着扬声器只是为了让它一直跑，不会出声
      oc.call(sp, ctx.destination);
      tap.sps.set(ctx, sp);
    }
    return sp;
  }
  function attach(ent) {
    if (ent.ctx.state === 'closed') return;
    try { oc.call(ent.node, spFor(ent.ctx)); } catch (e) {}
    if (tap.mute) { try { od.call(ent.node, ent.ctx.destination); } catch (e) {} }
  }
  // YouTube / Vimeo：<video> 接进我们自己的 AudioContext（同一个 <video> 只能接一次，之后声音一直走这里，不转写时直通扬声器）
  let ya = null; // { ctx, src, el, vol }
  function ytSource() {
    const v = YT ? vEl() : vmVideo();
    if (!v) return null;
    if (!ya || ya.el !== v) {
      const ps = pageSrc.get(v);
      if (ps && ps.context.state !== 'closed') ya = { ctx: ps.context, el: v, src: ps, vol: null, page: true }; // 页面已经接过：借它的
      else {
        const ctx = new AudioContext();
        ctx.__bnOwn = 1;
        ya = { ctx, el: v, src: ctx.createMediaElementSource(v), vol: null };
        oc.call(ya.src, ctx.destination);
      }
    }
    if (ya.ctx.state !== 'running') ya.ctx.resume().catch(() => {});
    return ya;
  }
  function resetAcc() { accN = 0; frac = 0; sum = 0; sumN = 0; lastVt = null; }
  // 浏览器的自动播放规则：没被点过的标签页里 AudioContext 是挂起的（一包声音都不来），有声播放也会被拒绝；
  // 「按页批量」自己开的标签页就是这样。挂起着就算 locked，面板会提示用户点一下页面；
  // 点了（或按了键）之后这里把 AudioContext 恢复、接着播 —— 不恢复的话视频显示在播、进度却不走
  const locked = () => !!(VID && tap.on && ya && ya.ctx.state !== 'running');
  function wake(e) {
    if (!e.isTrusted || !locked()) return;
    ya.ctx.resume().then(() => {
      resetAcc();
      // 点在画面上播放器自己会切换播放 / 暂停：等它处理完，还停着再播
      nST.call(window, () => { const p = P(); if (tap.on && p && p.paused) p.play(); }, 400);
    }).catch(() => {});
  }
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, wake, true);
  function tapOn(mute) {
    if (tap.on) tapOff();
    tap.on = true; tap.mute = mute !== false;
    resetAcc();
    if (VID) {
      let a;
      try { a = ytSource(); } catch (e) { tap.on = false; return { ok: false, detail: String(e.message || e) }; }
      if (!a) { tap.on = false; return { ok: false }; }
      oc.call(a.src, spFor(a.ctx));
      if (tap.mute) {
        if (a.page) { for (const e of outs) if (e.ctx === a.ctx) { try { od.call(e.node, a.ctx.destination); } catch (err) {} } } // 页面的声音链：断开接扬声器的末端
        else { try { od.call(a.src, a.ctx.destination); } catch (e) {} }
        // 不出声时把播放器音量开满（声音反正不进扬声器），转写拿到的声音才不会太小；停了再还原
        const m = YT && mp();
        if (m && m.getVolume) { a.vol = { v: m.getVolume(), muted: m.isMuted() }; m.unMute(); m.setVolume(100); }
        else if (!YT) { a.vol = { v: a.el.volume, muted: a.el.muted }; a.el.muted = false; a.el.volume = 1; }
      }
      return { ok: true, outs: 1 };
    }
    for (const e of outs) attach(e);
    return { ok: outs.length > 0, outs: outs.length };
  }
  function tapOff() {
    if (!tap.on) return;
    tap.on = false;
    if (VID && ya) {
      const sp = tap.sps.get(ya.ctx);
      if (sp) { try { od.call(ya.src, sp); } catch (e) {} }
      if (tap.mute) {
        if (ya.page) { for (const e of outs) if (e.ctx === ya.ctx) { try { oc.call(e.node, ya.ctx.destination); } catch (err) {} } }
        else { try { oc.call(ya.src, ya.ctx.destination); } catch (e) {} }
        const m = YT && mp();
        if (m && ya.vol) { m.setVolume(ya.vol.v); if (ya.vol.muted) m.mute(); ya.vol = null; }
        else if (!YT && ya.vol) { ya.el.volume = ya.vol.v; ya.el.muted = ya.vol.muted; ya.vol = null; }
      }
    } else {
      for (const e of outs) {
        const sp = tap.sps.get(e.ctx);
        if (sp) { try { od.call(e.node, sp); } catch (err) {} }
        if (tap.mute) { try { oc.call(e.node, e.ctx.destination); } catch (err) {} }
      }
    }
    for (const sp of tap.sps.values()) { sp.onaudioprocess = null; try { od.call(sp); } catch (e) {} }
    tap.sps.clear();
  }

  // —— 3. 后台不降速：转写期间，这个页面的定时器改由 Worker 里的计时器驱动（Worker 不受这种限速）；动画帧只在隐藏时换 ——
  let bgOn = false, worker = null;
  const cbs = new Map(); let wseq = 1e9;
  function ensureWorker() {
    if (worker) return worker;
    const src = 'const T=new Map();onmessage=e=>{const[d,id,ms,rep]=e.data;if(d==="s"){T.set(id,(rep?setInterval:setTimeout)(()=>{if(!rep)T.delete(id);postMessage(id)},ms))}else{clearTimeout(T.get(id));clearInterval(T.get(id));T.delete(id)}}';
    try { worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
    catch (e) { return null; }
    worker.onmessage = e => { const c = cbs.get(e.data); if (!c) return; if (!c.rep) cbs.delete(e.data); try { c.fn(); } catch (err) { nST.call(window, () => { throw err; }); } };
    return worker;
  }
  const wAdd = (fn, ms, rep) => { const id = ++wseq; cbs.set(id, { fn, rep }); worker.postMessage(['s', id, Math.max(0, +ms || 0), rep]); return id; };
  const wDel = id => { if (!cbs.has(id)) return false; cbs.delete(id); worker.postMessage(['c', id]); return true; };
  const nST = window.setTimeout, nCT = window.clearTimeout, nSI = window.setInterval, nCI = window.clearInterval;
  const nRAF = window.requestAnimationFrame, nCAF = window.cancelAnimationFrame;
  // 循环定时器要能“搬家”：播放器解码声音用的 setInterval 是开播时建的，转写开始后要从浏览器原生的搬到 Worker 上，
  // 不然后台一降速它就跟不上（保利威实测后台约 100 秒后播放器停下来等数据）。所以每个循环定时器都由这里发编号、记下来
  const ivs = new Map(); // 编号 → { fn, ms, nid（原生）, wid（Worker） }
  const ivStart = iv => { if (bgOn && ensureWorker()) iv.wid = wAdd(iv.fn, iv.ms, true); else iv.nid = nSI.call(window, iv.fn, iv.ms); };
  const ivStop = iv => { if (iv.wid) { wDel(iv.wid); iv.wid = 0; } if (iv.nid) { nCI.call(window, iv.nid); iv.nid = 0; } };
  const clearAny = (id, native) => {
    const iv = ivs.get(id);
    if (iv) { ivStop(iv); ivs.delete(id); return; }
    if (!wDel(id)) native.call(window, id);
  };
  window.setTimeout = function (fn, ms, ...a) { return typeof fn === 'function' && bgOn && ensureWorker() ? wAdd(() => fn(...a), ms, false) : nST.call(window, fn, ms, ...a); };
  window.setInterval = function (fn, ms, ...a) {
    if (typeof fn !== 'function') return nSI.call(window, fn, ms, ...a);
    const id = ++wseq, iv = { fn: () => fn(...a), ms: Math.max(4, +ms || 0), nid: 0, wid: 0 };
    ivs.set(id, iv); ivStart(iv);
    return id;
  };
  window.clearTimeout = function (id) { clearAny(id, nCT); };
  window.clearInterval = function (id) { clearAny(id, nCI); };
  window.requestAnimationFrame = function (fn) { return bgOn && document.hidden && ensureWorker() ? wAdd(() => fn(performance.now()), 16, false) : nRAF.call(window, fn); };
  window.cancelAnimationFrame = function (id) { if (!wDel(id)) nCAF.call(window, id); };
  function setBg(on) {
    if (on && !ensureWorker()) return false;
    bgOn = on;
    for (const iv of ivs.values()) { ivStop(iv); ivStart(iv); } // 已有的循环定时器全部搬到新地方
    return true;
  }

  // 跳转：保利威播放器跳完偶尔卡住不动（状态是 playing，声音和画面都在等数据；实测停在 0 秒时跳 0 秒、转写停下后马上跳都遇到过），
  // 再跳一次就好。所以跳完 3 秒还没走，就往后推 0.3 秒再跳，最多 3 次；用户暂停着就不管
  let seekToken = 0;
  function seekSure(p, ms, tries = 0) {
    const tok = tries ? seekToken : ++seekToken;
    p.seek(ms);
    window.setTimeout(() => {
      if (tok !== seekToken || !alive(p) || p.paused || tries >= 3) return;
      let vt = 0; try { vt = +p.currentTime || 0; } catch (e) {}
      if (vt > ms + 200) return;
      seekSure(p, Math.max(ms, vt) + 300, tries + 1);
    }, 3000);
  }

  // —— 4. YouTube 字幕 ——
  // 字幕接口要带一个播放器现算的令牌（pot），直接用页面数据里的地址下载回来是空的。
  // 所以记下播放器自己请求字幕时的地址（带令牌），换个语言参数就能下载任意一条字幕
  const ttUrl = new Map(); // 视频 ID → 带令牌的字幕地址
  const keepTT = u => { try { const x = new URL(String(u), location.href); if (/\/api\/timedtext/.test(x.pathname) && x.searchParams.get('pot')) ttUrl.set(x.searchParams.get('v'), x.href); } catch (e) {} };
  if (YT) {
    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { if (u && /timedtext/.test(u)) keepTT(u); return xo.apply(this, arguments); };
    const of = window.fetch;
    window.fetch = function (i) { try { const u = typeof i === 'string' ? i : i && i.url; if (u && /timedtext/.test(u)) keepTT(u); } catch (e) {} return of.apply(this, arguments); };
  }
  const perfTT = vid => { for (const e of performance.getEntriesByType('resource').reverse()) if (/\/api\/timedtext/.test(e.name) && e.name.includes('v=' + vid)) { keepTT(e.name); if (ttUrl.has(vid)) return ttUrl.get(vid); } return null; };
  const trackName = t => (t.name && (t.name.simpleText || (t.name.runs || []).map(r => r.text).join(''))) || t.languageCode;
  const cjk = s => /[⺀-鿿＀-￯]/.test(s);
  function parseJson3(j) {
    const raw = [];
    for (const e of j.events || []) {
      if (!e.segs || e.tStartMs == null) continue;
      const text = e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (text) raw.push({ from: e.tStartMs / 1000, to: (e.tStartMs + (e.dDurationMs || 0)) / 1000, text });
    }
    return mergeLines(raw);
  }
  // WebVTT（Vimeo 的字幕格式）：时间行「00:00:01.000 --> 00:00:04.000」，下面到空行为止是文字
  function parseVtt(text) {
    const raw = [], sec = s => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    const lines = String(text).replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const buf = [];
      while (i + 1 < lines.length && lines[i + 1].trim()) buf.push(lines[++i]);
      const t = buf.join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) raw.push({ from: sec(m[1]), to: sec(m[2]), text: t });
    }
    // 自动字幕常常一行是上一行的延续（滚动显示）：和上一条完全重复的去掉
    return mergeLines(raw.filter((x, i) => !i || x.text !== raw[i - 1].text));
  }
  function mergeLines(raw) {
    for (let i = 0; i < raw.length - 1; i++) if (raw[i].to > raw[i + 1].from) raw[i].to = Math.max(raw[i].from, raw[i + 1].from);
    // 自动字幕一行只有几个词：拼成一句一句（不超过 10 秒）
    const o = [];
    for (const x of raw) {
      const l = o[o.length - 1];
      if (l && x.from - l.from < 10 && l.text.length + x.text.length < 160 && !/[.?!。？！]$/.test(l.text)) { l.text += (cjk(l.text.slice(-1)) && cjk(x.text[0]) ? '' : ' ') + x.text; l.to = x.to; }
      else o.push({ ...x });
    }
    return o.map(x => ({ from: +x.from.toFixed(2), to: +x.to.toFixed(2), text: x.text }));
  }
  async function ytSubs() {
    const m = mp(), r = pr();
    if (!m || !r || !r.videoDetails) return { ok: false, detail: '播放器还没准备好' };
    const vid = r.videoDetails.videoId;
    const R = r.captions && r.captions.playerCaptionsTracklistRenderer, tracks = (R && R.captionTracks) || [];
    if (!tracks.length) return { ok: false, none: true, detail: '这个视频没有字幕' };
    // 选哪条：和视频原声同语言的人工字幕 > 自动字幕（自动字幕的语言就是原声语言）> 默认字幕 > 第一条
    // 开了 AI 配音的视频有一堆配音语言的自动字幕（下载回来是空的）：按原声音轨（defaultAudioTrackIndex）认原声语言
    const base = l => String(l || '').split(/[-.]/)[0];
    const au = (R.audioTracks || [])[R.defaultAudioTrackIndex || 0] || (R.audioTracks || [])[0];
    const def = au && tracks[au.defaultCaptionTrackIndex];
    const orig = au && au.audioTrackId ? base(au.audioTrackId) : def ? base(def.languageCode) : '';
    const asr = (orig && tracks.find(t => t.kind === 'asr' && base(t.languageCode) === orig)) || (def && def.kind === 'asr' && def) || tracks.find(t => t.kind === 'asr');
    const lang = orig || (asr && base(asr.languageCode));
    const pick = (lang && tracks.find(t => t.kind !== 'asr' && base(t.languageCode) === lang)) || asr || def || tracks[0];
    let url = ttUrl.get(vid) || perfTT(vid);
    if (!url) {
      // 让播放器自己请求一次字幕（开一下 CC 再还原），拿到带令牌的地址
      if (isAd()) return { ok: false, detail: '正在放广告，广告放完再点' };
      const btn = document.querySelector('#movie_player .ytp-subtitles-button');
      const toggle = () => { if (btn) btn.click(); else if (m.toggleSubtitles) m.toggleSubtitles(); };
      const wasOn = !!btn && btn.getAttribute('aria-pressed') === 'true';
      if (wasOn) toggle();
      toggle();
      for (let i = 0; i < 40 && !(url = ttUrl.get(vid) || perfTT(vid)); i++) await sleep(250);
      if (!wasOn) toggle();
      if (!url) return { ok: false, detail: '没拿到字幕地址（先点一下播放，等正片开始再试）' };
    }
    const u = new URL(url);
    u.searchParams.set('lang', pick.languageCode);
    if (pick.kind) u.searchParams.set('kind', pick.kind); else u.searchParams.delete('kind');
    u.searchParams.delete('tlang');
    u.searchParams.set('fmt', 'json3');
    const res = await fetch(u.href, { credentials: 'include' });
    const text = await res.text();
    if (!res.ok || !text) return { ok: false, detail: `字幕下载失败（HTTP ${res.status}${text ? '' : '，内容是空的'}）` };
    const lines = parseJson3(JSON.parse(text));
    if (!lines.length) return { ok: false, detail: '字幕是空的' };
    return { ok: true, vid, lines, lang: pick.languageCode, asr: pick.kind === 'asr', name: trackName(pick) };
  }

  // —— Vimeo 字幕：播放器在页面上放了 <track>，src 是 captions.vimeo.com 上带签名的 VTT，可以直接下载 ——
  function vmTracks() {
    return [...document.querySelectorAll('track')].filter(t => t.src && /^(captions|subtitles)$/i.test(t.kind || 'captions'));
  }
  async function vmSubs() {
    const id = vmId();
    if (!id || !vmVideo()) return { ok: false, detail: '播放器还没准备好' };
    let ts = vmTracks();
    for (let i = 0; i < 12 && !ts.length; i++) { await sleep(250); ts = vmTracks(); }
    if (!ts.length) return { ok: false, none: true, detail: '这个视频没有字幕' };
    // 人工字幕优先；自动字幕的语言标成 xx-x-autogen、名字带 auto-generated
    const auto = t => /autogen|auto-generated|自动/i.test((t.srclang || '') + ' ' + (t.label || ''));
    const pick = ts.find(t => !auto(t)) || ts[0];
    const res = await fetch(pick.src);
    const text = await res.text();
    if (!res.ok || !text) return { ok: false, detail: `字幕下载失败（HTTP ${res.status}）` };
    const lines = parseVtt(text);
    if (!lines.length) return { ok: false, detail: '字幕是空的' };
    const lang = String(pick.srclang || '').replace(/-x-autogen$/i, '') || 'und';
    return { ok: true, vid: id, lines, lang, asr: auto(pick), name: pick.label || lang };
  }

  // —— 插件发来的命令 ——
  window.addEventListener('message', async e => {
    const m = e.data;
    if (e.source !== window || !m || m.tag !== TAG || m.dir !== 'in') return;
    let r;
    try {
      const p = P();
      switch (m.cmd) {
        case 'state': r = state(); break;
        case 'seek': if (p) seekSure(p, Math.max(0, Math.round(+m.ms || 0))); r = { ok: !!p }; break;
        case 'play': if (p) p.play(); r = { ok: !!p }; break;
        case 'pause': if (p) p.pause(); r = { ok: !!p }; break;
        case 'rate': if (p) p.playbackRate = +m.v || 1; r = { ok: !!p }; break;
        case 'tap': r = m.on ? tapOn(m.mute) : (tapOff(), { ok: true }); break;
        case 'bg': r = { ok: setBg(!!m.on), intervals: ivs.size }; break;
        case 'subs': r = YT ? await ytSubs() : VM ? await vmSubs() : { ok: false, none: true }; break;
        // 批量：静音（返回原来是不是静音的）、在播放列表里换到某个视频（站内切换，不重新加载页面，后台也能走）
        case 'ytmute': {
          if (GEN) { const v = vmVideo(); if (!v) { r = { ok: false }; break; } const was = v.muted; v.muted = !!m.on; r = { ok: true, was }; break; }
          const y = mp(); if (!y || !y.isMuted) { r = { ok: false }; break; } const was = y.isMuted(); if (m.on) y.mute(); else y.unMute(); r = { ok: true, was }; break;
        }
        // 插件那一半的等待也借这里的计时器：后台标签页里插件自己的定时器会被限到一分钟一次，这里转写 / 批量时走 Worker 不受限
        case 'sleep': await sleep(Math.min(60000, Math.max(0, +m.ms || 0))); r = { ok: true }; break;
        case 'quality': { const y = mp(); try { if (y && y.setPlaybackQualityRange) y.setPlaybackQualityRange('hd1080', 'hd1080'); } catch (e) {} r = { ok: true }; break; } // 截图要清楚
        case 'adskip': { // 批量等广告时：有「跳过」按钮就点（和你手动点一样），广告停住了就让它接着放
          const b = document.querySelector('#movie_player .ytp-skip-ad-button, #movie_player .ytp-ad-skip-button-modern, #movie_player .ytp-ad-skip-button');
          const v = vEl();
          let skipped = false;
          if (b && b.offsetParent) { b.click(); skipped = true; }
          if (v && v.paused && isAd()) v.play().catch(() => {});
          r = { ok: true, skipped, paused: !!(v && v.paused) };
          break;
        }
        case 'goto': {
          const y = mp(), pl = (y && y.getPlaylist && y.getPlaylist()) || [], i = pl.indexOf(String(m.v || ''));
          if (i >= 0) { y.playVideoAt(i); r = { ok: true, spa: true }; }
          else { location.href = '/watch?v=' + encodeURIComponent(m.v) + (m.list ? '&list=' + encodeURIComponent(m.list) : ''); r = { ok: true, spa: false }; }
          break;
        }
        default: r = { ok: false, detail: 'unknown ' + m.cmd };
      }
    } catch (err) { r = { ok: false, detail: String(err && err.message || err) }; }
    out({ re: m.id, r });
  });
})();
