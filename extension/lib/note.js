// 生成导出文件：原始笔记 md、字幕 md、raw.json（给 AI 整理用）。插件和桌面软件共用这一份
// 三种记录：B 站网页（kind 为空或 'bili'，时间是视频秒数）、网页回放（kind 'web'，目前是保利威直播回放，时间是视频秒数）
// 和屏幕记录（kind 'screen'，时间是电脑时钟）
(() => {
  const fmt = t => {
    t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  };
  const isScreen = s => s.kind === 'screen';
  const isWeb = s => s.kind === 'web';
  const SITE = { polyv: '保利威回放', youtube: 'YouTube' };
  const isYT = s => isWeb(s) && s.site === 'youtube';
  // 把几句字幕连成一段：中文和中文之间加逗号（前一句自带标点就不加），英文等用空格
  const CJK_END = /[⺀-鿿＀-￯]$/, CJK_START = /^[⺀-鿿＀-￯]/;
  const glue = parts => parts.reduce((a, b) => !a ? b : CJK_END.test(a) && CJK_START.test(b) ? a + (/[。！？，；、：]$/.test(a) ? '' : '，') + b : a + ' ' + b, '');
  const siteName = s => SITE[s.site] || s.site || '网页回放';
  const isJot = s => s.mode === 'jot'; // 随笔：只要截图和自己的话，不带字幕，整理成短的随笔
  const clock = ms => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':'); };
  const label = (s, m) => isScreen(s) ? clock(m.wall) : fmt(m.t);              // 界面和文件名里显示的时间
  const stamp = (s, m) => label(s, m).replace(/:/g, '');
  const safe = s => (s || '').replace(/[\\/:*?"<>|#^\[\]\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
  // 网页回放：在原地址后面加 bn_t=秒，装了插件时打开会自动跳到那里
  const webLink = (url, t) => {
    if (!url) return '';
    url = url.replace(/([?&])bn_t=\d+&?/, '$1').replace(/[?&]$/, '');
    return url + (url.includes('?') ? '&' : '?') + 'bn_t=' + Math.floor(t);
  };
  // YouTube：用它自己的 t=秒s，不装插件也能跳
  const ytLink = (url, t) => url ? url.replace(/([?&])t=\d+s?&?/, '$1').replace(/[?&]$/, '') + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(t) + 's' : '';
  const link = (s, t) => isScreen(s) ? ''
    : isYT(s) ? ytLink(s.url, t)
    : isWeb(s) ? webLink(s.url, t)
    : s.ep ? `https://www.bilibili.com/bangumi/play/ep${s.ep}?t=${Math.floor(t)}` // 电影 / 番剧 / 纪录片页
    : `https://www.bilibili.com/video/${s.bvid}/?${s.p > 1 ? 'p=' + s.p + '&' : ''}t=${Math.floor(t)}`;
  const mdTime = (s, m) => isScreen(s) ? `${clock(m.wall)}（开始记录后 ${fmt(m.t)}）` : `[${fmt(m.t)}](${link(s, m.t)})`;
  const folderName = s => isWeb(s) ? safe(s.title + (s.part ? ' ' + s.part : '')) : safe(s.title + (s.ep ? (s.part ? ' ' + s.part : '') : s.part ? ` P${s.p} ${s.part}` : (s.p > 1 ? ` P${s.p}` : '')) + (isScreen(s) && s.day ? ' ' + s.day : ''));
  const noteLabel = m => m.voice ? '我的笔记（口述转写）' : '我的笔记';

  // 某个时间点前后的字幕：从上一条记录（最多往前 60 秒）到这一刻后 8 秒
  function excerpt(body, t, prevT) {
    if (!body || !body.length) return null;
    const from = Math.max(prevT == null ? 0 : prevT, t - 60, 0), to = t + 8;
    const lines = body.filter(x => x.to > from && x.from < to);
    if (!lines.length) return null;
    return { from: lines[0].from, to: lines[lines.length - 1].to, text: glue(lines.map(x => x.text)) };
  }

  function imageNames(s, marks) {
    const used = new Set(), pre = isScreen(s) ? 'shot' : isYT(s) ? 'yt' : isWeb(s) ? 'pv' : `${s.bvid}_p${s.p}`;
    return marks.map(m => {
      let n = `${pre}_${stamp(s, m)}`, k = 2;
      while (used.has(n)) n = `${pre}_${stamp(s, m)}_${k++}`;
      used.add(n);
      return n + '.jpg';
    });
  }

  function subsLabel(s) {
    const x = s.subs;
    if (isJot(s)) return '不带（随笔）';
    if (isScreen(s) && !(x && x.status === 'ok')) return '无（屏幕记录，没开听课）';
    if (!x) return '未获取';
    if (x.status === 'ok') return `${x.lanDoc || x.lan}（${x.count} 句）`;
    return '无（' + (x.detail || x.status) + '）';
  }

  function rawNote(s, marks, body, imgs, today) {
    const L = [];
    L.push('---');
    if (isScreen(s)) {
      L.push('来源: "屏幕记录"');
      L.push(`窗口: ${JSON.stringify(s.title || '')}`);
      if (s.app) L.push(`程序: ${JSON.stringify(s.app)}`);
    } else if (isWeb(s)) {
      L.push(`来源: ${s.url}`);
      L.push(`平台: ${JSON.stringify(siteName(s))}`);
      if (isYT(s) && s.owner) L.push(`频道: ${JSON.stringify(s.owner)}`);
      if (s.part) L.push(`${isYT(s) ? '发布' : '开播'}: ${JSON.stringify(s.part)}`);
      L.push(`时长: "${fmt(s.duration || 0)}"`);
    } else {
      L.push(`来源: ${s.url}`);
      L.push(`BV: ${s.bvid}`);
      if (s.ep) { if (s.part) L.push(`分集: ${JSON.stringify(s.part)}`); }
      else if (s.p > 1 || s.part) L.push(`分P: ${s.p}${s.part ? ' ' + JSON.stringify(s.part) : ''}`);
      L.push(`UP主: ${JSON.stringify(s.owner || '')}`);
      L.push(`时长: "${fmt(s.duration || 0)}"`);
    }
    L.push(`记录于: ${today}`);
    if (isJot(s)) L.push('类型: 随笔');
    else L.push(`字幕: ${JSON.stringify(subsLabel(s))}`);
    L.push('状态: 原始记录');
    L.push('---');
    L.push(`# ${s.title}${s.part ? ' · ' + s.part : ''}`);
    L.push('');
    if (isJot(s)) L.push(`> 随笔 · ${marks.length} 张截图${isScreen(s) ? '' : ` · [打开视频](${s.url})`}`);
    else if (isWeb(s)) L.push(`> ${siteName(s)} · 时长 ${fmt(s.duration || 0)} · ${marks.length} 个记录点 · [打开视频](${s.url})${isYT(s) ? '' : '（时间链接要装插件才会自动跳转）'}`);
    else if (isScreen(s)) L.push(`> 屏幕记录${s.app ? '（' + s.app + '）' : ''} · ${marks.length} 个记录点 · 时间是电脑时钟，括号里是开始记录后过了多久`);
    else L.push(`> UP主 ${s.owner || '?'} · 时长 ${fmt(s.duration || 0)} · ${marks.length} 个记录点 · [打开视频](${s.url})`);
    L.push('> 这是看视频时按键记下的原始记录；AI 整理版另存为「…-整理.md」，不会覆盖这份。');
    if (body && body.length) L.push(`> 视频里说的话全文在 [字幕.md](字幕.md)（${subsLabel(s)}）。${marks.length ? '' : '这次没有手动记录点。'}`);
    L.push('');
    marks.forEach((m, i) => {
      const ex = excerpt(body, m.t, i ? marks[i - 1].t : null);
      L.push(`## ${String(i + 1).padStart(2, '0')} · ${mdTime(s, m)}`);
      L.push('');
      L.push(`![](img/${imgs[i]})`);
      L.push('');
      if (m.note) { L.push(`**${noteLabel(m)}**：${m.note}`); L.push(''); }
      if (ex) {
        L.push(`> [!quote]- 字幕 ${fmt(ex.from)}–${fmt(ex.to)}`);
        L.push(`> ${ex.text}`);
        L.push('');
      }
    });
    return L.join('\n');
  }

  // 完整字幕按约 30 秒一段，每段带可点的时间
  function transcript(s, body) {
    const L = [`# 字幕 · ${s.title}${s.part ? ' · ' + s.part : ''}`, '',
      isScreen(s) ? `> ${subsLabel(s)} · 时间是开始听课后过了多久` : `> ${subsLabel(s)} · [打开视频](${s.url})`, ''];
    let seg = [], start = null;
    const when = t => isScreen(s) ? `**${fmt(t)}**` : `[${fmt(t)}](${link(s, t)})`;
    const flush = () => { if (seg.length) L.push(`${when(start)} ${glue(seg)}`, ''); seg = []; start = null; };
    for (const x of body) {
      if (start == null) start = x.from;
      seg.push(x.text);
      if (x.to - start >= 30) flush();
    }
    flush();
    return L.join('\n');
  }

  function rawJson(s, marks, body, imgs) {
    const video = isScreen(s)
      ? { kind: 'screen', title: s.title, app: s.app || '', day: s.day || '' }
      : isWeb(s) ? { kind: 'web', site: s.site || '', siteName: siteName(s), title: s.title, part: s.part || '', duration: s.duration, url: s.url }
      : { kind: 'bili', bvid: s.bvid, p: s.p, ...(s.ep ? { ep: s.ep } : {}), title: s.title, part: s.part, owner: s.owner, duration: s.duration, url: s.url };
    return JSON.stringify({
      version: 2,
      mode: isJot(s) ? 'jot' : 'study',
      video,
      subtitles: isJot(s) ? { status: 'off', detail: '随笔模式不带字幕', body: [] } : { ...(s.subs || { status: 'none' }), body: body || [] },
      marks: marks.map((m, i) => ({
        index: i + 1, t: +m.t.toFixed(2), time: label(s, m), link: link(s, m.t),
        note: m.note || '', noteSource: m.note ? (m.voice ? 'voice' : 'typed') : '', image: 'img/' + imgs[i]
      }))
    }, null, 1);
  }

  globalThis.BN_note = { fmt, safe, link, webLink, ytLink, glue, isWeb, isYT, siteName, label, mdTime, isScreen, isJot, noteLabel, folderName, excerpt, imageNames, subsLabel, rawNote, transcript, rawJson };
})();
