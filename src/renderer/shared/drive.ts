/**
 * Snapshot → renderer: the one place live telemetry reaches the avatar.
 *
 * Both windows call this on every snapshot the main process pushes, so the
 * popover and the living area cannot disagree about what the four signals
 * were. It is DOM-free, which lets `scripts/smoke-three.mjs` feed it real
 * client and mock snapshots and watch the 3D pose follow.
 */

import type { AvatarSnapshot } from '../../core/types.js';
import type { AvatarRenderer } from './renderer.js';
import type { PulsePlayer } from './bridge.js';

/** @returns how many new celebrate pulses fired — the caller may spatialize them. */
export function driveRenderer(
  renderer: AvatarRenderer,
  snapshot: AvatarSnapshot,
  pulses: PulsePlayer,
): number {
  renderer.setNourishment(snapshot.nourishment / 100);
  renderer.setEnergy(snapshot.energy / 100);
  renderer.setWorking(snapshot.isWorking);
  // The contract says `fresh: false` ⇒ render unknown, whatever the state field
  // claims. The client usually downgrades already; this makes it unconditional.
  renderer.setStateName(snapshot.fresh ? snapshot.state : 'unknown');

  const fresh = pulses.take(snapshot.pulses).filter((pulse) => pulse.kind === 'celebrate');
  for (const _pulse of fresh) renderer.celebrate();
  return fresh.length;
}
