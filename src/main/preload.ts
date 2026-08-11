/**
 * Preload — the only bridge between main and any renderer.
 *
 * Runs with `contextIsolation: true` and `sandbox: true`. The renderer gets
 * these four functions and nothing else: no `require`, no Node globals, no
 * ipcRenderer. Widening this surface should always be a deliberate, reviewed
 * act.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AvatarSnapshot } from '../core/types.js';

const CHANNEL = 'avatar:snapshot';

contextBridge.exposeInMainWorld('avatar', {
  onSnapshot(listener: (snapshot: AvatarSnapshot) => void): () => void {
    const handler = (_event: unknown, snapshot: AvatarSnapshot) => listener(snapshot);
    ipcRenderer.on(CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANNEL, handler);
  },
  getSnapshot: (): Promise<AvatarSnapshot | null> => ipcRenderer.invoke('avatar:get-snapshot'),
  toggleLivingArea: (): Promise<boolean> => ipcRenderer.invoke('avatar:toggle-living-area'),
  quit: (): Promise<void> => ipcRenderer.invoke('avatar:quit'),
});
