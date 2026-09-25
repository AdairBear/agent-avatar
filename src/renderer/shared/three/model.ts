/**
 * What the 3D renderer needs from a model, whatever it is built from.
 *
 * Two implementations: the primitive capybara (the placeholder until the real
 * asset exists) and a glTF adapter that plays the contract's pose clips.
 * The renderer drives both through the same calls, so replacing one with the
 * other changes nothing upstream.
 */

import * as THREE from 'three';
import type { PoseName, PoseParams } from '../../../core/pose.js';

export interface AvatarModel3D {
  /** Added to the scene once. Stands on y = 0, faces +x, about 1 unit long. */
  readonly root: THREE.Object3D;
  /** Surfaced in the popover, e.g. `primitive` or `glb 5/5 clips`. */
  readonly detail: string;
  /** Called on every pose change. Clip-driven models crossfade here. */
  setPose(pose: PoseName): void;
  /**
   * Called every frame with the eased params.
   * @param timeS renderer clock, seconds
   * @param dtS seconds since the previous frame
   */
  update(params: PoseParams, timeS: number, dtS: number): void;
  dispose(): void;
}

const GREY = new THREE.Color();

/**
 * Desaturate every mesh under `root` toward grey by `saturation` (0..1).
 *
 * Materials are cloned on first touch so a shared material (common in glTF)
 * cannot desaturate something outside this model, and the original colour is
 * remembered so the tint is reversible.
 */
export function applySaturation(root: THREE.Object3D, saturation: number): void {
  const s = Math.min(1, Math.max(0, saturation));
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material, index) => {
      const colored = material as THREE.MeshStandardMaterial;
      if (!colored.color) return;
      if (!colored.userData.avatarOwned) {
        const own = colored.clone();
        own.userData = { avatarOwned: true, baseColor: colored.color.clone() };
        if (Array.isArray(mesh.material)) mesh.material[index] = own;
        else mesh.material = own;
        return applyTo(own, s);
      }
      applyTo(colored, s);
    });
  });
}

function applyTo(material: THREE.MeshStandardMaterial, s: number): void {
  const base = material.userData.baseColor as THREE.Color;
  const luma = base.r * 0.299 + base.g * 0.587 + base.b * 0.114;
  GREY.setRGB(luma, luma, luma);
  material.color.copy(GREY).lerp(base, s);
}

/** Free GPU resources for everything under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}
