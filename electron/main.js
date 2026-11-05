'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  globalShortcut,
  screen,
  Notification,
} = require('electron');

const { Store } = require('./store');
const { GROUPS } = require('./data/symbols');
const { fetchQuotes } = require('./data/quotes');
const { fetchFlash } = require('./data/flash');
const { createIcon } = require('./icons');

const DEFAULT_SIZE = { width: 408, height: 726, minWidth: 330, minHeight: 260 };
// width 只是渲染进程量出内容宽度之前的初始值，拿到实际宽度后会立即自适应
const MINI_SIZE = { width: 360, height: 140, minWidth: 200 };
// 距离屏幕工作区边缘多少像素以内就吸附上去
const SNAP_DISTANCE = 18;
const APP_ID = 'com.maigo.marketinfo';

let store;
let win = null;
let tray = null;
let quoteTimer = null;
let flashTimer = null;

let quotes = [];
let flashes = [];
let lastQuoteAt = 0;
let lastFlashAt = 0;
let quoteBusy = false;
let flashBusy = false;
let lastError = { quotes: '', flash: '' };
let flashPrimed = false;
let miniBackup = null;
// 是否真的处在迷你形态（settings 里的 mini 在窗口尺寸切换完成后才一致，用它更可靠）
let isMini = false;
// 迷你条当前尺寸，吸边时用它固定大小，避免 DPI 取整让窗口越挪越大
let miniSize = null;
let boundsTimer = null;
let snapTimer = null;
let suppressPersist = false;
let suppressTimer = null;
let notifyIcon = null;
let hotkeys = {};

/* ---------------------------------------------------------------- 工具 */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 周末（周六 06:00 之后到周一凌晨）行情基本停滞，降频省电省请求 */
function slowMode() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0) return true;
  if (day === 6 && d.getHours() >= 6) return true;
  return false;
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return fitToWorkArea(
    {
      width: DEFAULT_SIZE.width,
      height: DEFAULT_SIZE.height,
      x: workArea.x + workArea.width - DEFAULT_SIZE.width - 28,
      y: workArea.y + Math.round((workArea.height - DEFAULT_SIZE.height) / 2),
    },
    workArea,
  );
}

/** 把矩形收进屏幕工作区，保证窗口完整可见（不越过屏幕边缘） */
function fitToWorkArea(bounds, workArea) {
  const width = Math.min(Math.round(bounds.width), workArea.width);
  const height = Math.min(Math.round(bounds.height), workArea.height);
  const x = Math.min(Math.max(Math.round(bounds.x), workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(Math.round(bounds.y), workArea.y), workArea.y + workArea.height - height);
  return { x, y, width, height };
}

function normalizeBounds(saved) {
  if (!saved || !saved.width || !saved.height) return defaultBounds();

  const rect = {
    x: Number(saved.x) || 0,
    y: Number(saved.y) || 0,
    width: Math.max(DEFAULT_SIZE.minWidth, Math.round(saved.width)),
    height: Math.max(DEFAULT_SIZE.minHeight, Math.round(saved.height)),
  };
  return fitToWorkArea(rect, screen.getDisplayMatching(rect).workArea);
}

/** 迷你条：优先保持贴边的一侧不动，超出屏幕就往回收 */
function miniBounds(cur, width = MINI_SIZE.width) {
  const area = screen.getDisplayMatching(cur).workArea;
  const w = Math.min(Math.max(MINI_SIZE.minWidth, Math.round(width)), area.width);
  const height = Math.min(MINI_SIZE.height, area.height);
  const anchorRight = cur.x + cur.width / 2 > area.x + area.width / 2;
  const x = anchorRight ? cur.x + cur.width - w : cur.x;
  return fitToWorkArea({ x, y: cur.y, width: w, height }, area);
}

/** 距离工作区边缘 SNAP_DISTANCE 以内就贴齐；同时把越界的窗口收回屏幕。无需调整时返回 null */
function snapBounds(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const fitted = fitToWorkArea(bounds, area);
  const { width, height } = fitted;
  let { x, y } = fitted;

  if (x - area.x <= SNAP_DISTANCE) x = area.x;
  else if (area.x + area.width - (x + width) <= SNAP_DISTANCE) x = area.x + area.width - width;

  if (y - area.y <= SNAP_DISTANCE) y = area.y;
  else if (area.y + area.height - (y + height) <= SNAP_DISTANCE) y = area.y + area.height - height;

  const moved =
    Math.round(bounds.x) !== fitted.x ||
    Math.round(bounds.y) !== fitted.y ||
    Math.round(bounds.width) !== fitted.width ||
    Math.round(bounds.height) !== fitted.height;
  if (!moved && x === fitted.x && y === fitted.y) return null;
  return { x, y, width, height };
}

/** 拖动停顿后自动吸边（普通模式和迷你模式共用） */
function scheduleSnap() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || suppressPersist) return;
    const cur = win.getBounds();
    const next = snapBounds(cur);
    if (!next) return;

    // 显式带上尺寸，避免 setPosition 在 150% 缩放下按 outer 边界重算，导致窗口每次吸边都胖 1px
    const size = (isMini ? miniSize : store.get('bounds')) || cur;
    suppressPersistFor(180);
    win.setBounds({ x: next.x, y: next.y, width: size.width, height: size.height });
    // 迷你模式的位置不落盘，只有普通模式的窗口位置需要记住
    if (!isMini) writeBounds();
  }, 200);
}

/** 程序化改变窗口尺寸期间屏蔽落盘和吸边，避免把中间态写进设置 */
function suppressPersistFor(ms) {
  suppressPersist = true;
  clearTimeout(suppressTimer);
  suppressTimer = setTimeout(() => {
    suppressPersist = false;
  }, ms);
}

/** 保存窗口位置和尺寸；1~2px 的变化视为 150% 缩放下 getBounds 的取整误差，沿用旧尺寸 */
function writeBounds() {
  const next = win.getBounds();
  const prev = store.get('bounds');
  if (prev) {
    const drift = Math.abs(next.width - prev.width) + Math.abs(next.height - prev.height);
    if (drift <= 2) {
      next.width = prev.width;
      next.height = prev.height;
    }
  }
  store.set({ bounds: next });
}

function saveBounds() {
  if (!win || win.isDestroyed() || store.get('mini') || suppressPersist) return;
  writeBounds();
}

function persistBounds() {
  if (!win || win.isDestroyed() || store.get('mini') || suppressPersist) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBounds, 400);
}

/* ---------------------------------------------------------------- 取数 */

async function pollQuotes() {
  if (quoteBusy) return;
  quoteBusy = true;
  try {
    const { quotes: list, errors } = await fetchQuotes(store.get('groups'));
    quotes = list;
    lastQuoteAt = Date.now();
    lastError.quotes = errors[0] || '';
    send('push:quotes', { quotes, at: lastQuoteAt, error: lastError.quotes });
  } catch (err) {
    lastError.quotes = err.message || String(err);
    send('push:quotes', { quotes, at: lastQuoteAt, error: lastError.quotes });
  } finally {
    quoteBusy = false;
  }
}

async function pollFlash() {
  if (flashBusy) return;
  flashBusy = true;
  try {
    const list = await fetchFlash();
    const known = new Set(flashes.map((f) => f.id));
    const fresh = list.filter((f) => !known.has(f.id));
    if (fresh.length) {
      flashes = [...fresh, ...flashes].slice(0, 300);
      send('push:flash', { items: fresh, total: flashes.length });
      if (flashPrimed) notifyImportant(fresh);
    }
    flashPrimed = true;
    lastFlashAt = Date.now();
    lastError.flash = '';
    send('push:status', { flashAt: lastFlashAt });
  } catch (err) {
    lastError.flash = err.message || String(err);
    send('push:status', { flashError: lastError.flash });
  } finally {
    flashBusy = false;
  }
}

/** 弹一条系统通知；点击时执行回调 */
function showToast({ title, body, onClick }) {
  if (!Notification.isSupported()) return null;
  const note = new Notification({
    title,
    body: String(body || '').slice(0, 200),
    icon: notifyIcon,
    silent: true,
  });
  if (onClick) note.on('click', onClick);
  note.show();
  return note;
}

/** 重要快讯弹 Windows 系统通知（通知中心 toast） */
function notifyImportant(items) {
  if (!store.get('notify')) return;

  const picked = items.filter((it) => it.important).slice(0, 3);
  for (const item of picked) {
    showToast({
      title: item.title || '金十重要快讯',
      body: item.text,
      onClick: () => {
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
        }
        shell.openExternal(`https://flash.jin10.com/detail/${item.id}`);
      },
    });
  }
}

function scheduleQuotes() {
  clearTimeout(quoteTimer);
  const base = Math.max(2000, Number(store.get('quoteInterval')) || 5000);
  let delay = base;
  if (slowMode()) delay = base * 6;
  if (win && !win.isVisible()) delay = Math.max(delay, 20000);

  quoteTimer = setTimeout(async () => {
    await pollQuotes();
    scheduleQuotes();
  }, delay);
}

function scheduleFlash() {
  clearTimeout(flashTimer);
  const base = Math.max(3000, Number(store.get('flashInterval')) || 8000);
  let delay = base;
  if (win && !win.isVisible()) delay = Math.max(delay, 30000);

  flashTimer = setTimeout(async () => {
    await pollFlash();
    scheduleFlash();
  }, delay);
}

/* ---------------------------------------------------------------- 窗口能力 */

function setOpacity(v) {
  const opacity = Math.min(1, Math.max(0.3, Number(v) || 0.94));
  if (win && !win.isDestroyed()) win.setOpacity(opacity);
}

function setAlwaysOnTop(on) {
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(Boolean(on), 'screen-saver');
}

function setClickThrough(on) {
  const enabled = Boolean(on);
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(enabled, { forward: true });
  store.set({ clickThrough: enabled });
  if (tray) refreshTrayMenu();
  send('settings:changed', { clickThrough: enabled });

  if (enabled) {
    // 开启后鼠标点击全部落到下层窗口，必须明确告诉用户怎么退出
    send('ui:close-sheet');
    showToast({
      title: '点击穿透已开启',
      body: `窗口不再响应鼠标，点击会落到下面的窗口。按 ${hotkeyText('through')} 关闭，或直接点这条通知。`,
      onClick: () => setClickThrough(false),
    });
  }
}

function applyMini(on) {
  if (!win || win.isDestroyed()) return;
  const enabled = Boolean(on);
  isMini = enabled;

  // 切换期间屏蔽 resize 落盘和吸边，避免把中间态的尺寸写进设置
  suppressPersistFor(500);

  if (enabled) {
    const cur = win.getBounds();
    miniBackup = cur;
    let target = miniBounds(cur);
    target = snapBounds(target) || target;
    miniSize = { width: target.width, height: target.height };
    // 先放宽最小尺寸，否则 setBounds 会被旧的 minHeight 顶回去
    win.setMinimumSize(MINI_SIZE.minWidth, Math.min(120, target.height));
    win.setBounds(target);
  } else {
    // 以迷你条当前所在的一侧为锚点，把大窗口放回同一边
    const cur = win.getBounds();
    const backup = miniBackup ? normalizeBounds(miniBackup) : normalizeBounds(store.get('bounds'));
    const area = screen.getDisplayMatching(cur).workArea;
    const anchorRight = cur.x + cur.width / 2 > area.x + area.width / 2;
    const x = anchorRight ? cur.x + cur.width - backup.width : cur.x;
    const restored = fitToWorkArea({ ...backup, x }, area);
    const target = snapBounds(restored) || restored;

    // 先恢复最小尺寸，再设回大窗口，顺序反过来宽度会被 mini 的 minWidth 卡住
    win.setMinimumSize(DEFAULT_SIZE.minWidth, DEFAULT_SIZE.minHeight);
    win.setBounds(target);
    // 迷你条可能被拖到另一侧，退出后按它当前所在的边记住大窗口位置
    store.set({ bounds: target });
    miniBackup = null;
    miniSize = null;
  }

  store.set({ mini: enabled });
  if (tray) refreshTrayMenu();
  send('settings:changed', { mini: enabled });
  // 页面此时才切到 mini 样式，通知它重新量一次内容宽度
  if (enabled) send('ui:mini-measure');
}

/** 渲染进程量出迷你条内容宽度后调用，窗口按内容伸缩并保持贴边 */
function applyMiniWidth(width) {
  if (!win || win.isDestroyed() || !isMini) return;
  const value = Math.round(Number(width));
  if (!Number.isFinite(value) || value <= 0) return;

  const cur = win.getBounds();
  const area = screen.getDisplayMatching(cur).workArea;
  const w = Math.min(area.width, Math.max(MINI_SIZE.minWidth, value));
  if (Math.abs(w - cur.width) < 1) return;

  // 哪边离屏幕边缘近，就以哪边为锚点伸缩，避免窗口突然“跳”到中间
  const gapLeft = cur.x - area.x;
  const gapRight = area.x + area.width - (cur.x + cur.width);
  const anchorRight = gapRight <= gapLeft;
  const x = anchorRight ? area.x + area.width - gapRight - w : cur.x;

  let next = fitToWorkArea({ x, y: cur.y, width: w, height: cur.height }, area);
  next = snapBounds(next) || next;

  miniSize = { width: next.width, height: next.height };
  suppressPersistFor(300);
  win.setBounds(next);
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    pollQuotes();
    pollFlash();
  }
  if (tray) refreshTrayMenu();
}

function setAutoLaunch(on) {
  const enabled = Boolean(on);
  try {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
    } else {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [path.resolve(__dirname, '..'), '--hidden'],
      });
    }
  } catch (err) {
    console.error('[autolaunch] 设置失败:', err.message);
  }
  store.set({ autoLaunch: enabled });
  if (tray) refreshTrayMenu();
  send('settings:changed', { autoLaunch: enabled });
}

function applySettings(patch = {}) {
  const next = { ...patch };

  if ('opacity' in next) {
    store.set({ opacity: next.opacity });
    setOpacity(next.opacity);
  }
  if ('alwaysOnTop' in next) {
    store.set({ alwaysOnTop: Boolean(next.alwaysOnTop) });
    setAlwaysOnTop(next.alwaysOnTop);
  }
  if ('clickThrough' in next) setClickThrough(next.clickThrough);
  if ('mini' in next) applyMini(next.mini);
  if ('autoLaunch' in next) setAutoLaunch(next.autoLaunch);

  if ('importantOnly' in next) store.set({ importantOnly: Boolean(next.importantOnly) });
  if ('notify' in next) {
    const enabled = Boolean(next.notify);
    store.set({ notify: enabled });
    if (enabled) {
      showToast({ title: '重要快讯通知已开启', body: '金十重要快讯将在这里提醒你，点击通知可打开原文。' });
    }
  }
  if ('watch' in next) store.set({ watch: Array.isArray(next.watch) ? next.watch.slice(0, 40) : [] });
  if ('groups' in next) {
    store.set({ groups: next.groups });
    pollQuotes();
  }
  if ('quoteInterval' in next) {
    store.set({ quoteInterval: next.quoteInterval });
    scheduleQuotes();
  }
  if ('flashInterval' in next) {
    store.set({ flashInterval: next.flashInterval });
    scheduleFlash();
  }
  if ('quoteHeight' in next) {
    const h = Math.round(Number(next.quoteHeight));
    store.set({ quoteHeight: Number.isFinite(h) && h > 0 ? h : null });
  }

  if (tray) refreshTrayMenu();
  send('settings:changed', store.get());
  return store.get();
}

/* ---------------------------------------------------------------- 托盘 */

function refreshTrayMenu() {
  if (!tray) return;
  const s = store.get();
  tray.setToolTip(s.clickThrough ? '市场速览 · 点击穿透中（右键菜单可关闭）' : '市场速览 · 金十快讯');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // 穿透状态下把退出入口放最上面，避免用户找不到
      ...(s.clickThrough
        ? [
            { label: `退出点击穿透（${hotkeyText('through')}）`, click: () => setClickThrough(false) },
            { type: 'separator' },
          ]
        : []),
      { label: win && win.isVisible() ? '隐藏窗口' : '显示窗口', click: toggleVisibility },
      { type: 'separator' },
      { label: '迷你模式', type: 'checkbox', checked: s.mini, click: () => applyMini(!s.mini) },
      { label: '点击穿透', type: 'checkbox', checked: s.clickThrough, click: () => setClickThrough(!s.clickThrough) },
      { label: '始终置顶', type: 'checkbox', checked: s.alwaysOnTop, click: () => applyToggle('alwaysOnTop') },
      { label: '开机自启', type: 'checkbox', checked: s.autoLaunch, click: () => setAutoLaunch(!s.autoLaunch) },
      { type: 'separator' },
      {
        label: '立即刷新',
        click: () => {
          pollQuotes();
          pollFlash();
        },
      },
      {
        label: '在浏览器打开金十',
        click: () => shell.openExternal('https://www.jin10.com/'),
      },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
  );
}

// 托盘里的开关统一走这里，保证 store 与窗口状态一致
function applyToggle(key) {
  const s = store.get();
  applySettings({ [key]: !s[key] });
}

/* ---------------------------------------------------------------- 生命周期 */

function quitApp() {
  app.isQuitting = true;
  clearTimeout(quoteTimer);
  clearTimeout(flashTimer);
  clearTimeout(boundsTimer);
  clearTimeout(snapTimer);
  clearTimeout(suppressTimer);
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}

function createWindow() {
  const s = store.get();
  const bounds = normalizeBounds(s.bounds);

  win = new BrowserWindow({
    ...bounds,
    minWidth: DEFAULT_SIZE.minWidth,
    minHeight: DEFAULT_SIZE.minHeight,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    hasShadow: true,
    show: false,
    title: '市场速览',
    icon: createIcon(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    setOpacity(s.opacity);
    setAlwaysOnTop(s.alwaysOnTop);
    if (s.mini) applyMini(true);
    if (!process.argv.includes('--hidden')) win.show();
    if (s.clickThrough) setClickThrough(true);
    pollQuotes();
    pollFlash();
    scheduleQuotes();
    scheduleFlash();
  });

  win.on('move', () => {
    persistBounds();
    scheduleSnap();
  });
  win.on('resize', () => {
    persistBounds();
    scheduleSnap();
    send('window:resized', { mini: store.get('mini') });
  });
  win.on('show', () => {
    if (tray) refreshTrayMenu();
  });
  win.on('hide', () => {
    if (tray) refreshTrayMenu();
  });

  // 关闭按钮 = 收进托盘；真正退出走托盘菜单或设置面板
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function registerShortcuts() {
  const spec = [
    ['toggle', ['CommandOrControl+Alt+J'], '显示 / 隐藏窗口', toggleVisibility],
    ['mini', ['CommandOrControl+Alt+M'], '迷你模式', () => applyMini(!store.get('mini'))],
    [
      'through',
      ['CommandOrControl+Alt+O', 'CommandOrControl+Alt+P', 'CommandOrControl+Alt+T'],
      '点击穿透',
      () => setClickThrough(!store.get('clickThrough')),
    ],
  ];

  for (const [action, accels, label, handler] of spec) {
    let bound = null;
    for (const accel of accels) {
      try {
        // register 返回 false 表示被别的程序占用，不会抛异常
        if (globalShortcut.register(accel, handler)) {
          bound = accel;
          break;
        }
      } catch (err) {
        console.error(`[hotkey] ${accel} 注册异常:`, err.message);
      }
    }

    if (bound) {
      hotkeys[action] = bound;
      console.log(`[hotkey] ${label} -> ${bound}`);
    } else {
      console.error(`[hotkey] ${label} 所有候选键位都被占用: ${accels.join(' / ')}`);
    }
  }
}

/** CommandOrControl+Alt+O -> Ctrl+Alt+O，给界面和通知用 */
function hotkeyText(action) {
  const accel = hotkeys[action];
  if (!accel) return '托盘菜单';
  return accel.replace('CommandOrControl', 'Ctrl');
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    settings: store.get(),
    groups: GROUPS,
    quotes,
    flashes,
    lastQuoteAt,
    lastFlashAt,
    errors: lastError,
    hotkeys,
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:set', (_e, patch) => applySettings(patch || {}));
  ipcMain.handle('flash:open', (_e, id) => {
    if (typeof id === 'string' && id) shell.openExternal(`https://flash.jin10.com/detail/${id}`);
  });
  ipcMain.handle('link:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('window:action', (_e, name) => {
    if (name === 'hide') win && win.hide();
    if (name === 'quit') quitApp();
    if (name === 'mini') applyMini(!store.get('mini'));
    if (name === 'refresh') {
      pollQuotes();
      pollFlash();
    }
  });
  ipcMain.handle('window:mini-width', (_e, width) => applyMiniWidth(width));
}

/* ---------------------------------------------------------------- 启动 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    store = new Store(path.join(app.getPath('userData'), 'settings.json'));
    notifyIcon = createIcon(64);

    registerIpc();
    // 先注册热键，渲染进程初始化时才能拿到真实键位
    registerShortcuts();
    createWindow();

    tray = new Tray(createIcon(32));
    tray.setToolTip('市场速览 · 金十快讯');
    tray.on('click', toggleVisibility);
    refreshTrayMenu();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (win) win.show();
    });
  });

  app.on('window-all-closed', () => {
    // 常驻托盘，不随窗口关闭退出
  });

  app.on('will-quit', () => {
    clearTimeout(quoteTimer);
    clearTimeout(flashTimer);
    clearTimeout(boundsTimer);
    clearTimeout(snapTimer);
    clearTimeout(suppressTimer);
    globalShortcut.unregisterAll();
  });
}