/* 弹窗：设置豆瓣 ID、扫描范围、查看/清理缓存 */
(() => {
  'use strict';
  const PREF_KEY = 'dbexcl:pref';
  const LAST_KEY = 'dbexcl:lastUid';
  const dataKey = (uid) => 'dbexcl:data:' + uid;
  const $ = (id) => document.getElementById(id);

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.round(m / 60);
    if (h < 48) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  function renderStatus(uid, data) {
    if (!uid) { $('status').textContent = '还没扫描过。先在豆瓣「看过」页打开一次，或上面填上 ID。'; return; }
    if (!data) { $('status').textContent = '豆瓣 ID ' + uid + '：暂无缓存，下次打开看过页会自动扫描。'; return; }
    const tv = data.tv || {}, mv = data.movie || {};
    const tvListed = (tv.listed === null || tv.listed === undefined) ? tv.total : tv.listed;
    const tvLeft = (tvListed === null || tv.anime === null) ? '—' : tvListed - tv.anime;
    const sum = (tvLeft === '—' || !mv.total) ? '—' : mv.total + tvLeft;
    $('status').textContent =
      '豆瓣 ID ' + uid + '（' + ago(data.ts) + '更新）\n' +
      '电影 ' + (mv.total === null || mv.total === undefined ? '—' : mv.total) +
        (mv.anime === null || mv.anime === undefined ? '' : '，动画电影 ' + mv.anime) + '\n' +
      '剧集 ' + tvListed + '，动画剧集 ' + tv.anime + '，排除后 ' + tvLeft + '\n' +
      '排除动画后合计 ' + sum;
  }

  function load() {
    chrome.storage.local.get([PREF_KEY, LAST_KEY], (o) => {
      const pref = (o && o[PREF_KEY]) || {};
      $('uid').value = pref.uidOverride || '';
      $('tvonly').checked = pref.scanTvOnly !== false;
      const uid = pref.uidOverride || (o && o[LAST_KEY]) || '';
      if (!uid) { renderStatus('', null); return; }
      chrome.storage.local.get(dataKey(uid), (o2) => {
        renderStatus(uid, o2 && o2[dataKey(uid)]);
      });
    });
  }

  $('save').addEventListener('click', () => {
    chrome.storage.local.get(PREF_KEY, (o) => {
      const pref = (o && o[PREF_KEY]) || {};
      pref.uidOverride = ($('uid').value || '').trim();
      pref.scanTvOnly = $('tvonly').checked;
      chrome.storage.local.set({ [PREF_KEY]: pref }, () => {
        $('status').textContent = '已保存。' + (pref.scanTvOnly ? '只扫描剧集。' : '剧集 + 电影都扫描。') +
          '\n改了 ID 或范围后，回看过页点一下「重新扫描」。';
      });
    });
  });

  $('clear').addEventListener('click', () => {
    chrome.storage.local.get([PREF_KEY, LAST_KEY], (o) => {
      const pref = (o && o[PREF_KEY]) || {};
      const uid = pref.uidOverride || (o && o[LAST_KEY]);
      if (!uid) { $('status').textContent = '没有可清除的缓存。'; return; }
      chrome.storage.local.remove(dataKey(uid), () => {
        $('status').textContent = '已清除 ' + uid + ' 的缓存，下次打开看过页会重新扫描。';
      });
    });
  });

  $('open').addEventListener('click', () => {
    chrome.storage.local.get([PREF_KEY, LAST_KEY], (o) => {
      const pref = (o && o[PREF_KEY]) || {};
      const uid = pref.uidOverride || (o && o[LAST_KEY]);
      const url = uid
        ? 'https://movie.douban.com/people/' + uid + '/collect?sort=time&rating=all&filter=all&mode=grid&type=all'
        : 'https://movie.douban.com/mine?status=collect';
      chrome.tabs.create({ url: url });
    });
  });

  load();
})();
