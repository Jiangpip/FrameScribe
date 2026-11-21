// 右上角的小弹窗：显示刚截的图和前 15 秒的候选、写一句、说一句（录音在这里做，转写交给主程序）
const card = document.getElementById('card');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let cur = null; // 当前显示的那条：{ sid, mid, timer, input, rec }

const resize = () => bn.call({ type: 'ov-size', h: document.body.scrollHeight });
// 弹窗不抢焦点（不打断播放器），这种窗口里鼠标“按下”会被系统吃掉、click 不会触发，只有“松开”能收到，所以点击一律按松开算
const tap = (el, fn) => el.addEventListener('mouseup', e => { if (e.button === 0) fn(e); });
function arm(ms) { if (!cur) return; clearTimeout(cur.timer); cur.timer = setTimeout(close, ms); }
function close() {
  if (!cur) return;
  const me = cur; cur = null;
  clearTimeout(me.timer);
  if (me.rec) me.rec.stop('cancel');
  if (me.input && me.input.value.trim()) bn.call({ type: 'mark-note', sid: me.sid, mid: me.mid, note: me.input.value.trim() });
  bn.call({ type: 'ov-close' });
}

function flash(text, ms) {
  if (cur) { const me = cur; cur = null; clearTimeout(me.timer); if (me.rec) me.rec.stop('cancel'); }
  card.innerHTML = `<div class="msg">${esc(text)}</div>`;
  cur = { timer: 0 };
  resize();
  arm(ms || 3000);
}

function show(d) {
  if (cur) { // 上一条还开着：先把没存的那句话存掉
    const me = cur; cur = null; clearTimeout(me.timer);
    if (me.rec) me.rec.stop('cancel');
    if (me.input && me.input.value.trim()) bn.call({ type: 'mark-note', sid: me.sid, mid: me.mid, note: me.input.value.trim() });
  }
  const n = d.frames.length;
  card.innerHTML = `
    <div class="head">${d.jot ? '<span class="tag jot">随笔</span>' : '<span class="tag">MARK</span>'}<span class="time">${esc(d.label)}</span><span class="no">第 ${d.no} 条</span>
      <span class="src${d.kind === 'bili' ? ' ext' : ''}">${d.kind === 'bili' ? '插件 · 原画' : '截屏'}</span><span class="sp"></span><button class="x" title="关闭">×</button></div>
    <div class="strip">${d.frames.map((f, i) => `<div class="fr${i === d.chosen ? ' on' : ''}" data-i="${i}"><img src="${esc(f.url)}"><span>${i === n - 1 ? '现在' : '-' + Math.max(1, Math.round(f.dt)) + 's'}</span></div>`).join('')}
      ${n === 1 ? '<span class="solo">前 15 秒画面没明显变化</span>' : ''}${d.chosen !== n - 1 ? '<span class="solo">按键时是黑场，已换成前一张</span>' : ''}</div>
    ${d.mode === 'note' ? '<input placeholder="写一句（回车保存，Esc 跳过）">' : ''}
    ${d.mode === 'voice' ? '<div class="voice"><span class="dot"></span><span class="vst">准备麦克风…</span><div class="meter"><i></i></div><span class="vt">0.0s</span></div><div class="vtext" style="display:none"></div>' : ''}
    <div class="hint">${n > 1 ? '点缩略图换成更清楚的那一张 · ' : ''}${d.mode === 'voice' ? (d.autoStop ? '说完停一下自动结束 · ' : '') + '再按 ' + esc(d.voiceKey) + ' 立即结束' : '视频不会暂停'}</div>`;
  const me = cur = { sid: d.sid, mid: d.markId, timer: 0, input: card.querySelector('input'), rec: null };
  tap(card.querySelector('.x'), close);
  const hint = card.querySelector('.hint'), hint0 = hint.textContent;
  card.querySelectorAll('.fr').forEach(el => tap(el, () => {
    if (cur !== me) return;
    card.querySelectorAll('.fr').forEach(x => x.classList.toggle('on', x === el));
    bn.call({ type: 'mark-choose', sid: me.sid, mid: me.mid, idx: +el.dataset.i });
    hint.textContent = `已换成「${el.querySelector('span').textContent}」这一张`;
    hint.classList.add('ok');
    clearTimeout(me.hintTimer);
    me.hintTimer = setTimeout(() => { hint.textContent = hint0; hint.classList.remove('ok'); }, 2500);
  }));
  const strip = card.querySelector('.strip');
  strip.scrollLeft = strip.scrollWidth; // 候选多时先让“现在”这张露出来
  strip.addEventListener('wheel', e => { if (!e.deltaX) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false }); // 滚轮横着翻更早的几张
  resize();
  if (d.mode === 'note') { setTimeout(() => me.input && me.input.focus(), 30); arm(45000); }
  else if (d.mode === 'voice') startRec(me, d.autoStop);
  else arm(n > 1 ? 7000 : 3500);
}

card.addEventListener('mouseenter', () => cur && clearTimeout(cur.timer));
card.addEventListener('mouseleave', () => cur && !cur.input && !cur.rec && arm(4000));
window.addEventListener('keydown', e => {
  if (!cur || !cur.input || e.isComposing) return;
  if (e.key === 'Enter') { e.preventDefault(); close(); }
  else if (e.key === 'Escape') { e.preventDefault(); cur.input.value = ''; close(); }
});

// —— 说一句 ——
const TAP = URL.createObjectURL(new Blob([`
  class Tap extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(800); this.n = 0; }   // 16 kHz 下每 50 毫秒交一包
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === 800) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
      return true;
    }
  }
  registerProcessor('bn-tap', Tap);`], { type: 'application/javascript' }));
const SPEECH = 0.02, QUIET = 0.012, SILENCE_MS = 1600, NOSPEECH_MS = 8000, MAX_MS = 60000;

function voiceUi(cls, text) {
  const box = card.querySelector('.voice');
  if (!box) return;
  box.className = 'voice ' + cls;
  box.querySelector('.vst').textContent = text;
}

async function startRec(me, autoStop) {
  const chunks = [];
  let stream = null, ctx = null, stopped = false, spoke = false, loud = 0, quietMs = 0, t0 = 0;
  const rec = me.rec = { stop };
  bn.call({ type: 'ov-voice-state', active: true });

  function cleanup() {
    stopped = true;
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    if (me.rec === rec) me.rec = null;
    bn.call({ type: 'ov-voice-state', active: false });
  }
  // why: key（再按一次）/ silence（停顿）/ max（到时间）/ nospeech（没人说话）/ cancel（关掉）/ inject（测试塞进来的声音）
  async function stop(why, injected) {
    if (stopped) return;
    cleanup();
    if (why === 'cancel') return;
    if (cur !== me) return;
    if (why === 'nospeech') { voiceUi('fail', '没听到说话，已跳过'); arm(2500); return; }
    let samples = injected;
    if (!samples) {
      let n = chunks.length;
      if (why === 'silence') n = Math.max(1, n - Math.floor((SILENCE_MS - 400) / 50)); // 去掉结尾那段停顿
      samples = new Float32Array(n * 800);
      for (let i = 0; i < n; i++) samples.set(chunks[i], i * 800);
    }
    if (samples.length < 16000 * 0.3) { voiceUi('fail', '太短了，已跳过'); arm(2500); return; }
    voiceUi('work', '转写中…');
    card.querySelector('.meter i').style.width = '0';
    const r = await bn.call({ type: 'ov-voice', sid: me.sid, mid: me.mid, samples });
    if (cur !== me) return;
    if (r.ok && r.text) {
      voiceUi('done', '已记下');
      const t = card.querySelector('.vtext'); t.textContent = r.text; t.style.display = '';
      resize();
      arm(5000);
    } else {
      voiceUi('fail', r.ok ? '没识别出内容（录音已保存）' : '转写失败：' + (r.detail || ''));
      arm(4000);
    }
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.audioWorklet.addModule(TAP);
    if (stopped) { ctx.close(); return; }
    const node = new AudioWorkletNode(ctx, 'bn-tap'), mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
    t0 = performance.now();
    voiceUi('live', '正在听…');
    const meter = card.querySelector('.meter i'), vt = card.querySelector('.vt');
    node.port.onmessage = e => {
      if (stopped) return;
      const buf = e.data;
      chunks.push(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length), ms = performance.now() - t0;
      meter.style.width = Math.min(100, rms * 600) + '%';
      vt.textContent = (ms / 1000).toFixed(1) + 's';
      if (rms > SPEECH) { loud++; if (loud >= 2) spoke = true; quietMs = 0; }
      else { loud = 0; if (rms < QUIET) quietMs += 50; }
      if (ms > MAX_MS) stop('max');
      else if (!spoke && ms > NOSPEECH_MS) stop('nospeech');
      else if (autoStop && spoke && quietMs >= SILENCE_MS) stop('silence');
    };
  } catch (e) {
    cleanup();
    if (cur === me) { voiceUi('fail', '打不开麦克风：' + (e.message || e.name)); arm(5000); }
  }
}

bn.on('ov:show', show);
bn.on('ov:flash', flash);
bn.on('ov:voice-stop', () => cur && cur.rec && cur.rec.stop('key'));
bn.on('ov:voice-inject', samples => cur && cur.rec && cur.rec.stop('inject', samples));
