// B 站接口：视频信息 + 字幕（WBI 签名）。在 content script 里调用，带上用户的登录 cookie。
(() => {
  const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
    60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
  let keys = null;
  const opts = globalThis.BN_fetchOpts || { credentials: 'include' };

  async function getJSON(url) {
    const r = await fetch(url, opts);
    return r.json();
  }

  async function wbiKeys() {
    if (keys && Date.now() - keys.at < 3600e3) return keys;
    const j = await getJSON('https://api.bilibili.com/x/web-interface/nav'); // 未登录 code=-101，但 wbi_img 照样给
    const name = u => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
    keys = { img: name(j.data.wbi_img.img_url), sub: name(j.data.wbi_img.sub_url), at: Date.now(), login: !!j.data.isLogin };
    return keys;
  }

  async function signed(params) {
    const k = await wbiKeys();
    const orig = k.img + k.sub;
    const mixin = MIXIN.map(n => orig[n]).join('').slice(0, 32);
    const p = { ...params, wts: Math.round(Date.now() / 1000) };
    const q = Object.keys(p).sort()
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(p[key]).replace(/[!'()*]/g, ''))}`)
      .join('&');
    return q + '&w_rid=' + globalThis.BN_md5(q + mixin);
  }

  async function videoInfo(bvid) {
    const j = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (j.code !== 0) throw new Error(`view ${j.code} ${j.message}`);
    return j.data;
  }

  // 电影、番剧、纪录片页（/bangumi/play/ep123）：地址里只有“集号”，这里换成这一集的 BV 号、aid、cid
  async function epInfo(epId) {
    const j = await getJSON(`https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`);
    if (j.code !== 0) throw new Error(`season ${j.code} ${j.message}`);
    const r = j.result || {};
    const all = [...(r.episodes || []), ...(r.section || []).flatMap(s => s.episodes || [])]; // section：预告、花絮
    const e = all.find(x => String(x.id || x.ep_id) === String(epId));
    if (!e || !e.bvid) throw new Error('这一集没有 BV 号');
    return {
      id: +epId, bvid: e.bvid, aid: e.aid, cid: e.cid,
      title: r.title || r.season_title || '', part: (r.episodes || []).length > 1 || !(r.episodes || []).includes(e) ? (e.show_title || [e.title, e.long_title].filter(Boolean).join(' ')) : '',
      owner: (r.up_info && r.up_info.uname) || '', duration: Math.round((e.duration || 0) / 1000),
      url: `https://www.bilibili.com/bangumi/play/ep${epId}`
    };
  }

  const PREF = ['zh-CN', 'zh-Hans', 'ai-zh', 'zh-Hant', 'zh-TW', 'zh-HK'];

  async function subtitles(aid, cid) {
    let j = await getJSON('https://api.bilibili.com/x/player/wbi/v2?' + await signed({ aid, cid }));
    if (j.code !== 0) j = await getJSON(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`); // 签名失效时退回旧接口
    if (j.code !== 0) return { status: 'error', detail: `player ${j.code} ${j.message}` };
    const list = (j.data && j.data.subtitle && j.data.subtitle.subtitles) || [];
    if (!list.length) {
      const k = await wbiKeys();
      return { status: k.login ? 'none' : 'need_login', detail: k.login ? '该视频没有字幕（含 AI 字幕）' : '未登录 B 站，AI 字幕需要登录' };
    }
    const s = [...list].sort((a, b) => rank(a.lan) - rank(b.lan))[0];
    let url = s.subtitle_url;
    if (!url) return { status: 'none', detail: '字幕地址为空' };
    if (url.startsWith('//')) url = 'https:' + url;
    const body = (await (await fetch(url)).json()).body || [];
    return {
      status: 'ok', lan: s.lan, lanDoc: s.lan_doc,
      body: body.map(x => ({ from: +x.from.toFixed(2), to: +x.to.toFixed(2), text: x.content }))
    };
  }
  const rank = lan => { const i = PREF.indexOf(lan); return i < 0 ? 99 : i; };

  globalThis.BN_bili = { videoInfo, epInfo, subtitles, wbiKeys, signed };
})();
