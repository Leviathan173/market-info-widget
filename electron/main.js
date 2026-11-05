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
const taskbarEmbed = require('./taskbar-embed');

const DEFAULT_SIZE = { width: 408, height: 726, minWidth: 330, minHeight: 260 };
// width 只是渲染进程量出内容宽度之前的初始值，拿到实际宽度后会立即自适应
const MINI_SIZE = { width: 360, height: 140, minWidth: 200 };
// 任务栏模式：高度由系统任务栏厚度决定，这里只约束宽度
const TASKBAR_SIZE = { width: 380, minWidth: 120, minHeight: 30 };
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
// 任务栏模式：嵌在系统任务栏里的横条
let isTaskbar = false;
let taskbarBackup = null;
let taskbarSize = null;
let taskbarTimer = null;
// 是否已经用 SetParent 挂进任务栏（实验性真嵌入）
let embedded = false;
// 普通任务栏条会被任务栏的置顶抢到后面，定时重新抬到最上层
let taskbarKeeper = null;
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

const clamp = (value, min, max) => Math.min(Math.max(min, value), Math.max(min, max));

/**
 * 取当前屏幕任务栏的位置和厚度（逻辑像素）。
 * 任务栏自动隐藏或没有任务栏时返回 null。
 */
function taskbarGeometry(bounds = null) {
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const b = display.bounds;
  const a = display.workArea;
  const bottom = b.y + b.height - (a.y + a.height);
  const top = a.y - b.y;
  const thickness = Math.max(bottom, top);
  if (thickness < 24) return null;

  const atBottom = bottom >= top;
  return {
    area: a,
    thickness,
    y: atBottom ? b.y + b.height - thickness : b.y,
  };
}

/** 任务栏条当前应该在屏幕上的位置（逻辑像素，含任务栏厚度） */
function taskbarBounds() {
  if (!win || win.isDestroyed()) return null;
  const cur = win.getBounds();
  const bar = taskbarGeometry(cur);
  if (!bar) return null;
  return { x: cur.x, y: bar.y, width: cur.width, height: bar.thickness };
}

/**
 * 计算真嵌入所需的物理像素参数。
 * 目前只支持主屏（副屏任务栏是另一个窗口，位置换算容易出错）。
 */
function embedGeometry() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  if (display.id !== screen.getPrimaryDisplay().id) return null;

  const bar = taskbarGeometry(bounds);
  if (!bar) return null;

  const rect = { x: bounds.x, y: bar.y, width: bounds.width, height: bar.thickness };
  return {
    rect,
    physical: screen.dipToScreenRect(win, rect),
    origin: screen.dipToScreenPoint({ x: display.bounds.x, y: bar.y }),
  };
}

function attachEmbed() {
  if (!isTaskbar || embedded || !store.get('taskbarEmbed')) return false;
  if (!win || win.isDestroyed() || !taskbarEmbed.available()) return false;

  const geo = embedGeometry();
  if (!geo) return false;

  const ok = taskbarEmbed.attach(win.getNativeWindowHandle(), geo.physical, geo.origin);
  embedded = Boolean(ok);
  return embedded;
}

function detachEmbed(rect = taskbarBounds()) {
  if (!embedded) return;
  const physical = rect ? screen.dipToScreenRect(win, rect) : null;
  taskbarEmbed.detach(physical);
  embedded = false;
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
  if (!win || win.isDestroyed() || isTaskbar) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || suppressPersist || isTaskbar) return;
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
  if (!win || win.isDestroyed() || store.get('mini') || isTaskbar || suppressPersist) return;
  writeBounds();
}

function persistBounds() {
  if (!win || win.isDestroyed() || store.get('mini') || isTaskbar || suppressPersist) return;
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
  // 迷你模式和任务栏模式互斥，先从任务栏条回到普通窗口再收缩
  if (enabled && isTaskbar) applyTaskbar(false);
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

/** 渲染进程量出迷你条 / 任务栏条内容宽度后调用，窗口按内容伸缩并保持贴边 */
function applyMiniWidth(width) {
  if (!win || win.isDestroyed() || (!isMini && !isTaskbar)) return;
  const value = Math.round(Number(width));
  if (!Number.isFinite(value) || value <= 0) return;

  const cur = win.getBounds();

  // 任务栏模式：只改宽度，高度和贴底位置保持不动
  if (isTaskbar) {
    const bar = taskbarGeometry(cur);
    if (!bar) return;
    const w = Math.min(bar.area.width - 16, Math.max(TASKBAR_SIZE.minWidth, value));
    if (Math.abs(w - cur.width) < 1) return;

    const savedX = Number(store.get('taskbarX'));
    const x = clamp(
      Number.isFinite(savedX) ? savedX : cur.x,
      bar.area.x,
      bar.area.x + bar.area.width - w,
    );
    const rect = { x, y: bar.y, width: w, height: bar.thickness };
    taskbarSize = { width: w, height: bar.thickness };
    suppressPersistFor(300);

    if (embedded) {
      const display = screen.getDisplayMatching(cur);
      const physical = screen.dipToScreenRect(win, rect);
      const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: bar.y });
      taskbarEmbed.move(physical, origin);
    } else {
      win.setBounds(rect);
      win.moveTop();
    }

    store.set({ taskbarX: x, taskbarWidth: w });
    return;
  }

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

/**
 * 缩到任务栏：用迷你样式贴在系统任务栏里显示（类似鲁大师的任务栏监控条）。
 * 再次调用即回到原来的普通窗口。
 */
function applyTaskbar(on) {
  if (!win || win.isDestroyed()) return;
  const enabled = Boolean(on);
  if (enabled === isTaskbar) return;

  // 迷你条和任务栏条互斥，先恢复普通窗口再进任务栏
  if (enabled && isMini) applyMini(false);

  const bar = enabled ? taskbarGeometry(win.getBounds()) : null;
  if (enabled && !bar) {
    // 任务栏自动隐藏时没有可用的条带位置，退回迷你模式
    applyMini(true);
    return;
  }

  // 切换期间既不落盘也不吸边
  suppressPersistFor(600);

  if (enabled) {
    taskbarBackup = win.getBounds();
    isTaskbar = true;

    const savedW = Math.round(Number(store.get('taskbarWidth')) || TASKBAR_SIZE.width);
    const width = clamp(savedW, TASKBAR_SIZE.minWidth, bar.area.width - 16);
    const savedX = Number(store.get('taskbarX'));
    const x = clamp(
      Number.isFinite(savedX) ? savedX : bar.area.x + 8,
      bar.area.x,
      bar.area.x + bar.area.width - width,
    );

    // 任务栏是 topmost，普通置顶盖不住；screen-saver 层级才在它上面
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setResizable(false);
    win.setMinimumSize(TASKBAR_SIZE.minWidth, TASKBAR_SIZE.minHeight);
    taskbarSize = { width, height: bar.thickness };
    win.setBounds({ x, y: bar.y, width, height: bar.thickness });
    win.moveTop();
    store.set({ taskbarX: x, taskbarWidth: width });

    // 设置里开了实验性真嵌入才挂进任务栏
    if (store.get('taskbarEmbed') && !attachEmbed()) {
      showToast({
        title: '没能嵌入任务栏',
        body: '已改用普通任务栏条。真嵌入需要 Windows 主屏，且依赖的原生模块要能加载。',
      });
    }
  } else {
    isTaskbar = false;

    const backup = taskbarBackup ? normalizeBounds(taskbarBackup) : normalizeBounds(store.get('bounds'));
    const area = screen.getDisplayMatching(backup).workArea;
    const target = fitToWorkArea(backup, area);

    // 先摘掉任务栏父子关系，再按顶层窗口恢复尺寸
    detachEmbed();
    win.setResizable(true);
    win.setMinimumSize(DEFAULT_SIZE.minWidth, DEFAULT_SIZE.minHeight);
    win.setBounds(target);
    setAlwaysOnTop(store.get('alwaysOnTop'));
    taskbarBackup = null;
    taskbarSize = null;
  }

  store.set({ taskbar: enabled });
  if (enabled) startTaskbarKeeper();
  else stopTaskbarKeeper();
  if (tray) refreshTrayMenu();
  send('settings:changed', { taskbar: enabled, mini: store.get('mini'), taskbarEmbedded: embedded });
  // 页面切到新样式后重新量一次内容宽度
  send('ui:mini-measure');
}

/** 实验性开关：把任务栏条真正挂进任务栏窗口树 */
function setTaskbarEmbed(on) {
  const enabled = Boolean(on);

  if (enabled && !taskbarEmbed.available()) {
    store.set({ taskbarEmbed: false });
    showToast({
      title: '真嵌入不可用',
      body: '当前系统没能加载原生模块，仍使用普通任务栏条。',
    });
    send('settings:changed', { taskbarEmbed: false, taskbarEmbedded: false });
    if (tray) refreshTrayMenu();
    return;
  }

  store.set({ taskbarEmbed: enabled });

  if (isTaskbar) {
    if (enabled) {
      if (!attachEmbed()) {
        showToast({
          title: '没能嵌入任务栏',
          body: '已改用普通任务栏条。真嵌入目前只支持任务栏在主屏且任务栏未自动隐藏。',
        });
      }
    } else {
      const rect = taskbarBounds();
      detachEmbed(rect);
      if (rect) {
        suppressPersistFor(300);
        win.setBounds(rect);
        win.moveTop();
      }
    }
  }

  if (tray) refreshTrayMenu();
  send('settings:changed', { taskbarEmbed: enabled, taskbarEmbedded: embedded });
}

/** 普通任务栏条会被任务栏重新压到下面，定时抬回最上层（真嵌入时不需要） */
function startTaskbarKeeper() {
  stopTaskbarKeeper();
  taskbarKeeper = setInterval(() => {
    if (!win || win.isDestroyed() || !isTaskbar) {
      stopTaskbarKeeper();
      return;
    }
    if (!embedded) win.moveTop();
  }, 1500);
}

function stopTaskbarKeeper() {
  if (taskbarKeeper) clearInterval(taskbarKeeper);
  taskbarKeeper = null;
}

/* 手动拖动任务栏条：子窗口没法用系统拖动，统一由渲染进程发位移、主进程改坐标 */
let taskbarDrag = null;

function handleTaskbarDrag(phase, dx) {
  if (!win || win.isDestroyed() || !isTaskbar) return;

  if (phase === 'start') {
    taskbarDrag = win.getBounds();
    return;
  }
  if (phase === 'end') {
    taskbarDrag = null;
    return;
  }
  if (!taskbarDrag) taskbarDrag = win.getBounds();

  const bar = taskbarGeometry(win.getBounds());
  if (!bar) return;

  const size = taskbarSize || { width: taskbarDrag.width, height: bar.thickness };
  const width = clamp(size.width, TASKBAR_SIZE.minWidth, bar.area.width - 16);
  const x = clamp(taskbarDrag.x + (Number(dx) || 0), bar.area.x, bar.area.x + bar.area.width - width);
  const rect = { x, y: bar.y, width, height: bar.thickness };

  suppressPersistFor(120);
  if (embedded) {
    const display = screen.getDisplayMatching(win.getBounds());
    const physical = screen.dipToScreenRect(win, rect);
    const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: bar.y });
    taskbarEmbed.move(physical, origin);
  } else {
    win.setBounds(rect);
    win.moveTop();
  }

  store.set({ taskbarX: x, taskbarWidth: width });
}

/** 任务栏条被拖动后：贴回任务栏、夹在屏幕内，并记住横向位置 */
function scheduleTaskbarPersist() {
  if (!isTaskbar || embedded) return;
  clearTimeout(taskbarTimer);
  taskbarTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || !isTaskbar) return;
    const bar = taskbarGeometry(win.getBounds());
    if (!bar) return;

    const cur = win.getBounds();
    const size = taskbarSize || { width: cur.width, height: bar.thickness };
    const width = clamp(size.width, TASKBAR_SIZE.minWidth, bar.area.width - 16);
    const x = clamp(cur.x, bar.area.x, bar.area.x + bar.area.width - width);
    const next = { x, y: bar.y, width, height: bar.thickness };

    store.set({ taskbarX: x, taskbarWidth: width });
    if (x !== cur.x || next.y !== cur.y || next.height !== cur.height) {
      suppressPersistFor(180);
      win.setBounds(next);
      win.moveTop();
    }
  }, 220);
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
  if ('taskbar' in next) applyTaskbar(next.taskbar);
  if ('taskbarEmbed' in next) setTaskbarEmbed(next.taskbarEmbed);
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
      { label: '任务栏模式', type: 'checkbox', checked: s.taskbar, click: () => applyTaskbar(!s.taskbar) },
      {
        label: '真嵌入任务栏（实验性）',
        type: 'checkbox',
        checked: s.taskbarEmbed,
        click: () => setTaskbarEmbed(!s.taskbarEmbed),
      },
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
  stopTaskbarKeeper();
  clearTimeout(quoteTimer);
  clearTimeout(flashTimer);
  clearTimeout(boundsTimer);
  clearTimeout(snapTimer);
  clearTimeout(suppressTimer);
  clearTimeout(taskbarTimer);
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
    if (s.taskbar) applyTaskbar(true);
    else if (s.mini) applyMini(true);
    if (!process.argv.includes('--hidden')) win.show();
    if (s.clickThrough) setClickThrough(true);
    pollQuotes();
    pollFlash();
    scheduleQuotes();
    scheduleFlash();
  });

  win.on('move', () => {
    if (isTaskbar) {
      scheduleTaskbarPersist();
      return;
    }
    persistBounds();
    scheduleSnap();
  });
  win.on('resize', () => {
    if (isTaskbar) {
      scheduleTaskbarPersist();
      send('window:resized', { mini: false });
      return;
    }
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

  // 真嵌入时任务栏销毁会连带销毁子窗口（例如 Explorer 重启），稍后按设置重建
  win.on('closed', () => {
    win = null;
    embedded = false;
    isTaskbar = false;
    stopTaskbarKeeper();
    taskbarBackup = null;
    taskbarSize = null;
    if (tray) refreshTrayMenu();
    if (app.isQuitting) return;

    setTimeout(() => {
      if (!win && !app.isQuitting) {
        console.log('[window] 窗口随任务栏销毁，正在重建');
        createWindow();
      }
    }, 1500);
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
    taskbarEmbedded: embedded,
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
    if (name === 'taskbar') applyTaskbar(!isTaskbar);
    if (name === 'taskbar-embed') setTaskbarEmbed(!store.get('taskbarEmbed'));
    if (name === 'refresh') {
      pollQuotes();
      pollFlash();
    }
  });
  ipcMain.handle('window:mini-width', (_e, width) => applyMiniWidth(width));
  ipcMain.on('window:taskbar-drag', (_e, phase, dx) => handleTaskbarDrag(phase, dx));
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
    stopTaskbarKeeper();
    clearTimeout(quoteTimer);
    clearTimeout(flashTimer);
    clearTimeout(boundsTimer);
    clearTimeout(snapTimer);
    clearTimeout(suppressTimer);
    clearTimeout(taskbarTimer);
    globalShortcut.unregisterAll();
  });
}