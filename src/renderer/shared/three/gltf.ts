/**
 * Adapter for a rigged glTF model that satisfies `model-contract.ts`.
 *
 * No such model exists yet — producing one is a manual asset step. This is the
 * code that will drive it: one looping clip per pose, crossfaded on each pose
 * change, with playback speed following energy. Missing clips are named in
 * the console and fall back to `idle`, mirroring how the Rive binding refuses
 * to fail silently.
 */

import * as THREE from 'three';
import type { PoseName, PoseParams } from '../../../core/pose.js';
import { POSES } from '../../../core/pose.js';
import { MODEL_CLIPS, MODEL_CROSSFADE_S } from '../../../core/model-contract.js';
import { applySaturation, disposeTree, type AvatarModel3D } from './model.js';

export class GltfCapybara implements AvatarModel3D {
  readonly root: THREE.Object3D;
  readonly detail: string;
  readonly mixer: THREE.AnimationMixer;

  /** Pose → action. A pose whose clip is missing shares idle's action. */
  private readonly actions = new Map<PoseName, THREE.AnimationAction>();
  private active: THREE.AnimationAction | null = null;
  private lastSaturation = -1;
  /** The model's authored scale; nourishment multiplies it rather than replacing it. */
  private readonly baseScale: THREE.Vector3;

  constructor(scene: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = scene;
    this.baseScale = scene.scale.clone();
    this.mixer = new THREE.AnimationMixer(scene);

    const byName = new Map(clips.map((clip) => [clip.name.toLowerCase(), clip]));
    const found: PoseName[] = [];
    for (const pose of POSES) {
      const clip = byName.get(MODEL_CLIPS[pose].toLowerCase());
      if (!clip) continue;
      this.actions.set(pose, this.mixer.clipAction(clip));
      found.push(pose);
    }

    const missing = POSES.filter((pose) => !found.includes(pose));
    if (missing.length > 0) {
      console.warn(
        `[avatar] avatar.glb has no clip for: ${missing.join(', ')} — ` +
          `${missing.length === POSES.length ? 'the model will stand frozen' : "those poses fall back to 'idle'"}. ` +
          `Clips present: ${clips.map((c) => c.name).join(', ') || 'none'}.`,
      );
    }
    const idle = this.actions.get('idle');
    if (idle) for (const pose of missing) this.actions.set(pose, idle);

    this.detail = `glb ${found.length}/${POSES.length} clips`;
  }

  /** The clip currently leading the blend, for tests and diagnostics. */
  get activeClipName(): string | null {
    return this.active?.getClip().name ?? null;
  }

  setPose(pose: PoseName): void {
    const next = this.actions.get(pose) ?? null;
    if (!next || next === this.active) return;
    next.reset();
    next.setEffectiveWeight(1);
    next.play();
    if (this.active) next.crossFadeFrom(this.active, MODEL_CROSSFADE_S, false);
    this.active = next;
  }

  update(p: PoseParams, _timeS: number, dtS: number): void {
    // Clips own the motion; params add what a clip can't know about: speed
    // from energy, girth from nourishment, and colour from freshness.
    if (this.active) this.active.timeScale = p.tempo;
    this.mixer.update(dtS);
    this.root.scale.set(
      this.baseScale.x * (1 + (p.plump - 1) * 0.5),
      this.baseScale.y * p.plump,
      this.baseScale.z * p.plump,
    );
    if (Math.abs(p.saturation - this.lastSaturation) > 0.004) {
      applySaturation(this.root, p.saturation);
      this.lastSaturation = p.saturation;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    disposeTree(this.root);
  }
}
