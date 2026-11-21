// 看不见的窗口：每块屏幕保持一路画面，每秒存一张（画面没变就不存，只留最近 15 秒，只在内存里）
// 按键时：截当前画面 + 从这 15 秒里挑出明显不同的几张
const BUF_SEC = 15, STORE_W = 1920, CAND_W = 960, MAIN_W = 1920, SAME_T = 0.8, DIFF_T = 7, MAX_CAND = 6;
const displays = new Map(); // displayId → { sourceId, video, stream, buf: [{ wall, sig, blob }] }
const sc = new OffscreenCanvas(32, 18), sctx = sc.getContext('2d', { willReadFrequently: true });

function sigOf(src, sx, sy, sw, sh) {
  sctx.drawImage(src, sx, sy, sw, sh, 0, 0, 32, 18);
  const d = sctx.getImageData(0, 0, 32, 18).data, g = new Uint8Array(576);
  for (let i = 0; i < 576; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  return g;
}
const bright = g => { let s = 0; for (let i = 0; i < g.length; i++) s += g[i]; return s / g.length; };
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function encode(src, sx, sy, sw, sh, maxW, q) {
  const w = Math.max(1, Math.min(Math.round(sw), maxW)), h = Math.max(1, Math.round(sh * w / sw));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: q });
}
const region = (W, H, crop) => crop
  ? { x: Math.round(crop.x * W), y: Math.round(crop.y * H), w: Math.max(2, Math.round(crop.w * W)), h: Math.max(2, Math.round(crop.h * H)) }
  : { x: 0, y: 0, w: W, h: H };

// 屏幕这一路画面会自己断：锁屏、显示器休眠、显卡驱动重置、换分辨率之后，系统把它结束掉，之后截到的全是黑的。
// 所以：断了就向主程序重新要一遍屏幕列表再打开；按键时发现是断的，先重开再截。
const alive = d => !!d && d.stream.getVideoTracks().some(t => t.readyState === 'live');
const drop = id => { const d = displays.get(id); if (!d) return; d.stream.getTracks().forEach(t => t.stop()); d.video.srcObject = null; displays.delete(id); };
let wanted = [], lastAsk = 0, syncing = Promise.resolve();
function askSources(why) {
  if (Date.now() - lastAsk < 3000) return;
  lastAsk = Date.now();
  bn.call({ type: 'cap-lost', text: why });
}
function sync(list, force) { return syncing = syncing.then(() => doSync(list, force)).catch(() => {}); } // 排队做，免得两次同时开同一块屏幕
async function doSync(list, force) {
  wanted = list;
  const want = new Map(list.map(s => [s.displayId, s]));
  for (const [id, d] of [...displays]) {
    if (force || !want.has(id) || want.get(id).sourceId !== d.sourceId || !alive(d)) drop(id);
  }
  for (const s of list) {
    if (displays.has(s.displayId)) continue;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: s.sourceId, minWidth: s.width, maxWidth: s.width, minHeight: s.height, maxHeight: s.height, maxFrameRate: 5 } }
      });
      const video = document.createElement('video');
      video.muted = true; video.srcObject = stream;
      await video.play();
      const d = { sourceId: s.sourceId, video, stream, buf: [] };
      displays.set(s.displayId, d);
      stream.getVideoTracks()[0].onended = () => { if (displays.get(s.displayId) === d) { drop(s.displayId); askSources('屏幕 ' + s.displayId + ' 的画面断了'); } };
    } catch (e) { bn.call({ type: 'cap-log', text: '打不开屏幕 ' + s.displayId + '：' + e.message }); }
  }
}

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    for (const [id, d] of [...displays]) if (!alive(d)) drop(id);                     // 断了但没收到通知的
    if (wanted.some(s => !displays.has(s.displayId))) askSources('有屏幕没在截');      // 没开起来的（比如正锁着屏），每 3 秒再试
    for (const d of displays.values()) {
      const v = d.video;
      if (v.readyState < 2 || !v.videoWidth) continue;
      const now = Date.now();
      d.buf = d.buf.filter(f => now - f.wall <= BUF_SEC * 1000);
      const g = sigOf(v, 0, 0, v.videoWidth, v.videoHeight), last = d.buf[d.buf.length - 1];
      if (last && diff(last.sig, g) < SAME_T) continue;
      d.buf.push({ wall: now, sig: g, blob: await encode(v, 0, 0, v.videoWidth, v.videoHeight, STORE_W, 0.82) });
    }
  } finally { ticking = false; }
}, 1000);

const ready = d => alive(d) && d.video.readyState >= 2 && d.video.videoWidth > 0;
async function grab({ rid, displayId, crop }) {
  let d = displays.get(displayId);
  if (!ready(d)) { // 这块屏幕的画面断了或还没开：重新要一遍，最多等 2.5 秒
    lastAsk = 0; askSources('按键时屏幕 ' + displayId + ' 没画面');
    for (let i = 0; i < 25 && !ready(d); i++) { await new Promise(r => setTimeout(r, 100)); d = displays.get(displayId); }
  }
  if (!ready(d) && !wanted.some(s => s.displayId === displayId)) d = [...displays.values()].find(ready); // 主程序给的屏幕编号对不上时，退到任意一块
  if (!ready(d)) return { rid, ok: false, detail: '这块屏幕的画面打不开（刚解锁或刚换过显示器的话，过几秒再按）' };
  const v = d.video, now = Date.now(), r = region(v.videoWidth, v.videoHeight, crop);
  const mainBlob = await encode(v, r.x, r.y, r.w, r.h, MAIN_W, 0.9), ms = sigOf(v, r.x, r.y, r.w, r.h);

  // 从新到旧，挑出和“现在”及彼此明显不同的画面
  const kept = [ms], cands = [];
  for (let i = d.buf.length - 1; i >= 0 && cands.length < MAX_CAND; i--) {
    const f = d.buf[i];
    if (now - f.wall < 600) continue;
    const bmp = await createImageBitmap(f.blob), b = region(bmp.width, bmp.height, crop);
    const g = sigOf(bmp, b.x, b.y, b.w, b.h);
    if (kept.every(k => diff(k, g) > DIFF_T)) { kept.push(g); cands.push({ dt: (now - f.wall) / 1000, sig: g, blob: await encode(bmp, b.x, b.y, b.w, b.h, CAND_W, 0.8) }); }
    bmp.close();
  }
  cands.reverse();
  const frames = [];
  for (const c of cands) frames.push({ dt: c.dt, buf: new Uint8Array(await c.blob.arrayBuffer()) });
  frames.push({ dt: 0, main: true, buf: new Uint8Array(await mainBlob.arrayBuffer()) });
  let chosen = frames.length - 1;
  if (bright(ms) < 14) for (let i = cands.length - 1; i >= 0; i--) if (bright(cands[i].sig) >= 14) { chosen = i; break; } // 按键时是黑场
  return { rid, ok: true, frames, chosen };
}

// —— 听课：录电脑正在播放的声音（不是麦克风），每 0.5 秒交一包 16 kHz 单声道给主程序 ——
const TAP = URL.createObjectURL(new Blob([`
  class Tap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(8000); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 8000) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
      return true;
    }
  }
  registerProcessor('bn-sys', Tap);`], { type: 'application/javascript' }));
let au = null;
function audioStop() {
  if (!au) return;
  const a = au; au = null;
  a.stream.getTracks().forEach(t => t.stop());
  a.ctx.close().catch(() => {});
}
async function audioStart() {
  if (au) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: { chromeMediaSource: 'desktop' } } });
  stream.getVideoTracks().forEach(t => t.stop());
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule(TAP);
  const node = new AudioWorkletNode(ctx, 'bn-sys', { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }); // 立体声混成单声道
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
  const me = au = { stream, ctx };
  node.port.onmessage = e => {
    if (au !== me) return;
    const buf = e.data;
    let s = 0; for (let i = 0; i < buf.length; i += 4) s += buf[i] * buf[i];
    bn.call({ type: 'cap-audio', samples: buf, wall: Date.now(), level: Math.sqrt(s / (buf.length / 4)) });
  };
  // 换了播放设备（比如插上耳机）这一路会断：告诉主程序，让它重新开
  stream.getAudioTracks()[0].onended = () => { if (au === me) { audioStop(); bn.call({ type: 'cap-audio-state', ok: false, ended: true, detail: '播放设备变了' }); } };
}
bn.on('cap:audio', on => {
  if (!on) return audioStop();
  audioStart().then(() => bn.call({ type: 'cap-audio-state', ok: true }), e => { audioStop(); bn.call({ type: 'cap-audio-state', ok: false, detail: e.message || e.name }); });
});

bn.on('cap:sources', (list, force) => sync(list, force));
bn.on('cap:grab', req => grab(req).catch(e => ({ rid: req.rid, ok: false, detail: String(e.message || e) })).then(r => bn.call({ type: 'cap-result', ...r })));
bn.call({ type: 'cap-ready' });
