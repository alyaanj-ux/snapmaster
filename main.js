const { app, screen, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let tray = null;
let editorWindow = null;
let assistWindow = null;
let hotkeysWindow = null;

const CONFIG_PATH = path.join(app.getPath('userData'), 'presets.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');

function loadPresets() {
  try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch(e) {}
  return [];
}
function savePresets(presets) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(presets, null, 2), 'utf8'); }

function runPS(lines) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), 'snap_' + Date.now() + '.ps1');
    fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
    exec('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + tmpFile + '"', (err, stdout) => {
      fs.unlink(tmpFile, () => {});
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// ---------------------------------------------------------------------------
// Win32 snapping
//
// One script builder serves both the hotkeys and the assist window. The only
// difference between them is which window handle gets snapped, so that is the
// single parameter: either a literal hwnd from the window list, or a live call
// to GetForegroundWindow() for the hotkey path.
//
// Coordinates arriving here are PHYSICAL pixels. powershell.exe is DPI-unaware,
// so without the SetThreadDpiAwarenessContext call Windows would hand it scaled
// window rects while DWM still reports physical frame bounds, and the border
// correction below would mix the two on any display not at 100%.
// ---------------------------------------------------------------------------
function buildSnapScript(hwndExpr, x, y, w, h) {
  return [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WinSnap {',
    '    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
    '    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
    '    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    '    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);',
    '    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);',
    '    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '    static void Place(IntPtr h, int x, int y, int w, int ht) {',
    // Windows 10/11 windows carry an invisible resize border. Without correcting
    // for it, the window sits inset from the zone by a few pixels on each side.
    '        RECT wr; RECT fb;',
    '        GetWindowRect(h, out wr);',
    '        int hr = DwmGetWindowAttribute(h, 9, out fb, Marshal.SizeOf(typeof(RECT)));',
    '        int mL = 0, mT = 0, mR = 0, mB = 0;',
    '        if (hr == 0) { mL = fb.Left - wr.Left; mT = fb.Top - wr.Top; mR = wr.Right - fb.Right; mB = wr.Bottom - fb.Bottom; }',
    '        SetWindowPos(h, IntPtr.Zero, x - mL, y - mT, w + mL + mR, ht + mT + mB, 0x0044);',
    '    }',
    '    public static void Snap(IntPtr h, int x, int y, int w, int ht) {',
    '        if (h == IntPtr.Zero) return;',
    // Per-monitor v2 (-4), falling back to per-monitor v1 (-3) on older Windows 10.
    '        try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetThreadDpiAwarenessContext(new IntPtr(-3)); } catch (EntryPointNotFoundException) {}',
    '        ShowWindow(h, 9);',
    '        int style = GetWindowLong(h, -16);',
    '        if ((style & 0x1000000) != 0) SetWindowLong(h, -16, style & ~0x1000000);',
    // Placed twice: moving a window onto a monitor with a different scale makes
    // it rescale itself and its border, so the margins are re-measured after.
    '        Place(h, x, y, w, ht);',
    '        Place(h, x, y, w, ht);',
    '    }',
    '}',
    '"@',
    '[WinSnap]::Snap(' + hwndExpr + ', ' + x + ', ' + y + ', ' + w + ', ' + h + ')',
  ];
}

// Zones are stored as fractions of the work area, so a layout drawn on one
// monitor lands correctly on any other resolution. Electron reports the work
// area in scaled (DIP) units; it is converted to physical pixels first so the
// fractions are applied in the same space SetWindowPos works in.
function zoneToRect(zone, display) {
  const { x: dx, y: dy, width: dw, height: dh } = screen.dipToScreenRect(null, display.workArea);
  const left = Math.round(dx + zone.x * dw);
  const top = Math.round(dy + zone.y * dh);
  return {
    x: left,
    y: top,
    w: Math.round(dx + (zone.x + zone.w) * dw) - left,
    h: Math.round(dy + (zone.y + zone.h) * dh) - top,
  };
}

function snapZone(zone, display, hwndExpr) {
  const r = zoneToRect(zone, display);
  return runPS(buildSnapScript(hwndExpr, r.x, r.y, r.w, r.h))
    .catch(e => console.error('Snap failed:', e.message));
}

function displayByIndex(i) {
  return screen.getAllDisplays()[i] || screen.getPrimaryDisplay();
}

// ---------------------------------------------------------------------------
// Global hotkeys
//
// Defaults avoid combinations apps commonly use (Alt+Left/Right is Back/Forward
// in every browser) and ones Windows 11 reserves (Win+Alt+Arrow). Users rebind
// them in the Hotkeys window; choices persist to settings.json by action id,
// so ids must never change.
// ---------------------------------------------------------------------------
const T = 1 / 3;
const ACTIONS = [
  { id: 'left-half',    label: 'Left Half',            defaultKey: 'Super+Alt+Shift+Left',  zone: { x: 0,   y: 0,   w: 0.5, h: 1   } },
  { id: 'right-half',   label: 'Right Half',           defaultKey: 'Super+Alt+Shift+Right', zone: { x: 0.5, y: 0,   w: 0.5, h: 1   } },
  { id: 'fullscreen',   label: 'Fullscreen',           defaultKey: 'Super+Alt+Shift+Up',    zone: { x: 0,   y: 0,   w: 1,   h: 1   } },
  { id: 'center-80',    label: 'Center 80%',           defaultKey: 'Super+Alt+Shift+Down',  zone: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { id: 'left-third',   label: 'Left Third',           defaultKey: 'Ctrl+Super+Alt+Left',   zone: { x: 0,   y: 0,   w: T,   h: 1   } },
  { id: 'middle-third', label: 'Middle Third',         defaultKey: 'Ctrl+Super+Alt+Up',     zone: { x: T,   y: 0,   w: T,   h: 1   } },
  { id: 'right-third',  label: 'Right Third',          defaultKey: 'Ctrl+Super+Alt+Right',  zone: { x: 2*T, y: 0,   w: T,   h: 1   } },
  { id: 'top-left',     label: 'Top Left Quarter',     defaultKey: 'Super+Alt+Shift+1',     zone: { x: 0,   y: 0,   w: 0.5, h: 0.5 } },
  { id: 'top-right',    label: 'Top Right Quarter',    defaultKey: 'Super+Alt+Shift+2',     zone: { x: 0.5, y: 0,   w: 0.5, h: 0.5 } },
  { id: 'bottom-left',  label: 'Bottom Left Quarter',  defaultKey: 'Super+Alt+Shift+3',     zone: { x: 0,   y: 0.5, w: 0.5, h: 0.5 } },
  { id: 'bottom-right', label: 'Bottom Right Quarter', defaultKey: 'Super+Alt+Shift+4',     zone: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  { id: 'center-60',    label: 'Center 60%',           defaultKey: 'Super+Alt+Shift+5',     zone: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
];

const ACCEL_RE = /^[A-Za-z0-9+\-=\[\]\\;',./`]{1,64}$/;

function defaultBindings() {
  return Object.fromEntries(ACTIONS.map(a => [a.id, a.defaultKey]));
}

// Returns a complete id -> accelerator|null map. Unknown ids and malformed
// values in the file are dropped rather than trusted.
function loadBindings() {
  const bindings = defaultBindings();
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).hotkeys || {};
    for (const a of ACTIONS) {
      if (!(a.id in saved)) continue;
      const v = saved[a.id];
      if (v === null || (typeof v === 'string' && ACCEL_RE.test(v))) bindings[a.id] = v;
    }
  } catch(e) {}
  return bindings;
}

// Written to a temp file then renamed, so a crash mid-write can't leave a
// half-written settings file behind.
function saveBindings(bindings) {
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ hotkeys: bindings }, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

let bindings = {};
let hotkeyStatus = {}; // id -> 'ok' | 'taken' | 'invalid' | 'unbound'

function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyStatus = {};
  for (const a of ACTIONS) {
    const accel = bindings[a.id];
    if (!accel) { hotkeyStatus[a.id] = 'unbound'; continue; }
    let ok;
    try {
      // register() returns false when Windows or another app already owns the
      // combination, and throws on a malformed accelerator.
      ok = globalShortcut.register(accel, () => {
        // Snap on whichever monitor the cursor is on, not always the primary.
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        snapZone(a.zone, display, '[WinSnap]::GetForegroundWindow()');
      });
      hotkeyStatus[a.id] = ok ? 'ok' : 'taken';
    } catch(e) {
      hotkeyStatus[a.id] = 'invalid';
    }
  }
  const failed = ACTIONS.filter(a => hotkeyStatus[a.id] === 'taken' || hotkeyStatus[a.id] === 'invalid');
  if (failed.length) console.warn('Hotkeys unavailable: ' + failed.map(a => bindings[a.id]).join(', '));
  if (tray) buildTrayMenu();
  return failed;
}

function hotkeyState() {
  return ACTIONS.map(a => ({
    id: a.id, label: a.label,
    accelerator: bindings[a.id] || null,
    defaultAccelerator: a.defaultKey,
    status: hotkeyStatus[a.id] || 'unbound',
  }));
}

function prettyAccel(accel) {
  return accel.replace(/Super/g, 'Win').replace(/\+/g, ' + ');
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function openEditor() {
  if (editorWindow && !editorWindow.isDestroyed()) { editorWindow.focus(); return; }
  editorWindow = new BrowserWindow({
    width: 820, height: 620, minWidth: 700, minHeight: 540,
    title: 'SnapMaster', backgroundColor: '#0a0a0e', icon: ICON_PATH,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(__dirname, 'preload.js') }
  });
  editorWindow.loadFile(path.join(__dirname, 'editor.html'));
  editorWindow.setMenuBarVisibility(false);
}

function openAssist() {
  if (assistWindow && !assistWindow.isDestroyed()) { assistWindow.focus(); return; }
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workArea;
  assistWindow = new BrowserWindow({
    width: 540, height: 500, minWidth: 420, minHeight: 360,
    x: Math.round((width - 540) / 2), y: Math.round((height - 500) / 2),
    frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: false,
    backgroundColor: '#0a0a0e', icon: ICON_PATH,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false, preload: path.join(__dirname, 'preload.js') }
  });
  assistWindow.loadFile(path.join(__dirname, 'assist.html'));
}

function openHotkeys() {
  if (hotkeysWindow && !hotkeysWindow.isDestroyed()) { hotkeysWindow.focus(); return; }
  hotkeysWindow = new BrowserWindow({
    width: 560, height: 620, minWidth: 480, minHeight: 420,
    title: 'SnapMaster Hotkeys', backgroundColor: '#0a0a0e', icon: ICON_PATH,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  // No menu at all: a hidden menu bar still steals a lone Alt press, which the
  // key recorder needs to see.
  hotkeysWindow.setMenu(null);
  hotkeysWindow.loadFile(path.join(__dirname, 'hotkeys.html'));
  // Recording suspends every hotkey; closing mid-recording must not leave them off.
  hotkeysWindow.on('closed', () => { hotkeysWindow = null; registerHotkeys(); });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-displays', () =>
  screen.getAllDisplays().map((d, i) => {
    // Reported in physical pixels so the UI shows the resolution the user
    // knows their monitor by, not the scaled size Electron works in.
    const phys = screen.dipToScreenRect(null, d.bounds);
    return {
      index: i, id: d.id,
      size: { width: phys.width, height: phys.height },
      scaleFactor: d.scaleFactor,
      workArea: d.workArea,
      isPrimary: d.id === screen.getPrimaryDisplay().id
    };
  })
);
ipcMain.handle('load-presets', () => loadPresets());
ipcMain.handle('save-presets', (e, presets) => { savePresets(presets); return true; });

ipcMain.handle('snap-window', (e, zone, displayIndex) =>
  snapZone(zone, displayByIndex(displayIndex), '[WinSnap]::GetForegroundWindow()')
);

ipcMain.handle('snap-window-by-hwnd', (e, hwnd, zone, displayIndex) => {
  if (typeof hwnd !== 'string' || !/^\d+$/.test(hwnd)) {
    return { error: 'Invalid window handle.' };
  }
  return snapZone(zone, displayByIndex(displayIndex), '[IntPtr]' + hwnd);
});

ipcMain.handle('get-windows', () => {
  return runPS([
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class WinList {',
    '    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
    '    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
    '    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);',
    '    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);',
    '    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '    public static List<string> GetWindows() {',
    '        var list = new List<string>();',
    '        EnumWindows((hWnd, lParam) => {',
    '            if (!IsWindowVisible(hWnd)) return true;',
    '            if (GetAncestor(hWnd, 3) != hWnd) return true;',
    '            int cloaked = 0;',
    '            DwmGetWindowAttribute(hWnd, 14, out cloaked, 4);',
    '            if (cloaked != 0) return true;',
    '            int style = GetWindowLong(hWnd, -16);',
    '            int exStyle = GetWindowLong(hWnd, -20);',
    '            if ((style & 0x10000000) == 0) return true;',
    '            if ((exStyle & 0x00000080) != 0) return true;',
    '            if ((exStyle & 0x00000008) != 0) return true;',
    '            int len = GetWindowTextLength(hWnd);',
    '            if (len < 3) return true;',
    '            var sb = new StringBuilder(len + 1);',
    '            GetWindowText(hWnd, sb, sb.Capacity);',
    '            string title = sb.ToString().Trim();',
    '            if (title.Length < 3) return true;',
    '            if (title == "Program Manager" || title == "Windows Input Experience" || title == "SnapMaster") return true;',
    '            if (title.StartsWith("Microsoft Text") || title.StartsWith("Windows.UI")) return true;',
    '            if (title.Length > 0) list.Add(hWnd.ToInt64() + "|" + title);',
    '            return true;',
    '        }, IntPtr.Zero);',
    '        return list;',
    '    }',
    '}',
    '"@',
    '$wins = [WinList]::GetWindows()',
    '$wins | ForEach-Object { $_ }',
  ]).then(stdout => {
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const idx = line.indexOf('|');
      if (idx === -1) return null;
      const hwnd = line.substring(0, idx).trim();
      const title = line.substring(idx+1).trim();
      if (!hwnd || !title) return null;
      return { hwnd, title };
    }).filter(Boolean);
  }).catch(e => { console.error('Window enumeration failed:', e.message); return []; });
});

ipcMain.handle('close-assist', () => { if (assistWindow && !assistWindow.isDestroyed()) assistWindow.close(); });

ipcMain.handle('open-hotkeys', () => openHotkeys());
ipcMain.handle('get-hotkeys', () => hotkeyState());

// While the recorder is listening, every hotkey is released so the combination
// the user presses reaches the page instead of snapping a window.
ipcMain.handle('suspend-hotkeys', () => { globalShortcut.unregisterAll(); return true; });
ipcMain.handle('resume-hotkeys', () => { registerHotkeys(); return hotkeyState(); });

ipcMain.handle('set-hotkeys', (e, next) => {
  if (!next || typeof next !== 'object') return { error: 'Invalid hotkey settings.' };
  const candidate = {};
  for (const a of ACTIONS) {
    const v = a.id in next ? next[a.id] : bindings[a.id];
    if (v !== null && !(typeof v === 'string' && ACCEL_RE.test(v))) return { error: 'Invalid hotkey for ' + a.label + '.' };
    candidate[a.id] = v;
  }
  const seen = new Map();
  for (const a of ACTIONS) {
    const v = candidate[a.id];
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) return { error: prettyAccel(v) + ' is assigned to both ' + seen.get(key) + ' and ' + a.label + '.' };
    seen.set(key, a.label);
  }
  bindings = candidate;
  try { saveBindings(bindings); } catch(err) { console.error('Saving hotkeys failed:', err.message); registerHotkeys(); return { error: 'Could not save hotkeys: ' + err.message, hotkeys: hotkeyState() }; }
  registerHotkeys();
  return { hotkeys: hotkeyState() };
});

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function buildTrayMenu() {
  const hotkeyItems = ACTIONS.map(a => {
    const accel = bindings[a.id];
    const st = hotkeyStatus[a.id];
    const suffix = !accel ? 'not set' : st === 'ok' ? prettyAccel(accel) : prettyAccel(accel) + ' (unavailable)';
    return { label: a.label + '  —  ' + suffix, enabled: false };
  });

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SnapMaster', enabled: false },
    { type: 'separator' },
    { label: 'Snap Window', click: openAssist },
    { label: 'Open Editor', click: openEditor },
    { type: 'separator' },
    { label: 'Hotkeys', submenu: [...hotkeyItems, { type: 'separator' }, { label: 'Change Hotkeys…', click: openHotkeys }] },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

function createTray() {
  // Falls back to an empty image rather than crashing if the icon is missing.
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) console.warn('Tray icon missing at ' + ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('SnapMaster');
  buildTrayMenu();
  tray.on('click', openAssist);
  tray.on('double-click', openEditor);
  tray.on('balloon-click', openHotkeys);
}

// A second launch should surface the running instance, not start a rival copy
// that fights over the same global hotkeys.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openEditor());

  app.whenReady().then(() => {
    bindings = loadBindings();
    createTray();
    const failed = registerHotkeys();
    if (failed.length) {
      // Without this the user presses a hotkey, nothing happens, and they
      // reasonably conclude the app is broken.
      tray.displayBalloon({
        iconType: 'warning',
        title: 'Some SnapMaster hotkeys are unavailable',
        content: failed.length + ' hotkey' + (failed.length > 1 ? 's are' : ' is') +
          ' already used by Windows or another app. Click here to choose different keys.'
      });
    }
    openEditor();
    console.log('SnapMaster running.');
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => e.preventDefault());
}
