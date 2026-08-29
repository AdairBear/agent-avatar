/**
 * The avatar render slot.
 *
 * The rest of the UI drives the avatar exclusively through `AvatarRenderer`.
 * Behind that interface sits either the real Rive runtime or the placeholder
 * canvas blob -- and nothing outside this folder can tell which.
 *
 * Swapping in the real art is: drop `avatar.riv` into `src/assets/`, rebuild.
 * No code change.
 */

import type { AvatarStateName } from '../../core/types.js';
import { RIVE_ASSET_URL } from '../../core/rive-contract.js';
import { PlaceholderAvatarRenderer } from './placeholder.js';
import { tryCreateRiveRenderer } from './rive.js';

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
  /** Per-frame tick. The Rive implementation ignores it; the placeholder animates on it. */
  frame(dtMs: number): void;
  destroy(): void;
  /** Which implementation is live — surfaced in the popover so it's never a mystery. */
  readonly kind: 'rive' | 'placeholder';
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
 * A flag can disagree with reality; a HEAD request cannot.
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
        'Falling back to the placeholder.',
    );
  } else {
    console.info(
      `[avatar] no ${RIVE_ASSET_URL} found — using the placeholder renderer. ` +
        'Drop the .riv into src/assets/ and rebuild to switch over.',
    );
  }

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
