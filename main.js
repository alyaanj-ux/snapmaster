const { app, screen, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let tray = null;
let editorWindow = null;
let assistWindow = null;

const CONFIG_PATH = path.join(app.getPath('userData'), 'presets.json');
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
    '    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);',
    '    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
    '    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);',
    '    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    '    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);',
    '    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '    public static void Snap(IntPtr h, int x, int y, int w, int ht) {',
    '        if (h == IntPtr.Zero) return;',
    '        ShowWindow(h, 9);',
    '        int style = GetWindowLong(h, -16);',
    '        if ((style & 0x1000000) != 0) SetWindowLong(h, -16, style & ~0x1000000);',
    // Windows 10/11 windows carry an invisible resize border. Without correcting
    // for it, the window sits inset from the zone by a few pixels on each side.
    '        RECT wr; RECT fb;',
    '        GetWindowRect(h, out wr);',
    '        int hr = DwmGetWindowAttribute(h, 9, out fb, Marshal.SizeOf(typeof(RECT)));',
    '        int mL = 0, mT = 0, mR = 0, mB = 0;',
    '        if (hr == 0) { mL = fb.Left - wr.Left; mT = fb.Top - wr.Top; mR = wr.Right - fb.Right; mB = wr.Bottom - fb.Bottom; }',
    '        int tx = x - mL; int ty = y - mT; int tw = w + mL + mR; int th = ht + mT + mB;',
    '        SetWindowPos(h, IntPtr.Zero, tx, ty, tw, th, 0x0044);',
    '        MoveWindow(h, tx, ty, tw, th, true);',
    '        SetWindowPos(h, IntPtr.Zero, tx, ty, tw, th, 0x0044);',
    '    }',
    '}',
    '"@',
    '[WinSnap]::Snap(' + hwndExpr + ', ' + x + ', ' + y + ', ' + w + ', ' + h + ')',
  ];
}

// Zones are stored as fractions of the work area, so a layout drawn on one
// monitor lands correctly on any other resolution.
function zoneToRect(zone, display) {
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  return {
    x: Math.round(dx + zone.x * dw),
    y: Math.round(dy + zone.y * dh),
    w: Math.round(zone.w * dw),
    h: Math.round(zone.h * dh),
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
// ---------------------------------------------------------------------------
const T = 1 / 3;
const HOTKEYS = {
  'Alt+Left':        { label: 'Left Half',            zone: { x: 0,   y: 0,   w: 0.5, h: 1   } },
  'Alt+Right':       { label: 'Right Half',           zone: { x: 0.5, y: 0,   w: 0.5, h: 1   } },
  'Alt+Up':          { label: 'Fullscreen',           zone: { x: 0,   y: 0,   w: 1,   h: 1   } },
  'Alt+Down':        { label: 'Center 80%',           zone: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  'Alt+Shift+Left':  { label: 'Left Third',           zone: { x: 0,   y: 0,   w: T,   h: 1   } },
  'Alt+Shift+Up':    { label: 'Middle Third',         zone: { x: T,   y: 0,   w: T,   h: 1   } },
  'Alt+Shift+Right': { label: 'Right Third',          zone: { x: 2*T, y: 0,   w: T,   h: 1   } },
  'Alt+1':           { label: 'Top Left Quarter',     zone: { x: 0,   y: 0,   w: 0.5, h: 0.5 } },
  'Alt+2':           { label: 'Top Right Quarter',    zone: { x: 0.5, y: 0,   w: 0.5, h: 0.5 } },
  'Alt+3':           { label: 'Bottom Left Quarter',  zone: { x: 0,   y: 0.5, w: 0.5, h: 0.5 } },
  'Alt+4':           { label: 'Bottom Right Quarter', zone: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  'Alt+5':           { label: 'Center 60%',           zone: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
  'Alt+6':           { label: 'Fullscreen',           zone: { x: 0,   y: 0,   w: 1,   h: 1   } },
};

function registerHotkeys() {
  const failed = [];
  for (const [accel, def] of Object.entries(HOTKEYS)) {
    // register() returns false when another app already owns the combination.
    const ok = globalShortcut.register(accel, () => {
      // Snap on whichever monitor the cursor is on, not always the primary.
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      snapZone(def.zone, display, '[WinSnap]::GetForegroundWindow()');
    });
    if (!ok) failed.push(accel);
  }
  const total = Object.keys(HOTKEYS).length;
  if (failed.length) {
    console.warn('Hotkeys unavailable (already claimed by another app): ' + failed.join(', '));
  }
  console.log('Registered ' + (total - failed.length) + '/' + total + ' hotkeys.');
  return failed;
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

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-displays', () =>
  screen.getAllDisplays().map((d, i) => ({
    index: i, id: d.id, size: d.size, workArea: d.workArea,
    isPrimary: d.id === screen.getPrimaryDisplay().id
  }))
);
ipcMain.handle('load-presets', () => loadPresets());
ipcMain.handle('save-presets', (e, presets) => { savePresets(presets); return true; });

ipcMain.handle('snap-window', (e, zone, displayIndex) =>
  snapZone(zone, displayByIndex(displayIndex), '[WinSnap]::GetForegroundWindow()')
);

ipcMain.handle('snap-window-by-hwnd', (e, hwnd, zone, displayIndex) =>
  snapZone(zone, displayByIndex(displayIndex), '[IntPtr]' + hwnd)
);

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

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  // Falls back to an empty image rather than crashing if the icon is missing.
  const icon = nativeImage.createFromPath(ICON_PATH);
  if (icon.isEmpty()) console.warn('Tray icon missing at ' + ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('SnapMaster');

  const hotkeyItems = Object.entries(HOTKEYS).map(([accel, def]) => ({
    label: def.label, accelerator: accel, enabled: false
  }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'SnapMaster', enabled: false },
    { type: 'separator' },
    { label: 'Snap Window', click: openAssist },
    { label: 'Open Editor', click: openEditor },
    { type: 'separator' },
    { label: 'Hotkeys', submenu: hotkeyItems },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', openAssist);
  tray.on('double-click', openEditor);
}

// A second launch should surface the running instance, not start a rival copy
// that fights over the same global hotkeys.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openEditor());

  app.whenReady().then(() => {
    createTray();
    registerHotkeys();
    openEditor();
    console.log('SnapMaster running.');
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => e.preventDefault());
}
