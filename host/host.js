// 本地桥接程序（Chrome Native Messaging）：插件 ⇄ 本机文件 / Claude Code / Codex
// 协议：stdin/stdout，每条消息 = 4 字节小端长度 + UTF-8 JSON。实际干活的函数在 core.js（桌面软件也用同一份）
const core = require('./core.js');
const VERSION = '0.7.0';
const path = require('path');

function send(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0);
  process.stdout.write(Buffer.concat([h, b]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
    buf = buf.subarray(4 + n);
    handle(msg).then(r => send({ id: msg.id, ...r }), e => {
      core.hostLog('error', msg.type, e.stack || e);
      send({ id: msg.id, ok: false, detail: String(e && e.message || e) });
    });
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(msg) {
  switch (msg.type) {
    case 'ping': {
      const e = core.engines();
      return { ok: true, version: VERSION, node: process.version, defaultRoot: path.join(process.env.USERPROFILE || '', 'Documents', 'FrameScribe'), engines: { claude: e.claude && e.claude.via, codex: e.codex && e.codex.via } };
    }
    case 'write':
      return core.writeFile(msg.path, msg.b64 != null ? Buffer.from(msg.b64, 'base64') : msg.text, msg.backup);
    case 'reveal':
      return core.reveal(msg.path);
    case 'organize':
      return core.organize(msg, line => send({ id: msg.id, type: 'progress', line }));
    case 'cancel':
      return core.cancel(msg.jobId);
  }
  return { ok: false, detail: '未知命令 ' + msg.type };
}
