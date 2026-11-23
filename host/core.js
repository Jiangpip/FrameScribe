// 桥接程序（host.js）和桌面软件（app\main.js）共用：找引擎、备份旧整理版、调 Claude Code / Codex
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const LOGDIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const hostLog = (...a) => { try { fs.appendFileSync(path.join(LOGDIR, 'host.log'), new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch (e) {} };

// 找本机的 Claude Code / Codex：先看常见安装位置，再翻 PATH（npm 全局装的 .cmd 外壳会解析出里面真正的 .js / .exe）
// js 入口用当前进程当 node 跑：在桌面软件里 process.execPath 是 electron.exe，要设 ELECTRON_RUN_AS_NODE
const asJs = (js, via) => ({ cmd: process.execPath, pre: [js], via, asNode: !!process.versions.electron });
function fromShim(file, via) {
  if (/\.exe$/i.test(file)) return { cmd: file, pre: [], via };
  try {
    // npm 的外壳里先出现的是 "%dp0%\node.exe"（判断旁边有没有 node），跳过它，要的是后面的入口文件
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/"%~?dp0%?\\([^"]+?\.(js|mjs|cjs|exe))"/gi)) {
      const target = path.join(path.dirname(file), m[1]);
      if (/^node\.exe$/i.test(m[1]) || !fs.existsSync(target)) continue;
      return /\.exe$/i.test(target) ? { cmd: target, pre: [], via } : asJs(target, via);
    }
    return null;
  } catch (e) { return null; }
}
function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of ['.exe', '.cmd']) {
      const f = path.join(dir.replace(/^"|"$/g, ''), name + ext);
      if (fs.existsSync(f)) { const e = fromShim(f, name); if (e) return e; }
    }
  }
  return null;
}
let engCache = null, engAt = 0;
function engines() {
  if (engCache && Date.now() - engAt < 30000) return engCache;
  const la = process.env.LOCALAPPDATA || '', ad = process.env.APPDATA || '', home = process.env.USERPROFILE || '';
  const reclaude = path.join(la, 'Programs', 'reclaude', 'bin', 'reclaude.exe'); // 可选的 Claude Code 启动器
  const claude = path.join(home, '.local', 'bin', 'claude.exe');                  // 官方安装脚本的位置
  const codexJs = path.join(ad, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  engCache = {
    claude: fs.existsSync(reclaude) ? { cmd: reclaude, pre: ['cli'], via: 'reclaude' }
      : fs.existsSync(claude) ? { cmd: claude, pre: [], via: 'claude' } : onPath('claude'),
    codex: fs.existsSync(codexJs) ? asJs(codexJs, 'codex') : onPath('codex')
  };
  engAt = Date.now();
  return engCache;
}

function mustAbs(p) {
  if (!p || !path.isAbsolute(p)) throw new Error('路径必须是绝对路径：' + p);
  return path.normalize(p);
}

// 已有的整理版先挪进 .backup（Obsidian 不显示点开头的文件夹）
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), '.backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const to = path.join(dir, path.basename(file, '.md') + '.' + stamp + '.md');
  fs.renameSync(file, to);
  return to;
}

function writeFile(p, data, withBackup) {
  const file = mustAbs(p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = withBackup ? backup(file) : null;
  fs.writeFileSync(file, data, typeof data === 'string' ? 'utf8' : undefined);
  return { ok: true, path: file, backup: old };
}

function reveal(p) {
  p = mustAbs(p);
  spawn('explorer.exe', [fs.existsSync(p) && fs.statSync(p).isFile() ? '/select,' + p : p], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}

const running = new Map();
function cancel(jobId) {
  const c = running.get(jobId);
  if (c) c.kill();
  return { ok: !!c };
}

// msg: { engine, jobId, dir, outFile, model, prompt, images }；onProgress(一行文字)
// msg.raw = true：只要模型最后的回复文字（resolve { ok, text }），不写文件（生成大纲用）
function organize(msg, onProgress) {
  return new Promise(resolve => {
    const dir = mustAbs(msg.dir), outFile = msg.raw ? '' : mustAbs(msg.outFile);
    const e = engines()[msg.engine];
    if (!e) return resolve({ ok: false, detail: `本机没找到 ${msg.engine === 'claude' ? 'Claude Code' : 'Codex'}` });

    // 同时跑两个（批量生成大纲）时文件名别撞：带上记录编号
    const tag = String(msg.jobId || 'job').replace(/[^\w-]/g, '').slice(0, 40);
    let args;
    if (msg.engine === 'claude') {
      args = [...e.pre, '-p', '--output-format', 'stream-json', '--verbose',
        '--allowedTools', 'Read,Glob,Grep', '--max-turns', '80'];
      if (msg.model) args.push('--model', msg.model);
    } else {
      args = [...e.pre, 'exec', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '--json',
        '-o', path.join(LOGDIR, `codex-last-${Date.now()}-${tag}.md`)];
      if (msg.model) args.push('-m', msg.model);
      if (msg.effort) args.push('-c', `model_reasoning_effort="${String(msg.effort).replace(/[^a-z]/g, '')}"`); // 生成大纲不用最高档思考，快、省额度
      for (const im of msg.images || []) args.push('-i', path.join(dir, im)); // -i 必须放最后（可变参数）
    }
    const lastFile = msg.engine === 'codex' ? args[args.indexOf('-o') + 1] : null;
    const logFile = path.join(LOGDIR, `${msg.engine}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}-${tag}.log`);
    const log = fs.createWriteStream(logFile);
    const t0 = Date.now();
    hostLog('organize', msg.engine, dir);

    const env = e.asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
    const child = spawn(e.cmd, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    running.set(msg.jobId, child);
    child.stdin.end(msg.prompt, 'utf8');

    let finalText = '', rest = '', lastProg = 0, codexErr = '';
    const progress = line => {
      if (Date.now() - lastProg < 800) return;
      lastProg = Date.now();
      if (onProgress) onProgress(line.slice(0, 160));
    };
    child.stdout.on('data', d => {
      log.write(d);
      rest += d.toString('utf8');
      const lines = rest.split('\n'); rest = lines.pop();
      for (const ln of lines) {
        let j; try { j = JSON.parse(ln); } catch (err) { continue; }
        if (msg.engine === 'claude') {
          if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
            for (const c of j.message.content) {
              if (c.type === 'tool_use') {
                const f = c.input && (c.input.file_path || c.input.pattern || c.input.path) || '';
                progress(`${c.name} ${path.basename(String(f))}`);
              }
            }
          } else if (j.type === 'result') {
            finalText = j.result || '';
            if (j.is_error || j.subtype !== 'success') finalText = '', progress('出错：' + (j.subtype || '') + ' ' + (j.result || ''));
          }
        } else {
          const it = j.item || {};
          // 真正的失败原因（模型不可用、额度用完等）；“忽略了某些设置”之类的提醒不算
          const em = j.type === 'turn.failed' ? j.error && j.error.message : j.type === 'error' ? j.message : '';
          if (em) codexErr = String(em).slice(0, 300);
          // 进度只显示看得懂的；item 类型 error 是 Codex 的提醒（配置项被忽略、技能太多被裁掉），不影响整理，不显示
          const what = it.command || { reasoning: '思考中', agent_message: '写出结果', file_change: '改文件', web_search: '搜索' }[it.type]
            || (j.type === 'turn.started' ? '开始整理' : '');
          if (what) progress(String(what));
        }
      }
    });
    child.stderr.on('data', d => log.write(d));
    const timer = setTimeout(() => child.kill(), 25 * 60 * 1000);
    child.on('error', err => { clearTimeout(timer); running.delete(msg.jobId); log.end(); resolve({ ok: false, detail: String(err.message || err), log: logFile }); });
    child.on('close', code => {
      clearTimeout(timer);
      running.delete(msg.jobId);
      log.end();
      if (lastFile && fs.existsSync(lastFile)) { finalText = fs.readFileSync(lastFile, 'utf8'); fs.unlinkSync(lastFile); }
      const sec = Math.round((Date.now() - t0) / 1000);
      if (msg.raw) {
        if (code !== 0 || !finalText.trim()) return resolve({ ok: false, detail: codexErr ? `Codex 报错：${codexErr}` : `${msg.engine} 退出码 ${code}，没有输出，详见日志`, log: logFile, seconds: sec });
        return resolve({ ok: true, text: finalText, seconds: sec, log: logFile });
      }
      finalText = cleanMd(finalText);
      if (code !== 0 || finalText.length < (msg.minChars || 200)) { // 随笔一两张图时整篇本来就短
        return resolve({ ok: false, detail: codexErr && !finalText ? `Codex 报错：${codexErr}` : `${msg.engine} 退出码 ${code}，输出 ${finalText.length} 字，详见日志`, log: logFile, seconds: sec });
      }
      const old = backup(outFile);
      fs.writeFileSync(outFile, finalText, 'utf8');
      resolve({ ok: true, outFile, chars: finalText.length, seconds: sec, log: logFile, backup: old });
    });
  });
}

function cleanMd(md) {
  md = (md || '').trim();
  const m = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  md = (m ? m[1] : md).trim();
  const fm = md.indexOf('---'); // 去掉 frontmatter 前偶尔多出来的一句话
  if (fm > 0 && fm < 200 && md.slice(0, fm).split('\n').length <= 3) md = md.slice(fm);
  return md ? md + '\n' : '';
}

module.exports = { LOGDIR, hostLog, engines, mustAbs, backup, writeFile, reveal, cancel, organize, cleanMd };
