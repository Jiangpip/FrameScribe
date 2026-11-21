// 读“现在最前面的窗口”：标题、程序名、位置（物理像素）。装不上 koffi 时返回 null，软件退回整屏截图
let api = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll'), dwm = koffi.load('dwmapi.dll'), k32 = koffi.load('kernel32.dll');
  koffi.struct('BN_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  api = {
    GetForegroundWindow: user32.func('uintptr_t GetForegroundWindow()'),
    GetWindowTextW: user32.func('int GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t *buf, int max)'),
    GetWindowRect: user32.func('bool GetWindowRect(uintptr_t hWnd, _Out_ BN_RECT *r)'),
    GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *pid)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(uintptr_t hWnd)'),
    IsWindow: user32.func('bool IsWindow(uintptr_t hWnd)'),
    DwmGetWindowAttribute: dwm.func('long DwmGetWindowAttribute(uintptr_t hWnd, uint32_t attr, _Out_ BN_RECT *r, uint32_t cb)'),
    OpenProcess: k32.func('uintptr_t OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: k32.func('bool QueryFullProcessImageNameW(uintptr_t h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'),
    CloseHandle: k32.func('bool CloseHandle(uintptr_t h)')
  };
} catch (e) {
  console.error('[win32] koffi 不可用，退回整屏截图：', e.message);
}

const wstr = (arr, n) => Buffer.from(arr.buffer, arr.byteOffset, n * 2).toString('utf16le');

function foreground() {
  if (!api) return null;
  try {
    const hwnd = api.GetForegroundWindow();
    if (!hwnd) return null;
    const tb = new Uint16Array(512);
    const n = api.GetWindowTextW(hwnd, tb, 512);
    const title = wstr(tb, Math.max(0, n));
    const r = {};
    // 9 = DWMWA_EXTENDED_FRAME_BOUNDS：不含窗口阴影的真实边界
    if (api.DwmGetWindowAttribute(hwnd, 9, r, 16) !== 0) api.GetWindowRect(hwnd, r);
    const pid = [0];
    api.GetWindowThreadProcessId(hwnd, pid);
    let exe = '';
    const h = api.OpenProcess(0x1000, false, pid[0]); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h) {
      const eb = new Uint16Array(520), size = [520];
      if (api.QueryFullProcessImageNameW(h, 0, eb, size)) exe = wstr(eb, size[0]).split('\\').pop();
      api.CloseHandle(h);
    }
    return { hwnd, title, exe, pid: pid[0], rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } };
  } catch (e) {
    console.error('[win32] foreground 失败：', e.message);
    return null;
  }
}

function focus(hwnd) {
  if (!api || !hwnd) return false;
  try { return api.IsWindow(hwnd) && api.SetForegroundWindow(hwnd); } catch (e) { return false; }
}

module.exports = { available: !!api, foreground, focus };

if (require.main === module) console.log(JSON.stringify(foreground(), (k, v) => typeof v === 'bigint' ? String(v) : v));
