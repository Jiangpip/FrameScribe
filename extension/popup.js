// 插件图标的弹窗：找出当前网页里嵌入的 Vimeo / YouTube 视频，可以单个打开，或者当成一门课批量出大纲
// 用 activeTab：点图标的这一刻临时获得这个标签页的权限，不需要「所有网站」权限
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIDEO_PAGE = /^https:\/\/(www\.youtube\.com\/watch\?|(player\.)?vimeo\.com\/(video\/)?\d{5,}|www\.bilibili\.com\/|[^/]+\.polyv\.cn\/)/;
const urlOf = x => x.site === 'vimeo' ? 'https://vimeo.com/' + x.id : 'https://www.youtube.com/watch?v=' + x.id;
const keyOf = x => (x.site === 'vimeo' ? 'vm_' : 'yt_') + x.id;

$('#nb').onclick = () => chrome.runtime.sendMessage({ type: 'open-manager' }).then(() => window.close());

// 在网页里运行：按出现顺序找视频地址（iframe、data-* 属性、页面脚本里的列表都在 outerHTML 里），顺手取页面自己写的标题
function scanPage() {
  const html = document.documentElement.outerHTML, out = [], seen = new Set();
  const re = /(?:player\.vimeo\.com\/video\/|vimeo\.com\/(?:video\/)?)(\d{6,})|(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/g;
  let m;
  while ((m = re.exec(html))) {
    const site = m[1] ? 'vimeo' : 'youtube', id = m[1] || m[2], k = site + id;
    if (seen.has(k)) continue;
    seen.add(k);
    // 页面脚本里的视频列表常写成 {"title": "…", "url": "…"}：取往前 400 字以内、同一个对象里最近的 title
    const before = html.slice(Math.max(0, m.index - 400), m.index);
    const t = before.match(/"title"\s*:\s*"((?:[^"\\]|\\.){1,200})"[^{}]*$/);
    let title = '';
    if (t) { try { title = JSON.parse('"' + t[1] + '"'); } catch (e) {} }
    out.push({ site, id, title });
  }
  return { items: out, title: document.title, url: location.href };
}

async function oembedTitle(x) {
  const u = x.site === 'vimeo'
    ? 'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/' + x.id)
    : 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + x.id);
  try { const r = await fetch(u); if (!r.ok) return ''; const j = await r.json(); return j.title || ''; } catch (e) { return ''; }
}

function renderRunning(b) {
  const done = b.items.filter(x => x.st).length, cur = b.items.find(x => !x.st);
  return `<div class="run"><b>批量进行中</b>：${esc(b.group)} · ${done}/${b.items.length}${cur ? `<br><span class="dim">正在做：${esc(cur.title || cur.key)}</span>` : ''}
    <div class="row"><button id="lbGo">切到批量标签页</button><span class="sp"></span><button id="lbStop">停止批量</button></div></div>`;
}

(async () => {
  // ?tab=<编号>：调试用，扫描指定标签页（平常点图标时就是当前标签页）
  const forced = +new URLSearchParams(location.search).get('tab');
  const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const st = await chrome.runtime.sendMessage({ type: 'lb-status' }).catch(() => null);
  const running = st && st.batch && st.batch.running ? st.batch : null;
  let head = running ? renderRunning(running) : '';
  const bindRun = () => {
    if (!$('#lbStop')) return;
    $('#lbStop').onclick = async () => { await chrome.runtime.sendMessage({ type: 'lb-stop' }); window.close(); };
    $('#lbGo').onclick = async () => { await chrome.runtime.sendMessage({ type: 'lb-focus' }); window.close(); };
  };
  if (!tab || !/^https?:/.test(tab.url || '')) { $('#main').innerHTML = head + '<p class="dim">这个页面里用不了。打开有视频的网页再点。</p>'; return bindRun(); }
  if (VIDEO_PAGE.test(tab.url)) { $('#main').innerHTML = head + '<p>这一页就是视频页：用网页右下角的「📒 大纲」面板（B 站用快捷键截图）。</p>'; return bindRun(); }

  let res;
  try { [{ result: res }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanPage }); }
  catch (e) { $('#main').innerHTML = head + `<p class="dim">读不了这个页面：${esc(e.message || e)}</p>`; return bindRun(); }
  const items = (res && res.items) || [];
  if (!items.length) { $('#main').innerHTML = head + '<p class="dim">这一页里没找到 Vimeo / YouTube 视频。</p>'; return bindRun(); }

  const group = String(res.title || tab.title || '').trim().slice(0, 100);
  $('#main').innerHTML = head + `
    <div>这一页有 <b>${items.length}</b> 个视频：</div>
    <div class="list">${items.map((x, i) => `<div class="it"><input type="checkbox" data-i="${i}" checked><span class="n">${i + 1}</span>
      <span class="t"><span class="tt" data-i="${i}">${esc(x.title || '（读取标题…）')}</span><br><span class="s">${x.site === 'vimeo' ? 'Vimeo' : 'YouTube'}</span></span>
      <a href="#" data-open="${i}" title="在新标签页打开，右下角有大纲面板">打开 ↗</a></div>`).join('')}</div>
    <label class="blk">课程名（总目录用这个名字）</label><input type="text" id="group" value="${esc(group)}">
    <div class="row"><span class="dim" id="hint">要先开着 FrameScribe 软件</span><span class="sp"></span><button class="pri" id="go"${running ? ' disabled title="已经有一个批量在跑"' : ''}>批量出大纲</button></div>`;
  bindRun();
  // 页面里没写标题的：问 oEmbed
  items.forEach(async (x, i) => {
    if (!x.title) x.title = await oembedTitle(x) || (x.site === 'vimeo' ? 'Vimeo ' : 'YouTube ') + x.id;
    const el = document.querySelector(`.tt[data-i="${i}"]`); if (el) el.textContent = x.title;
  });
  document.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); chrome.tabs.create({ url: urlOf(items[+a.dataset.open]) }); });
  const pick = () => [...document.querySelectorAll('input[type=checkbox]')].filter(c => c.checked).map(c => items[+c.dataset.i]);
  const sync = () => { const n = pick().length; $('#go').textContent = `批量出大纲（${n} 个）`; $('#go').disabled = !!running || !n; };
  document.querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = sync);
  sync();
  const app = await chrome.runtime.sendMessage({ type: 'app-ok' }).catch(() => null);
  $('#hint').textContent = app && app.ok ? '软件已连接 · 每个视频有字幕约 1 分钟，没字幕要转写' : '⚠ 没连上 FrameScribe 软件：先打开软件';
  $('#go').onclick = async () => {
    const sel = pick();
    const name = $('#group').value.trim() || group || '网页视频';
    const r = await chrome.runtime.sendMessage({ type: 'lb-start', group: name, source: res.url, items: sel.map(x => ({ key: keyOf(x), url: urlOf(x), title: x.title, site: x.site })) });
    if (r && r.ok) window.close(); else $('#hint').textContent = (r && r.detail) || '开始不了';
  };
})();
