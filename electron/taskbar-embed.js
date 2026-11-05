'use strict';

/**
 * 把窗口挂进 Windows 任务栏（Shell_TrayWnd）的实验性实现。
 *
 * 微软没有给 Windows 11 的 XAML 任务栏提供 DeskBand 之类的受支持接口，
 * 这里用 SetParent 把窗口变成任务栏的子窗口：它会被任务栏裁剪、跟随任务栏移动。
 * 代价是 Explorer 重启时任务栏销毁会连带销毁子窗口，主进程需要重建窗口。
 */

const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;

let api = null;
let state = null;

function load() {
  if (api !== null) return api || null;
  if (process.platform !== 'win32') {
    api = false;
    return null;
  }

  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    api = {
      FindWindowW: lib.func('void* FindWindowW(const char16_t* cls, const char16_t* name)'),
      GetWindowLongPtrW: lib.func('int64_t GetWindowLongPtrW(void* h, int index)'),
      SetWindowLongPtrW: lib.func('int64_t SetWindowLongPtrW(void* h, int index, int64_t value)'),
      SetParent: lib.func('void* SetParent(void* child, void* parent)'),
      GetParent: lib.func('void* GetParent(void* h)'),
      SetWindowPos: lib.func(
        'bool SetWindowPos(void* h, void* after, int x, int y, int cx, int cy, uint32_t flags)',
      ),
    };
  } catch (err) {
    console.error('[taskbar-embed] koffi 加载失败:', err.message);
    api = false;
  }
  return api || null;
}

function available() {
  return Boolean(load());
}

function hwndOf(buffer) {
  if (buffer.length >= 8) return buffer.readBigUInt64LE(0);
  return BigInt(buffer.readUInt32LE(0));
}

function trayHandle() {
  const tray = api.FindWindowW('Shell_TrayWnd', null);
  if (!tray) return null;
  return tray;
}

function setChildStyle(hwnd, style) {
  const next = (style & ~WS_POPUP) | WS_CHILD;
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, next);
  return next;
}

function setTopLevelStyle(hwnd, style) {
  const next = (style & ~WS_CHILD) | WS_POPUP;
  api.SetWindowLongPtrW(hwnd, GWL_STYLE, next);
  return next;
}

/**
 * 挂进任务栏。
 * @param {Buffer} handleBuf win.getNativeWindowHandle()
 * @param {{x:number,y:number,width:number,height:number}} rect 屏幕物理像素
 * @param {{x:number,y:number}} origin 任务栏客户区左上角的屏幕物理坐标
 */
function attach(handleBuf, rect, origin) {
  if (!available()) return false;
  if (state) detach();

  const hwnd = hwndOf(handleBuf);
  const tray = trayHandle();
  if (!tray) return false;

  const style = Number(api.GetWindowLongPtrW(hwnd, GWL_STYLE));
  state = { hwnd, tray, style };

  setChildStyle(hwnd, style);
  api.SetParent(hwnd, tray);
  api.SetWindowPos(
    hwnd,
    null,
    Math.round(rect.x - origin.x),
    Math.round(rect.y - origin.y),
    Math.round(rect.width),
    Math.round(rect.height),
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
  );
  return true;
}

/** 只改位置和宽度，仍然留在任务栏里；rect 为屏幕物理像素 */
function move(rect, origin) {
  if (!state) return false;
  api.SetWindowPos(
    state.hwnd,
    null,
    Math.round(rect.x - origin.x),
    Math.round(rect.y - origin.y),
    Math.round(rect.width),
    Math.round(rect.height),
    SWP_NOZORDER | SWP_NOACTIVATE,
  );
  return true;
}

/** 回到普通顶层窗口；rect 为解绑后要落到的屏幕物理位置 */
function detach(rect) {
  if (!state) return false;
  const { hwnd, style } = state;

  api.SetParent(hwnd, null);
  setTopLevelStyle(hwnd, style);
  if (rect) {
    api.SetWindowPos(
      hwnd,
      null,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
  }

  state = null;
  return true;
}

function isAttached() {
  return Boolean(state);
}

module.exports = { available, attach, move, detach, isAttached };