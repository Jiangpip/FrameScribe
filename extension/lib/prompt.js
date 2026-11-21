// 整理笔记的提示词：所有引擎（Claude Code / Codex / 各家 API）共用同一套规则。插件和桌面软件共用这一份
(() => {
  const STRUCTURE = `整理版的结构：
1. 开头 frontmatter（YAML）：来源（视频链接；屏幕记录写窗口标题）、UP主（没有就不写）、原始记录: "[[{RAW}]]"、整理于: {TODAY}、tags: [视频笔记]
2. 一级标题用视频标题；下面一段引用（>）：这个视频讲了什么、主要结论是什么，3–5 句
3. 按内容主题分节（## 1. 主题名），不要按记录点机械罗列；节内用要点列表，关键概念加粗
4. 用户截的每张图都要用上，放在讲到它的位置：![](img/文件名.jpg)，图下一行用斜体写这张图在说明什么，并附时间链接 [mm:ss](链接)；记录点没有链接时只写时间
5. 用户自己写的笔记保留原话，放在相关小节的 callout 里：
   > [!note] 我的笔记
   > 原话（一字不改）
   这是用户认为重要的地方，要讲透
   标了“口述转写”（raw.json 里 noteSource 为 voice）的笔记是语音识别出来的：可以改正明显的识别错字和标点，意思不能改
6. 最后一节 ## 待查：字幕可能识别错的专有名词、讲者没讲清楚的地方

规则：
- 图里的公式写成 LaTeX（$...$ 或 $$...$$），代码写成代码块，表格转成 Markdown 表
- 只写视频里讲了的内容；补充的背景知识要标“（补充）”
- AI 字幕常把专有名词识别错，对照画面纠正，拿不准的放进“待查”
- 如果没有字幕，只依据截图和用户笔记整理，并在开头写明“本视频没有拿到字幕，内容只来自截图和笔记”
- 字幕标着“本机转写”（raw.json 里 subtitles.lan 为 asr）时，是软件听着视频的声音识别出来的：会有同音错字、断句不准、口头语多，按上下文改正后再用；人名、软件名、术语拿不准的放进“待查”
- 字幕里讲到的知识点都要整理进去，不能只写记录点附近的内容；宁可多分几节，不要为了简短丢掉具体的步骤、参数、数字和例子。闲聊、重复、等待加载之类的话不用写
- 一个记录点都没有时，完全按字幕整理（这时没有截图可用），每一节标题后面标上对应的时间段
- 屏幕记录（raw.json 里 video.kind 为 screen）的截图是从屏幕上截的，可能带播放器界面、弹幕或网页的其他部分，只看视频内容本身；时间是电脑时钟
- 不写煽情的收尾，结尾只写事实或判断
- 全文用中文`;

  // 随笔：看电影、做审美积累时随手截的图和想法。不是学习笔记，要短
  const JOT = `随笔整理版的结构：
1. 开头 frontmatter（YAML）：来源（视频链接；屏幕记录写窗口标题）、原始记录: "[[{RAW}]]"、整理于: {TODAY}、tags: [随笔]
2. 一级标题用视频标题；下面一行引用（>）：这次记了几张图、主要在看什么（一句话，不写剧情梗概）
3. 按时间顺序，每个记录点一小节，不合并、不重排：
   ### 01 · 时间（有链接写成 [mm:ss](链接)，屏幕记录只写时间）
   ![](img/文件名.jpg)
   用户写的话原样放进 callout：
   > [!note] 我的想法
   > 原话
   手打的一字不改；标了“口述转写”（raw.json 里 noteSource 为 voice）的只改明显的识别错字和标点
   然后最多 2 句：画面里看得见的东西（构图、光线、色彩、镜头、材质、动作、字体排版），让用户以后回看时知道这张图好在哪；用户已经说到的不要重复
   用户没写话的记录点，只写这 1–2 句观察
4. 几张图之间有明显的共同点（同一种用光、配色、构图手法）时，最后加一节 ## 共同点，2–4 条；没有就不写这一节

规则：
- 这是随手记的灵感和审美积累，不是学习笔记：不讲剧情、不补背景知识、不总结知识点、不加“待查”
- 只写图里看得见的和用户说过的；看不出来的（导演意图、拍摄参数、演员是谁）不要猜
- 短：每个记录点除了用户原话，自己写的不超过 2 句
- 屏幕记录（raw.json 里 video.kind 为 screen）的截图可能带播放器界面、弹幕或网页其他部分，只看画面本身
- 不写煽情的收尾，结尾只写事实或判断
- 全文用中文`;

  const fill = (s, raw, today) => s.replace('{RAW}', raw).replace('{TODAY}', today);

  // 给 Claude Code / Codex：它们自己读文件夹，最后把整篇 Markdown 作为回复输出（由程序写文件）
  function cli(raw, today, jot) {
    if (jot) return `你在帮用户把看视频时随手截的图和想法整理成一篇随笔（审美积累，不是学习笔记）。材料都在当前文件夹：
- raw.json：视频信息、记录点（时间、跳转链接、用户写的话、截图路径）。这次是随笔模式，没有字幕
- img/：用户挑定的截图，请逐张查看
- ${raw}.md：原始记录，只读

请读完所有材料后，输出整理好的随笔。
重要：不要修改或新建任何文件；把整理版的完整 Markdown 原文作为你最后的回复直接输出（不要用代码块包起来，不要加任何前言或说明），程序会把它保存为「${raw}-整理.md」。

${fill(JOT, raw, today)}`;
    return `你在帮用户把一份看视频时按键记下的记录整理成学习笔记。材料都在当前文件夹：
- raw.json：视频信息、记录点（时间、跳转链接、用户笔记、截图路径）、完整字幕 subtitles.body（from/to 为秒；可能为空）
- 字幕.md：完整字幕（没有字幕时没有这个文件）
- img/：用户挑定的截图，请逐张查看（里面常有 PPT、公式、代码，字幕里没有）
- ${raw}.md：原始记录，只读

请读完所有材料后，输出整理好的笔记。
重要：不要修改或新建任何文件；把整理版的完整 Markdown 原文作为你最后的回复直接输出（不要用代码块包起来，不要加任何前言或说明），程序会把它保存为「${raw}-整理.md」。

${fill(STRUCTURE, raw, today)}`;
  }

  // 给 API：材料直接放在消息里
  function system(raw, today, jot) {
    if (jot) return `你是随笔整理助手。用户看视频（电影、动画、作品集等）时随手截了几张图，有的写了几句想法，这是审美积累，不是学习笔记。请整理成一篇简短的 Markdown 随笔。
直接输出 Markdown 原文（不要用代码块包裹，不要前言）。

${fill(JOT, raw, today)}`;
    return `你是学习笔记整理助手。用户看视频时按键记下了若干时间点（带截图和随手笔记），有字幕时附上完整字幕。请据此写出一份完整、准确、好复习的 Markdown 学习笔记。
直接输出 Markdown 原文（不要用代码块包裹，不要前言）。

${fill(STRUCTURE, raw, today)}`;
  }

  const fmt = t => {
    t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
  };
  const clock = ms => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':'); };
  // 几句连成一段：中文之间加逗号（前一句自带标点就不加），英文等用空格（和 note.js 的 glue 一样）
  const CJK_END = /[⺀-鿿＀-￯]$/, CJK_START = /^[⺀-鿿＀-￯]/;
  const glue = parts => parts.reduce((a, b) => !a ? b : CJK_END.test(a) && CJK_START.test(b) ? a + (/[。！？，；、：]$/.test(a) ? '' : '，') + b : a + ' ' + b, '');

  function material(s, marks, body, imgs, link) {
    const L = [], screen = s.kind === 'screen';
    if (screen) L.push(`# 视频信息\n屏幕记录（没有视频链接，时间是电脑时钟）\n窗口标题：${s.title}${s.app ? '\n程序：' + s.app : ''}`);
    else if (s.kind === 'web' && s.site === 'youtube') L.push(`# 视频信息\n标题：${s.title}${s.part ? '（发布：' + s.part + '）' : ''}\n平台：YouTube${s.owner ? '\n频道：' + s.owner : ''}\n时长：${fmt(s.duration || 0)}\n链接：${s.url}`);
    else if (s.kind === 'web') L.push(`# 视频信息\n标题：${s.title}${s.part ? '（开播：' + s.part + '）' : ''}\n平台：直播回放\n时长：${fmt(s.duration || 0)}\n链接：${s.url}`);
    else L.push(`# 视频信息\n标题：${s.title}${s.part ? '（分P：' + s.part + '）' : ''}\nUP主：${s.owner}\n时长：${fmt(s.duration || 0)}\n链接：${s.url}`);
    L.push('\n# 记录点（用户按键的时刻）');
    marks.forEach((m, i) => {
      const when = screen ? clock(m.wall) : `[${fmt(m.t)}](${link(s, m.t)})`;
      const note = m.note ? (m.voice ? '　用户笔记（口述转写）：' : '　用户笔记：') + m.note : '';
      L.push(`${i + 1}. ${when} 截图：img/${imgs[i]}${note}`);
    });
    if (s.mode === 'jot') return L.join('\n') + '\n\n（随笔模式：没有字幕，只看截图和用户写的话）';
    L.push('\n# 完整字幕');
    if (body && body.length) for (const x of body) L.push(`[${fmt(x.from)}] ${x.text}`);
    else L.push('（没有字幕）');
    return L.join('\n');
  }

  // 去掉模型偶尔包上的 ```markdown 外壳
  function clean(md) {
    md = (md || '').trim();
    const m = md.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
    return (m ? m[1] : md).trim() + '\n';
  }

  // —— 大纲：只看转写的文字，出一份带时间的目录，用来在长视频里快速找到某段内容 ——
  // 转写按约 20 秒并成一行，行首是视频时间，省一半篇幅
  function transcriptLines(body, gap = 20) {
    const L = []; let start = null, buf = [];
    const flush = () => { if (buf.length) L.push(`[${fmt(start)}] ${glue(buf)}`); buf = []; start = null; };
    for (const x of body || []) {
      if (start == null) start = x.from;
      buf.push(x.text);
      if (x.to - start >= gap) flush();
    }
    flush();
    return L.join('\n');
  }
  // 文字从哪来：本机转写（lan 'asr'）还是视频网站的字幕
  function sourceLine(s) {
    const what = s.site === 'youtube' ? '一个 YouTube 视频' : '一节课（直播回放）';
    const x = s.subs || {};
    if (!x.lan || x.lan === 'asr') return `下面是${what}的语音转写，每行开头的 [时:分:秒] 是视频时间。转写是机器听出来的，有同音错字和口头语；`;
    return `下面是${what}的字幕（${x.lanDoc || x.lan}），每行开头的 [时:分:秒] 是视频时间。${/自动/.test(x.lanDoc || '') ? '自动字幕是机器听出来的，可能有识别错误、没有标点；' : ''}字幕可能是外语，目录照样用中文写；`;
  }
  function outlinePrompt(s, body) {
    return `${sourceLine(s)}内容可能是软件操作教程、课程讲座或别的视频，按实际内容写，不要猜测视频类型。

请给这个视频做一份带时间的目录，让用户在长视频里能快速找到某个知识点并跳过去。只输出一个 JSON 对象，不要代码块、不要任何说明文字，格式：
{"summary":"这节课讲了什么，3–5 句","chapters":[{"t":秒,"title":"章节标题","points":[{"t":秒,"text":"知识点"}]}]}

要求：
- t 是整数秒（视频开头算 0），取这段内容开始的那一行的时间；章节和知识点都按时间先后排
- 章节按讲课内容自然分段（换了一个主题、换了一个软件或一个新的操作环节就分），一般每 5–20 分钟一章；开场闲聊、等人、调设备、课间休息可以合成一章，标题写清楚是什么（如“开场与课前闲聊”），不要丢掉时间段
- 每章 2–8 个知识点，写具体：做了什么操作、用了哪个节点 / 参数 / 菜单、讲了什么原理或结论，便于搜索（例：“新建 HDA：File → New Asset，类型选 Object”），不要写“讲解了一些内容”这种空话
- 专有名词按上下文改正明显的识别错误，拿不准就保留原文并加“(?)”
- 学生提问、老师答疑也算知识点，前面加“问答：”
- 转写里没有声音的时间段（老师在默默操作）不用硬编内容
- 全文中文，软件里的英文名词保持英文

视频标题：${s.title}${s.part ? '（' + s.part + '）' : ''}
时长：${fmt(s.duration || 0)}

转写：
${transcriptLines(body)}`;
  }
  // 从模型的回复里取出 JSON；格式不对就抛错
  function parseOutline(text) {
    let t = String(text || '').trim();
    const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fence) t = fence[1];
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('模型没有返回 JSON：' + t.slice(0, 120));
    const j = JSON.parse(t.slice(a, b + 1));
    const num = v => Math.max(0, Math.round(+v || 0));
    const chapters = (Array.isArray(j.chapters) ? j.chapters : []).map(c => ({
      t: num(c.t), title: String(c.title || '').trim() || '（无标题）',
      points: (Array.isArray(c.points) ? c.points : []).map(p => ({ t: num(p.t), text: String(p.text || '').trim() })).filter(p => p.text).sort((x, y) => x.t - y.t)
    })).sort((x, y) => x.t - y.t);
    if (!chapters.length) throw new Error('模型返回的目录是空的');
    return { summary: String(j.summary || '').trim(), chapters };
  }
  // 大纲.md：章节和知识点的时间都能点；pic(章节, 序号) 返回这一章配的截图相对路径（没有就空）
  function outlineMd(s, o, link, today, pic) {
    const when = t => { const u = link(s, t); return u ? `[${fmt(t)}](${u})` : fmt(t); };
    const L = ['---', `来源: ${s.url || ''}`, `时长: "${fmt(s.duration || 0)}"`, `生成于: ${today}`, 'tags: [视频笔记, 大纲]', '---',
      `# 大纲 · ${s.title}${s.part ? ' · ' + s.part : ''}`, ''];
    if (o.summary) L.push('> ' + o.summary.replace(/\n+/g, ' '), '');
    const fromSubs = s.subs && s.subs.lan && s.subs.lan !== 'asr';
    L.push(`> 由${fromSubs ? '视频字幕（' + (s.subs.lanDoc || s.subs.lan) + '）' : '本机转写的文字'}自动生成；时间可点（${s.site === 'youtube' ? '直接跳到那一秒' : '装了 FrameScribe 插件，打开链接会自动跳到那一秒'}）；术语可能有识别错误。`, '');
    L.push('## 目录', '');
    o.chapters.forEach((c, i) => L.push(`${i + 1}. ${fmt(c.t)} ${c.title}`));
    L.push('');
    o.chapters.forEach((c, i) => {
      const next = o.chapters[i + 1];
      L.push(`## ${i + 1}. ${c.title}`, '', `${when(c.t)}${next ? ' – ' + fmt(next.t) : ''}`, '');
      const p = pic && pic(c, i);
      if (p) L.push(`![](${p})`, '');
      for (const x of c.points) L.push(`- ${when(x.t)} ${x.text}`);
      L.push('');
    });
    return L.join('\n');
  }

  globalThis.BN_prompt = { cli, system, material, clean, transcriptLines, outlinePrompt, parseOutline, outlineMd };
})();
