// FrameScribe 桌面软件：全局快捷键 → 截图（装了插件的 B 站网页用插件的原画，其他情况截屏）→ 弹窗 → 存盘
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, desktopCapturer, nativeImage, shell, utilityProcess, net, powerMonitor } = require('electron');
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const { WebSocketServer } = require('ws');

const DEBUG = process.env.BN_DEBUG === '1';
const PORT = +(process.env.BN_PORT || 38917);
const VERSION = require('./package.json').version;
app.setName('FrameScribe');
if (process.env.BN_DATA) app.setPath('userData', process.env.BN_DATA);
else migrateOldData();
// 旧名字（BiliNotes）时代的数据目录：新目录还没有时整体改名过来；
// 改不动（旧版还开着、文件被占用）就先接着用旧目录，下次启动再迁
function migrateOldData() {
  const appData = app.getPath('appData'), oldDir = path.join(appData, 'BiliNotes'), newDir = path.join(appData, 'FrameScribe');
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  try { fs.renameSync(oldDir, newDir); } catch (e) { app.setPath('userData', oldDir); }
}
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const { Store } = require('./store.js');
const org = require('./organize.js');
const win32 = require('./win32.js');
const N = org.N;

const DATA = path.join(app.getPath('userData'), 'data');
fs.mkdirSync(DATA, { recursive: true });
const store = new Store(DATA);
const LOG = path.join(app.getPath('userData'), 'app.log');
const log = (...a) => { const line = new Date().toISOString() + ' ' + a.map(x => x && x.stack || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} if (DEBUG) console.log(line); };
process.on('uncaughtException', e => log('uncaught', e));
process.on('unhandledRejection', e => log('unhandled', e));

// —— 设置 ——
const DEFAULTS = {
  exportRoot: path.join(app.getPath('documents'), 'FrameScribe'), // 我的文档\FrameScribe；建议改到 Obsidian 库里
  engine: 'claude', // 第一次启动时按本机装了什么自动选（firstRunEngine）
  cliModel: { claude: '', codex: '' },
  api: { kind: 'openai', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', key: '', model: '', sendImages: true, maxImages: 24 },
  keys: { capture: 'Alt+S', note: 'Alt+A', voice: 'Alt+D', record: 'Alt+L' },
  voice: { autoStop: true, lang: 'auto' },
  crop: 'window', // window = 只截最前面的窗口；screen = 整个屏幕
  jotDefault: false, // 开着时，新建的记录是“随笔”：不带字幕，整理成短随笔（看电影、审美积累用）
  jotRoot: ''        // 随笔导出位置；空 = 导出位置下的「随笔」
};
const SETTINGS = path.join(DATA, 'settings.json');
const FIRST_RUN = !fs.existsSync(SETTINGS); // 没有设置文件 = 第一次用：笔记本里显示欢迎引导
function loadSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) {}
  if (FIRST_RUN && !s.engine) s.engine = firstRunEngine();
  return { ...DEFAULTS, ...s, cliModel: { ...DEFAULTS.cliModel, ...s.cliModel }, api: { ...DEFAULTS.api, ...s.api }, keys: { ...DEFAULTS.keys, ...s.keys }, voice: { ...DEFAULTS.voice, ...s.voice } };
}
// 本机有 Claude Code 就用它，其次 Codex；都没有先“只导出”，引导里提示去填 API
function firstRunEngine() {
  try { const e = org.core.engines(); return e.claude ? 'claude' : e.codex ? 'codex' : 'none'; } catch (e) { return 'claude'; }
}
let settings = loadSettings();
let welcome = FIRST_RUN;

// —— 窗口 ——
const PRELOAD = path.join(__dirname, 'preload.js');
const ui = f => path.join(__dirname, 'ui', f);
let nbWin = null, capWin = null, overlay = null, tray = null, quitting = false;

// dotRGB：中间那个点的颜色。平时橙色，听课时红色
function appIcon(S = 32, dotRGB = [255, 122, 47]) {
  const [dr, dg, db] = dotRGB;
  const buf = Buffer.alloc(S * S * 4), c = (S - 1) / 2, R = S * 0.5, rad = S * 0.22, dot = S * 0.24;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.max(Math.abs(x - c) - (R - rad), 0), dy = Math.max(Math.abs(y - c) - (R - rad), 0);
    const a = Math.max(0, Math.min(1, rad - Math.hypot(dx, dy) + 0.5));           // 圆角方块
    const k = Math.max(0, Math.min(1, dot - Math.hypot(x - c, y - c) + 0.5));     // 中间的橙点
    const i = (y * S + x) * 4;
    buf[i] = Math.round((29 * (1 - k) + db * k) * a); buf[i + 1] = Math.round((23 * (1 - k) + dg * k) * a);
    buf[i + 2] = Math.round((20 * (1 - k) + dr * k) * a); buf[i + 3] = Math.round(255 * a);
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

function openNotebook(sessionId) {
  if (nbWin) {
    if (nbWin.isMinimized()) nbWin.restore();
    nbWin.show(); nbWin.focus();
    if (sessionId) nbWin.webContents.send('nb:open', sessionId);
    return;
  }
  nbWin = new BrowserWindow({
    width: 1320, height: 860, minWidth: 760, minHeight: 480, backgroundColor: '#0d0f13', title: 'FrameScribe',
    icon: appIcon(64), autoHideMenuBar: true, webPreferences: { preload: PRELOAD }
  });
  nbWin.loadFile(ui('notebook.html'), sessionId ? { query: { s: sessionId } } : undefined);
  nbWin.on('close', e => { if (!quitting) { e.preventDefault(); nbWin.hide(); } });
  nbWin.on('closed', () => { nbWin = null; });
  // 外链（B 站、Obsidian）交给系统打开，窗口自己不跳转
  nbWin.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  nbWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openExternal(url); } });
}
function openExternal(url) {
  if (/^(https?|obsidian):/i.test(url)) shell.openExternal(url).catch(e => log('openExternal', e));
}
const toNb = (ch, ...a) => { if (nbWin && !nbWin.isDestroyed()) nbWin.webContents.send(ch, ...a); };
const changed = (sessionId, kind = 'data') => toNb('nb:changed', { sessionId, kind });

function createCapture() {
  capWin = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { preload: PRELOAD, backgroundThrottling: false } });
  capWin.loadFile(ui('capture.html'));
}
// force：把每块屏幕的画面都关掉重开（睡眠唤醒、解锁之后用，那时旧的那一路可能已经是黑的）
async function pushSources(force) {
  force = force === true; // 屏幕变化事件会带别的参数进来
  if (!capWin || capWin.isDestroyed()) return;
  try {
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const list = screen.getAllDisplays().map((d, i) => {
      const s = srcs.find(x => x.display_id === String(d.id)) || srcs[i];
      return s && { displayId: d.id, sourceId: s.id, width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    }).filter(Boolean);
    capWin.webContents.send('cap:sources', list, force);
  } catch (e) { log('pushSources', e); }
}

const OV_W = 476;
let ovCtx = null, voiceActive = false;
function createOverlay() {
  overlay = new BrowserWindow({
    width: OV_W, height: 180, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false, webPreferences: { preload: PRELOAD, backgroundThrottling: false }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (!process.env.BN_NO_PROTECT) overlay.setContentProtection(true); // 弹窗自己不要被截进后面的截图
  overlay.loadFile(ui('overlay.html'));
}
function placeOverlay(h) {
  if (!ovCtx) return;
  const wa = ovCtx.display.workArea;
  overlay.setBounds({ x: wa.x + wa.width - OV_W - 8, y: wa.y + 56, width: OV_W, height: Math.max(60, Math.min(Math.round(h), wa.height - 80)) });
  if (!overlay.isVisible() || ovCtx.fresh) {
    ovCtx.fresh = false;
    if (ovCtx.focus) { overlay.show(); overlay.focus(); } else overlay.showInactive();
  }
}
function showOverlay(data, display, fg) {
  ovCtx = { display, restore: fg && fg.hwnd, focus: data.mode === 'note', fresh: true };
  overlay.setFocusable(ovCtx.focus);
  overlay.webContents.send('ov:show', data);
}
function flash(text, ms = 3000, display) {
  ovCtx = { display: display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), restore: null, focus: false, fresh: true };
  overlay.setFocusable(false);
  overlay.webContents.send('ov:flash', text, ms);
}
function closeOverlay() {
  if (!overlay.isVisible()) return;
  const c = ovCtx;
  overlay.hide();
  if (c && c.focus && c.restore) win32.focus(c.restore); // 写完一句，把键盘还给刚才的播放器
}

// —— 截屏 ——
let seq = 0, lostLogAt = 0;
const capWaiters = new Map();
function grabScreen(displayId, crop) {
  return new Promise(resolve => {
    if (!capWin || capWin.isDestroyed()) return resolve({ ok: false, detail: '截屏窗口没起来' });
    const rid = ++seq;
    capWaiters.set(rid, resolve);
    capWin.webContents.send('cap:grab', { rid, displayId, crop });
    setTimeout(() => { if (capWaiters.delete(rid)) resolve({ ok: false, detail: '截屏超时' }); }, 4000);
  });
}

function cleanTitle(t) {
  if (!t) return '';
  t = t.replace(/[\u200b-\u200f\ufeff]/g, '');
  t = t.replace(/\s+[-—–]\s+(Google Chrome for Testing|Google Chrome|Chromium|Microsoft Edge|Mozilla Firefox|Firefox|Brave|Opera|PotPlayer|VLC media player|mpv|Windows Media Player|媒体播放器)\s*$/i, '');
  t = t.replace(/\s+-\s+(个人|工作|Personal|Work|Profile \d+|用户配置 \d+)\s*$/i, '');
  t = t.replace(/\s+和另外 \d+ 个页面$/, '').replace(/\s+and \d+ more pages?$/i, '');
  t = t.replace(/_哔哩哔哩_bilibili$/, '').replace(/\s+-\s+YouTube$/, '').replace(/^\(\d+\+?\)\s*/, '');
  t = t.replace(/^[^\p{L}\p{N}【《「\[(（"“]+/u, ''); // 开头会变的小图标（播放标记、转圈符号），不然同一个窗口会被当成两条
  return t.trim().slice(0, 120);
}
function screenSession(fg, wall) {
  const title = cleanTitle(fg && fg.title) || '屏幕记录';
  const day = new Date(wall).toLocaleDateString('sv-SE');
  const id = 'scr_' + crypto.createHash('sha1').update(title).digest('hex').slice(0, 10) + '_' + day.replace(/-/g, '');
  return { id, kind: 'screen', title, app: fg ? fg.exe : '', day };
}
// 最前面的窗口在哪块屏幕上、占屏幕的哪一块（比例）
function locate(fg) {
  let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), crop = null;
  if (fg && fg.rect && fg.rect.width > 80 && fg.rect.height > 80) {
    const dip = screen.screenToDipRect(null, fg.rect);
    display = screen.getDisplayMatching(dip);
    if (settings.crop === 'window') {
      const b = display.bounds;
      const x0 = Math.max(dip.x, b.x), y0 = Math.max(dip.y, b.y), x1 = Math.min(dip.x + dip.width, b.x + b.width), y1 = Math.min(dip.y + dip.height, b.y + b.height);
      if (x1 - x0 > 80 && y1 - y0 > 80) {
        crop = { x: (x0 - b.x) / b.width, y: (y0 - b.y) / b.height, w: (x1 - x0) / b.width, h: (y1 - y0) / b.height };
        if (crop.w > 0.985 && crop.h > 0.985) crop = null;
      }
    }
  }
  return { display, crop };
}

// —— 浏览器插件连接（插件主动连过来；只认我们自己的扩展 ID） ——
const EXT_IDS = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'host', 'EXTENSION_ID.txt'), 'utf8').split(/\s+/).filter(Boolean); } catch (e) { return []; } })();
const exts = new Set(), extWaiters = new Map();
let portOk = false;
function askExt(ws, msg, ms) {
  return new Promise(resolve => {
    const rid = ++seq;
    extWaiters.set(rid, r => resolve(r && { ...r, ws }));
    try { ws.send(JSON.stringify({ ...msg, rid })); } catch (e) { extWaiters.delete(rid); return resolve(null); }
    setTimeout(() => { if (extWaiters.delete(rid)) resolve(null); }, ms);
  });
}
async function captureViaExt() {
  if (!exts.size) return null;
  const rs = await Promise.all([...exts].map(ws => askExt(ws, { type: 'capture' }, 900)));
  const hit = rs.find(r => r && r.ok && r.session && Array.isArray(r.frames) && r.frames.length) || null;
  if (!hit && DEBUG) log('插件没交图：', rs.map(r => r ? r.reason || 'ok 但内容不全' : '超时').join(' / '));
  return hit;
}
function saveSubs(sessionId, r, force) {
  const rec = r && store.load(sessionId);
  if (!rec) return;
  const old = rec.session.subs;
  if (!force && old && old.status === 'ok' && r.status !== 'ok') return; // 自动取失败时，别把以前取到的字幕冲掉
  store.patchSession(sessionId, { subs: { status: r.status, lan: r.lan || '', lanDoc: r.lanDoc || '', detail: r.detail || '', count: r.body ? r.body.length : 0, at: Date.now() } });
  if (r.status === 'ok' && Array.isArray(r.body)) store.putSubs(sessionId, r.body);
  changed(sessionId);
}
function onExt(ws, m) {
  if (m.rid && extWaiters.has(m.rid)) { const w = extWaiters.get(m.rid); extWaiters.delete(m.rid); return w(m); }
  if (typeof m.type === 'string' && m.type.startsWith('lec-')) return onLec(ws, m).catch(e => { log('lec', m.type, e); if (m.q) sendWs(ws, { a: m.q, ok: false, detail: String(e.message || e) }); });
  switch (m.type) {
    case 'hello': ws.info = { browser: String(m.browser || '浏览器').slice(0, 40), version: String(m.version || '') }; toNb('nb:status'); break;
    case 'hotkey': hotkey(m.name === 'capture-note' ? 'note' : 'capture').catch(e => log('hotkey', e)); break;
    case 'subs': try { saveSubs(m.sessionId, m.subs); } catch (e) { log('subs', e); } break;
    case 'open-notebook': openNotebook(m.sessionId); break;
    case 'count': { let n = 0; try { const r = store.load(m.sessionId); n = r ? r.marks.length : 0; } catch (e) {} ws.send(JSON.stringify({ a: m.q, count: n })); break; }
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (DEBUG && req.url.startsWith('/debug/')) return debugRoute(req, res).catch(e => { res.statusCode = 500; res.end(String(e && e.stack || e)); });
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({
    server, maxPayload: 64 * 1024 * 1024,
    verifyClient: info => EXT_IDS.some(id => info.origin === 'chrome-extension://' + id)
  });
  wss.on('error', () => {}); // 端口被占时由下面 server 的 error 统一处理
  wss.on('connection', ws => {
    ws.info = { browser: '浏览器' };
    exts.add(ws);
    ws.on('message', d => { try { onExt(ws, JSON.parse(d.toString('utf8'))); } catch (e) { log('ext message', e); } });
    ws.on('close', () => { exts.delete(ws); toNb('nb:status'); if (lec && lec.ws === ws) lecStop('浏览器插件断开了'); });
    ws.on('error', () => {});
    toNb('nb:status');
  });
  // 心跳：浏览器扩展的后台 30 秒没动静就会休眠、连接跟着断；有消息来往就一直醒着
  setInterval(() => { for (const ws of exts) { try { ws.send('{"type":"ping"}'); } catch (e) {} } }, 20000);
  server.on('error', e => { portOk = false; log('server', e); toNb('nb:status'); });
  server.listen(PORT, '127.0.0.1', () => { portOk = true; });
}

// —— 语音转写（单独的进程，第一次用到才启动） ——
const MODEL = path.join(__dirname, 'models', 'sense-voice', 'model.int8.onnx');
const VAD_MODEL = path.join(__dirname, 'models', 'silero_vad.onnx');
let asrProc = null;
const asrWait = new Map();
function asrEnsure() {
  if (asrProc) return asrProc;
  asrProc = utilityProcess.fork(path.join(__dirname, 'asr-worker.js'), [], { env: { ...process.env, BN_ASR_LANG: settings.voice.lang || 'auto' }, stdio: 'ignore' });
  asrProc.on('message', m => {
    if (m.type === 'seg') return lec ? lecSeg(m) : onSeg(m);
    if (m.type === 'stream-done') { const x = lec || rec; return x && x.onDone && x.onDone(); }
    if (m.type === 'stream-error') return log('转写出错', m.detail);
    const w = asrWait.get(m.id); if (w) { asrWait.delete(m.id); w(m); }
  });
  asrProc.on('exit', () => {
    asrProc = null;
    for (const w of asrWait.values()) w({ ok: false, detail: '转写进程退出了' });
    asrWait.clear();
    if (rec) { log('听课中转写进程退出'); stopRec('转写进程意外退出，听课已结束'); }
    if (lec) { log('转写回放时转写进程退出'); lecStop('转写进程意外退出了，转写已停止'); }
  });
  return asrProc;
}
function asrCall(msg) {
  if (!fs.existsSync(MODEL)) return Promise.resolve({ ok: false, detail: '没找到语音模型：双击安装目录里的 setup.cmd 下载' });
  return new Promise(resolve => { const id = ++seq; asrWait.set(id, resolve); asrEnsure().postMessage({ id, ...msg }); });
}

// —— 听课：录电脑播放的声音，边录边转成文字，当作这条记录的字幕 ——
let rec = null; // { sid, startedAt, body, dirty, lastSave, lastAudio, level, stopping, onDone }
function saveRec(r) {
  if (!r || !r.dirty) return;
  r.dirty = false; r.lastSave = Date.now();
  store.putSubs(r.sid, r.body);
  store.patchSession(r.sid, { subs: { status: 'ok', lan: 'asr', lanDoc: '本机转写', detail: '', count: r.body.length, at: Date.now() }, updatedAt: Date.now() });
}
function onSeg(m) {
  const r = rec;
  if (!r) return;
  const from = Math.max(0, (m.startWall - r.startedAt) / 1000), to = Math.max(from, (m.endWall - r.startedAt) / 1000);
  r.body.push({ from: +from.toFixed(2), to: +to.toFixed(2), text: m.text });
  r.dirty = true;
  if (Date.now() - r.lastSave > 8000) saveRec(r);
  toNb('nb:seg', { sessionId: r.sid, count: r.body.length, line: r.body[r.body.length - 1] });
}
function setRecUi() {
  if (tray) { tray.setImage(appIcon(32, rec ? [239, 68, 68] : undefined)); tray.setToolTip(rec ? 'FrameScribe · 听课中' : 'FrameScribe'); tray.setContextMenu(trayMenu()); }
  toNb('nb:status');
}
async function startRec() {
  if (rec) return;
  if (!fs.existsSync(MODEL) || !fs.existsSync(VAD_MODEL)) return flash('语音模型缺失，不能听课：双击安装目录里的 setup.cmd 下载', 5000);
  let fg = win32.foreground();
  if (fg && fg.pid === process.pid) fg = lastFg;
  else if (fg && /^explorer\.exe$/i.test(fg.exe) && (!fg.title || fg.title === 'Program Manager')) fg = null;
  else lastFg = fg;
  const now = Date.now(), d = new Date(now), p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hm = p(d.getHours()) + p(d.getMinutes());
  const sid = `rec_${date.replace(/-/g, '')}_${hm}${p(d.getSeconds())}`;
  const title = cleanTitle(fg && fg.title) || `听课 ${date} ${hm.slice(0, 2)}:${hm.slice(2)}`;
  const st = await asrCall({ type: 'stream-start' });
  if (!st.ok) return flash('转写启动失败：' + st.detail, 5000);
  store.upsertSession({ id: sid, kind: 'screen', title, app: fg ? fg.exe : '', day: `${date} ${hm}`, startedAt: now, recording: true,
    subs: { status: 'ok', lan: 'asr', lanDoc: '本机转写', detail: '', count: 0, at: now } });
  store.putSubs(sid, []);
  rec = { sid, startedAt: now, body: [], dirty: false, lastSave: now, lastAudio: 0, level: 0, stopping: false, onDone: null };
  capWin.webContents.send('cap:audio', true);
  setRecUi();
  changed(sid);
  toNb('nb:open', sid);
  flash(`开始听课：${title}\n正在把电脑播放的声音转成文字 · 再按 ${settings.keys.record || '托盘菜单'} 结束`, 4000, fg ? locate(fg).display : undefined);
  log('rec start', sid);
}
async function stopRec(reason) {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  if (capWin && !capWin.isDestroyed()) capWin.webContents.send('cap:audio', false);
  if (asrProc) { // 把最后半句也转完
    await new Promise(resolve => { r.onDone = resolve; asrProc.postMessage({ id: ++seq, type: 'stream-stop' }); setTimeout(resolve, 15000); });
  }
  r.dirty = true;
  saveRec(r);
  if (DEBUG && r.dump) { // 调试：把收到的声音原样存下来，连同每包到达的时间
    const all = new Float32Array(r.dump.reduce((n, c) => n + c.s.length, 0));
    let o = 0; for (const c of r.dump) { all.set(c.s, o); o += c.s.length; }
    store.saveVoice(r.sid, 'debug-rec', all);
    fs.writeFileSync(path.join(store.dir(r.sid), 'debug-chunks.json'), JSON.stringify(r.dump.map(c => [c.at, c.wall, c.s.length])));
  }
  const sec = Math.round((Date.now() - r.startedAt) / 1000);
  store.patchSession(r.sid, { recording: false, duration: sec });
  rec = null;
  setRecUi();
  changed(r.sid);
  flash(reason || `听课结束 · ${N.fmt(sec)} · 转写了 ${r.body.length} 句\n在笔记本里点「导出并整理」生成笔记`, 5000);
  log('rec stop', r.sid, r.body.length);
}
const toggleRec = () => {
  if (rec) return stopRec();
  if (lec) return flash('插件正在转写网页回放，转写完或在网页上点「停止转写」后才能听课', 5000);
  return startRec();
};

// —— 转写网页回放（保利威）：插件从网页播放器里取声音（可以倍速、可以在后台），时间是视频进度 ——
// 和听课共用一个转写进程，同一时间只能跑一个
let lec = null; // { sid, ws, body, fresh:Set, dirty, lastSave, lastNb, stopping, onDone }
const sendWs = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch (e) {} };
function lecSave(l, force) {
  if (!l || (!l.dirty && !force)) return;
  l.dirty = false; l.lastSave = Date.now();
  store.putSubs(l.sid, l.body);
  store.patchSession(l.sid, { subs: { status: 'ok', lan: 'asr', lanDoc: '本机转写', detail: '', count: l.body.length, at: Date.now() }, updatedAt: Date.now() });
}
function lecSeg(m) {
  const l = lec;
  if (!l) return;
  const from = +(Math.max(0, m.startWall / 1000)).toFixed(2), to = +(Math.max(from, m.endWall / 1000)).toFixed(2);
  const line = { from, to, text: m.text };
  // 同一段以前转过（重转、拖回去）：去掉旧的那几句，换成这次的；这次转出来的句子之间不互相删
  l.body = l.body.filter(x => l.fresh.has(x) || x.to <= from + 0.3 || x.from >= to - 0.3);
  let i = l.body.length;
  while (i > 0 && l.body[i - 1].from > from) i--;
  l.body.splice(i, 0, line);
  l.fresh.add(line);
  l.dirty = true;
  if (Date.now() - l.lastSave > 8000) lecSave(l);
  if (Date.now() - l.lastNb > 15000) { l.lastNb = Date.now(); changed(l.sid); }
  sendWs(l.ws, { type: 'lec-seg', sid: l.sid, count: l.body.length, line });
}
// 已经转过的时间段（秒）：合并重叠的
function mergeRanges(rs) {
  const a = rs.filter(r => r[1] > r[0]).map(r => [+r[0], +r[1]]).sort((x, y) => x[0] - y[0]), out = [];
  for (const r of a) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 3) last[1] = Math.max(last[1], r[1]); else out.push(r); }
  return out.map(r => [+r[0].toFixed(1), +r[1].toFixed(1)]);
}
// 插件交来的网页视频信息 → 记录的 session（用户在笔记本里改过标题就不覆盖）
function webSession(meta) {
  const s = { id: String(meta.id || ''), kind: 'web', site: String(meta.site || ''), title: String(meta.title || '未命名').slice(0, 120), part: String(meta.part || '').slice(0, 60),
    url: String(meta.url || ''), duration: +meta.duration || 0, owner: String(meta.owner || meta.siteName || '').slice(0, 80) };
  const old = store.load(s.id);
  if (old && old.session.renamed) s.title = old.session.title;
  return s;
}
// 批量取播放列表：记下这个视频在哪个列表、第几个（一个视频可以在好几个列表里；导出文件夹按第一次加入的列表）
function groupPatch(sid, group, idx) {
  group = String(group || '').slice(0, 120);
  if (!group) return {};
  const old = store.load(sid), s0 = (old && old.session) || {};
  return { group: s0.group || group, groups: { ...(s0.groups || {}), [group]: +idx || 0 } };
}
async function lecStart(ws, meta) {
  if (rec) return { ok: false, detail: '软件正在听课（Alt+L），先结束听课再转写' };
  if (lec && lec.ws !== ws) return { ok: false, detail: '另一个网页正在转写，先停掉那边' };
  if (lec) await lecStop();
  if (!fs.existsSync(MODEL) || !fs.existsSync(VAD_MODEL)) return { ok: false, detail: '软件缺语音模型：双击安装目录里的 setup.cmd 下载' };
  const sid = String(meta.id || '');
  store.dir(sid);
  const st = await asrCall({ type: 'stream-start' });
  if (!st.ok) return { ok: false, detail: '转写启动失败：' + st.detail };
  const old = store.load(sid);
  const session = webSession(meta);
  if (!old || !(old.session.subs && old.session.subs.status === 'ok')) session.subs = { status: 'ok', lan: 'asr', lanDoc: '本机转写', detail: '', count: 0, at: Date.now() };
  session.transcribing = true;
  store.upsertSession(session);
  lec = { sid, ws, body: (old && store.subs(sid)) || [], fresh: new Set(), dirty: false, lastSave: Date.now(), lastNb: 0, stopping: false, onDone: null };
  changed(sid);
  log('lec start', sid);
  return { ok: true, sid };
}
async function lecStop(reason) {
  const l = lec;
  if (!l || l.stopping) return { ok: true };
  l.stopping = true;
  if (asrProc) await new Promise(resolve => { l.onDone = resolve; asrProc.postMessage({ id: ++seq, type: 'stream-stop' }); setTimeout(resolve, 15000); });
  lecSave(l, true);
  store.patchSession(l.sid, { transcribing: false });
  lec = null;
  changed(l.sid);
  if (reason) sendWs(l.ws, { type: 'lec-ended', sid: l.sid, reason });
  log('lec stop', l.sid, l.body.length, reason || '');
  return { ok: true, count: l.body.length };
}
function lecState(sid) {
  const r = store.load(sid);
  if (!r) return { ok: true, exists: false };
  const s = r.session;
  return { ok: true, exists: true, keys: store.keys(sid).length, session: { id: s.id, title: s.title, part: s.part, duration: s.duration, subs: s.subs || null, lec: s.lec || null, job: s.job || null, transcribing: !!(lec && lec.sid === sid), marks: r.marks.length },
    body: lec && lec.sid === sid ? lec.body : (store.subs(sid) || []), outline: store.outline(sid) };
}
async function onLec(ws, m) {
  const reply = o => sendWs(ws, { a: m.q, ...o });
  switch (m.type) {
    case 'lec-start': return reply(await lecStart(ws, m.session || {}));
    case 'lec-stop': return reply(lec && lec.ws === ws ? await lecStop() : { ok: true });
    case 'lec-audio': {
      if (!lec || lec.ws !== ws || lec.stopping || !asrProc) return;
      const b = Buffer.from(String(m.pcm || ''), 'base64'), n = b.length >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readInt16LE(i * 2) / 32768;
      asrProc.postMessage({ type: 'stream-audio', samples: f, wall: +m.vt || 0, rate: +m.rate || 1 });
      return;
    }
    case 'lec-subs': { // YouTube 字幕：整份文字一次交来，不用转写
      const sid = String((m.session && m.session.id) || '');
      if (!sid || !Array.isArray(m.body)) return reply({ ok: false, detail: '数据不对' });
      if (lec && lec.sid === sid) return reply({ ok: false, detail: '这个视频正在转写，先停掉转写' });
      const body = m.body.slice(0, 50000).map(x => ({ from: +x.from || 0, to: +x.to || 0, text: String(x.text || '').slice(0, 1000) })).filter(x => x.text);
      if (!body.length) return reply({ ok: false, detail: '字幕是空的' });
      const session = webSession(m.session);
      if (!session.duration) session.duration = Math.ceil(body[body.length - 1].to);
      session.subs = { status: 'ok', lan: String(m.lan || 'yt').slice(0, 20), lanDoc: String(m.lanDoc || '字幕').slice(0, 80), detail: '', count: body.length, at: Date.now() };
      session.lec = { covered: [[0, session.duration]], rate: 1, at: Date.now() };
      Object.assign(session, groupPatch(sid, m.session.group, m.session.groupIdx));
      store.upsertSession(session);
      store.putSubs(sid, body);
      changed(sid);
      log('lec subs', sid, body.length);
      return reply({ ok: true, count: body.length });
    }
    case 'lec-join': { // 批量：已经有文字的视频，只记下它属于哪个播放列表
      const sid = String(m.sid || '');
      if (!store.load(sid)) return reply({ ok: false, detail: '没有这条记录' });
      store.patchSession(sid, groupPatch(sid, m.group, m.idx));
      changed(sid);
      return reply({ ok: true });
    }
    case 'lec-keys-done': { // 截图截完了：大纲已经有了的话，重写大纲.md 把图配上
      const sid = String(m.sid || '');
      try { return reply({ ok: true, file: org.rewriteOutlineMd(store, settings, sid) }); }
      catch (e) { return reply({ ok: false, detail: String(e.message || e) }); }
    }
    case 'lec-index': { // 批量：写（或重写）播放列表的总目录
      try { return reply({ ok: true, file: org.writeGroupIndex(store, settings, String(m.group || '')), queued: org.outlineQueued() }); }
      catch (e) { return reply({ ok: false, detail: String(e.message || e) }); }
    }
    case 'lec-have': { // 批量：列表里哪些视频已经有文字 / 大纲
      const out = {};
      for (const id of (Array.isArray(m.ids) ? m.ids : []).slice(0, 1000)) {
        const r = store.load(String(id));
        if (r) out[id] = { subs: !!(r.session.subs && r.session.subs.status === 'ok' && r.session.subs.count), outline: !!store.outline(String(id)), keys: store.keys(String(id)).length, job: r.session.job && r.session.job.state || '' };
      }
      return reply({ ok: true, have: out, queued: org.outlineQueued() });
    }
    case 'lec-cut': if (lec && lec.ws === ws && asrProc) asrProc.postMessage({ type: 'stream-cut' }); return;
    case 'lec-progress': {
      const r = store.load(String(m.sid || ''));
      if (!r || !Array.isArray(m.ranges)) return;
      const old = (r.session.lec && r.session.lec.covered) || [];
      store.patchSession(r.session.id, { lec: { covered: mergeRanges([...old, ...m.ranges.slice(0, 50)]), rate: +m.rate || 1, at: Date.now() } });
      return;
    }
    case 'lec-frame': {
      try { if (store.load(String(m.sid || ''))) store.addKey(m.sid, +m.t || 0, Buffer.from(String(m.b64 || ''), 'base64')); } catch (e) { log('lec-frame', e); }
      return;
    }
    case 'lec-get': return reply(lecState(String(m.sid || '')));
    case 'lec-outline': {
      const sid = String(m.sid || '');
      if (lec && lec.sid === sid) lecSave(lec, true); // 还在转也能先用已有的部分生成
      org.queueOutline({ store, sid, settings, fetchFn: (u, o) => net.fetch(u, o), setJob: setJob(sid) })
        .then(r => sendWs(ws, { type: 'lec-outline-done', sid, ok: r.ok, detail: r.detail || '' }));
      return reply({ ok: true });
    }
    case 'lec-open': openNotebook(String(m.sid || '')); return reply({ ok: true });
  }
}
// 5 秒收不到声音数据就提醒一次（不是“没人说话”，是这一路根本没数据）
setInterval(() => {
  if (rec && !rec.stopping && Date.now() - Math.max(rec.lastAudio, rec.startedAt) > 6000 && !rec.warned) { rec.warned = true; flash('听课：没收到电脑的声音数据，可能录不到', 5000); }
}, 3000);
async function transcribeMark(sid, mid, samples) {
  const r = await asrCall({ type: 'run', samples });
  store.updateMark(sid, mid, m => {
    if (!m.voice) return;
    m.voice.state = r.ok ? 'done' : 'error';
    m.voice.detail = r.ok ? '' : r.detail;
    if (r.ok && r.text) {
      // 重新转写时替换上一次的转写，别重复追加
      const old = m.voice.text;
      m.note = old && m.note.includes(old) ? m.note.replace(old, r.text) : (m.note ? m.note + ' ' + r.text : r.text);
      m.voice.text = r.text;
    }
  });
  changed(sid);
  return r;
}

// —— 快捷键 ——
let keyState = {}, busy = false, lastFg = null;
function registerKeys() {
  globalShortcut.unregisterAll();
  keyState = {};
  for (const [name, acc] of Object.entries(settings.keys)) {
    if (!acc) { keyState[name] = '未设置'; continue; }
    const run = name === 'record' ? toggleRec : () => hotkey(name);
    try { keyState[name] = globalShortcut.register(acc, () => Promise.resolve(run()).catch(e => log('hotkey', name, e))) ? 'ok' : '被别的程序占用'; }
    catch (e) { keyState[name] = '写法不对'; }
  }
  if (tray) tray.setContextMenu(trayMenu());
}

async function hotkey(name) {
  if (name === 'voice' && voiceActive) { overlay.webContents.send('ov:voice-stop'); return; } // 再按一次 = 说完了
  if (busy) return;
  busy = true;
  try {
    const wall = Date.now();
    let fg = win32.foreground();
    if (fg && fg.pid === process.pid) fg = lastFg;        // 焦点在我们自己的弹窗上：按上一个窗口算
    else if (fg && /^explorer\.exe$/i.test(fg.exe) && (!fg.title || fg.title === 'Program Manager')) fg = null; // 桌面
    else lastFg = fg;
    const { display, crop } = locate(fg);
    const [ext, scr] = await Promise.all([captureViaExt(), grabScreen(display.id, crop)]);

    let session, t, frames, chosen;
    if (rec && !rec.stopping && (ext || (scr && scr.ok))) {
      // 听课中：记录点都进这节课，时间按“开始听课后多久”算，和转写的文字对得上
      session = { id: rec.sid };
      t = (wall - rec.startedAt) / 1000;
      frames = ext
        ? ext.frames.map(f => ({ t: t - Math.max(0, (+ext.t || 0) - (+f.t || 0)), main: !!f.main, buf: Buffer.from(String(f.dataUrl).split(',')[1] || '', 'base64') }))
        : scr.frames.map(f => ({ t: t - f.dt, main: !!f.main, buf: Buffer.from(f.buf) }));
      chosen = ext ? ext.chosen : scr.chosen;
    } else if (ext && ext.session.kind === 'web') { // 网页视频（保利威回放 / YouTube）：时间是视频进度
      const e = ext.session;
      session = webSession(e);
      t = +ext.t || 0;
      frames = ext.frames.map(f => ({ t: +f.t || 0, main: !!f.main, buf: Buffer.from(String(f.dataUrl).split(',')[1] || '', 'base64') }));
      chosen = ext.chosen;
    } else if (ext) {
      const e = ext.session;
      session = { id: String(e.id), kind: 'bili', bvid: String(e.bvid || ''), p: +e.p || 1, aid: +e.aid || 0, cid: +e.cid || 0, title: String(e.title || '未命名'),
        part: String(e.part || ''), owner: String(e.owner || ''), duration: +e.duration || 0, url: String(e.url || '') };
      if (+e.ep) session.ep = +e.ep; // 电影 / 番剧页的集号，时间点链接要用
      t = +ext.t || 0;
      frames = ext.frames.map(f => ({ t: +f.t || 0, main: !!f.main, buf: Buffer.from(String(f.dataUrl).split(',')[1] || '', 'base64') }));
      chosen = ext.chosen;
    } else if (scr && scr.ok) {
      const meta = screenSession(fg, wall), old = store.load(meta.id);
      const startedAt = old ? old.session.startedAt : wall;
      session = { ...meta, startedAt };
      t = (wall - startedAt) / 1000;
      frames = scr.frames.map(f => ({ t: t - f.dt, main: !!f.main, buf: Buffer.from(f.buf) }));
      chosen = scr.chosen;
    } else {
      return flash('没截到画面：' + ((scr && scr.detail) || '未知原因'), 4000, display);
    }
    store.dir(session.id); // 校验 id
    if (settings.jotDefault && !store.load(session.id)) session.mode = 'jot'; // 只决定新记录；已有的记录保持它自己的模式
    store.upsertSession(session);
    const m = store.addMark(session.id, { t, wall, chosen }, frames);
    const saved = store.load(session.id);
    showOverlay({
      mode: name, sid: session.id, markId: m.id, kind: ext ? 'bili' : 'screen', jot: N.isJot(saved.session), label: N.label(saved.session, m), no: saved.marks.length,
      frames: m.frames.map(f => ({ url: pathToFileURL(store.framePath(session.id, f)).href, dt: Math.max(0, t - f.t) })), chosen: m.chosen,
      autoStop: settings.voice.autoStop, voiceKey: settings.keys.voice
    }, display, fg);
    changed(session.id);
    if (ext) { try { ext.ws.send(JSON.stringify({ type: 'saved', sessionId: session.id, count: saved.marks.length })); } catch (e) {} }
    if (name === 'voice') asrCall({ type: 'warm' }); // 边说边把模型加载好
  } finally { busy = false; }
}

// —— 界面发来的请求 ——
function sessionForUi(id) {
  const rec = store.load(id);
  if (!rec) return null;
  const s = rec.session;
  return {
    session: s,
    marks: [...rec.marks].sort((a, b) => a.t - b.t).map(m => ({
      ...m, label: N.label(s, m), link: N.link(s, m.t),
      frames: m.frames.map(f => ({ ...f, url: pathToFileURL(store.framePath(id, f)).href })),
      voiceUrl: m.voice && m.voice.file ? pathToFileURL(path.join(store.dir(id), m.voice.file)).href : ''
    })),
    body: s.subs && s.subs.status === 'ok' ? store.subs(id) : null
  };
}
function status() {
  const e = org.core.engines();
  return {
    version: VERSION, engines: { claude: e.claude && e.claude.via, codex: e.codex && e.codex.via },
    exts: [...exts].map(ws => ws.info), port: PORT, portOk, keys: settings.keys, keyState,
    asrModel: fs.existsSync(MODEL), vadModel: fs.existsSync(VAD_MODEL), win32: win32.available, dataDir: DATA, welcome,
    rec: rec ? { sid: rec.sid, startedAt: rec.startedAt, count: rec.body.length, level: rec.level, stopping: rec.stopping } : null
  };
}
const setJob = sid => patch => {
  const rec = store.load(sid);
  if (!rec) return;
  rec.session.job = { ...(rec.session.job || {}), ...patch };
  store.save(sid);
  changed(sid, 'job');
};

async function handle(msg, sender) {
  switch (msg.type) {
    // 笔记本
    case 'status': return status();
    case 'sessions': return store.sessions();
    case 'session': return sessionForUi(msg.id);
    case 'mark-note': store.updateMark(msg.sid, msg.mid, m => { m.note = String(msg.note || ''); }); if (sender !== (nbWin && nbWin.webContents)) changed(msg.sid); return { ok: true };
    case 'mark-choose': store.updateMark(msg.sid, msg.mid, m => { if (msg.idx >= 0 && msg.idx < m.frames.length) m.chosen = msg.idx; }); if (sender !== (nbWin && nbWin.webContents)) changed(msg.sid); return { ok: true };
    case 'mark-del': store.delMark(msg.sid, msg.mid); return { ok: true };
    case 'session-del': store.delSession(msg.sid); return { ok: true };
    case 'settings-get': return settings;
    case 'welcome-done': welcome = false; fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 1), 'utf8'); return { ok: true };
    case 'settings-set': {
      const s = msg.settings || {}, langChanged = s.voice && s.voice.lang !== settings.voice.lang;
      settings = { ...settings, ...s, cliModel: { ...settings.cliModel, ...s.cliModel }, api: { ...settings.api, ...s.api }, keys: { ...settings.keys, ...s.keys }, voice: { ...settings.voice, ...s.voice } };
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 1), 'utf8');
      registerKeys();
      if (langChanged && asrProc) asrProc.kill();
      return { ok: true, keyState };
    }
    case 'rec-toggle': await toggleRec(); return { ok: true };
    case 'jot-default': setJotDefault(!!msg.on); return { ok: true };
    case 'session-mode': store.patchSession(msg.sid, { mode: msg.mode === 'jot' ? 'jot' : 'study' }); changed(msg.sid); return { ok: true };
    case 'session-rename': {
      const title = String(msg.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!title) return { ok: false, detail: '标题不能为空' };
      store.patchSession(msg.sid, { title, renamed: true });
      return { ok: true };
    }
    case 'export':
    case 'organize':
      if (rec && rec.sid === msg.sessionId) { rec.dirty = true; saveRec(rec); } // 听课还没结束也能先整理已有的部分
      return org.runJob({ store, sid: msg.sessionId, settings, organizeToo: msg.type === 'organize', fetchFn: (u, o) => net.fetch(u, o), setJob: setJob(msg.sessionId) });
    case 'outline':
      if (lec && lec.sid === msg.sessionId) lecSave(lec, true);
      return org.queueOutline({ store, sid: msg.sessionId, settings, fetchFn: (u, o) => net.fetch(u, o), setJob: setJob(msg.sessionId) });
    case 'cancel': return org.core.cancel(msg.sessionId);
    case 'reveal': return org.core.reveal(msg.path);
    case 'test-api': {
      const cfg = settings.api;
      if (!cfg.key || !cfg.model) return { ok: false, detail: '先填 API Key 和模型名' };
      try {
        const out = await org.chat((u, o) => net.fetch(u, o), cfg, '你是连接测试助手。', '只回复两个字：收到', [], 50);
        return { ok: true, detail: '连通，模型回复：' + String(out || '').trim().slice(0, 40) };
      } catch (e) { return { ok: false, detail: String(e.message || e) }; }
    }
    case 'refetch-subs': {
      const rec = store.load(msg.sessionId);
      if (!rec || rec.session.kind !== 'bili') return { ok: false, detail: '屏幕记录没有字幕可取' };
      if (!exts.size) return { ok: false, detail: '浏览器插件没连上：打开装了插件的浏览器，并开着任意一个 B 站视频页' };
      const rs = await Promise.all([...exts].map(ws => askExt(ws, { type: 'fetch-subs', bvid: rec.session.bvid, p: rec.session.p }, 20000)));
      const r = rs.find(x => x && x.subs);
      if (!r) return { ok: false, detail: '需要先在浏览器里打开任意一个 B 站视频页（字幕要用你的登录状态去取）' };
      saveSubs(msg.sessionId, r.subs, true);
      return { ok: true, status: r.subs.status, detail: r.subs.detail };
    }
    case 'voice-retry': {
      const m = store.mark(msg.sid, msg.mid);
      if (!m || !m.voice) return { ok: false, detail: '这条没有录音' };
      store.updateMark(msg.sid, msg.mid, x => { x.voice.state = 'transcribing'; });
      changed(msg.sid);
      return transcribeMark(msg.sid, msg.mid, store.readVoice(msg.sid, m.voice.file));
    }
    case 'open-url': openExternal(String(msg.url || '')); return { ok: true };

    // 弹窗
    case 'ov-size': placeOverlay(msg.h); return { ok: true };
    case 'ov-close': closeOverlay(); return { ok: true };
    case 'ov-voice-state': voiceActive = !!msg.active; return { ok: true };
    case 'ov-voice': {
      const samples = msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples);
      const rel = store.saveVoice(msg.sid, msg.mid, samples);
      store.updateMark(msg.sid, msg.mid, m => { m.voice = { file: rel, sec: +(samples.length / 16000).toFixed(1), state: 'transcribing', text: '' }; });
      changed(msg.sid);
      return transcribeMark(msg.sid, msg.mid, samples);
    }

    // 截屏窗口
    case 'cap-ready': pushSources(); return { ok: true };
    case 'cap-result': { const w = capWaiters.get(msg.rid); if (w) { capWaiters.delete(msg.rid); w(msg); } return { ok: true }; }
    case 'cap-log': log('capture', msg.text); return { ok: true };
    case 'cap-lost': // 某块屏幕的画面断了：重新列一遍屏幕让截屏窗口再打开。锁屏期间会一直重试，日志一分钟只记一条
      if (Date.now() - lostLogAt > 60000) { lostLogAt = Date.now(); log('capture', msg.text, '→ 重新打开'); }
      await pushSources();
      return { ok: true };
    case 'cap-audio':
      if (rec && !rec.stopping && asrProc) {
        rec.lastAudio = Date.now(); rec.level = +msg.level || 0;
        if (DEBUG) (rec.dump = rec.dump || []).push({ at: Date.now() - rec.startedAt, wall: msg.wall - rec.startedAt, s: Float32Array.from(msg.samples) });
        asrProc.postMessage({ type: 'stream-audio', samples: msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples), wall: msg.wall });
      }
      return { ok: true };
    case 'cap-audio-state':
      if (!rec || rec.stopping) return { ok: true };
      if (msg.ok) return { ok: true };
      log('听课声音', msg.detail);
      if (msg.ended && (rec.retries = (rec.retries || 0) + 1) <= 5) { setTimeout(() => rec && !rec.stopping && capWin.webContents.send('cap:audio', true), 1500); return { ok: true }; } // 换了播放设备：重新接上
      stopRec('录不到电脑的声音：' + (msg.detail || '未知原因') + '，听课已结束');
      return { ok: true };
  }
  return { ok: false, detail: '未知命令 ' + msg.type };
}
ipcMain.handle('bn', async (e, msg) => {
  try { return await handle(msg, e.sender); }
  catch (err) { log('handle', msg && msg.type, err); return { ok: false, detail: String(err && err.message || err) }; }
});

// —— 托盘 ——
function setJotDefault(on) {
  settings.jotDefault = on;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 1), 'utf8');
  if (tray) tray.setContextMenu(trayMenu());
  toNb('nb:cfg');
}
function trayMenu() {
  const k = settings.keys, st = n => keyState[n] === 'ok' ? '' : `（${keyState[n] || '未注册'}）`;
  return Menu.buildFromTemplate([
    { label: '打开笔记本', click: () => openNotebook() },
    { type: 'separator' },
    { label: `${k.capture}　截图${st('capture')}`, click: () => hotkey('capture') },
    { label: `${k.note}　截图 + 写一句${st('note')}`, click: () => hotkey('note') },
    { label: `${k.voice}　截图 + 说一句${st('voice')}`, click: () => hotkey('voice') },
    { type: 'separator' },
    { label: `${k.record}　${rec ? '■ 结束听课' : '● 开始听课（把视频里说的话转成文字）'}${st('record')}`, click: () => toggleRec() },
    { type: 'separator' },
    { label: '随笔模式（新记录不带字幕，整理成短随笔）', type: 'checkbox', checked: !!settings.jotDefault, click: it => setJotDefault(it.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
}

// —— 调试口（只有 BN_DEBUG=1 时开）：自动测试用 ——
async function debugRoute(req, res) {
  const u = new URL(req.url, 'http://x'), q = u.searchParams;
  const json = o => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o, null, 1)); };
  const win = { overlay, notebook: nbWin, capture: capWin }[q.get('win') || 'overlay'];
  switch (u.pathname) {
    case '/debug/hotkey': await hotkey(q.get('name') || 'capture'); return json({ ok: true });
    case '/debug/rec': await toggleRec(); return json({ ok: true, rec: status().rec });
    case '/debug/state': return json({ ...status(), ovVisible: overlay.isVisible(), ovBounds: overlay.getBounds(), voiceActive, sessions: store.sessions().map(s => ({ id: s.id, kind: s.kind, title: s.title, count: s.count })) });
    case '/debug/shot': { const img = await win.webContents.capturePage(); fs.writeFileSync(q.get('out'), img.toPNG()); return json({ ok: true, size: img.getSize() }); }
    case '/debug/eval': return json({ result: await win.webContents.executeJavaScript(q.get('js'), true) });
    case '/debug/open': openNotebook(q.get('s') || undefined); return json({ ok: true });
    case '/debug/voice': { // 把一个 16 kHz wav 当成刚录到的声音塞给弹窗
      const buf = fs.readFileSync(q.get('wav')), n = (buf.length - 44) >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(44 + i * 2) / 32768;
      overlay.webContents.send('ov:voice-inject', f);
      return json({ ok: true, sec: n / 16000 });
    }
    case '/debug/quit': json({ ok: true }); quitting = true; app.quit(); return;
  }
  res.statusCode = 404; res.end();
}

// —— 启动 ——
app.on('second-instance', () => openNotebook());
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  if (lec) { try { lecSave(lec, true); store.patchSession(lec.sid, { transcribing: false }); } catch (e) { log('quit save lec', e); } }
  if (rec) { try { rec.dirty = true; saveRec(rec); store.patchSession(rec.sid, { recording: false, duration: Math.round((Date.now() - rec.startedAt) / 1000) }); } catch (e) { log('quit save', e); } }
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.whenReady().then(() => {
  for (const s of store.sessions()) {
    if (s.recording || s.transcribing) store.patchSession(s.id, { recording: false, transcribing: false }); // 上次听课时软件被强行关掉
    // 上次退出时还在排队 / 生成的大纲：标成没完成，批量再跑一遍会补上
    if (s.job && s.job.state === 'running') store.patchSession(s.id, { job: { ...s.job, state: 'error', step: '', detail: '软件退出时还没做完，重新生成一下' } });
  }
  startServer();
  createCapture();
  createOverlay();
  tray = new Tray(appIcon(32));
  tray.setToolTip('FrameScribe');
  tray.on('click', () => openNotebook());
  registerKeys();
  screen.on('display-added', pushSources);
  screen.on('display-removed', pushSources);
  screen.on('display-metrics-changed', pushSources);
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => setTimeout(() => pushSources(true), 1500)); // 等显示器亮起来再开
  if (!process.argv.includes('--hidden')) openNotebook();
  log('started', VERSION, 'port', PORT, 'data', DATA);
});
