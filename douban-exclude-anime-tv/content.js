/* 豆瓣「排除动画剧集」 内容脚本 v1.0.0
 *
 * 原理：
 *   1) 拉取自己的「看过」列表（mode=list，每页 30 条），这种模式下每个条目里
 *      都藏着一行 <span class="intro">，里面带完整类型信息（… / 20分钟 / 动画 / 奇幻 / …）。
 *   2) 类型里出现「动画」的【剧集】记进黑名单（动画电影按你的要求不排除）。
 *   3) 把动画剧集的数量从剧集中扣掉，在页面顶部给出排除后的统计（不隐藏下方条目）。
 *
 * 只读：全程不发任何写请求，绝不改动豆瓣上的标记、评分、标签。
 */
(() => {
  'use strict';
  if (window.__DBX_LOADED__) return;
  window.__DBX_LOADED__ = true;

  const PAGE_SIZE = 30;   // mode=list 每页 30 条
  const DELAY = 800;      // 每页之间间隔 0.8 秒，平衡速度与风控
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const PREF_KEY = 'dbexcl:pref';
  const dataKey = (uid) => 'dbexcl:data:' + uid;
  const DEFAULT_PREF = { scanTvOnly: false, uidOverride: '' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 存储 ---------------- */

  function getPref() {
    return new Promise((resolve) => {
      chrome.storage.local.get(PREF_KEY, (o) => {
        resolve(Object.assign({}, DEFAULT_PREF, (o && o[PREF_KEY]) || {}));
      });
    });
  }
  function setPref(p) {
    return new Promise((resolve) => chrome.storage.local.set({ [PREF_KEY]: p }, resolve));
  }
  function loadCache(uid) {
    return new Promise((resolve) => {
      chrome.storage.local.get(dataKey(uid), (o) => {
        const d = o && o[dataKey(uid)];
        resolve(d && Date.now() - d.ts < CACHE_TTL ? d : null);
      });
    });
  }
  function saveCache(uid, data) {
    data.ts = Date.now();
    data.uid = uid;
    return new Promise((resolve) => chrome.storage.local.set(
      { [dataKey(uid)]: data, 'dbexcl:lastUid': uid }, resolve));
  }
  function dropCache(uid) {
    return new Promise((resolve) => chrome.storage.local.remove(dataKey(uid), resolve));
  }

  /* ---------------- 豆瓣 ID ---------------- */

  function detectUid() {
    const m = location.href.match(/\/people\/(\d+)/);
    if (m) return m[1];
    // /mine?status=collect 这类页面：取全局导航里出现次数最多的个人主页 ID
    const counter = {};
    const links = document.querySelectorAll('a[href*="/people/"]');
    for (let i = 0; i < links.length; i++) {
      const mm = (links[i].getAttribute('href') || '').match(/\/people\/(\d+)/);
      if (mm) counter[mm[1]] = (counter[mm[1]] || 0) + 1;
    }
    const rank = Object.keys(counter).sort((a, b) => counter[b] - counter[a]);
    return rank.length ? rank[0] : null;
  }

  /* ---------------- 抓取与解析 ---------------- */

  function buildUrl(uid, type, start) {
    return 'https://movie.douban.com/people/' + uid +
      '/collect?sort=time&rating=all&filter=all&mode=list&type=' + type + '&start=' + start;
  }

  async function fetchPage(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP' + res.status);
    const html = await res.text();
    if (/异常请求|请输入验证码|安全验证|检测到有恶意/.test(html)) throw new Error('RISK');
    return html;
  }

  function parseTotal(doc) {
    const h1 = doc.querySelector('h1');
    if (h1) {
      const m = h1.textContent.match(/\(([\d,]+)\)/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    const sn = doc.querySelector('.subject-num');
    if (sn) {
      const m = sn.textContent.match(/\/\s*([\d,]+)/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    return null;
  }

  function isAnimeIntro(text) {
    return String(text || '').split('/').map((s) => s.trim()).indexOf('动画') >= 0;
  }

  function parseItems(doc) {
    const out = [];
    const push = (id, introText) => {
      out.push({ id: id, anime: isAnimeIntro(introText), known: !!introText });
    };
    const nodes = doc.querySelectorAll('li.item, div.item.comment-item');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const a = n.querySelector('a[href*="/subject/"]');
      if (!a) continue;
      const m = (a.getAttribute('href') || '').match(/\/subject\/(\d+)/);
      if (!m) continue;
      const intro = n.querySelector('.intro');
      push(m[1], intro ? intro.textContent : '');
    }
    // 兜底：万一模板变了，直接从 <div id="grid123456"> 里捞
    if (!out.length) {
      const grids = doc.querySelectorAll('div[id^="grid"]');
      for (let i = 0; i < grids.length; i++) {
        const m = (grids[i].getAttribute('id') || '').match(/^grid(\d+)$/);
        if (!m) continue;
        const intro = grids[i].querySelector('.intro');
        push(m[1], intro ? intro.textContent : '');
      }
    }
    return out;
  }

  /* 扫描某一类。deep=false 时只取首页（只要总数） */
  async function scanType(uid, type, deep, onProgress) {
    let html = await fetchPage(buildUrl(uid, type, 0));
    let doc = new DOMParser().parseFromString(html, 'text/html');
    const total = parseTotal(doc);
    if (total === null) throw new Error('LOGIN'); // 拿不到计数 = 多半被登录墙挡了

    if (!deep) {
      return { total: total, listed: null, anime: null, unknown: null, animeIds: [] };
    }

    const items = [];
    const limit = total || 3000;
    let start = 0, emptyPages = 0, guard = 0;
    while (start < limit && guard++ < 500) {
      if (start > 0) {
        await sleep(DELAY);
        html = await fetchPage(buildUrl(uid, type, start));
        doc = new DOMParser().parseFromString(html, 'text/html');
      }
      const page = parseItems(doc);
      if (!page.length) {
        if (++emptyPages >= 2) break;
      } else {
        emptyPages = 0;
        for (let i = 0; i < page.length; i++) items.push(page[i]);
      }
      onProgress({ type: type, done: items.length, total: total });
      start += PAGE_SIZE;
    }

    const animeIds = items.filter((i) => i.anime).map((i) => i.id);
    return {
      total: total,
      listed: items.length,
      anime: animeIds.length,
      unknown: items.filter((i) => !i.known).length,
      animeIds: animeIds
    };
  }

  async function scanAll(uid, deepMovie, onProgress) {
    const tv = await scanType(uid, 'tv', true, onProgress);
    const movie = await scanType(uid, 'movie', deepMovie, onProgress);
    return { ts: Date.now(), uid: uid, tv: tv, movie: movie };
  }

  function describeError(e) {
    const msg = String((e && e.message) || e);
    if (msg.indexOf('RISK') === 0) return '豆瓣风控了（出现验证码 / 异常请求提示）。请等一会儿再点「重新扫描」。';
    if (msg.indexOf('LOGIN') === 0) return '读不到数据，可能没登录或页面被登录墙挡了。请先在豆瓣登录后刷新本页。';
    if (msg.indexOf('HTTP') === 0) return '请求失败：' + msg + '。稍后再试。';
    return '出错了：' + msg;
  }

  /* ---------------- 面板 ---------------- */

  function mountPanel() {
    const panel = document.createElement('div');
    panel.className = 'dbx-panel';
    panel.innerHTML =
      '<div class="dbx-head">' +
        '<span class="dbx-title">动画剧集排除统计</span>' +
        '<span class="dbx-uid"></span>' +
        '<button class="dbx-btn" type="button">重新扫描</button>' +
      '</div>' +
      '<div class="dbx-body"></div>';
    const host = document.querySelector('#content') || document.querySelector('.article');
    if (host) host.insertBefore(panel, host.firstChild);
    else document.body.insertBefore(panel, document.body.firstChild);
    return {
      root: panel,
      uid: panel.querySelector('.dbx-uid'),
      btn: panel.querySelector('.dbx-btn'),
      body: panel.querySelector('.dbx-body')
    };
  }

  function num(n) { return n === null || n === undefined ? '—' : String(n); }

  function renderBody(ui, state) {
    const d = state.data;
    if (!d) {
      ui.body.innerHTML = '<div class="dbx-tip">' + (state.msg || '准备中…') + '</div>';
      return;
    }
    const tv = d.tv || {};
    const mv = d.movie || {};
    const tvListed = tv.listed === null || tv.listed === undefined ? tv.total : tv.listed;
    const tvLeft = (tvListed === null || tvListed === undefined || tv.anime === null) ? null : tvListed - tv.anime;
    const sum = (tvLeft === null || !mv.total) ? null : mv.total + tvLeft;

    let html = '<div class="dbx-stats">';
    html += '<div class="dbx-k">电影</div><div class="dbx-v"><b>' + num(mv.total) + '</b> 部' +
      (mv.anime === null || mv.anime === undefined
        ? ''
        : '（其中动画电影 ' + num(mv.anime) + '）') + '</div>';
    html += '<div class="dbx-k">剧集</div><div class="dbx-v">' + num(tvListed) + ' 部' +
      (tv.total && tv.listed && tv.total !== tv.listed
        ? ' <span class="dbx-k">（豆瓣计数 ' + tv.total + '）</span>' : '') + '</div>';
    html += '<div class="dbx-k">&nbsp;&nbsp;↳ 动画剧集</div><div class="dbx-v">' + num(tv.anime) + ' 部</div>';
    html += '<div class="dbx-k">&nbsp;&nbsp;↳ 排除后</div><div class="dbx-v">' + num(tvLeft) + ' 部</div>';
    html += '</div>';

    html += '<div class="dbx-sum">排除动画剧集后合计：<b>' + num(sum) + '</b> 部' +
      (sum === null ? '' : '（电影 ' + num(mv.total) + ' + 剧集 ' + num(tvLeft) + '）') + '</div>';

    if (tv.unknown) {
      html += '<div class="dbx-tip">有 ' + tv.unknown + ' 条目缺少简介信息，无法判断类型，默认不算动画。</div>';
    }
    if (tv.total && tv.listed && tv.total !== tv.listed) {
      html += '<div class="dbx-tip">豆瓣自己计数 ' + tv.total + '，实际能列出 ' + tv.listed + ' 条，' +
        '差额是已下架 / 合并的条目（豆瓣老毛病）。上面的数字按实际列出的算。</div>';
    }
    const mins = Math.max(1, Math.round((Date.now() - d.ts) / 60000));
    html += '<div class="dbx-tip">数据' + (mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前') +
      '更新 · 只读不改标记</div>';
    ui.body.innerHTML = html;
  }

  /* ---------------- 主流程 ---------------- */

  async function main() {
    const pref = await getPref();
    const uid = pref.uidOverride || detectUid();
    const ui = mountPanel();
    ui.uid.textContent = uid ? '（豆瓣 ID ' + uid + '）' : '';

    const state = { uid: uid, data: null, msg: '' };

    if (!uid) {
      renderBody(ui, { data: null, msg: '没能识别出豆瓣数字 ID，点右上角扩展图标，在弹窗里手动填一下。' });
      ui.btn.disabled = true;
      return;
    }

    const refresh = async (force) => {
      ui.btn.disabled = true;
      ui.btn.textContent = '扫描中…';
      try {
        if (force) await dropCache(uid);
        let data = force ? null : await loadCache(uid);
        if (!data) {
          renderBody(ui, { data: null, msg: '正在翻你的看过列表（每页间隔 0.8 秒，别关页面）…' });
          data = await scanAll(uid, !pref.scanTvOnly, (p) => {
            ui.btn.textContent = '扫描中…' + (p.type === 'tv' ? '剧集' : '电影') + ' ' + p.done + '/' + p.total;
          });
          await saveCache(uid, data);
        }
        state.data = data;
        renderBody(ui, state);
      } catch (e) {
        renderBody(ui, { data: null, msg: describeError(e) });
      }
      ui.btn.disabled = false;
      ui.btn.textContent = '重新扫描';
    };

    ui.btn.addEventListener('click', () => refresh(true));
    await refresh(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
