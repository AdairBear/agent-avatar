/**
 * The contract between this app and a rigged 3D model (`avatar.glb`).
 *
 * The 3D counterpart of `rive-contract.ts`. Producing the model — image-to-3D,
 * Blender rigging, authoring the clips — is a manual asset step; this file is
 * what that step has to hit so the model drops in with no code change.
 *
 * A model satisfies the contract by shipping one animation clip per pose,
 * named exactly as below (matching ignores case). Clips should loop cleanly:
 * the renderer crossfades between them on every pose change and modulates
 * playback speed by energy. A missing clip is logged by name and falls back
 * to `idle`, and the popover reports `glb 3/5 clips` so a half-wired model is
 * visible rather than silently frozen.
 */

import type { PoseName } from './pose.js';

export const MODEL_CLIPS: Record<PoseName, string> = {
  idle: 'idle',
  working: 'working',
  droop: 'droop',
  sleep: 'sleep',
  celebrate: 'celebrate',
};

/** Where the build drops the model, relative to the renderer HTML. */
export const MODEL_ASSET_URL = 'avatar.glb';

/** Seconds to crossfade between pose clips. */
export const MODEL_CROSSFADE_S = 0.35;
