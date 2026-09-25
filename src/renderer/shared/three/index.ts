/**
 * Entry point for the headless 3D smoke test (`scripts/smoke-three.mjs`).
 *
 * Bundled standalone with `three` left external, so the test builds its
 * synthetic clips and scenes against the same three.js instance the renderer
 * uses. The windows never import this file.
 */

export { ThreeAvatarRenderer } from './renderer.js';
export type { GlBackend, CanvasLike } from './renderer.js';
export { PrimitiveCapybara } from './capybara.js';
export { GltfCapybara } from './gltf.js';
export { applySaturation } from './model.js';
export { driveRenderer } from '../drive.js';
export { PulsePlayer } from '../bridge.js';
