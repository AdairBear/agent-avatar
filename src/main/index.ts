/**
 * Electron main — wires the pure engine to the macOS surfaces.
 *
 * Everything interesting happens in `src/core`. This file is plumbing: start
 * the engine, push each snapshot at the tray and the windows, answer four IPC
 * calls.
 */

import { app, ipcMain } from 'electron';
import { AvatarEngine } from '../core/engine.js';
import { DEMO_CONFIG } from '../core/config.js';
import { FakeAdapter } from '../core/adapters/fake.js';
import type { SourceAdapter } from '../core/adapters/types.js';
import { AvatarTray } from './tray.js';
import { WindowManager } from './windows.js';

let tray: AvatarTray | null = null;
let windows: WindowManager | null = null;
let engine: AvatarEngine | null = null;

/**
 * Phase 1 registers only the fake source.
 *
 * Track 3 adds `new ConductorAdapter()` and `new TokenTelemetryAdapter()` to
 * this array and drops the fake. Nothing else in the app changes — see
 * `docs/TELEMETRY.md`.
 */
function buildAdapters(): SourceAdapter[] {
  return [new FakeAdapter({ drainSeconds: 180, completionEverySeconds: 8 })];
}

async function main(): Promise<void> {
  // A menu-bar app has no Dock presence and no windows-closed-means-quit.
  app.dock?.hide();

  windows = new WindowManager();

  tray = new AvatarTray({
    onClick: (bounds) => windows?.togglePopover(bounds),
    onToggleLivingArea: () => windows?.toggleLivingArea(),
    onQuit: () => app.quit(),
  });

  engine = new AvatarEngine({
    adapters: buildAdapters(),
    // DEMO_CONFIG compresses the emotional arc into ~3 minutes so the loop can
    // be felt in one sitting. Swap to DEFAULT_CONFIG with real adapters.
    config: DEMO_CONFIG,
    log: (level, message) => console[level](`[engine] ${message}`),
  });

  engine.onSnapshot((snapshot) => {
    tray?.update(snapshot);
    windows?.broadcast(snapshot);
  });

  ipcMain.handle('avatar:get-snapshot', () => engine?.lastSnapshot ?? null);
  ipcMain.handle('avatar:toggle-living-area', () => windows?.toggleLivingArea() ?? false);
  ipcMain.handle('avatar:quit', () => app.quit());

  await engine.start();
  console.info('[main] Agentic Avatar running — click the menu-bar item for stats.');

  // Dev affordance: open both surfaces without a click, so a headless run can
  // prove the renderers actually load. `AVATAR_DEBUG_OPEN=1 npm start`
  if (process.env.AVATAR_DEBUG_OPEN === '1') {
    windows.togglePopover();
    windows.toggleLivingArea();
    console.info('[main] AVATAR_DEBUG_OPEN — popover + living area opened');
  }
}

app.whenReady().then(main).catch((error) => {
  // Fail loud. A menu-bar app that dies silently is indistinguishable from one
  // that is quietly doing nothing.
  console.error('[main] failed to start:', error);
  app.quit();
});

// A menu-bar app outlives its windows.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  void engine?.stop();
  tray?.destroy();
  windows?.destroy();
});
