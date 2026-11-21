// 语音转写（SenseVoice，本机 CPU 跑，不联网）。三种用法：
//   1. 一句话：软件发 { id, type: 'run', samples: Float32Array(16 kHz) }，回 { id, ok, text }
//   2. 听课：stream-start → 不断 stream-audio { samples, wall, rate } → stream-stop；
//      中间按停顿切成一句一句，每句回 { type: 'seg', startWall, endWall, text }，结束回 { type: 'stream-done' }
//      wall 是这包声音结束时的时刻（毫秒）：听课时是电脑时钟；转写网页回放时是视频进度，rate 是倍速（1 秒声音 = rate 秒视频）
//      stream-cut：视频被拖动了，把手上的半句先转完，后面的声音另起一句（不然会把拖动前后的话拼在一起）
//   3. 命令行自测：node asr-worker.js <16k 单声道 wav> [--stream]
const path = require('path'), fs = require('fs');
const MODEL_DIR = process.env.BN_ASR_MODEL_DIR || path.join(__dirname, 'models', 'sense-voice'); // 换模型做对比时用环境变量指过去
const VAD_MODEL = path.join(__dirname, 'models', 'silero_vad.onnx');

let rec = null, sherpa = null;
function load() {
  if (rec) return rec;
  const model = path.join(MODEL_DIR, 'model.int8.onnx'), tokens = path.join(MODEL_DIR, 'tokens.txt');
  if (!fs.existsSync(model) || !fs.existsSync(tokens)) throw new Error('没找到语音模型：' + MODEL_DIR);
  sherpa = require('sherpa-onnx-node');
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model, language: process.env.BN_ASR_LANG || 'auto', useInverseTextNormalization: 1 },
      tokens, numThreads: 4, provider: 'cpu', debug: 0
    }
  });
  return rec;
}

function transcribe(samples) {
  const r = load(), stream = r.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples });
  r.decode(stream);
  const out = r.getResult(stream);
  return { text: String(out.text || '').trim(), lang: out.lang || '' };
}

// —— 听课：连续的声音 → 按停顿分句 → 逐句转写 ——
const WIN = 512, HIST = 16000 * 45, PRE = 4000, POST = 2400; // 每句往前多取 0.25 秒、往后 0.15 秒，免得开头的字被切掉
let vad = null, fed = 0, rest = new Float32Array(0), stamps = []; // stamps：第几个采样点对应几点（毫秒），之后每个采样点走 rate/16 毫秒
let hist = new Float32Array(HIST), histLen = 0, histStart = 0;      // 最近 45 秒的声音，histStart 是 hist[0] 的采样序号
function remember(samples) {
  if (histLen + samples.length > HIST) {
    const drop = Math.min(histLen, histLen + samples.length - HIST);
    hist.copyWithin(0, drop, histLen);
    histLen -= drop; histStart += drop;
  }
  hist.set(samples.subarray(Math.max(0, samples.length - HIST)), histLen);
  histLen += Math.min(samples.length, HIST);
}
function padded(start, n, fallback) {
  const a = Math.max(start - PRE, histStart), b = Math.min(start + n + POST, histStart + histLen);
  return a < start && b > a ? hist.slice(a - histStart, b - histStart) : fallback;
}
function streamStart() {
  load();
  if (!fs.existsSync(VAD_MODEL)) throw new Error('没找到分段模型：' + VAD_MODEL);
  vad = new sherpa.Vad({
    sileroVad: { model: VAD_MODEL, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.4, maxSpeechDuration: 18, windowSize: WIN },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0
  }, 60);
  fed = 0; rest = new Float32Array(0); stamps = [];
  histLen = 0; histStart = 0;
}
function wallOf(idx) {
  let m = stamps[0];
  for (const s of stamps) { if (s.idx <= idx) m = s; else break; }
  return m ? m.wall + (idx - m.idx) / 16 * (m.rate || 1) : Date.now();
}
function drain(emit) {
  while (!vad.isEmpty()) {
    const seg = vad.front(false); // Electron 里不允许外部缓冲区
    vad.pop();
    const start = Number(seg.start), n = seg.samples.length;
    const r = transcribe(padded(start, n, seg.samples));
    if (r.text.replace(/[\p{P}\p{S}\s]/gu, '').length) emit({ type: 'seg', startWall: wallOf(start), endWall: wallOf(start + n), text: r.text });
  }
  while (stamps.length > 2 && stamps[1].idx < fed - 16000 * 120) stamps.shift();
}
function streamAudio(samples, wall, emit, rate = 1) {
  if (!vad) return;
  stamps.push({ idx: fed, wall: wall - samples.length / 16 * rate, rate });
  fed += samples.length;
  remember(samples);
  const all = new Float32Array(rest.length + samples.length);
  all.set(rest); all.set(samples, rest.length);
  let i = 0;
  for (; i + WIN <= all.length; i += WIN) vad.acceptWaveform(all.subarray(i, i + WIN));
  rest = all.slice(i);
  drain(emit);
}
function streamCut(emit) {
  if (!vad) return;
  vad.flush();
  drain(emit);
}
function streamStop(emit) {
  if (!vad) return;
  vad.flush();
  drain(emit);
  vad = null;
}

if (process.parentPort) {
  const post = m => process.parentPort.postMessage(m);
  process.parentPort.on('message', e => {
    const m = e.data;
    try {
      switch (m.type) {
        case 'warm': load(); post({ id: m.id, ok: true }); break;
        case 'stream-start': streamStart(); post({ id: m.id, ok: true }); break;
        case 'stream-audio': streamAudio(m.samples, m.wall, post, +m.rate || 1); break;
        case 'stream-cut': streamCut(post); break;
        case 'stream-stop': streamStop(post); post({ type: 'stream-done' }); post({ id: m.id, ok: true }); break;
        default: { // 'run'（老版本的主程序不带 type）
          const t0 = Date.now(), r = transcribe(m.samples);
          post({ id: m.id, ok: true, ...r, ms: Date.now() - t0 });
        }
      }
    } catch (err) {
      post({ id: m.id, ok: false, detail: String(err && err.message || err) });
      if (m.type === 'stream-audio') post({ type: 'stream-error', detail: String(err && err.message || err) });
    }
  });
} else if (require.main === module) {
  const t0 = Date.now();
  load();
  const t1 = Date.now();
  const wave = sherpa.readWave(process.argv[2], false);
  if (process.argv.includes('--stream')) {
    // 模拟听课：这段声音 + 1.5 秒安静 + 再来一遍，每 0.5 秒喂一包
    const gap = new Float32Array(24000), all = new Float32Array(wave.samples.length * 2 + gap.length);
    all.set(wave.samples); all.set(wave.samples, wave.samples.length + gap.length);
    streamStart();
    const out = [], base = 1e12;
    for (let i = 0; i < all.length; i += 8000) {
      const chunk = all.slice(i, i + 8000);
      streamAudio(chunk, base + (i + chunk.length) / 16, s => out.push(s));
    }
    streamStop(s => out.push(s));
    for (const s of out) console.log(JSON.stringify({ from: +((s.startWall - base) / 1000).toFixed(2), to: +((s.endWall - base) / 1000).toFixed(2), text: s.text }));
    console.log(JSON.stringify({ audioSec: +(all.length / 16000).toFixed(1), totalMs: Date.now() - t1 }));
  } else {
    const r = transcribe(wave.samples);
    console.log(JSON.stringify({ loadMs: t1 - t0, decodeMs: Date.now() - t1, sec: +(wave.samples.length / wave.sampleRate).toFixed(1), rate: wave.sampleRate, ...r }));
  }
}
