# SnapMaster

A window-snapping utility for Windows. Draw your own zone layouts, then throw windows into
them with a hotkey or a tray-driven picker. Runs in the system tray.

Built with Electron. Window manipulation goes through the Win32 API (`SetWindowPos`,
`MoveWindow`, `EnumWindows`) via PowerShell interop.

## Install

Download `SnapMaster-Setup-1.0.0.exe` from the [Releases](https://github.com/alyaanj-ux/snapmaster/releases)
page and run it.

The installer is per-user, so it does not prompt for UAC, and it bundles the Electron
runtime — there is nothing else to fetch. It creates a desktop and Start Menu shortcut.

## Build from source

```bash
npm install
npm start          # run in place
npm run build      # produces release/SnapMaster-Setup-<version>.exe
```

Requires Node.js. Electron and electron-builder are dev dependencies.

## Hotkeys

Snapping targets the monitor the **mouse cursor** is currently on, not always the primary.

| Hotkey              | Zone                 |
|---------------------|----------------------|
| Alt + Left          | Left half            |
| Alt + Right         | Right half           |
| Alt + Up            | Fullscreen           |
| Alt + Down          | Center 80%           |
| Alt + Shift + Left  | Left third           |
| Alt + Shift + Up    | Middle third         |
| Alt + Shift + Right | Right third          |
| Alt + 1             | Top-left quarter     |
| Alt + 2             | Top-right quarter    |
| Alt + 3             | Bottom-left quarter  |
| Alt + 4             | Bottom-right quarter |
| Alt + 5             | Center 60%           |
| Alt + 6             | Fullscreen           |

These are registered globally, which means **Alt+Left and Alt+Right are taken system-wide**
and will no longer reach apps that use them for back/forward. To change them, edit the
`HOTKEYS` map at the top of `main.js` — switching the whole set to `Ctrl+Alt+...` is a
find-and-replace. Any combination already claimed by another app is skipped, and the app
logs which ones on startup rather than failing.

## Zone editor

Tray → **Open Editor**, or double-click the tray icon.

Draw zones by dragging on the monitor mockup, or use the quick splits: `½ ½`, `⅓ ⅓ ⅓`,
`2×2`, `Main+Side`. Zones can be dragged and resized, snap to each other's edges, and are
rejected if they would overlap. Up to 8 zones per layout, 6 layouts total.

Layouts are stored as **fractions of the work area**, not pixels, so a layout drawn on one
monitor lands correctly on a different resolution. Each layout remembers which display it
was made for. They persist to `presets.json` under the app's userData directory.

## Snap assistant

Tray → **Snap Window**, or single-click the tray icon.

A three-step picker: choose a monitor, choose a saved layout, then assign a running window
to each zone and hit **Apply All**. The window list is enumerated with `EnumWindows` and
filtered down to real top-level app windows — cloaked windows, tool windows, and shell
surfaces are excluded.

## Implementation notes

- **Shadow-border correction.** Windows 10/11 windows carry an invisible resize border, so
  naively moving a window to a zone leaves a visible gap on each side. SnapMaster reads the
  true visible bounds with `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` and offsets
  the target rect by the difference. Snaps land pixel-exact on the zone.
- **Maximized windows** are restored and un-maximized before snapping, otherwise the move
  is ignored.
- **Single instance.** A second launch surfaces the running copy instead of starting a rival
  that would fight over the same global hotkeys.

## Known limitations

- **Windows owned by elevated processes cannot be snapped.** SnapMaster runs unelevated
  (`asInvoker`) so it never shows a UAC prompt on launch; the tradeoff is that Windows
  blocks it from repositioning windows of admin-level apps, which fail silently. Building
  with `requestedExecutionLevel: requireAdministrator` reverses that tradeoff.
- **Multi-monitor is implemented but has only been exercised on a single-display machine.**
  Zone math accounts for each display's work-area offset, and both UIs let you pick a
  target display, but the multi-display path has not been verified against real hardware.
- **Per-app rules** (auto-snap an app to a zone on launch) are not implemented.
