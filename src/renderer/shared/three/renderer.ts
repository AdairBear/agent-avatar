/**
 * The three.js implementation of `AvatarRenderer`.
 *
 * Signals come in through the same five setters every renderer implements.
 * Each frame they are resolved to a pose (`PoseMachine`), the pose to rig
 * targets (`poseTargets`), the targets eased (`easeParams`), and the eased
 * params handed to the model. That pipeline is the whole render layer; the
 * model behind it is either the primitive capybara or a contract-satisfying
 * `avatar.glb`, picked by asset presence exactly like the `.riv`.
 *
 * The GL backend is injectable so the full pipeline — scene graph, pose
 * machine, easing, rig — runs headlessly in `scripts/smoke-three.mjs`.
 * Production always uses `WebGLRenderer`.
 */

import * as THREE from 'three';
import type { AvatarRenderer } from '../renderer.js';
import type { AvatarStateName } from '../../../core/types.js';
import {
  DEFAULT_POSE_TUNING,
  PoseMachine,
  easeParams,
  poseTargets,
  type PoseName,
  type PoseParams,
  type PoseTuning,
} from '../../../core/pose.js';
import { MODEL_ASSET_URL } from '../../../core/model-contract.js';
import { PrimitiveCapybara } from './capybara.js';
import { GltfCapybara } from './gltf.js';
import type { AvatarModel3D } from './model.js';

/** The slice of `WebGLRenderer` this file uses. */
export interface GlBackend {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}

/** What the renderer needs from its canvas. Real canvases satisfy it; tests pass a stub. */
export interface CanvasLike {
  clientWidth: number;
  clientHeight: number;
}

export interface ThreeRendererOptions {
  canvas: CanvasLike;
  backend: GlBackend;
  model?: AvatarModel3D;
  tuning?: PoseTuning;
  pixelRatio?: number;
}

export class ThreeAvatarRenderer implements AvatarRenderer {
  readonly kind = 'three' as const;

  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  readonly model: AvatarModel3D;
  readonly machine: PoseMachine;

  /** Latest signals, stored by the setters and read once per frame. */
  private nourishment = 0.5;
  private energy = 1;
  private working = false;
  private hint: AvatarStateName = 'unknown';
  /** Renderer clock in ms — the pose machine's time base. */
  private clockMs = 0;
  private readonly params: PoseParams;
  private readonly canvas: CanvasLike;
  private readonly backend: GlBackend;
  private size = { w: 0, h: 0 };
  private destroyed = false;

  constructor(options: ThreeRendererOptions) {
    this.canvas = options.canvas;
    this.backend = options.backend;
    this.backend.setPixelRatio(Math.min(2, options.pixelRatio ?? 1));
    this.model = options.model ?? new PrimitiveCapybara();
    this.machine = new PoseMachine(options.tuning ?? DEFAULT_POSE_TUNING);
    this.machine.onTransition((from, to) => {
      this.model.setPose(to);
      console.info(`[avatar] pose ${from} → ${to}`);
    });

    this.scene.add(this.model.root);
    this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0x5a4636, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(2, 3, 2.5);
    this.scene.add(key);

    // Three-quarter view from slightly above: reads as a creature at a glance
    // even at the popover's 76px, with headroom for the celebrate hop.
    this.camera.position.set(1.5, 1.05, 2.9);
    this.camera.lookAt(0.15, 0.4, 0);

    this.params = poseTargets('idle', this.nourishment, this.energy, true);
    this.model.setPose(this.machine.pose);
  }

  /**
   * The model only, not the pose: the popover writes this right after a
   * snapshot, before the next frame resolves the pose, so a pose here would
   * always read one snapshot stale. The popover's heading already names the state.
   */
  get detail(): string {
    return this.model.detail;
  }

  /** The pose currently resolved, for diagnostics and tests. */
  get pose(): PoseName {
    return this.machine.pose;
  }

  /** The eased params last handed to the model. A copy — mutating it does nothing. */
  get currentParams(): PoseParams {
    return { ...this.params };
  }

  setNourishment(value01: number): void {
    this.nourishment = value01;
  }

  setEnergy(value01: number): void {
    this.energy = value01;
  }

  setWorking(working: boolean): void {
    this.working = working;
  }

  /** Carries freshness (`unknown`) and the backend's sleep/drowsy verdicts. */
  setStateName(state: AvatarStateName): void {
    this.hint = state;
  }

  celebrate(): void {
    this.machine.celebrate(this.clockMs);
  }

  frame(dtMs: number): void {
    if (this.destroyed) return;
    const dt = Math.max(0, Math.min(250, dtMs)); // a suspended window must not fast-forward
    this.clockMs += dt;

    const pose = this.machine.update(
      {
        nourishment: this.nourishment * 100,
        energy: this.energy * 100,
        isWorking: this.working,
        fresh: this.hint !== 'unknown',
        hint: this.hint,
      },
      this.clockMs,
    );
    const target = poseTargets(pose, this.nourishment, this.energy, this.machine.isStale);
    easeParams(this.params, target, dt);
    this.model.update(this.params, this.clockMs / 1000, dt / 1000);

    this.fitToCanvas();
    this.backend.render(this.scene, this.camera);
  }

  destroy(): void {
    this.destroyed = true;
    this.model.dispose();
    this.backend.dispose();
  }

  /** Match the drawing buffer to the canvas's CSS box; the windows resize freely. */
  private fitToCanvas(): void {
    const w = this.canvas.clientWidth || 160;
    const h = this.canvas.clientHeight || 160;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.backend.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

/**
 * Build the WebGL-backed renderer, or `null` when WebGL is unavailable (the
 * caller then falls back to the 2D placeholder).
 *
 * Uses `avatar.glb` when the build shipped one, the primitive capybara
 * otherwise. A `.glb` that exists but fails to load is logged loudly and the
 * primitive is used, so a broken export is visible rather than a blank window.
 */
export async function tryCreateThreeRenderer(
  canvas: HTMLCanvasElement,
): Promise<ThreeAvatarRenderer | null> {
  if (!webglAvailable()) {
    console.warn('[avatar] WebGL unavailable — cannot use the 3D renderer.');
    return null;
  }

  let backend: THREE.WebGLRenderer;
  try {
    backend = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    backend.setClearColor(0x000000, 0); // transparent: the living area floats on the desktop
  } catch (error) {
    console.warn('[avatar] WebGLRenderer construction failed:', error);
    return null;
  }

  const model = await loadGltfModel();
  return new ThreeAvatarRenderer({
    canvas,
    backend,
    model: model ?? undefined,
    pixelRatio: window.devicePixelRatio || 1,
  });
}

async function loadGltfModel(): Promise<AvatarModel3D | null> {
  if (!(await assetExists(MODEL_ASSET_URL))) {
    console.info(
      `[avatar] no ${MODEL_ASSET_URL} — using the primitive capybara. ` +
        'Drop a model satisfying src/core/model-contract.ts into src/assets/ and rebuild.',
    );
    return null;
  }
  try {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(MODEL_ASSET_URL);
    console.info(`[avatar] rendering ${MODEL_ASSET_URL}`);
    return new GltfCapybara(gltf.scene, gltf.animations);
  } catch (error) {
    console.error(
      `[avatar] ${MODEL_ASSET_URL} exists but failed to load — using the primitive capybara:`,
      error,
    );
    return null;
  }
}

/** Probe on a throwaway canvas, so a failed attempt can't poison the real one for 2D. */
function webglAvailable(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // don't hold a context slot
    return Boolean(gl);
  } catch {
    return false;
  }
}

async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}
