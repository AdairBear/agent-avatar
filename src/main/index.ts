/**
 * Electron main — wires the telemetry source to the macOS surfaces.
 *
 * Two sources, chosen by one flag:
 *
 *   npm start            → TelemetryClient, polling the local Python backend
 *   npm start -- --mock  → MockSource, synthetic values, no backend needed
 *
 * Everything downstream is identical either way, which is what makes mock mode
 * a real rehearsal rather than a separate code path.
 */

import { app, ipcMain, net } from 'electron';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelemetryClient, type ClientTransport } from '../core/client.js';
import { MockSource } from '../core/mock.js';
import type { AvatarSnapshot } from '../core/types.js';
import { AvatarTray } from './tray.js';
import { WindowManager } from './windows.js';

/** Matches `Config.port` in telemetry/avatar_telemetry/config.py. */
const DEFAULT_PORT = 8787;
/** Matches `Config.state_file`. */
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.agentic-avatar', 'state.json');

const MOCK = process.argv.includes('--mock') || process.env.AVATAR_MOCK === '1';
const PORT = Number(process.env.AVATAR_PORT ?? DEFAULT_PORT);
const STATE_FILE = process.env.AVATAR_STATE_FILE ?? DEFAULT_STATE_FILE;
/** How often the shell asks the backend for a fresh snapshot. */
const POLL_MS = 2_000;

let tray: AvatarTray | null = null;
let windows: WindowManager | null = null;
let client: TelemetryClient | null = null;
let mockTimer: ReturnType<typeof setInterval> | null = null;
let latest: AvatarSnapshot | null = null;

/**
 * Reads the backend over loopback HTTP, falling back to its state file.
 *
 * Uses Electron's `net` rather than `fetch` so the request is made from the
 * main process without a renderer, and returns `null` (not a throw) when the
 * service simply is not running — an expected state, not an error.
 */
const transport: ClientTransport = {
  fetchState(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        const request = net.request(url);
        // A hung backend must not stall the poll loop.
        const timer = setTimeout(() => {
          request.abort();
          finish(null);
        }, 1_500);

        request.on('response', (response) => {
          if (response.statusCode !== 200) {
            clearTimeout(timer);
            response.on('data', () => {});
            finish(null);
            return;
          }
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            clearTimeout(timer);
            finish(Buffer.concat(chunks).toString('utf-8'));
          });
        });
        request.on('error', () => {
          clearTimeout(timer);
          finish(null);
        });
        request.end();
      } catch {
        finish(null);
      }
    });
  },

  async readStateFile(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf-8');
    } catch {
      return null;
    }
  },
};

function publish(snapshot: AvatarSnapshot): void {
  latest = snapshot;
  tray?.update(snapshot);
  windows?.broadcast(snapshot);
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

  ipcMain.handle('avatar:get-snapshot', () => latest);
  ipcMain.handle('avatar:toggle-living-area', () => windows?.toggleLivingArea() ?? false);
  ipcMain.handle('avatar:quit', () => app.quit());

  if (MOCK) {
    const source = new MockSource();
    publish(source.snapshot());
    mockTimer = setInterval(() => publish(source.snapshot()), 1_000);
    console.info('[main] MOCK MODE — synthetic gauges, no telemetry backend needed.');
  } else {
    client = new TelemetryClient({
      url: `http://127.0.0.1:${PORT}/state`,
      stateFile: STATE_FILE,
      transport,
      pollMs: POLL_MS,
      log: (level, message) => console[level](`[telemetry] ${message}`),
    });
    client.onSnapshot(publish);
    await client.start();
    console.info(`[main] reading telemetry from http://127.0.0.1:${PORT}/state`);
  }

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
  client?.stop();
  if (mockTimer) clearInterval(mockTimer);
  tray?.destroy();
  windows?.destroy();
});
