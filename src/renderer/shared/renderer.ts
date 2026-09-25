/**
 * The avatar render slot.
 *
 * The rest of the UI drives the avatar exclusively through `AvatarRenderer`.
 * Behind that interface sits the Rive runtime, the three.js capybara, or the
 * 2D placeholder blob -- and nothing outside this folder can tell which.
 *
 * Swapping in real art is: drop `avatar.riv` or `avatar.glb` into
 * `src/assets/`, rebuild. No code change.
 */

import type { AvatarStateName } from '../../core/types.js';
import { RIVE_ASSET_URL } from '../../core/rive-contract.js';
import { PlaceholderAvatarRenderer } from './placeholder.js';
import { tryCreateRiveRenderer } from './rive.js';
import { tryCreateThreeRenderer } from './three/renderer.js';

export interface AvatarRenderer {
  /** @param value01 0..1 — scaled to the artboard's 0–100 at the Rive boundary. */
  setNourishment(value01: number): void;
  /** @param value01 0..1 — scaled to the artboard's 0–100 at the Rive boundary. */
  setEnergy(value01: number): void;
  /** Drives the `isWorking` boolean input. */
  setWorking(working: boolean): void;
  setStateName(state: AvatarStateName): void;
  /** Fire-and-forget one-shot. Maps to the Rive `celebrate` trigger. */
  celebrate(): void;
  /** Per-frame tick. Rive ignores it; three.js and the placeholder animate on it. */
  frame(dtMs: number): void;
  destroy(): void;
  /** Which implementation is live — surfaced in the popover so it's never a mystery. */
  readonly kind: 'rive' | 'three' | 'placeholder';
  /**
   * Optional one-liner about *how well* it is wired, shown next to `kind`.
   *
   * The Rive implementation reports how many of the four contract inputs it
   * actually bound. "rive" alone would look like success even when the
   * artboard is ignoring every signal.
   */
  readonly detail?: string;
}

/**
 * Pick a renderer by asset presence, not by a config flag.
 *
 * A flag can disagree with reality; a HEAD request cannot. In order:
 *
 *  1. `avatar.riv` present → Rive (the 2D art track, kept working).
 *  2. otherwise → three.js: `avatar.glb` if present, else the primitive capybara.
 *  3. no WebGL → the 2D placeholder blob.
 */
export async function createAvatarRenderer(canvas: HTMLCanvasElement): Promise<AvatarRenderer> {
  const hasRiveAsset = await assetExists(RIVE_ASSET_URL);

  if (hasRiveAsset) {
    const rive = await tryCreateRiveRenderer(canvas);
    if (rive) {
      console.info('[avatar] rendering via Rive:', RIVE_ASSET_URL);
      return rive;
    }
    // Asset present but the runtime refused it — a real problem worth shouting
    // about, not something to paper over silently.
    console.warn(
      `[avatar] ${RIVE_ASSET_URL} exists but the Rive runtime could not load it. ` +
        'Falling back to the 3D renderer.',
    );
  }

  const three = await tryCreateThreeRenderer(canvas);
  if (three) return three;

  console.warn('[avatar] 3D renderer unavailable — using the 2D placeholder.');
  return new PlaceholderAvatarRenderer(canvas);
}

async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}
