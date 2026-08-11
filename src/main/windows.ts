/**
 * Window management: the popover and the living area.
 *
 * This file plus `tray.ts` is the entire Electron-specific surface — roughly
 * 300 lines. A future Tauri or native port replaces these two files and keeps
 * `src/core/` and `src/renderer/` unchanged. That is the point of the split.
 */

import { BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import type { AvatarSnapshot } from '../core/types.js';

const PRELOAD = path.join(__dirname, 'preload.cjs');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 430;

/** The living area's default home range: a slice of the bottom-right of the display. */
const LIVING_AREA_FRACTION = { width: 0.3, height: 0.34 };

export class WindowManager {
  private popover: BrowserWindow | null = null;
  private livingArea: BrowserWindow | null = null;

  // ── Popover ───────────────────────────────────────────────────────────

  private createPopover(): BrowserWindow {
    const win = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Rounded, translucent panel that reads as a menu-bar popover.
      vibrancy: 'popover',
      visualEffectState: 'active',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    void win.loadFile(path.join(RENDERER_DIR, 'popover', 'index.html'));

    // Dismiss on click-away, the way a real popover behaves.
    win.on('blur', () => {
      if (!win.webContents.isDevToolsOpened()) win.hide();
    });
    win.on('closed', () => {
      this.popover = null;
    });
    blockExternalNavigation(win);

    return win;
  }

  /** @param anchor tray icon bounds, so the popover appears under the den. */
  togglePopover(anchor?: Electron.Rectangle): void {
    if (!this.popover) this.popover = this.createPopover();

    if (this.popover.isVisible()) {
      this.popover.hide();
      return;
    }

    this.positionPopover(anchor);
    this.popover.show();
    this.popover.focus();
  }

  private positionPopover(anchor?: Electron.Rectangle): void {
    if (!this.popover) return;

    const display = anchor
      ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
      : screen.getPrimaryDisplay();
    const work = display.workArea;

    if (!anchor) {
      this.popover.setPosition(
        Math.round(work.x + work.width - POPOVER_WIDTH - 12),
        Math.round(work.y + 8),
      );
      return;
    }

    // Centre under the tray icon, clamped so it never runs off the display.
    const x = Math.round(anchor.x + anchor.width / 2 - POPOVER_WIDTH / 2);
    const clampedX = Math.min(
      work.x + work.width - POPOVER_WIDTH - 8,
      Math.max(work.x + 8, x),
    );
    this.popover.setPosition(clampedX, Math.round(anchor.y + anchor.height + 4));
  }

  // ── Living area ───────────────────────────────────────────────────────

  /**
   * A transparent, always-on-top, click-through window (spec §10.3).
   *
   * `setIgnoreMouseEvents(true, { forward: true })` is what makes the creature
   * non-intrusive: clicks pass straight through to whatever is underneath, so
   * it roams over the desktop without ever stealing focus or blocking work.
   */
  private createLivingArea(): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const work = display.workArea;
    const width = Math.round(work.width * LIVING_AREA_FRACTION.width);
    const height = Math.round(work.height * LIVING_AREA_FRACTION.height);

    const win = new BrowserWindow({
      width,
      height,
      x: work.x + work.width - width - 24,
      y: work.y + work.height - height - 24,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    win.setIgnoreMouseEvents(true, { forward: true });
    // Visible over full-screen spaces, and not a window the user has to manage.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setAlwaysOnTop(true, 'floating');

    void win.loadFile(path.join(RENDERER_DIR, 'living', 'index.html'));
    win.on('closed', () => {
      this.livingArea = null;
    });
    blockExternalNavigation(win);

    return win;
  }

  /** @returns whether the living area is now visible. */
  toggleLivingArea(): boolean {
    if (!this.livingArea) this.livingArea = this.createLivingArea();

    if (this.livingArea.isVisible()) {
      this.livingArea.hide(); // "retreats to its den" — not an off-switch
      return false;
    }
    this.livingArea.showInactive(); // never steals focus
    return true;
  }

  get livingAreaVisible(): boolean {
    return this.livingArea?.isVisible() ?? false;
  }

  // ── Broadcast ─────────────────────────────────────────────────────────

  broadcast(snapshot: AvatarSnapshot): void {
    for (const win of [this.popover, this.livingArea]) {
      if (win && !win.isDestroyed()) win.webContents.send('avatar:snapshot', snapshot);
    }
  }

  destroy(): void {
    for (const win of [this.popover, this.livingArea]) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.popover = null;
    this.livingArea = null;
  }
}

/**
 * Renderers load local files only. Anything trying to navigate or open a new
 * window goes to the system browser instead — standard hardening so a bug (or
 * a malicious `.riv`-adjacent asset) can't turn a renderer into a browser.
 */
function blockExternalNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}
