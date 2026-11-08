/* 中国电视直播 · 单文件版播放器
 *
 * 与多文件版功能一致，但不依赖 Video.js：直接使用原生 <video> + hls.js，
 * 全部代码内联在一个 HTML 里。换台复用同一个 Hls 实例（loadSource），速度最快。
 */
(function () {
  'use strict';

  var DATA = window.__CHANNELS__ || { channels: [], categories: [] };
  var CHANNELS = DATA.channels || [];
  var CATS = [{ id: 'all', label: '全部' }].concat(DATA.categories || []).concat([{ id: 'fav', label: '我的收藏' }]);

  var LOAD_TIMEOUT = 14000;
  var PROBE_TIMEOUT = 8000;
  var PROBE_CONCURRENCY = 6;
  var REPROBE_MS = 180000;
  var STORE = { fav: 'cntv1:fav', last: 'cntv1:last', vol: 'cntv1:vol' };

  var VIDEO = document.getElementById('video');
  var PLAYER = document.getElementById('player');

  var els = {
    list: document.getElementById('list'),
    chips: document.getElementById('chips'),
    count: document.getElementById('count'),
    search: document.getElementById('search'),
    now: document.getElementById('now'),
    overlay: document.getElementById('overlay'),
    osd: document.getElementById('osd'),
    osdNum: document.getElementById('osd-num'),
    osdName: document.getElementById('osd-name'),
    stats: document.getElementById('stats'),
    statsBody: document.getElementById('stats-body'),
    toast: document.getElementById('toast'),
    clock: document.getElementById('clock'),
    unmute: document.getElementById('unmute'),
    playBtn: document.getElementById('btn-play'),
    muteBtn: document.getElementById('btn-mute'),
    vol: document.getElementById('vol'),
    bufBar: document.getElementById('buf-bar'),
    recheck: document.getElementById('btn-recheck'),
  };

  var state = {
    category: 'all',
    query: '',
    current: null,
    sourceIndex: -1,
    tried: {},
    favorites: {},
    status: {},
    latency: {},
    frags: 0,
    timer: 0,
    failed: false,
    osdTimer: 0,
    digits: '',
    digTimer: 0,
    statsTimer: 0,
    statsOn: false,
    extended: false,
    drops: 0,
    log: [],
    errors: [],
  };

  function logEvent(evt, detail) {
    state.log.push({ at: new Date().toISOString().slice(11, 19), evt: evt, d: detail || '' });
    if (state.log.length > 80) state.log.shift();
  }

  var hls = null;
  var hideCtrlTimer = 0;

  /* ---------- 小工具 ---------- */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 隐私模式下不可写，忽略 */
    }
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 3200);
  }

  var ICON = {
    play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
    vol: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m17 9 4 6M21 9l-4 6"/>',
    prev: '<path d="M15 18l-6-6 6-6"/>',
    next: '<path d="M9 18l6-6-6-6"/>',
    star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
    theater: '<rect x="2.5" y="6" width="19" height="12" rx="2"/>',
  };

  function icon(name, filled) {
    return (
      '<svg viewBox="0 0 24 24" ' +
      (filled
        ? 'fill="currentColor" stroke="none"'
        : 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"') +
      '>' +
      ICON[name] +
      '</svg>'
    );
  }

  function channelById(id) {
    for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].id === id) return CHANNELS[i];
    return null;
  }

  function catLabel(id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label;
    return '';
  }

  function fmtBps(bps) {
    if (!bps) return '—';
    return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1e3) + ' kbps';
  }

  /* ---------- 信号检测 ---------- */

  function srcStatus(src) {
    return state.status[src.url] || 'checking';
  }

  function channelStatus(ch) {
    var hasChecking = false;
    for (var i = 0; i < ch.sources.length; i++) {
      var s = srcStatus(ch.sources[i]);
      if (s === 'ok') return 'ok';
      if (s === 'checking') hasChecking = true;
    }
    return hasChecking ? 'checking' : 'down';
  }

  function pickSource(ch) {
    var best = 0;
    var bestRank = 9;
    var bestLat = Infinity;
    for (var i = 0; i < ch.sources.length; i++) {
      var s = srcStatus(ch.sources[i]);
      var rank = s === 'ok' ? 0 : s === 'checking' ? 1 : 2;
      var lat = state.latency[ch.sources[i].url] || Infinity;
      if (rank < bestRank || (rank === bestRank && lat < bestLat)) {
        best = i;
        bestRank = rank;
        bestLat = lat;
      }
    }
    return best;
  }

  function probe(url, cb) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, PROBE_TIMEOUT);
    var start = performance.now();
    state.status[url] = 'checking';
    fetch(url, { cache: 'no-store', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (!res.ok) return null;
        return res.text();
      })
      .then(function (body) {
        var ok = !!body && body.indexOf('#EXTM3U') >= 0;
        state.status[url] = ok ? 'ok' : 'down';
        if (ok) state.latency[url] = Math.round(performance.now() - start);
        cb && cb();
      })
      .catch(function () {
        state.status[url] = 'down';
        cb && cb();
      })
      .then(function () {
        clearTimeout(timer);
      });
  }

  function probeAll(force) {
    var urls = [];
    var seen = {};
    CHANNELS.forEach(function (ch) {
      ch.sources.forEach(function (s) {
        if (!seen[s.url]) {
          seen[s.url] = 1;
          urls.push(s.url);
        }
      });
    });
    var i = 0;
    function worker() {
      if (i >= urls.length) return Promise.resolve();
      var url = urls[i++];
      if (!force && state.status[url] && state.status[url] !== 'checking') return worker();
      return new Promise(function (resolve) {
        probe(url, function () {
          scheduleRender();
          resolve();
        });
      }).then(worker);
    }
    var lanes = [];
    for (var n = 0; n < PROBE_CONCURRENCY; n++) lanes.push(worker());
    return Promise.all(lanes);
  }

  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderList();
      renderSources();
    });
  }

  /* ---------- 渲染 ---------- */

  function tile(ch, size) {
    return (
      '<span class="tile ' +
      (size || '') +
      '" data-len="' +
      Math.min(String(ch.logo.text).length, 4) +
      '" style="--from:' +
      ch.logo.from +
      ';--to:' +
      ch.logo.to +
      '">' +
      esc(ch.logo.text) +
      '</span>'
    );
  }

  function visible() {
    var q = state.query.trim().toLowerCase();
    return CHANNELS.filter(function (ch) {
      if (state.category === 'fav' && !state.favorites[ch.id]) return false;
      if (state.category !== 'all' && state.category !== 'fav' && ch.category !== state.category) return false;
      if (!q) return true;
      var hay = [ch.name, ch.network, catLabel(ch.category), ch.tags.join(' '), String(ch.number)].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function renderChips() {
    els.chips.innerHTML = CATS.map(function (c) {
      var n =
        c.id === 'all'
          ? CHANNELS.length
          : c.id === 'fav'
          ? Object.keys(state.favorites).length
          : CHANNELS.filter(function (ch) {
              return ch.category === c.id;
            }).length;
      if (c.id !== 'all' && c.id !== 'fav' && !n) return '';
      return (
        '<button class="chip" type="button" data-cat="' +
        c.id +
        '" aria-selected="' +
        (state.category === c.id) +
        '">' +
        (c.id === 'fav' ? icon('star', true) : '') +
        esc(c.label) +
        '<b>' +
        n +
        '</b></button>'
      );
    }).join('');
  }

  function renderList() {
    var items = visible();
    var playable = CHANNELS.filter(function (ch) {
      return channelStatus(ch) === 'ok';
    }).length;
    els.count.textContent = CHANNELS.length + ' 个 · ' + playable + ' 个可播放';

    if (!items.length) {
      els.list.innerHTML =
        '<li class="empty">' +
        (state.category === 'fav' && !state.query ? '还没有收藏的频道。点击频道右侧的星标即可收藏。' : '没有找到匹配的频道。') +
        '</li>';
      return;
    }

    var grouped = state.category === 'all' && !state.query.trim();
    var html = '';
    var lastCat = '';
    items.forEach(function (ch) {
      if (grouped && ch.category !== lastCat) {
        html += '<li class="group-title">' + esc(catLabel(ch.category)) + '</li>';
        lastCat = ch.category;
      }
      var st = channelStatus(ch);
      var fav = !!state.favorites[ch.id];
      html +=
        '<li class="ch" role="option" tabindex="0" data-id="' +
        ch.id +
        '" aria-selected="' +
        (state.current && state.current.id === ch.id) +
        '">' +
        tile(ch) +
        '<span class="ch-main"><span class="ch-name">' +
        esc(ch.name) +
        '</span><span class="ch-sub">' +
        esc(ch.network || catLabel(ch.category)) +
        ' · ' +
        ch.sources.length +
        ' 路源</span></span>' +
        '<span class="ch-side"><em class="ch-num">' +
        String(ch.number).padStart(2, '0') +
        '</em><i class="dot" data-status="' +
        st +
        '"></i>' +
        '<button class="fav" type="button" data-fav="' +
        ch.id +
        '" aria-pressed="' +
        fav +
        '" aria-label="收藏">' +
        icon('star', fav) +
        '</button></span></li>';
    });
    els.list.innerHTML = html;
  }

  function renderNow() {
    var ch = state.current;
    if (!ch) return;
    var fav = !!state.favorites[ch.id];
    els.now.innerHTML =
      '<div class="now-head">' +
      tile(ch, 'tile-lg') +
      '<div class="now-title"><div class="now-kicker"><span class="live-badge"><i></i>LIVE 直播</span><span>' +
      esc(ch.number) +
      ' 号频道 · ' +
      esc(catLabel(ch.category)) +
      '</span></div><h1>' +
      esc(ch.name) +
      '</h1><p class="now-sub">' +
      esc([ch.network, catLabel(ch.category), ch.sources.length + ' 路信号源'].filter(Boolean).join(' · ')) +
      '</p></div>' +
      '<div class="now-actions">' +
      '<button class="btn icon" type="button" data-action="prev" title="上一个频道（[）">' +
      icon('prev') +
      '</button>' +
      '<button class="btn icon" type="button" data-action="next" title="下一个频道（]）">' +
      icon('next') +
      '</button>' +
      '<button class="btn" type="button" data-action="fav" aria-pressed="' +
      fav +
      '">' +
      icon('star', fav) +
      '<span>' +
      (fav ? '已收藏' : '收藏') +
      '</span></button>' +
      '<button class="btn" type="button" data-action="theater">' +
      icon('theater') +
      '<span>剧场模式</span></button>' +
      '<button class="btn" type="button" data-action="share">分享</button>' +
      '</div></div>' +
      '<p class="now-intro">' +
      esc(ch.intro) +
      '</p>' +
      '<div class="now-tags">' +
      ch.tags
        .map(function (t) {
          return '<span class="tag">' + esc(t) + '</span>';
        })
        .join('') +
      '</div>' +
      '<div class="now-sources" id="src-box"></div>';
    renderSources();
  }

  function renderSources() {
    var box = document.getElementById('src-box');
    var ch = state.current;
    if (!box || !ch) return;
    box.innerHTML =
      '<span class="label">信号源</span><div class="seg" role="radiogroup">' +
      ch.sources
        .map(function (s, i) {
          var st = srcStatus(s);
          var lat = state.latency[s.url];
          return (
            '<button class="seg-btn" type="button" data-source="' +
            i +
            '" aria-checked="' +
            (i === state.sourceIndex) +
            '"><i class="dot" data-status="' +
            st +
            '"></i><span>源 ' +
            (i + 1) +
            ' · ' +
            esc(s.label) +
            '</span>' +
            (lat ? '<small>' + lat + 'ms</small>' : '') +
            '</button>'
          );
        })
        .join('') +
      '</div><p class="src-note">打开频道时自动选择最快的可用信号源，播放失败会自动切换到下一路。' +
      '按 [ 或 ] 换台，直接输入数字跳到对应频道。</p>';
  }

  /* ---------- 播放列表去抖 ----------
   *
   * 这些源站前面有多个不同步的节点：连续两次请求可能拿到相差二三十秒的直播窗口，
   * 有时还会退回到更早的窗口。hls.js 拿到「倒退」的列表会把时间轴整体重排，
   * 画面表现为每隔十几秒被拉回旧时间点（代理版靠 keep-alive 钉住同一节点避开了它）。
   *
   * 这里在浏览器里做同样的处理：比较新列表第一个分片的时间戳，
   * 倒退的直接复用上一次的文本，让 hls.js 看到的时间始终单调前进。
   */

  var plCache = {};

  function playlistStartTime(text) {
    var pdt = /#EXT-X-PROGRAM-DATE-TIME:\s*([^\r\n]+)/.exec(text);
    if (pdt) {
      var ms = Date.parse(pdt[1].trim());
      if (!isNaN(ms)) return ms;
    }
    var st = /[?&]starttime=(\d+)/.exec(text);
    if (st) return parseInt(st[1], 10) * 1000;
    return 0;
  }

  function stabilizePlaylist(url, text) {
    if (text.indexOf('#EXT-X-MEDIA-SEQUENCE:') < 0) return text;
    var seqM = /#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/.exec(text);
    var seq = seqM ? parseInt(seqM[1], 10) : 0;
    var start = playlistStartTime(text);
    var prev = plCache[url];

    if (prev) {
      if (seq < prev.seq) return prev.text;
      if (start && prev.start && start < prev.start) {
        prev.drops = (prev.drops || 0) + 1;
        if (prev.drops <= 3) {
          state.drops++;
          return prev.text;
        }
      }
      if (seq === prev.seq && start === prev.start) return prev.text;
    }

    plCache[url] = { seq: seq, start: start, text: text, drops: 0 };
    var keys = Object.keys(plCache);
    if (keys.length > 40) {
      for (var i = 0; i < keys.length - 40; i++) delete plCache[keys[i]];
    }
    return text;
  }

  function makePlaylistLoader() {
    var Base = window.Hls && window.Hls.DefaultConfig && window.Hls.DefaultConfig.loader;
    if (typeof Base !== 'function') return null;
    function StablePlaylistLoader(config) {
      Base.call(this, config);
    }
    StablePlaylistLoader.prototype = Object.create(Base.prototype);
    StablePlaylistLoader.prototype.constructor = StablePlaylistLoader;
    StablePlaylistLoader.prototype.load = function (context, config, callbacks) {
      var onSuccess = callbacks.onSuccess;
      callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
        try {
          if (response && typeof response.data === 'string') {
            // 1) 丢掉时间窗口倒退的列表；2) 把分片地址统一成 /__seg?u=...
            response.data = rewritePlaylist(stabilizePlaylist(ctx.url, response.data), ctx.url);
          }
        } catch (e) {
          /* 处理失败就用原始文本 */
        }
        return onSuccess.call(this, response, stats, ctx, networkDetails);
      };
      return Base.prototype.load.call(this, context, config, callbacks);
    };
    return StablePlaylistLoader;
  }

  /* ---------- 分片地址统一 ----------
   *
   * 源站每次刷新播放列表都会给同一分片换一套签名路径（路径里的长哈希会变）。
   * hls.js 比较新旧列表时只去掉 query 比较路径，于是判定「media sequence mismatch」，
   * 丢弃这次更新 —— 没有新分片，缓冲耗尽，十几秒后画面就停住。
   * 代理版之所以稳定，是因为经代理后所有分片路径都是 /api/stream，比较永远相同。
   *
   * 这里复刻同样的做法：播放列表里的分片改写成统一的 /__seg?u=<真实地址>，
   * 真正请求时由自定义分片加载器还原成真实地址。路径恒定 → 不再误判。
   */

  var SEG_MARK = '/__seg?u=';

  function wrapSeg(absUrl) {
    return SEG_MARK + encodeURIComponent(absUrl);
  }

  function unwrapSeg(url) {
    var i = url.indexOf(SEG_MARK);
    if (i < 0) return '';
    try {
      return decodeURIComponent(url.slice(i + SEG_MARK.length));
    } catch (e) {
      return '';
    }
  }

  function rewritePlaylist(text, baseUrl) {
    var lines = text.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();
      if (!t) {
        out.push(line);
        continue;
      }
      if (t.charAt(0) === '#') {
        if (t.indexOf('URI="') >= 0) {
          line = t.replace(/URI="([^"]+)"/g, function (m, u) {
            try {
              return 'URI="' + wrapSeg(new URL(u, baseUrl).href) + '"';
            } catch (e) {
              return m;
            }
          });
        }
        out.push(line);
        continue;
      }
      try {
        out.push(wrapSeg(new URL(t, baseUrl).href));
      } catch (e) {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  function makeFragmentLoader() {
    var Base = window.Hls && window.Hls.DefaultConfig && window.Hls.DefaultConfig.loader;
    if (typeof Base !== 'function') return null;
    function StableFragmentLoader(config) {
      Base.call(this, config);
    }
    StableFragmentLoader.prototype = Object.create(Base.prototype);
    StableFragmentLoader.prototype.constructor = StableFragmentLoader;
    StableFragmentLoader.prototype.load = function (context, config, callbacks) {
      var real = unwrapSeg(context.url || '');
      if (real) {
        var ctx = {};
        for (var k in context) {
          if (Object.prototype.hasOwnProperty.call(context, k)) ctx[k] = context[k];
        }
        ctx.url = real;
        context = ctx;
      }
      return Base.prototype.load.call(this, context, config, callbacks);
    };
    return StableFragmentLoader;
  }

  /* ---------- 播放 ---------- */

  function ensureHls() {
    if (hls) return hls;
    if (!window.Hls || !window.Hls.isSupported()) {
      showOverlay(
        '<div class="overlay-card"><h3>浏览器不支持</h3><p>当前浏览器不支持 HLS 播放，请用 Chrome、Edge 或 Safari 的较新版本打开。</p></div>',
      );
      return null;
    }
    var PlaylistLoader = makePlaylistLoader();
    var FragmentLoader = makeFragmentLoader();
    hls = new window.Hls({
      // 央视 CDN 每次刷新播放列表都会换一套签名路径，同一序号分片的 URL 因此变化，
      // hls.js 会判定 media sequence mismatch 并丢弃本次更新（非致命）。忽略它，
      // 否则直连播放十几秒后画面就会停住。
      ignorePlaylistParsingErrors: true,
      pLoader: PlaylistLoader || undefined,
      fLoader: FragmentLoader || undefined,
      enableWorker: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      maxBufferLength: 20,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      capLevelToPlayerSize: true,
      manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingTimeOut: 15000,
      fragLoadingMaxRetry: 5,
    });
    hls.attachMedia(VIDEO);
    hls.on(window.Hls.Events.ERROR, function (_e, data) {
      if (!data) return;
      state.errors.push({
        at: new Date().toISOString().slice(11, 19),
        type: data.type,
        details: data.details,
        code: data.response && data.response.code,
        fatal: !!data.fatal,
      });
      if (state.errors.length > 60) state.errors.shift();
      if (data.fatal) fail();
    });
    hls.on(window.Hls.Events.FRAG_LOADED, function () {
      state.frags++;
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      tryPlay();
    });
    return hls;
  }

  function playSource(index, force) {
    var ch = state.current;
    if (!ch) return;
    var src = ch.sources[index];
    state.sourceIndex = index;
    state.failed = false;
    state.extended = false;
    state.frags = 0;
    clearTimeout(state.timer);
    hideOverlay();
    renderSources();

    if (!src) {
      showOverlay(
        '<div class="overlay-card"><h3>这个频道暂时没有可用信号</h3><p>所有源都没返回有效信号，可能临时停播。可以稍后重试。</p>' +
          '<div class="overlay-actions"><button class="btn primary" type="button" data-action="retry">重新检测</button>' +
          '<button class="btn" type="button" data-action="next">下一个频道</button></div></div>',
      );
      return;
    }
    if (!force && state.status[src.url] === 'down') {
      fail();
      return;
    }
    var h = ensureHls();
    if (!h) return;

    VIDEO.title = ch.name;
    logEvent('play', '源' + (index + 1) + ' ' + src.label);
    try {
      h.stopLoad();
      h.loadSource(src.url);
      h.startLoad();
    } catch (e) {
      fail();
      return;
    }
    tryPlay();
    state.timer = setTimeout(onTimeout, LOAD_TIMEOUT);
  }

  function onTimeout() {
    // 已经加载过分片说明源是通的，播放中的短暂停顿交给停滞自纠处理，
    // 不要在这里判失败换源（直播缓冲本来就留了二十多秒）。
    if (state.frags > 0) return;
    fail();
  }

  function fail() {
    var ch = state.current;
    if (!ch || state.failed) return;
    var src = ch.sources[state.sourceIndex];
    if (!src) return;
    state.failed = true;
    clearTimeout(state.timer);
    state.status[src.url] = 'down';
    state.tried[state.sourceIndex] = 1;
    logEvent('fail', '源' + (state.sourceIndex + 1) + ' ' + src.label + ' frags=' + state.frags);
    scheduleRender();

    var next = -1;
    for (var i = 0; i < ch.sources.length; i++) {
      if (!state.tried[i] && srcStatus(ch.sources[i]) !== 'down') {
        next = i;
        break;
      }
    }
    if (next >= 0) {
      toast('源 ' + (state.sourceIndex + 1) + '（' + src.label + '）无法播放，已切换到下一路');
      playSource(next);
      return;
    }
    if (hls) hls.stopLoad();
    VIDEO.pause();
    showOverlay(
      '<div class="overlay-card"><h3>信号暂时无法播放</h3><p>' +
        esc(ch.name) +
        ' 的各路信号都没能播放，可能是源站临时故障或网络问题。可以重试或先看其他频道。</p>' +
        '<div class="overlay-actions"><button class="btn primary" type="button" data-action="retry">重新连接</button>' +
        '<button class="btn" type="button" data-action="next">下一个频道</button></div></div>',
    );
  }

  function tryPlay() {
    var p = VIDEO.play();
    if (!p || !p.catch) return;
    p.catch(function () {
      if (VIDEO.muted) return;
      VIDEO.muted = true;
      updateMute();
      VIDEO.play().catch(function () {
        /* 仍无法自动播放时保留播放按钮 */
      });
    });
  }

  function showOverlay(html) {
    els.overlay.innerHTML = html;
    els.overlay.hidden = false;
  }

  function hideOverlay() {
    els.overlay.hidden = true;
    els.overlay.innerHTML = '';
  }

  /* ---------- 换台 ---------- */

  function showOsd(ch, hold) {
    if (!ch) return;
    els.osdNum.textContent = String(ch.number).padStart(2, '0');
    els.osdName.textContent = ch.name;
    els.osd.hidden = false;
    clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(function () {
      els.osd.hidden = true;
    }, hold || 1500);
  }

  function zapDigit(d) {
    state.digits = (state.digits + d).slice(0, 3);
    var n = Number(state.digits);
    var target = null;
    for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].number === n) target = CHANNELS[i];
    els.osdNum.textContent = state.digits;
    els.osdName.textContent = target ? target.name : '……';
    els.osd.hidden = false;
    clearTimeout(state.digTimer);
    clearTimeout(state.osdTimer);
    state.digTimer = setTimeout(commitZap, 1100);
    if (state.digits.length >= 3 || n * 10 > CHANNELS.length) commitZap();
  }

  function commitZap() {
    clearTimeout(state.digTimer);
    var n = Number(state.digits);
    state.digits = '';
    if (!n) {
      els.osd.hidden = true;
      return;
    }
    var target = null;
    for (var i = 0; i < CHANNELS.length; i++) if (CHANNELS[i].number === n) target = CHANNELS[i];
    if (target) selectChannel(target.id);
    else {
      els.osdName.textContent = '没有这个频道号';
      state.osdTimer = setTimeout(function () {
        els.osd.hidden = true;
      }, 1200);
      toast('没有 ' + n + ' 号频道（共 ' + CHANNELS.length + ' 个）');
    }
  }

  function selectChannel(id) {
    var ch = channelById(id);
    if (!ch) return;
    if (state.current && state.current.id === ch.id && state.sourceIndex >= 0 && els.overlay.hidden) return;
    state.current = ch;
    state.tried = {};
    writeJSON(STORE.last, ch.id);
    if (location.hash !== '#/' + ch.id) history.replaceState(null, '', '#/' + ch.id);
    document.title = ch.name + ' | 中国电视直播';
    renderNow();
    renderList();
    scrollActive();
    playSource(ch.sources.length ? pickSource(ch) : -1);
  }

  function step(dir) {
    var list = visible();
    var inList = false;
    list.forEach(function (ch) {
      if (state.current && ch.id === state.current.id) inList = true;
    });
    if (!inList) list = CHANNELS;
    var i = -1;
    list.forEach(function (ch, idx) {
      if (state.current && ch.id === state.current.id) i = idx;
    });
    var target = list[(i + dir + list.length) % list.length];
    selectChannel(target.id);
    showOsd(target);
  }

  function scrollActive() {
    var box = els.list;
    var item = box.querySelector('.ch[aria-selected="true"]');
    if (!item) return;
    var top = item.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 6) box.scrollTop = top - 40;
    else if (top + item.offsetHeight > box.scrollTop + box.clientHeight - 6)
      box.scrollTop = top + item.offsetHeight - box.clientHeight + 10;
  }

  /* ---------- 收藏 / 剧场 / 分享 ---------- */

  function toggleFav(id) {
    var ch = channelById(id);
    if (!ch) return;
    var on = !state.favorites[id];
    if (on) state.favorites[id] = 1;
    else delete state.favorites[id];
    writeJSON(STORE.fav, state.favorites);
    renderChips();
    renderList();
    if (state.current && state.current.id === id) renderNow();
    toast(on ? '已收藏 ' + ch.name : '已取消收藏 ' + ch.name);
  }

  function toggleTheater() {
    var on = document.body.classList.toggle('theater');
    var layout = document.querySelector('.layout');
    var side = document.querySelector('.sidebar');
    if (on) {
      layout.style.gridTemplateColumns = 'minmax(0, 1fr)';
      side.style.display = 'none';
      toast('剧场模式，按 T 退出');
    } else {
      layout.style.gridTemplateColumns = '';
      side.style.display = '';
      toast('已退出剧场模式');
    }
  }

  function share() {
    var url = location.href;
    if (navigator.share) {
      navigator.share({ title: document.title, url: url }).catch(function () {});
      return;
    }
    copyText(url, '链接已复制');
  }

  function copyText(text, ok) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast(ok);
        },
        function () {
          toast('复制失败，请手动复制');
        },
      );
    } else toast('复制失败，请手动复制');
  }

  /* ---------- 统计 ---------- */

  function bufAhead() {
    try {
      var t = VIDEO.currentTime;
      for (var i = 0; i < VIDEO.buffered.length; i++) {
        if (VIDEO.buffered.start(i) <= t && t <= VIDEO.buffered.end(i)) return VIDEO.buffered.end(i) - t;
      }
    } catch (e) {
      /* 忽略 */
    }
    return 0;
  }

  function renderStats() {
    if (!state.statsOn) return;
    var ch = state.current;
    var src = ch && ch.sources[state.sourceIndex];
    var level = hls && hls.levels && hls.levels[hls.currentLevel];
    var lat = src ? state.latency[src.url] : 0;
    var rows = [
      ['频道', ch ? ch.number + ' · ' + ch.name : '—'],
      ['信号源', src ? '源 ' + (state.sourceIndex + 1) + ' · ' + src.label + (lat ? ' · ' + lat + 'ms' : '') : '—'],
      ['状态', !VIDEO.paused ? '播放中' : '已暂停'],
      ['分辨率', VIDEO.videoWidth ? VIDEO.videoWidth + ' × ' + VIDEO.videoHeight : '—'],
      ['当前画质', level && level.height ? level.height + 'p · ' + fmtBps(level.bitrate) : '自动'],
      ['带宽估计', hls && hls.bandwidthEstimate ? fmtBps(hls.bandwidthEstimate) : '—'],
      ['缓冲余量', bufAhead().toFixed(1) + ' 秒'],
      ['已加载分片', String(state.frags)],
      ['去抖丢弃', String(state.drops)],
      ['音量', VIDEO.muted ? '静音' : Math.round(VIDEO.volume * 100) + '%'],
    ];
    els.statsBody.innerHTML = rows
      .map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
      })
      .join('');
  }

  function setStats(on) {
    state.statsOn = on;
    els.stats.hidden = !on;
    clearInterval(state.statsTimer);
    if (on) {
      renderStats();
      state.statsTimer = setInterval(renderStats, 1000);
    }
  }

  /* ---------- 控件 ---------- */

  function updatePlayBtn() {
    els.playBtn.innerHTML = icon(VIDEO.paused ? 'play' : 'pause');
  }

  function updateMute() {
    els.muteBtn.innerHTML = icon(VIDEO.muted || VIDEO.volume === 0 ? 'mute' : 'vol');
    els.unmute.hidden = !(VIDEO.muted && !VIDEO.paused);
  }

  function bindPlayer() {
    els.playBtn.addEventListener('click', function () {
      if (VIDEO.paused) tryPlay();
      else VIDEO.pause();
    });
    els.muteBtn.addEventListener('click', function () {
      VIDEO.muted = !VIDEO.muted;
      if (!VIDEO.muted && VIDEO.volume === 0) VIDEO.volume = 0.8;
      updateMute();
    });
    els.vol.addEventListener('input', function () {
      VIDEO.volume = Number(els.vol.value);
      VIDEO.muted = VIDEO.volume === 0;
      writeJSON(STORE.vol, VIDEO.volume);
      updateMute();
    });
    els.unmute.addEventListener('click', function () {
      VIDEO.muted = false;
      if (VIDEO.volume < 0.2) VIDEO.volume = 0.8;
      els.vol.value = String(VIDEO.volume);
      writeJSON(STORE.vol, VIDEO.volume);
      updateMute();
    });
    document.getElementById('btn-full').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (PLAYER.requestFullscreen) PLAYER.requestFullscreen();
    });
    document.getElementById('btn-pip').addEventListener('click', function () {
      try {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else VIDEO.requestPictureInPicture();
      } catch (e) {
        toast('当前浏览器不支持画中画');
      }
    });
    document.getElementById('btn-stats').addEventListener('click', function () {
      setStats(!state.statsOn);
    });
    document.getElementById('stats-close').addEventListener('click', function () {
      setStats(false);
    });

    VIDEO.addEventListener('play', updatePlayBtn);
    VIDEO.addEventListener('pause', updatePlayBtn);
    VIDEO.addEventListener('volumechange', updateMute);
    VIDEO.addEventListener('playing', hideOverlay);
    VIDEO.addEventListener('canplay', function () {
      if (!els.overlay.hidden && !state.failed) hideOverlay();
    });

    var savedVol = readJSON(STORE.vol, 0.8);
    VIDEO.volume = typeof savedVol === 'number' ? Math.min(1, Math.max(0, savedVol)) : 0.8;
    els.vol.value = String(VIDEO.volume);
    updatePlayBtn();
    updateMute();

    // 鼠标静止 3 秒后淡出控件
    function wake() {
      PLAYER.classList.add('is-idle');
      clearTimeout(hideCtrlTimer);
      hideCtrlTimer = setTimeout(function () {
        PLAYER.classList.remove('is-idle');
      }, 3000);
    }
    PLAYER.addEventListener('mousemove', wake);
    PLAYER.addEventListener('mouseleave', function () {
      clearTimeout(hideCtrlTimer);
      PLAYER.classList.remove('is-idle');
    });

    // 缓冲进度条
    setInterval(function () {
      if (!VIDEO.buffered.length) return;
      els.bufBar.style.width = Math.min(100, (bufAhead() / 12) * 100) + '%';
    }, 700);

    // 直播停滞自纠：6 秒没有推进就重启加载；12 秒仍不动就清掉去抖缓存强制接受新列表
    var lastT = -1;
    var lastChange = Date.now();
    var stalls = 0;
    setInterval(function () {
      if (VIDEO.paused || state.failed) return;
      if (Math.abs(VIDEO.currentTime - lastT) > 0.08) {
        lastT = VIDEO.currentTime;
        lastChange = Date.now();
        stalls = 0;
        return;
      }
      if (Date.now() - lastChange < 6000) return;
      lastChange = Date.now();
      stalls++;
      logEvent('stall', '第' + stalls + '次 frags=' + state.frags);
      try {
        if (stalls >= 2) {
          plCache = {};
          var src = state.current && state.current.sources[state.sourceIndex];
          if (hls && src) {
            hls.stopLoad();
            hls.loadSource(src.url);
            hls.startLoad();
          }
        } else {
          if (hls) hls.startLoad();
        }
        // 只有严重落后（超过 60 秒）才跳回直播边缘；正常延迟本来就有 20~30 秒
        var end = VIDEO.seekable.length ? VIDEO.seekable.end(VIDEO.seekable.length - 1) : 0;
        if (end && end - VIDEO.currentTime > 60) {
          VIDEO.currentTime = Math.max(0, end - 8);
          toast('直播落后，已跳到最新画面');
        }
      } catch (e) {
        /* 忽略 */
      }
    }, 2000);
  }

  /* ---------- 事件 ---------- */

  function handleAction(action) {
    switch (action) {
      case 'prev':
        step(-1);
        break;
      case 'next':
        step(1);
        break;
      case 'fav':
        toggleFav(state.current.id);
        break;
      case 'theater':
        toggleTheater();
        break;
      case 'share':
        share();
        break;
      case 'retry':
        state.tried = {};
        state.current.sources.forEach(function (s) {
          state.status[s.url] = 'checking';
          probe(s.url, scheduleRender);
        });
        playSource(state.sourceIndex >= 0 ? state.sourceIndex : pickSource(state.current), true);
        break;
    }
  }

  function bindUI() {
    els.chips.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-cat]');
      if (!chip) return;
      state.category = chip.dataset.cat;
      renderChips();
      renderList();
    });

    els.list.addEventListener('click', function (e) {
      var fav = e.target.closest('[data-fav]');
      if (fav) {
        e.stopPropagation();
        toggleFav(fav.dataset.fav);
        return;
      }
      var item = e.target.closest('.ch');
      if (item) selectChannel(item.dataset.id);
    });

    els.list.addEventListener('keydown', function (e) {
      var item = e.target.closest('.ch');
      if (!item) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectChannel(item.dataset.id);
      }
    });

    els.search.addEventListener('input', function () {
      state.query = els.search.value;
      renderList();
    });
    els.search.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') {
        els.search.value = '';
        state.query = '';
        renderList();
        els.search.blur();
      } else if (e.key === 'Enter') {
        var first = visible()[0];
        if (first) selectChannel(first.id);
        els.search.blur();
      }
    });

    els.now.addEventListener('click', function (e) {
      var srcBtn = e.target.closest('[data-source]');
      if (srcBtn) {
        state.tried = {};
        playSource(Number(srcBtn.dataset.source), true);
        return;
      }
      var btn = e.target.closest('[data-action]');
      if (btn) handleAction(btn.dataset.action);
    });

    els.overlay.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) handleAction(btn.dataset.action);
    });

    els.recheck.addEventListener('click', function () {
      if (els.recheck.classList.contains('spinning')) return;
      els.recheck.classList.add('spinning');
      toast('正在重新检测所有信号…');
      probeAll(true).then(function () {
        els.recheck.classList.remove('spinning');
        var ok = CHANNELS.filter(function (ch) {
          return channelStatus(ch) === 'ok';
        }).length;
        toast('检测完成：' + ok + ' 个频道可播放');
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var k = e.key;

      if (k === '/') {
        e.preventDefault();
        els.search.focus();
        els.search.select();
      } else if (k === ']' || k === 'PageDown') {
        e.preventDefault();
        step(1);
      } else if (k === '[' || k === 'PageUp') {
        e.preventDefault();
        step(-1);
      } else if (k === 't' || k === 'T') {
        toggleTheater();
      } else if (k === 'm' || k === 'M') {
        VIDEO.muted = !VIDEO.muted;
        updateMute();
      } else if (k === 'f' || k === 'F') {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (PLAYER.requestFullscreen) PLAYER.requestFullscreen();
      } else if (k === 'i' || k === 'I') {
        try {
          if (document.pictureInPictureElement) document.exitPictureInPicture();
          else VIDEO.requestPictureInPicture();
        } catch (err) {
          /* 不支持时忽略 */
        }
      } else if (k === ' ') {
        e.preventDefault();
        if (VIDEO.paused) tryPlay();
        else VIDEO.pause();
      } else if (/^[0-9]$/.test(k)) {
        e.preventDefault();
        zapDigit(k);
      } else if (k === 'Backspace' && state.digits) {
        e.preventDefault();
        state.digits = state.digits.slice(0, -1);
        if (!state.digits) {
          clearTimeout(state.digTimer);
          els.osd.hidden = true;
        } else zapDigit('');
      }
    });

    window.addEventListener('hashchange', function () {
      var id = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
      if (id && (!state.current || id !== state.current.id)) selectChannel(id);
    });

    setInterval(function () {
      if (document.hidden) return;
      CHANNELS.forEach(function (ch) {
        ch.sources.forEach(function (s) {
          if (state.status[s.url] === 'down') probe(s.url, scheduleRender);
        });
      });
    }, REPROBE_MS);

    var clockFmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    function tickClock() {
      els.clock.textContent = clockFmt.format(new Date());
    }
    tickClock();
    setInterval(tickClock, 10000);
  }

  /* ---------- 启动 ---------- */

  function boot() {
    if (!CHANNELS.length) {
      showOverlay('<div class="overlay-card"><h3>没有频道数据</h3><p>数据可能损坏，请重新运行 build_single.py 生成。</p></div>');
      return;
    }
    state.favorites = readJSON(STORE.fav, {}) || {};
    renderChips();
    renderList();
    bindUI();
    bindPlayer();

    // HTTPS 页面直连 HTTP 源会被浏览器按混合内容拦截（fetch/XHR 属于主动混合内容）
    if (location.protocol === 'https:' && CHANNELS.some(function (ch) {
      return ch.sources.some(function (s) { return s.url.indexOf('http:') === 0; });
    })) {
      var footer = document.querySelector('.footer');
      if (footer) {
        var warn = document.createElement('p');
        warn.style.color = '#f5b83d';
        warn.style.fontWeight = '650';
        warn.textContent =
          '⚠ 当前页面通过 HTTPS 提供，而直播源全是 HTTP：浏览器会拦截这类跨协议请求，播放大概率不可用。请下载本文件后双击打开（file:// 实测可用），或放到 http:// 环境访问。';
        footer.insertBefore(warn, footer.firstChild);
      }
      toast('HTTPS 页面无法直连 HTTP 直播源，请下载本文件双击打开');
    }

    var initial =
      channelById(decodeURIComponent(location.hash.replace(/^#\/?/, ''))) ||
      channelById(readJSON(STORE.last, '')) ||
      CHANNELS[0];
    state.current = initial;
    renderNow();
    showOverlay('<div class="overlay-card"><span class="spinner"></span><p>正在检测直播信号…</p></div>');

    // 先测初始频道的源，尽快起播；其余在后台测
    var first = initial.sources.map(function (s) {
      return new Promise(function (resolve) {
        probe(s.url, function () {
          scheduleRender();
          resolve();
        });
      });
    });
    probeAll(false);

    Promise.race([
      Promise.all(first),
      new Promise(function (r) {
        setTimeout(r, 3500);
      }),
    ]).then(function () {
      state.current = null;
      selectChannel(initial.id);
    });

    window.__CNTV__ = {
      channels: CHANNELS,
      selectChannel: selectChannel,
      state: state,
      getHls: function () {
        return hls;
      },
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
