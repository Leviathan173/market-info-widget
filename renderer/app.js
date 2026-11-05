'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const MAX_FEED = 180;

const app = {
  settings: {},
  groups: [],
  quotes: [],
  filter: 'all',
  hotkeys: {},
  lastQuoteAt: 0,
  lastFlashAt: 0,
  quoteEls: new Map(),
  flashEls: new Map(),
  lastPrice: new Map(),
  opacityTimer: null,
};

/* ----------------------------------------------------------- 格式化 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function clockText(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function hhmm(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtPrice(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  const digits = abs >= 10 ? 2 : 3;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function dirOf(pct) {
  if (!Number.isFinite(pct) || pct === 0) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

function pctText(pct) {
  if (!Number.isFinite(pct)) return '--';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/* ----------------------------------------------------------- 行情渲染 */

function itemKey(it) {
  return it.src === 'em' ? it.secid : it.code;
}

/** 全部品种索引（不受分组开关影响，关注栏要用到所有品种） */
function itemIndex() {
  const map = new Map();
  for (const group of app.groups) {
    for (const item of group.items) map.set(itemKey(item), item);
  }
  return map;
}

function makeCard(item, watched) {
  const cell = document.createElement('div');
  cell.className = `q${watched ? ' watched' : ''}`;
  cell.dataset.key = itemKey(item);
  cell.title = `${item.name} · ${watched ? '点击移出关注' : '点击加入关注'}`;
  cell.innerHTML = `
    <div class="q-top">
      <span class="q-title"><span class="q-name"></span><span class="q-date"></span></span>
      <span class="q-pct">--</span>
    </div>
    <div class="q-price-row">
      <div class="q-price">--</div>
      <span class="q-ref" hidden></span>
    </div>
    <div class="q-range"><i></i><b></b></div>`;
  cell.querySelector('.q-name').textContent = item.short;
  return cell;
}

function registerQuoteEl(key, cell) {
  const arr = app.quoteEls.get(key);
  if (arr) arr.push(cell);
  else app.quoteEls.set(key, [cell]);
}

function buildQuoteSkeleton() {
  const watchGrid = $('#watchGrid');
  const wrap = $('#quotes');
  watchGrid.innerHTML = '';
  wrap.innerHTML = '';
  app.quoteEls.clear();

  const index = itemIndex();
  const watchKeys = (app.settings.watch || []).filter((key) => index.has(key));

  // 关注栏：固定在最上面，顺序即加入顺序
  for (const key of watchKeys) {
    const cell = makeCard(index.get(key), true);
    watchGrid.appendChild(cell);
    registerQuoteEl(key, cell);
  }
  $('#watchCount').textContent = watchKeys.length;
  $('#watchHint').hidden = watchKeys.length > 0;
  $('#app').classList.toggle('has-watch', watchKeys.length > 0);

  const enabled = new Set(app.settings.groups || []);
  for (const group of app.groups) {
    if (!enabled.has(group.id) || !group.items.length) continue;

    const label = document.createElement('div');
    label.className = 'q-group';
    label.textContent = group.name;
    wrap.appendChild(label);

    for (const item of group.items) {
      const key = itemKey(item);
      const cell = makeCard(item, watchKeys.includes(key));
      wrap.appendChild(cell);
      registerQuoteEl(key, cell);
    }
  }

  // 迷你条的宽度取决于展示的卡片数量，重建后重新量一次
  carousel.page = 0;
  scheduleMiniMeasure();
}

function updateQuoteFade() {
  const wrap = $('#quotesWrap');
  if (app.settings.mini) {
    wrap.classList.remove('fade');
    return;
  }
  wrap.classList.toggle('fade', wrap.scrollHeight - wrap.clientHeight > 2);
}

/* ----------------------------------------------------------- 迷你条宽度自适应 */

let miniMeasureRaf = 0;

/** 迷你条和任务栏条都是横排紧凑布局，需要按内容量宽度 */
function isCompact() {
  return Boolean(app.settings.mini || app.settings.taskbar);
}

/** 量出迷你条真正需要多宽：内容宽度和标题栏最小宽度取大者 */
function measureMiniWidth() {
  if (!isCompact()) return;

  // 关注超过一屏时先分好页，宽度按最宽的一页算
  const paged = syncWatchCarousel();

  const grid = $('#app').classList.contains('has-watch') ? $('#watchGrid') : $('#quotes');
  const region = $('#quotesRegion');
  const regionStyle = getComputedStyle(region);
  const pad =
    (parseFloat(regionStyle.paddingLeft) || 0) + (parseFloat(regionStyle.paddingRight) || 0);
  // 面板左右各 1px 边框
  const gridWidth = paged ? carousel.width : grid.getBoundingClientRect().width;
  const contentWidth = Math.ceil(gridWidth + pad + 2);

  // 任务栏模式没有标题栏，宽度只看内容
  let titleWidth = 0;
  if (!app.settings.taskbar) {
    const brand = $('.brand').getBoundingClientRect().width;
    const right = $('.titlebar-right').getBoundingClientRect().width;
    const tbStyle = getComputedStyle($('.titlebar'));
    const tbPad = (parseFloat(tbStyle.paddingLeft) || 0) + (parseFloat(tbStyle.paddingRight) || 0);
    titleWidth = Math.ceil(brand + right + tbPad + 8);
  }

  window.market.miniWidth(Math.max(contentWidth, titleWidth));
}

/** 等两帧再量，确保 mini 样式和卡片布局都已经生效 */
function scheduleMiniMeasure() {
  if (!isCompact()) return;
  cancelAnimationFrame(miniMeasureRaf);
  miniMeasureRaf = requestAnimationFrame(() => {
    miniMeasureRaf = requestAnimationFrame(measureMiniWidth);
  });
}

/* ----------------------------------------------------------- 关注栏轮播 */

// 一屏最多放 4 张卡；关注超过 4 个时，紧凑模式自动分页轮播
const CAROUSEL_PAGE_SIZE = 4;
const CAROUSEL_INTERVAL = 6000;

const carousel = { page: 0, pages: 0, width: 0, offsets: [], timer: 0, paused: false };

/** 停掉轮播，把布局还原成普通的横向排列 */
function resetWatchCarousel() {
  clearInterval(carousel.timer);
  carousel.timer = 0;
  carousel.page = 0;
  carousel.pages = 0;
  carousel.width = 0;
  carousel.offsets = [];

  const grid = $('#watchGrid');
  grid.style.transform = '';
  grid.style.transition = '';
  const block = $('.watch-block');
  if (block) block.style.width = '';
  $('#app').classList.remove('carousel');
}

/**
 * 重新计算分页宽度，并保留当前页（换页时窗口宽度不会来回跳）。
 * 返回 true 表示当前是轮播状态。
 */
function syncWatchCarousel() {
  const grid = $('#watchGrid');
  const cards = $$('#watchGrid .q');

  if (!isCompact() || cards.length <= CAROUSEL_PAGE_SIZE) {
    if (carousel.pages || $('#app').classList.contains('carousel')) resetWatchCarousel();
    return false;
  }

  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  const offsets = [];
  const widths = [];
  let acc = 0;
  let pageStart = 0;

  cards.forEach((card, index) => {
    if (index % CAROUSEL_PAGE_SIZE === 0) {
      pageStart = acc;
      offsets.push(acc);
    }
    acc += card.offsetWidth;
    // 一页的宽度含页内卡片之间的间距，不含页尾那一格间距
    if ((index + 1) % CAROUSEL_PAGE_SIZE === 0 || index === cards.length - 1) {
      widths.push(acc - pageStart);
    }
    acc += gap;
  });

  carousel.pages = offsets.length;
  carousel.offsets = offsets;
  carousel.width = Math.ceil(Math.max(...widths));
  carousel.page = Math.min(carousel.page, carousel.pages - 1);

  $('#app').classList.add('carousel');
  $('.watch-block').style.width = `${carousel.width}px`;
  grid.style.transition = 'transform 420ms cubic-bezier(0.4, 0, 0.2, 1)';
  grid.style.transform = `translateX(-${carousel.offsets[carousel.page]}px)`;

  if (!carousel.timer) {
    carousel.timer = setInterval(() => {
      // 鼠标停在条上时先别翻页，方便点卡片
      if (carousel.paused) return;
      carousel.page = (carousel.page + 1) % carousel.pages;
      grid.style.transform = `translateX(-${carousel.offsets[carousel.page]}px)`;
    }, CAROUSEL_INTERVAL);
  }

  return true;
}

function initWatchCarousel() {
  const block = $('.watch-block');
  block.addEventListener('pointerenter', () => {
    carousel.paused = true;
  });
  block.addEventListener('pointerleave', () => {
    carousel.paused = false;
  });
}

/* ----------------------------------------------------------- 行情 / 快讯分隔条 */

// 行情区最低高度、快讯区至少留出的高度（像素）
const SPLIT_LIMIT = { minQuotes: 90, minFeed: 96 };

function maxQuoteHeight() {
  const used =
    $('.titlebar').offsetHeight +
    $('.statusbar').offsetHeight +
    $('#splitter').offsetHeight +
    SPLIT_LIMIT.minFeed;
  return Math.max(SPLIT_LIMIT.minQuotes, Math.round($('#app').clientHeight - used));
}

/** 把高度夹在可视范围内后写到行内样式 */
function paintQuoteHeight(px) {
  const value = Math.round(Math.min(maxQuoteHeight(), Math.max(SPLIT_LIMIT.minQuotes, px)));
  $('#quotesRegion').style.height = `${value}px`;
  $('#app').classList.add('custom-split');
  requestAnimationFrame(updateQuoteFade);
  return value;
}

function setQuoteHeight(px, { save = false } = {}) {
  if (px === null || px === undefined || !Number.isFinite(Number(px))) {
    $('#quotesRegion').style.height = '';
    $('#app').classList.remove('custom-split');
    app.settings.quoteHeight = null;
    requestAnimationFrame(updateQuoteFade);
    if (save) window.market.setSettings({ quoteHeight: null });
    return null;
  }

  const value = paintQuoteHeight(Number(px));
  app.settings.quoteHeight = value;
  if (save) window.market.setSettings({ quoteHeight: value });
  return value;
}

function initSplitter() {
  const bar = $('#splitter');
  const region = $('#quotesRegion');
  let drag = null;

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || app.settings.mini) return;
    drag = { y: e.clientY, height: region.getBoundingClientRect().height, pointerId: e.pointerId };
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    $('#app').classList.add('dragging-split');
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const delta = e.clientY - drag.y;
    if (Math.abs(delta) > 2) drag.moved = true;
    setQuoteHeight(drag.height + delta);
  });

  const stop = () => {
    if (!drag) return;
    const { pointerId, moved } = drag;
    drag = null;
    try {
      bar.releasePointerCapture(pointerId);
    } catch {
      /* 忽略 */
    }
    $('#app').classList.remove('dragging-split');
    // 只是点了一下没有拖动，不改变布局
    if (moved) setQuoteHeight(app.settings.quoteHeight, { save: true });
  };

  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);

  // 双击恢复默认比例
  bar.addEventListener('dblclick', () => setQuoteHeight(null, { save: true }));
}

function updateCard(cell, q) {
  const pctEl = cell.querySelector('.q-pct');
  const priceEl = cell.querySelector('.q-price');
  const dir = dirOf(q.pct);

  priceEl.textContent =
    q.source === 'fund' && Number.isFinite(q.price) ? q.price.toFixed(4) : fmtPrice(q.price);
  priceEl.className = `q-price ${dir}`;
  pctEl.textContent = pctText(q.pct);
  pctEl.className = `q-pct ${dir}`;

  const bar = cell.querySelector('.q-range i');
  const dot = cell.querySelector('.q-range b');
  if (Number.isFinite(q.high) && Number.isFinite(q.low) && q.high > q.low) {
    const pos = Math.min(100, Math.max(0, ((q.price - q.low) / (q.high - q.low)) * 100));
    bar.style.width = `${pos}%`;
    dot.style.left = `${pos}%`;
  }

  // 场外基金只有每天收盘后公布的确认净值，把净值日期标出来，避免误当成当天涨跌
  const isFund = q.source === 'fund' && q.date;
  const dateEl = cell.querySelector('.q-date');
  if (dateEl) dateEl.textContent = isFund ? q.date.slice(5) : '';

  const wasFund = cell.classList.contains('is-fund');
  cell.classList.toggle('is-fund', Boolean(isFund));
  // 紧凑模式下基金卡片会多出一个日期角标，宽度变了要重新量
  if (wasFund !== Boolean(isFund) && isCompact()) scheduleMiniMeasure();

  // 基金卡片里再带一行目标 ETF 的实时涨跌，作为盘中参考
  const refEl = cell.querySelector('.q-ref');
  if (refEl) {
    const ref = q.ref;
    refEl.hidden = !ref;
    if (ref) {
      refEl.className = `q-ref ${dirOf(ref.pct)}`;
      refEl.textContent = `ETF ${pctText(ref.pct)}`;
    }
  }

  if (isFund) {
    const action = cell.classList.contains('watched') ? '点击移出关注' : '点击加入关注';
    const refText = q.ref
      ? ` · 参考 ${q.ref.name} ${fmtPrice(q.ref.price)} ${pctText(q.ref.pct)}`
      : '';
    cell.title = `${q.name} · 净值日期 ${q.date}${refText} · ${action}`;
  }

  // 价格跳动时给一格淡色高亮
  const prev = app.lastPrice.get(q.key);
  if (Number.isFinite(prev) && Number.isFinite(q.price) && prev !== q.price) {
    const color = q.price > prev ? 'rgba(255,92,99,.34)' : 'rgba(47,191,122,.3)';
    priceEl.animate([{ background: color }, { background: 'transparent' }], { duration: 720, easing: 'ease-out' });
  }
  app.lastPrice.set(q.key, q.price);
}

function applyQuotes(list, at, error) {
  app.quotes = list || [];
  if (Number.isFinite(at)) app.lastQuoteAt = at;

  for (const q of app.quotes) {
    const cells = app.quoteEls.get(q.key);
    if (!cells) continue;
    for (const cell of cells) updateCard(cell, q);
  }

  updateStatus(error);
  updateQuoteFade();
}

function toggleWatch(key) {
  const list = [...(app.settings.watch || [])];
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(key);

  app.settings.watch = list;
  buildQuoteSkeleton();
  applyQuotes(app.quotes, app.lastQuoteAt);
  window.market.setSettings({ watch: list });
}

/* ----------------------------------------------------------- 快讯渲染 */

function flashNode(item) {
  const el = document.createElement('article');
  el.className = `f${item.important ? ' important' : ''}`;
  el.dataset.id = item.id;

  const time = document.createElement('div');
  time.className = 'f-time';
  time.textContent = item.time;

  const body = document.createElement('div');
  body.className = 'f-body';

  if (item.title) {
    const t = document.createElement('p');
    t.className = 'f-title';
    t.textContent = item.title;
    body.appendChild(t);
  }

  const text = document.createElement('p');
  text.className = 'f-text';
  text.textContent = item.text;
  body.appendChild(text);

  const meta = document.createElement('div');
  meta.className = 'f-meta';
  if (item.remark) {
    const tag = document.createElement('span');
    tag.className = 'f-tag';
    tag.textContent = item.remark;
    meta.appendChild(tag);
  }
  const link = document.createElement('span');
  link.className = 'f-link';
  link.textContent = '原文 ↗';
  meta.appendChild(link);
  body.appendChild(meta);

  el.append(time, body);
  return el;
}

function renderFlash(items, { prepend = false } = {}) {
  const list = $('#feed');
  const fresh = (items || []).filter((it) => !app.flashEls.has(it.id));
  if (!fresh.length) return;

  const nearTop = list.scrollTop < 24;
  const before = list.scrollHeight;

  const frag = document.createDocumentFragment();
  for (const item of fresh) {
    const el = flashNode(item);
    app.flashEls.set(item.id, el);
    if (prepend) el.classList.add('fresh');
    frag.appendChild(el);
  }

  list.insertBefore(frag, list.firstChild);

  if (prepend && !nearTop) {
    list.scrollTop += list.scrollHeight - before;
  }

  // 控制 DOM 数量
  const nodes = Array.from(list.children);
  for (const el of nodes.slice(MAX_FEED)) {
    app.flashEls.delete(el.dataset.id);
    el.remove();
  }

  setTimeout(() => {
    for (const el of $$('.f.fresh', list)) el.classList.remove('fresh');
  }, 900);

  applyFilter();
  updateStatus();
}

function applyFilter() {
  let visible = 0;
  for (const el of app.flashEls.values()) {
    const hide = app.filter === 'important' && !el.classList.contains('important');
    el.classList.toggle('hide', hide);
    if (!hide) visible += 1;
  }
  for (const t of $$('.tab')) t.classList.toggle('on', t.dataset.filter === app.filter);
  $('#feedMeta').textContent = visible ? `${visible} 条` : '暂无';
  $('#feedEmpty').hidden = visible > 0;
  if (!visible) {
    $('#feedEmpty').textContent = app.filter === 'important' ? '当前没有重要快讯' : '正在连接金十数据…';
  }
}

/* ----------------------------------------------------------- 状态栏 */

function setDot(kind) {
  const dot = $('#liveDot');
  dot.className = `dot${kind ? ` ${kind}` : ''}`;
}

function updateStatus(error) {
  const quotesOk = app.lastQuoteAt > 0;
  const flashOk = app.lastFlashAt > 0;
  const err = error || '';

  setDot(err ? 'warn' : quotesOk && flashOk ? '' : 'warn');

  if (err) {
    $('#statusText').textContent = err;
  } else if (!quotesOk) {
    $('#statusText').textContent = '正在拉取行情…';
  } else {
    $('#statusText').textContent = `行情 ${hhmm(app.lastQuoteAt)} · 快讯 ${hhmm(app.lastFlashAt)}`;
  }

  const stale = quotesOk && Date.now() - app.lastQuoteAt > 120000;
  $('#latency').textContent = stale ? '行情已 2 分钟未更新' : `${app.quotes.length} 个品种`;
}

function startClock() {
  const tick = () => {
    $('#clock').textContent = clockText();
    const age = app.lastQuoteAt ? Date.now() - app.lastQuoteAt : 0;
    if (age > 120000) setDot('err');
    updateStatus(app.settings.lastError || '');
  };
  tick();
  setInterval(tick, 1000);
}

/* ----------------------------------------------------------- 设置面板 */

function syncSettingsUI() {
  const s = app.settings;

  const opacity = Math.round((s.opacity ?? 0.94) * 100);
  $('#opacity').value = opacity;
  $('#opacityVal').textContent = `${opacity}%`;

  for (const id of ['quoteInterval', 'flashInterval']) {
    const val = String(s[id] ?? '');
    for (const btn of $$(`#${id} button`)) btn.classList.toggle('on', btn.dataset.v === val);
  }

  $('#alwaysOnTop').checked = Boolean(s.alwaysOnTop);
  $('#clickThrough').checked = Boolean(s.clickThrough);
  $('#taskbarEmbed').checked = Boolean(s.taskbarEmbed);
  $('#autoLaunch').checked = Boolean(s.autoLaunch);
  $('#notify').checked = Boolean(s.notify);
  applyPassthrough(s.clickThrough);
  renderHotkeys();

  const groups = $('#groups');
  groups.innerHTML = '';
  for (const g of app.groups) {
    const chip = document.createElement('button');
    chip.className = `chip${(s.groups || []).includes(g.id) ? ' on' : ''}`;
    chip.dataset.id = g.id;
    chip.textContent = g.name;
    groups.appendChild(chip);
  }
}

function openSheet(open) {
  $('#sheet').hidden = !open;
  if (open) syncSettingsUI();
}

function bindUI() {
  // 标题栏按钮
  for (const btn of $$('.tb-actions [data-act]')) {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'settings') openSheet($('#sheet').hidden);
      else if (act === 'mini') window.market.action('mini');
      else if (act === 'taskbar') window.market.action('taskbar');
      else if (act === 'hide') window.market.action('hide');
    });
  }

  // 任务栏条右侧的还原按钮
  $('[data-act="restore-taskbar"]').addEventListener('click', () => window.market.action('taskbar'));

  // 关注栏轮播：鼠标停在条上时暂停翻页
  initWatchCarousel();

  // 任务栏条：拖动左侧手柄横向移动（子窗口不能用系统拖动区）
  const grip = $('.taskbar-grip');
  let gripDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (!app.settings.taskbar || e.button !== 0) return;
    gripDrag = { x: e.screenX, id: e.pointerId, moved: false };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!gripDrag) return;
    const dx = Math.round(e.screenX - gripDrag.x);
    if (!gripDrag.moved && Math.abs(dx) > 1) {
      gripDrag.moved = true;
      window.market.taskbarDrag('start');
    }
    if (gripDrag.moved) window.market.taskbarDrag('move', dx);
  });
  const endGrip = () => {
    if (!gripDrag) return;
    const { id, moved } = gripDrag;
    gripDrag = null;
    try {
      grip.releasePointerCapture(id);
    } catch {
      /* 忽略 */
    }
    if (moved) window.market.taskbarDrag('end');
  };
  grip.addEventListener('pointerup', endGrip);
  grip.addEventListener('pointercancel', endGrip);

  $('[data-act="close-sheet"]').addEventListener('click', () => openSheet(false));
  $('[data-act="quit"]').addEventListener('click', () => window.market.action('quit'));

  // 快讯筛选
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      app.filter = tab.dataset.filter;
      applyFilter();
      window.market.setSettings({ importantOnly: app.filter === 'important' });
    });
  }

  // 快讯点击：展开 / 原文
  $('#feed').addEventListener('click', (e) => {
    const node = e.target.closest('.f');
    if (!node) return;
    if (e.target.classList.contains('f-link')) {
      window.market.openFlash(node.dataset.id);
      return;
    }
    node.classList.toggle('expanded');
  });

  // 不透明度（节流写盘）
  $('#opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    $('#opacityVal').textContent = `${e.target.value}%`;
    app.settings.opacity = v;
    clearTimeout(app.opacityTimer);
    app.opacityTimer = setTimeout(() => window.market.setSettings({ opacity: v }), 120);
  });

  // 刷新间隔
  for (const row of [$('#quoteInterval'), $('#flashInterval')]) {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      const key = row.id;
      const value = Number(btn.dataset.v);
      app.settings[key] = value;
      for (const b of $$('button', row)) b.classList.toggle('on', b === btn);
      window.market.setSettings({ [key]: value });
    });
  }

  // 分组开关
  $('#groups').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.id;
    const set = new Set(app.settings.groups || []);
    if (set.has(id)) {
      if (set.size <= 1) return; // 至少留一组
      set.delete(id);
    } else {
      set.add(id);
    }
    app.settings.groups = app.groups.map((g) => g.id).filter((gid) => set.has(gid));
    syncSettingsUI();
    buildQuoteSkeleton();
    applyQuotes(app.quotes, app.lastQuoteAt);
    window.market.setSettings({ groups: app.settings.groups });
  });

  // 开关项
  for (const [id, key] of [
    ['alwaysOnTop', 'alwaysOnTop'],
    ['clickThrough', 'clickThrough'],
    ['taskbarEmbed', 'taskbarEmbed'],
    ['autoLaunch', 'autoLaunch'],
    ['notify', 'notify'],
  ]) {
    $(`#${id}`).addEventListener('change', (e) => {
      window.market.setSettings({ [key]: e.target.checked });
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 键盘事件不受点击穿透影响，Esc 是面板内的第二道退出口
    if (app.settings.clickThrough) {
      window.market.setSettings({ clickThrough: false });
      return;
    }
    openSheet(false);
  });

  $('#quotesWrap').addEventListener('scroll', updateQuoteFade, { passive: true });

  // 点击行情卡片 = 加入 / 移出关注
  $('#quotesRegion').addEventListener('click', (e) => {
    const cell = e.target.closest('.q');
    if (!cell || !cell.dataset.key) return;
    toggleWatch(cell.dataset.key);
  });

  window.addEventListener('resize', () => {
    // 窗口变矮时把自定义高度收回可视范围，变大时按原意图重新展开
    if (!isCompact() && $('#app').classList.contains('custom-split')) {
      paintQuoteHeight(app.settings.quoteHeight ?? 0);
    }
    // 迷你条 / 任务栏条被手动拉宽拉窄后，重新按内容收边
    if (isCompact()) scheduleMiniMeasure();
    updateQuoteFade();
    updateStatus(app.settings.lastError || '');
  });
}

/* ----------------------------------------------------------- 订阅 */

function subscribe() {
  window.market.on('push:quotes', (payload) => {
    applyQuotes(payload.quotes, payload.at, payload.error);
  });

  window.market.on('push:flash', (payload) => {
    app.lastFlashAt = Date.now();
    renderFlash(payload.items, { prepend: true });
  });

  window.market.on('push:status', (payload) => {
    if (payload.flashAt) app.lastFlashAt = payload.flashAt;
    if (payload.flashError) app.settings.lastError = payload.flashError;
    updateStatus(app.settings.lastError || '');
  });

  window.market.on('settings:changed', (patch) => {
    const before = (app.settings.groups || []).join(',');
    Object.assign(app.settings, patch);

    if ('mini' in patch) applyMiniClass(patch.mini);
    if ('taskbar' in patch) applyTaskbarClass(patch.taskbar);
    if ('taskbarEmbedded' in patch) applyEmbedClass(patch.taskbarEmbedded);
    if ('clickThrough' in patch) applyPassthrough(patch.clickThrough);

    if ('groups' in patch && (patch.groups || []).join(',') !== before) {
      buildQuoteSkeleton();
      applyQuotes(app.quotes, app.lastQuoteAt);
    }
    syncSettingsUI();
  });

  window.market.on('ui:close-sheet', () => openSheet(false));
  window.market.on('ui:mini-measure', () => scheduleMiniMeasure());
}

function applyMiniClass(on) {
  $('#app').classList.toggle('mini', Boolean(on));
  if (on) openSheet(false);
  requestAnimationFrame(updateQuoteFade);
  carousel.page = 0;
  syncWatchCarousel();
  scheduleMiniMeasure();
}

function applyTaskbarClass(on) {
  $('#app').classList.toggle('taskbar', Boolean(on));
  if (on) openSheet(false);
  requestAnimationFrame(updateQuoteFade);
  carousel.page = 0;
  syncWatchCarousel();
  scheduleMiniMeasure();
}

/** 真嵌入时窗口是任务栏的子窗口，不能用系统的拖动区域，隐藏拖动手柄 */
function applyEmbedClass(on) {
  $('#app').classList.toggle('taskbar-embed', Boolean(on));
  scheduleMiniMeasure();
}

function applyPassthrough(on) {
  $('#app').classList.toggle('passthrough', Boolean(on));
}

function renderHotkeys() {
  const rows = [
    ['toggle', '显示 / 隐藏'],
    ['mini', '迷你模式'],
    ['through', '点击穿透'],
  ];
  const box = $('#hotkeys');
  box.innerHTML = '';

  for (const [key, label] of rows) {
    const row = document.createElement('div');
    const accel = app.hotkeys[key];
    if (accel) {
      for (const part of accel.replace('CommandOrControl', 'Ctrl').split('+')) {
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
        row.appendChild(kbd);
      }
      row.appendChild(document.createTextNode(label));
    } else {
      row.className = 'hotkey-missing';
      row.textContent = `${label}：键位被其它程序占用，请用托盘菜单`;
    }
    box.appendChild(row);
  }
}

/* ----------------------------------------------------------- 启动 */

async function boot() {
  const init = await window.market.init();
  app.settings = init.settings || {};
  app.groups = init.groups || [];
  app.hotkeys = init.hotkeys || {};
  app.lastQuoteAt = init.lastQuoteAt || 0;
  app.lastFlashAt = init.lastFlashAt || 0;
  app.filter = app.settings.importantOnly ? 'important' : 'all';

  applyMiniClass(app.settings.mini);
  applyTaskbarClass(app.settings.taskbar);
  applyEmbedClass(init.taskbarEmbedded);
  buildQuoteSkeleton();
  applyQuotes(init.quotes || [], init.lastQuoteAt);

  if (!app.settings.mini && !app.settings.taskbar && Number.isFinite(app.settings.quoteHeight)) {
    paintQuoteHeight(app.settings.quoteHeight);
  }
  initSplitter();

  syncSettingsUI();
  bindUI();
  subscribe();
  scheduleMiniMeasure();

  renderFlash(init.flashes || [], { prepend: false });
  if (!init.flashes?.length) applyFilter();
  updateStatus(init.errors?.quotes || '');

  // 首次渲染时字体和行情还没铺满，等布局稳定后再量一次宽度
  setTimeout(scheduleMiniMeasure, 700);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleMiniMeasure);

  startClock();
}

boot().catch((err) => {
  $('#statusText').textContent = `初始化失败：${err.message}`;
  setDot('err');
});