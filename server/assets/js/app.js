// 中国电视直播前端逻辑。
// 频道数据来自 serve.py 的 /api/channels（多个 m3u 源聚合为一台多源）；
// 所有 HLS 请求经 /api/stream 本地代理转发，以绕过流媒体服务器不开放 CORS 的限制。

const DEFAULT_CHANNEL = 'cctv-1';
const LOAD_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 8000;
const PROBE_CONCURRENCY = 8;
const REPROBE_MS = 3 * 60 * 1000; // 后台定期重测失败的信号源
const STORE = { favorites: 'cntv:favorites', last: 'cntv:last-channel', theater: 'cntv:theater' };

const STATUS_TEXT = {
  ok: '可播放',
  down: '暂不可用',
  checking: '检测中',
};

const STATUS_HINT = {
  ok: '已检测到直播信号，可以直接播放',
  down: '暂未检测到可用信号，可能临时故障',
  checking: '正在检测信号…',
};

// 选择信号源时的优先级：可用 > 检测中 > 不可用；同级之间按测速延迟排序
const SOURCE_RANK = ['ok', 'checking', 'down'];

const svg = (body, filled = false) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" ${
    filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`;

const STAR_PATH = '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>';

const ICON = {
  prev: svg('<path d="M15 18l-6-6 6-6"/>'),
  next: svg('<path d="M9 18l6-6-6-6"/>'),
  star: svg(STAR_PATH, true),
  starLine: svg(STAR_PATH),
  share: svg('<path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/>'),
  theater: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>'),
  alert: svg('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
};

let CHANNELS = [];
let CATEGORIES = [{ id: 'all', label: '全部' }, { id: 'fav', label: '我的收藏' }];

const $ = (sel) => document.querySelector(sel);
const els = {
  layout: $('#layout'),
  shell: $('#player-shell'),
  player: $('#player'),
  media: $('#media'),
  overlay: $('#overlay'),
  unmute: $('#unmute'),
  ctxMenu: $('#ctx-menu'),
  stats: $('#stats'),
  statsBody: $('#stats-body'),
  now: $('#now'),
  chips: $('#chips'),
  list: $('#channel-list'),
  count: $('#count'),
  search: $('#search'),
  toast: $('#toast'),
  recheck: $('#btn-recheck'),
  clockCn: $('#clock-cn'),
  zapOsd: $('#zap-osd'),
  zapNum: $('#zap-num'),
  zapName: $('#zap-name'),
};

const state = {
  category: 'all',
  query: '',
  current: null,
  sourceIndex: -1,
  tried: new Set(),
  favorites: new Set(readJSON(STORE.favorites, [])),
  srcStatus: new Map(),
  srcLatency: new Map(),
  interacted: false,
  loadTimer: 0,
  playToken: 0,
  fragsLoaded: 0,
  loadExtended: false,
  failed: false,
  lastHttpCode: 0,
  playerReady: false,
  engine: null,
  statsOn: false,
};

const probeCache = new Map();
const isHls = (s) => s.type === 'hls';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channelById = (id) => CHANNELS.find((ch) => ch.id === id);
const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? '';

// 运行模式：'server' 经 serve.py 聚合接口与流代理；'static' 纯静态托管，浏览器直连直播源。
// 启动时探测 api/channels，不存在（404/无 JSON）就自动降级为 static。
let MODE = 'server';
const streamSrc = (url) => (MODE === 'server' ? `api/stream?url=${encodeURIComponent(url)}` : url);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

const normalize = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/* ---------- 频道数据加载 ---------- */

async function loadChannelData() {
  // 先探测 serve.py 的聚合接口；能返回 JSON 就说明在代理模式下运行
  try {
    const res = await fetch('api/channels', { cache: 'no-store' });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
    if (data?.channels?.length) return data;
    if (data) throw new Error(data.error || '直播源暂时都不可访问，请稍后重试');
    // 非 JSON 响应：多半是纯静态托管环境，继续尝试 channels.json
  } catch (err) {
    if (!(err instanceof TypeError)) throw err; // fetch 本身失败（无本地服务）→ 走静态分支；其余错误向上抛
  }

  MODE = 'static';
  let res;
  try {
    res = await fetch('channels.json', { cache: 'no-store' });
  } catch {
    throw new Error(
      '静态版无法加载频道数据。请通过任意静态 HTTP 服务器打开本目录（如 python -m http.server）——file:// 双击打开会被浏览器拦截，无法加载数据和直播流。',
    );
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? '这里既没有运行 serve.py（api/channels 不可达），也没有静态版的 channels.json。请用 python serve.py 启动代理版，或在 china-tv-live 目录运行 build_static.py 生成静态版。'
        : `频道数据 channels.json 加载失败（HTTP ${res.status}），请重新运行 build_static.py 生成`,
    );
  }
  const data = await res.json().catch(() => null);
  if (!data?.channels?.length) throw new Error('channels.json 内容无效，请重新运行 build_static.py 生成');
  return data;
}

function buildChannels(data) {
  CHANNELS = data.channels;
  const used = new Set(CHANNELS.map((ch) => ch.category));
  CATEGORIES = [
    { id: 'all', label: '全部' },
    ...data.categories.filter((c) => used.has(c.id)),
    { id: 'fav', label: '我的收藏' },
  ];
}

/* ---------- 信号状态与测速 ---------- */

function sourceStatus(src) {
  return state.srcStatus.get(src.url) ?? 'checking';
}

function channelStatus(ch) {
  const list = ch.sources.map(sourceStatus);
  for (const s of ['ok', 'checking']) if (list.includes(s)) return s;
  return 'down';
}

function pickSourceIndex(ch) {
  let best = 0;
  let bestRank = Infinity;
  let bestLat = Infinity;
  ch.sources.forEach((src, i) => {
    const rank = SOURCE_RANK.indexOf(sourceStatus(src));
    const lat = state.srcLatency.get(src.url) ?? Infinity;
    if (rank < bestRank || (rank === bestRank && lat < bestLat)) {
      best = i;
      bestRank = rank;
      bestLat = lat;
    }
  });
  return best;
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(streamSrc(url), { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) return { status: 'down', latency: 0 };
    const body = await res.text();
    const latency = Math.round(performance.now() - started);
    return body.includes('#EXTM3U') ? { status: 'ok', latency } : { status: 'down', latency: 0 };
  } catch {
    return { status: 'down', latency: 0 };
  } finally {
    clearTimeout(timer);
  }
}

function probeSource(url, force = false) {
  if (!force && probeCache.has(url)) return probeCache.get(url);
  state.srcStatus.set(url, 'checking');
  const task = probe(url).then(({ status, latency }) => {
    state.srcStatus.set(url, status);
    if (status === 'ok') state.srcLatency.set(url, latency);
    scheduleRefresh();
    return status;
  });
  probeCache.set(url, task);
  return task;
}

async function probeAll(force = false) {
  const urls = [...new Set(CHANNELS.flatMap((ch) => ch.sources.map((s) => s.url)))];
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      await probeSource(urls[cursor++], force).catch(() => {});
    }
  };
  await Promise.allSettled(Array.from({ length: PROBE_CONCURRENCY }, worker));
}

// 失败的信号源每隔几分钟静默重测一次，恢复后列表会自动变绿
function startReprobeLoop() {
  setInterval(() => {
    if (document.hidden) return;
    for (const [url, status] of state.srcStatus) {
      if (status === 'down') probeSource(url, true);
    }
  }, REPROBE_MS);
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    renderList();
    renderSources();
  });
}

/* ---------- 渲染 ---------- */

function tileHTML(ch, size = '') {
  const text = ch.logo.text;
  return `<span class="tile ${size}" data-len="${Math.min(text.length, 4)}" style="--from:${ch.logo.from};--to:${ch.logo.to}" aria-hidden="true">${esc(text)}</span>`;
}

function visibleChannels() {
  const q = normalize(state.query.trim());
  return CHANNELS.filter((ch) => {
    if (state.category === 'fav' && !state.favorites.has(ch.id)) return false;
    if (state.category !== 'all' && state.category !== 'fav' && ch.category !== state.category) return false;
    if (!q) return true;
    const category = CATEGORIES.find((c) => c.id === ch.category);
    const haystack = [ch.name, ch.network, ch.number ? `${ch.number} 号频道` : '', category?.label, ...ch.tags].join(' ');
    return normalize(haystack).includes(q);
  });
}

function renderChips() {
  els.chips.innerHTML = CATEGORIES.map((c) => {
    const n =
      c.id === 'all' ? CHANNELS.length : c.id === 'fav' ? state.favorites.size : CHANNELS.filter((ch) => ch.category === c.id).length;
    if (c.id !== 'all' && c.id !== 'fav' && n === 0) return '';
    return `<button class="chip" type="button" role="tab" data-cat="${c.id}" aria-selected="${state.category === c.id}">${
      c.id === 'fav' ? ICON.star : ''
    }${esc(c.label)}<b>${n}</b></button>`;
  }).join('');
}

function itemHTML(ch) {
  const status = channelStatus(ch);
  const active = state.current?.id === ch.id;
  const fav = state.favorites.has(ch.id);
  return `<li class="ch" role="option" tabindex="0" data-id="${ch.id}" aria-selected="${active}">
    ${tileHTML(ch)}
    <span class="ch-main">
      <span class="ch-name">${esc(ch.name)}<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span></span>
      <span class="ch-sub">${esc(ch.network || categoryLabel(ch.category))} · ${ch.sources.length} 路源</span>
    </span>
    <span class="ch-side">
      <em class="ch-num" title="按数字键可直达">${String(ch.number).padStart(2, '0')}</em>
      <span class="status" data-status="${status}" title="${esc(STATUS_HINT[status])}"><i></i><em>${STATUS_TEXT[status]}</em></span>
      <button class="fav" type="button" data-fav="${ch.id}" aria-pressed="${fav}" aria-label="${fav ? '取消收藏' : '收藏'} ${esc(ch.name)}">${
        fav ? ICON.star : ICON.starLine
      }</button>
    </span>
  </li>`;
}

function renderList() {
  if (!CHANNELS.length) return;
  const focusedId = document.activeElement?.closest?.('.ch')?.dataset.id;
  const items = visibleChannels();
  const playable = CHANNELS.filter((ch) => channelStatus(ch) === 'ok').length;
  els.count.textContent = `${CHANNELS.length} 个 · ${playable} 个可播放`;

  if (!items.length) {
    els.list.innerHTML = `<li class="empty">${
      state.category === 'fav' && !state.query ? '还没有收藏的频道。<br />点击频道右侧的星标即可收藏。' : '没有找到匹配的频道，换个关键词试试。'
    }</li>`;
    return;
  }

  const grouped = state.category === 'all' && !state.query.trim();
  let html = '';
  let lastCategory = '';
  for (const ch of items) {
    if (grouped && ch.category !== lastCategory) {
      html += `<li class="group-title" role="presentation">${esc(categoryLabel(ch.category))}</li>`;
      lastCategory = ch.category;
    }
    html += itemHTML(ch);
  }
  els.list.innerHTML = html;
  if (focusedId) els.list.querySelector(`.ch[data-id="${focusedId}"]`)?.focus({ preventScroll: true });
}

function renderNow() {
  const ch = state.current;
  if (!ch) return;
  const fav = state.favorites.has(ch.id);
  const meta = [ch.network, categoryLabel(ch.category), `${ch.sources.length} 路信号源`].filter(Boolean).join(' · ');
  els.now.innerHTML = `
    <div class="now-head">
      ${tileHTML(ch, 'tile-lg')}
      <div class="now-title">
        <div class="now-kicker">
          <span class="live-pill"><i></i>LIVE 直播</span>
          <span>${esc(ch.number)} 号频道 · ${esc(categoryLabel(ch.category))}</span>
        </div>
        <h1>${esc(ch.name)}</h1>
        <p class="now-sub">${esc(meta)}</p>
      </div>
      <div class="now-actions">
        <button class="btn icon" type="button" data-action="prev" title="上一个频道（[）" aria-label="上一个频道">${ICON.prev}</button>
        <button class="btn icon" type="button" data-action="next" title="下一个频道（]）" aria-label="下一个频道">${ICON.next}</button>
        <button class="btn" type="button" data-action="fav" aria-pressed="${fav}">${fav ? ICON.star : ICON.starLine}<span class="lbl">${
          fav ? '已收藏' : '收藏'
        }</span></button>
        <button class="btn" type="button" data-action="theater" aria-pressed="${isTheater()}" title="剧场模式（T）">${ICON.theater}<span class="lbl">剧场模式</span></button>
        <button class="btn" type="button" data-action="share">${ICON.share}<span class="lbl">分享</span></button>
      </div>
    </div>
    <p class="now-intro">${esc(ch.intro)}</p>
    <div class="now-tags">${ch.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="now-sources" id="now-sources"></div>`;
  renderSources();
}

function sourceNote(src) {
  const lat = state.srcLatency.get(src.url);
  const parts = ['打开频道时自动选择最快的可用信号源；当前源播放失败会自动切换到下一路。'];
  if (lat) parts.push(`当前测速 ${lat} ms。`);
  parts.push(
    MODE === 'server'
      ? '所有播放地址均经本机 serve.py 代理转发，按 [ 或 ] 快速换台，直接输入数字可跳到对应频道。'
      : '静态直连模式：播放地址由浏览器直连源站（源站已开放跨域），按 [ 或 ] 快速换台，直接输入数字可跳到对应频道。',
  );
  return parts.join(' ');
}

function renderSources() {
  const box = document.getElementById('now-sources');
  const ch = state.current;
  if (!box || !ch) return;
  const current = ch.sources[state.sourceIndex] ?? ch.sources[0];
  if (!current) {
    box.innerHTML = `<span class="label">信号源</span><p class="source-note">暂无可用信号源。</p>`;
    return;
  }
  box.innerHTML = `<span class="label">信号源</span>
    <div class="seg" role="radiogroup" aria-label="选择信号源">
      ${ch.sources
        .map((src, i) => {
          const status = sourceStatus(src);
          const lat = state.srcLatency.get(src.url);
          return `<button class="seg-btn" type="button" role="radio" data-source="${i}" aria-checked="${i === state.sourceIndex}" title="${esc(
            STATUS_HINT[status],
          )}">
            <span class="dot" data-status="${status}"></span>
            <span>源 ${i + 1} · ${esc(src.label)}</span>
            ${lat ? `<small>${lat}ms</small>` : ''}
          </button>`;
        })
        .join('')}
    </div>
    <div class="src-foot">
      <p class="source-note">${esc(sourceNote(current))}</p>
      <button class="btn small" type="button" data-action="copy-src">${ICON.copy}复制播放地址</button>
    </div>`;
}

/* ---------- 换台 OSD ---------- */

let zapTimer = 0;
function showZap(ch, hold = 1500) {
  if (!ch) return;
  els.zapNum.textContent = String(ch.number).padStart(2, '0');
  els.zapName.textContent = ch.name;
  els.zapOsd.hidden = false;
  clearTimeout(zapTimer);
  zapTimer = setTimeout(() => {
    els.zapOsd.hidden = true;
  }, hold);
}

const zap = { digits: '', timer: 0 };

function zapDigit(digit) {
  zap.digits = (zap.digits + digit).slice(0, 3);
  const n = Number(zap.digits);
  const target = CHANNELS.find((ch) => ch.number === n);
  els.zapNum.textContent = zap.digits;
  els.zapName.textContent = target ? target.name : '……';
  els.zapOsd.hidden = false;
  clearTimeout(zap.timer);
  clearTimeout(zapTimer);
  zap.timer = setTimeout(commitZap, 1100);
  if (zap.digits.length >= 3 || n * 10 > CHANNELS.length) commitZap();
}

function commitZap() {
  clearTimeout(zap.timer);
  const n = Number(zap.digits);
  zap.digits = '';
  if (!n) {
    els.zapOsd.hidden = true;
    return;
  }
  const target = CHANNELS.find((ch) => ch.number === n);
  if (target) {
    selectChannel(target.id);
    showZap(target); // 换台完成后让 OSD 停留片刻再消失
  } else {
    els.zapName.textContent = '没有这个频道号';
    zapTimer = setTimeout(() => {
      els.zapOsd.hidden = true;
    }, 1200);
    toast(`没有 ${n} 号频道（当前共 ${CHANNELS.length} 个）`);
  }
}

/* ---------- 播放控制 ---------- */

function setMode(mode) {
  els.shell.dataset.mode = mode;
  if (mode !== 'hls') els.unmute.hidden = true;
}

function showOverlay(html) {
  els.overlay.innerHTML = html;
  els.overlay.hidden = false;
}

function hideOverlay() {
  els.overlay.hidden = true;
  els.overlay.innerHTML = '';
}

function loadingHTML(message) {
  return `<div class="overlay-card"><span class="spinner" aria-hidden="true"></span><p>${esc(message)}</p></div>`;
}

function stopHls() {
  clearTimeout(state.loadTimer);
  if (!state.playerReady) return;
  els.media.pause();
  els.media.source = null;
}

function playSource(index, { force = false } = {}) {
  const ch = state.current;
  const src = ch.sources[index];
  state.playToken += 1;
  state.sourceIndex = index;
  state.failed = false;
  state.lastHttpCode = 0;
  state.fragsLoaded = 0;
  state.loadExtended = false;
  clearTimeout(state.loadTimer);
  hideOverlay();
  renderSources();

  if (!src) {
    stopHls();
    setMode('hls');
    showOverlay(`<div class="overlay-card">
        <span class="overlay-icon">${ICON.alert}</span>
        <h3>这个频道暂时没有可用信号</h3>
        <p>所有源都没有返回有效信号，可能是临时停播。可以稍后重试，或先看其他频道。</p>
        <div class="actions">
          <button class="btn primary" type="button" data-action="retry">${ICON.retry}重新检测</button>
          <button class="btn" type="button" data-action="next">${ICON.next}下一个频道</button>
        </div>
      </div>`);
    return;
  }

  setMode('hls');
  // 检测已确认不可用的信号直接走失败流程，不必让用户白等加载超时；手动重试时仍会强制尝试
  const known = state.srcStatus.get(src.url);
  if (!force && known === 'down') {
    fail('error');
    return;
  }
  if (!state.playerReady) return;
  els.media.title = ch.name;
  els.media.source = {
    src: streamSrc(src.url),
    type: 'application/x-mpegurl',
    // 按播放器尺寸限制自动画质，避免小窗口也去下载高码率流
    capRenditionToPlayerSize: true,
    engine: {
      hlsJs: {
        // 央视 CDN 每次刷新播放列表会换一套签名路径，同一序号的分片 URL 因此变化，
        // hls.js 会判定「media sequence mismatch」并丢弃这次更新（fatal: false）。
        // 但它只是一次更新被跳过，直接忽略即可；否则直连模式下十几秒后画面就会停住。
        ignorePlaylistParsingErrors: true,
        backBufferLength: 30,
        maxBufferLength: 24,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
        startFragPrefetch: true,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 15000,
        fragLoadingMaxRetry: 5,
      },
    },
  };
  state.loadTimer = setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
}

function showError(ch, reason) {
  showOverlay(`<div class="overlay-card">
      <span class="overlay-icon">${ICON.alert}</span>
      <h3>信号暂时无法播放</h3>
      <p>${
        reason === 'slow'
          ? `${esc(ch.name)} 的各路信号都能连通，但网速不足以流畅播放，可稍后重试。`
          : `可能是 ${esc(ch.name)} 临时停播、网络不稳定，或信号源服务器暂时不可达。可以重试或先看其他频道。`
      }</p>
      <div class="actions">
        <button class="btn primary" type="button" data-action="retry">${ICON.retry}重新连接</button>
        <button class="btn" type="button" data-action="next">${ICON.next}下一个频道</button>
      </div>
    </div>`);
}

function fail(reason) {
  const ch = state.current;
  const src = ch?.sources[state.sourceIndex];
  if (state.failed || !src) return;
  state.failed = true;
  clearTimeout(state.loadTimer);
  state.srcStatus.set(src.url, 'down');
  state.tried.add(state.sourceIndex);
  scheduleRefresh();

  const next = ch.sources.findIndex((s, i) => !state.tried.has(i) && sourceStatus(s) !== 'down');
  if (next !== -1) {
    toast(`源 ${state.sourceIndex + 1}（${src.label}）无法播放，已切换到 源 ${next + 1}（${ch.sources[next].label}）`);
    playSource(next);
    return;
  }
  stopHls();
  showError(ch, reason === 'slow' ? 'slow' : 'error');
}

function onReady() {
  const src = state.current?.sources[state.sourceIndex];
  if (els.shell.dataset.mode !== 'hls' || !src || state.failed) return;
  clearTimeout(state.loadTimer);
  if (state.srcStatus.get(src.url) !== 'ok') {
    state.srcStatus.set(src.url, 'ok');
    scheduleRefresh();
  }
}

function onLoadTimeout() {
  // 高码率流的首个分片可能要下载很久，只要分片还在陆续到达就再多等一轮
  if (state.fragsLoaded > 0 && !state.loadExtended) {
    state.loadExtended = true;
    toast('信号较慢，正在缓冲…');
    state.loadTimer = setTimeout(onLoadTimeout, LOAD_TIMEOUT_MS);
    return;
  }
  fail('timeout');
}

function selectChannel(id) {
  const ch = channelById(id);
  if (!ch) return;
  if (state.current?.id === ch.id && state.sourceIndex !== -1 && els.overlay.hidden) return;
  state.current = ch;
  state.tried = new Set();
  writeJSON(STORE.last, ch.id);
  if (location.hash !== `#/${ch.id}`) history.replaceState(null, '', `#/${ch.id}`);
  document.title = `${ch.name} | 中国电视直播`;
  renderNow();
  renderList();
  scrollActiveIntoView();
  playSource(ch.sources.length ? pickSourceIndex(ch) : -1);
}

function step(direction) {
  let list = visibleChannels();
  if (!list.some((ch) => ch.id === state.current?.id)) list = CHANNELS;
  const i = list.findIndex((ch) => ch.id === state.current?.id);
  const target = list[(i + direction + list.length) % list.length];
  selectChannel(target.id);
  showZap(target);
}

function scrollActiveIntoView() {
  const box = els.list;
  const item = box.querySelector('.ch[aria-selected="true"]');
  if (!item || box.scrollHeight <= box.clientHeight + 1) return;
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < box.scrollTop + 8) box.scrollTo({ top: top - 40, behavior: 'smooth' });
  else if (bottom > box.scrollTop + box.clientHeight - 8) box.scrollTo({ top: bottom - box.clientHeight + 12, behavior: 'smooth' });
}

/* ---------- 收藏 / 剧场 / 分享 ---------- */

function toggleFavorite(id) {
  const ch = channelById(id);
  if (!ch) return;
  const added = !state.favorites.has(id);
  if (added) state.favorites.add(id);
  else state.favorites.delete(id);
  writeJSON(STORE.favorites, [...state.favorites]);
  renderChips();
  renderList();
  if (state.current?.id === id) {
    const btn = els.now.querySelector('[data-action="fav"]');
    if (btn) {
      btn.setAttribute('aria-pressed', String(added));
      btn.innerHTML = `${added ? ICON.star : ICON.starLine}<span class="lbl">${added ? '已收藏' : '收藏'}</span>`;
    }
  }
  toast(added ? `已收藏 ${ch.name}` : `已取消收藏 ${ch.name}`);
}

const isTheater = () => els.layout.classList.contains('is-theater');

function applyTheater(on) {
  els.layout.classList.toggle('is-theater', on);
  document.querySelectorAll('[data-action="theater"]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

function toggleTheater() {
  const on = !isTheater();
  applyTheater(on);
  writeJSON(STORE.theater, on);
  toast(on ? '已开启剧场模式，按 T 退出' : '已退出剧场模式');
}

async function share() {
  const url = location.href;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: document.title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast('链接已复制，发给朋友就能直接打开这个频道');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('复制失败，请手动复制地址栏中的链接');
  }
}

let toastTimer = 0;
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

/* ---------- 播放地址与统计信息 ---------- */

let statsTimer = 0;

function currentUrl() {
  const src = state.current?.sources[state.sourceIndex];
  return src ? src.url : '';
}

// 局域网 IP 或 http 页面下 navigator.clipboard 不可用，退回到选中文本再执行复制命令
function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

async function copyText(text, okMessage) {
  try {
    if (!navigator.clipboard) throw new Error('no clipboard api');
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    toast(legacyCopy(text) ? okMessage : '复制失败，请手动复制');
  }
}

function copySource() {
  const url = currentUrl();
  if (!url) {
    toast('当前信号没有可复制的播放地址');
    return;
  }
  copyText(url, '播放地址已复制');
}

const fmtBps = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbps` : `${Math.round(bps / 1e3)} kbps`);

function bufferedAhead(video) {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) return video.buffered.end(i) - t;
  }
  return 0;
}

function statsRows() {
  const ch = state.current;
  const src = ch?.sources[state.sourceIndex];
  if (!src) return [['状态', '当前没有播放中的信号']];
  const video = els.media;
  const store = els.player.store;
  const q = store?.activeVideoRendition;
  const hls = video.engine;
  // <hlsjs-video> 把真正的 <video> 放在 Shadow DOM 里，丢帧数需要从它上面读取
  const vq = (video.shadowRoot?.querySelector('video') ?? video).getVideoPlaybackQuality?.();
  const lat = state.srcLatency.get(src.url);
  return [
    ['频道', `${ch.number} · ${ch.name}`],
    ['信号源', `源 ${state.sourceIndex + 1} · ${src.label}${lat ? ` · ${lat}ms` : ''}`],
    [MODE === 'server' ? '原始地址' : '播放地址', src.url],
    ['播放器', `Video.js 10 + hls.js${MODE === 'server' ? '（经本地代理）' : '（直连）'}`],
    ['状态', store?.waiting ? '缓冲中' : video.paused ? '已暂停' : '播放中'],
    ['分辨率', video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : '—'],
    ['当前画质', q?.height ? `${q.height}p${q.bitrate ? ` · ${fmtBps(q.bitrate)}` : ''}` : '自动'],
    ['带宽估计', hls?.bandwidthEstimate ? fmtBps(hls.bandwidthEstimate) : '—'],
    ['缓冲余量', `${bufferedAhead(video).toFixed(1)} 秒`],
    ['已加载分片', String(state.fragsLoaded)],
    ['丢帧', vq ? `${vq.droppedVideoFrames} / ${vq.totalVideoFrames}` : '—'],
    ['音量', video.muted ? '静音' : `${Math.round(video.volume * 100)}%`],
  ];
}

function renderStats() {
  if (!state.statsOn) return;
  els.statsBody.innerHTML = statsRows()
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
}

function setStats(on) {
  state.statsOn = on;
  els.stats.hidden = !on;
  clearInterval(statsTimer);
  if (on) {
    renderStats();
    statsTimer = setInterval(renderStats, 1000);
  }
}

function hideMenu() {
  els.ctxMenu.hidden = true;
}

function showMenu(x, y) {
  const menu = els.ctxMenu;
  menu.querySelector('[data-ctx="copy"]').disabled = !currentUrl();
  menu.querySelector('[data-ctx="stats"]').textContent = state.statsOn ? '关闭统计信息' : '统计信息';
  menu.hidden = false;
  const box = els.shell.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, box.width - menu.offsetWidth - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, box.height - menu.offsetHeight - 6))}px`;
}

function bindPlayerMenu() {
  // 只在 HLS 直连时接管右键菜单；报错页保留浏览器原生行为
  els.shell.addEventListener('contextmenu', (e) => {
    if (els.shell.dataset.mode !== 'hls' || !els.overlay.hidden) return;
    e.preventDefault();
    const box = els.shell.getBoundingClientRect();
    showMenu(e.clientX - box.left, e.clientY - box.top);
  });

  els.ctxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ctx]');
    if (!item || item.disabled) return;
    hideMenu();
    if (item.dataset.ctx === 'copy') copySource();
    if (item.dataset.ctx === 'stats') setStats(!state.statsOn);
  });

  els.stats.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctx]');
    if (!btn) return;
    if (btn.dataset.ctx === 'copy') copySource();
    if (btn.dataset.ctx === 'stats-close') setStats(false);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!els.ctxMenu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('resize', hideMenu);
  window.addEventListener('scroll', hideMenu, { passive: true });
}

/* ---------- 时钟 ---------- */

function startClock() {
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const tick = () => {
    els.clockCn.textContent = fmt.format(new Date());
  };
  tick();
  setInterval(tick, 10000);
}

/* ---------- 事件绑定 ---------- */

function idFromHash() {
  try {
    return decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  } catch {
    return '';
  }
}

function handleAction(action, target) {
  switch (action) {
    case 'prev':
      step(-1);
      break;
    case 'next':
      step(1);
      break;
    case 'fav':
      toggleFavorite(state.current.id);
      break;
    case 'theater':
      toggleTheater();
      break;
    case 'share':
      share();
      break;
    case 'copy-src':
      copySource();
      break;
    case 'retry':
      state.tried = new Set();
      state.current.sources.forEach((s) => probeSource(s.url, true));
      playSource(state.sourceIndex >= 0 ? state.sourceIndex : pickSourceIndex(state.current), { force: true });
      break;
    case 'source': {
      const i = Number(target.dataset.source);
      state.tried = new Set();
      if (i !== state.sourceIndex || !els.overlay.hidden) playSource(i, { force: true });
      break;
    }
    case 'reload':
      location.reload();
      break;
  }
}

// 全页面可用的 空格 / M / F / I；焦点在播放器内时皮肤已处理并阻止默认行为，这里不会再次触发
function playerKey(e) {
  if (e.repeat) return;
  const key = e.key.toLowerCase();
  if (!['m', 'f', 'i', ' '].includes(key)) return;
  if (key === ' ' && e.target instanceof HTMLElement && e.target.closest('button, a, input, select, textarea, [role="option"], [role="radio"]')) return;
  const media = els.media;
  const store = els.player.store;
  const run = (promise) => promise?.catch?.(() => {});
  e.preventDefault();
  if (key === ' ') {
    if (media.paused) tryPlay();
    else media.pause();
  } else if (key === 'm') {
    media.muted = !media.muted;
  } else if (key === 'f') {
    run(store?.isFullscreen ? store.exitFullscreen() : store?.requestFullscreen());
  } else if (key === 'i') {
    run(store?.isPictureInPicture ? store.exitPictureInPicture() : store?.requestPictureInPicture());
  }
}

function bindUI() {
  bindPlayerMenu();
  const markInteracted = () => {
    state.interacted = true;
  };
  window.addEventListener('pointerdown', markInteracted, { once: true, capture: true });
  window.addEventListener('keydown', markInteracted, { once: true, capture: true });

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.dataset.cat;
    renderChips();
    renderList();
  });

  els.list.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
    const item = e.target.closest('.ch');
    if (item) selectChannel(item.dataset.id);
  });

  // 拦截列表内的按键，防止播放器的全局快捷键（空格、方向键）被同时触发
  els.list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.ch');
    if (!item || e.target.closest('[data-fav]')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      selectChannel(item.dataset.id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const items = [...els.list.querySelectorAll('.ch')];
      const i = items.indexOf(item);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderList();
  });
  els.search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      els.search.value = '';
      state.query = '';
      renderList();
      els.search.blur();
    } else if (e.key === 'Enter') {
      const first = visibleChannels()[0];
      if (first) selectChannel(first.id);
      els.search.blur();
    }
  });

  els.now.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-source]');
    if (!el) return;
    handleAction(el.dataset.action ?? 'source', el);
  });

  els.overlay.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) handleAction(el.dataset.action, el);
  });

  els.unmute.addEventListener('click', () => {
    els.media.muted = false;
    if (els.media.volume < 0.2) els.media.volume = 0.8;
    els.unmute.hidden = true;
  });

  els.recheck.addEventListener('click', async () => {
    if (els.recheck.classList.contains('spinning')) return;
    els.recheck.classList.add('spinning');
    toast('正在重新检测所有频道的信号…');
    await probeAll(true);
    scheduleRefresh();
    els.recheck.classList.remove('spinning');
    const ok = CHANNELS.filter((ch) => channelStatus(ch) === 'ok').length;
    toast(`检测完成：${ok} 个频道可正常播放`);
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === '/') {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    } else if (e.key === ']' || e.key === 'PageDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === '[' || e.key === 'PageUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 't' || e.key === 'T') {
      toggleTheater();
    } else if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      zapDigit(e.key);
    } else if (e.key === 'Backspace' && zap.digits) {
      e.preventDefault();
      zap.digits = zap.digits.slice(0, -1);
      if (!zap.digits) {
        clearTimeout(zap.timer);
        els.zapOsd.hidden = true;
      } else {
        zapDigit('');
      }
    } else if (els.shell.dataset.mode === 'hls') {
      playerKey(e);
    }
  });

  window.addEventListener('hashchange', () => {
    const id = idFromHash();
    if (id && id !== state.current?.id) selectChannel(id);
  });
}

// hls.js 实例在每次加载新源时重建，所以每次 loadstart 都重新绑定统计和错误事件
function bindEngine() {
  const hls = els.media.engine;
  if (!hls || hls === state.engine) return;
  state.engine = hls;
  hls.on('hlsFragLoaded', () => {
    state.fragsLoaded += 1;
  });
  hls.on('hlsError', (_event, data) => {
    if (!data?.fatal) return;
    state.lastHttpCode = data.response?.code ?? 0;
    const src = state.current?.sources[state.sourceIndex];
    if (els.shell.dataset.mode !== 'hls' || !src) return;
    fail('error');
  });
}

// 先尝试带声音播放；被浏览器拦截时静音再播，并显示“点击开启声音”
async function tryPlay() {
  const media = els.media;
  try {
    await media.play();
  } catch {
    if (media.muted) return;
    media.muted = true;
    try {
      await media.play();
    } catch {
      /* 静音后仍无法自动播放时，保留播放按钮让用户手动点击 */
    }
  }
}

function setupPlayer() {
  const media = els.media;

  media.addEventListener('loadstart', bindEngine);

  // 首帧到达即视为信号可用，并尝试开始播放
  media.addEventListener('loadeddata', () => {
    onReady();
    if (els.shell.dataset.mode === 'hls') tryPlay();
  });
  media.addEventListener('playing', () => {
    onReady();
    if (media.muted && els.shell.dataset.mode === 'hls') els.unmute.hidden = false;
  });

  media.addEventListener('error', () => {
    const src = state.current?.sources[state.sourceIndex];
    if (els.shell.dataset.mode !== 'hls' || !src) return;
    const active = media.src;
    const expected = new URL(streamSrc(src.url), location.href).href;
    if (active && active !== expected) return;
    fail('error');
  });

  media.addEventListener('volumechange', () => {
    if (!media.muted) els.unmute.hidden = true;
  });

  state.playerReady = true;
}

function showFatal(message) {
  showOverlay(`<div class="overlay-card">
      <span class="overlay-icon">${ICON.alert}</span>
      <h3>频道列表加载失败</h3>
      <p>${esc(message)}</p>
      <div class="actions">
        <button class="btn primary" type="button" data-action="reload">${ICON.retry}重试</button>
      </div>
    </div>`);
}

async function init() {
  applyTheater(readJSON(STORE.theater, false) === true);
  bindUI();
  startClock();
  showOverlay(loadingHTML('正在加载频道列表…'));

  try {
    buildChannels(await loadChannelData());
  } catch (err) {
    showFatal(err.message);
    return;
  }

  renderChips();
  renderList();

  if (MODE === 'static') {
    const note = document.querySelector('.footer p');
    if (note) {
      note.textContent =
        '静态直连版：未检测到本地 serve.py，直播信号由浏览器直连公开的第三方播放列表地址。本站不存储、不转码任何音视频内容，节目版权归各电视台及版权方所有，请勿用于商业用途。';
    }
    // HTTPS 页面直连 HTTP 源会被浏览器按混合内容拦截（hls.js 的请求属于主动混合内容）
    if (location.protocol === 'https:' && CHANNELS.some((ch) => ch.sources.some((s) => s.url.startsWith('http:')))) {
      const warn = document.createElement('p');
      warn.className = 'https-warn';
      warn.textContent =
        '⚠ 当前页面通过 HTTPS 提供，而直播源全是 HTTP：浏览器会拦截这类跨协议请求，播放大概率不可用。请改用 http:// 地址访问本页，或使用代理版（server/serve.py），或下载单文件版双击观看。';
      const footer = document.querySelector('.footer');
      if (footer) footer.prepend(warn);
      toast('HTTPS 页面无法直连 HTTP 直播源，播放可能不可用');
    } else {
      toast('静态直连模式：已直接连接直播源（未使用本地代理）');
    }
  }

  const initial = channelById(idFromHash()) ?? channelById(readJSON(STORE.last, '')) ?? channelById(DEFAULT_CHANNEL) ?? CHANNELS[0];
  state.current = initial;
  renderNow();
  showOverlay(loadingHTML('正在检测直播信号…'));

  await Promise.all(['video-player', 'video-skin', 'hlsjs-video'].map((tag) => customElements.whenDefined(tag)));
  setupPlayer();

  // 先测初始频道自己的源，其余频道在后台测；等首屏结果时开播就能选中最快的信号源
  const firstRound = initial.sources.map((s) => probeSource(s.url));
  probeAll(); // 其余频道在后台测速，测完列表状态会自动刷新
  startReprobeLoop();
  await Promise.race([Promise.allSettled(firstRound), sleep(3500)]);
  state.current = null;
  selectChannel(initial.id);
}

init();
