/**
 * The preload bridge, as seen from the renderer.
 *
 * Kept narrow on purpose: with `contextIsolation` and `sandbox` on, this is the
 * complete surface a renderer can reach. Adding a capability here is a
 * deliberate act, which is what makes it reviewable.
 */

import type { AvatarSnapshot, Pulse } from '../../core/types.js';

export interface AvatarBridge {
  /** Subscribe to engine snapshots. Returns an unsubscribe fn. */
  onSnapshot(listener: (snapshot: AvatarSnapshot) => void): () => void;
  /** Ask main for the latest snapshot immediately (windows open mid-run). */
  getSnapshot(): Promise<AvatarSnapshot | null>;
  /** Toggle the free-roaming living area. */
  toggleLivingArea(): Promise<boolean>;
  quit(): Promise<void>;
}

declare global {
  interface Window {
    avatar: AvatarBridge;
  }
}

/**
 * At-most-once pulse playback.
 *
 * Snapshots are re-delivered to late subscribers, so edge-detecting on a level
 * would re-fire `celebrate` every time a window reopens. Dedup on pulse id
 * instead.
 */
export class PulsePlayer {
  private readonly played = new Set<string>();

  /** @returns the pulses not yet played, in order. */
  take(pulses: Pulse[]): Pulse[] {
    const fresh = pulses.filter((p) => !this.played.has(p.id));
    for (const p of fresh) this.played.add(p.id);
    // Unbounded growth would be a slow leak in a long-running menu-bar app.
    if (this.played.size > 500) {
      const keep = [...this.played].slice(-250);
      this.played.clear();
      for (const id of keep) this.played.add(id);
    }
    return fresh;
  }
}
