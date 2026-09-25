#!/usr/bin/env node
/**
 * Headless proof that the 3D render layer follows live telemetry — no GPU,
 * no Electron, no window.
 *
 * The whole pipeline runs for real: snapshot → `driveRenderer` → the
 * renderer's five setters → `PoseMachine` → `poseTargets` → easing → the
 * primitive capybara's joints. Only the final `WebGLRenderer.render()` is
 * stubbed. What it proves:
 *
 *   1. the four signals resolve to each of the five poses, on the backend's ladder
 *   2. hysteresis and dwell stop the pose flapping at a threshold
 *   3. a stale feed droops, desaturated — never a happy creature
 *   4. pose targets and easing behave (frame-rate independent, convergent)
 *   5. the rig's joints actually move per pose, and the scene renders each frame
 *   6. the glTF adapter crossfades contract clips and reports missing ones
 *   7. mock-mode snapshots walk the renderer through the arc, celebrating once per pulse
 *   8. real backend payloads (via the client's parser) land on the right pose
 *   9. the real Python backend, polled over loopback HTTP, drives pose changes live
 *
 * Run:  npm run smoke:three   (builds first)
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { PoseMachine, POSES, poseTargets, easeParams } from '../dist/core/pose.mjs';
import { MockSource } from '../dist/core/mock.mjs';
import { TelemetryClient, normalize } from '../dist/core/client.mjs';
import {
  ThreeAvatarRenderer,
  GltfCapybara,
  driveRenderer,
  PulsePlayer,
} from '../dist/renderer/shared/three.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    failures.push(label);
  }
};

// The renderer logs every pose change; keep the test output readable.
const quietInfo = console.info;
console.info = () => {};
const quietWarn = console.warn;

const signals = (overrides = {}) => ({
  nourishment: 50,
  energy: 80,
  isWorking: false,
  fresh: true,
  ...overrides,
});

/** A GL backend that records instead of drawing. */
function stubBackend() {
  return {
    renders: 0,
    sizes: [],
    disposed: false,
    setPixelRatio() {},
    setSize(w, h) {
      this.sizes.push([w, h]);
    },
    render(scene, camera) {
      if (!scene.isScene || !camera.isCamera) throw new Error('bad render call');
      this.renders += 1;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function makeRenderer(canvas = { clientWidth: 140, clientHeight: 140 }) {
  const backend = stubBackend();
  const renderer = new ThreeAvatarRenderer({ canvas, backend });
  return { renderer, backend, canvas };
}

/** Advance the renderer `ms` in 60fps frames, calling `each` after every frame. */
function run(renderer, ms, each = () => {}) {
  for (let t = 0; t < ms; t += 16) {
    renderer.frame(16);
    each();
  }
}

function feed(renderer, { nourishment = 50, energy = 80, working = false, state = 'idle' }) {
  renderer.setNourishment(nourishment / 100);
  renderer.setEnergy(energy / 100);
  renderer.setWorking(working);
  renderer.setStateName(state);
}

// ────────────────────────────────────────────────────────────────────────────
console.log('\n1. Four signals → five poses, on the backend ladder');
{
  const at = (input, now = 10_000) => new PoseMachine().update(signals(input), now);
  check('isWorking false → idle', at({ isWorking: false }) === 'idle');
  check('isWorking true → working', at({ isWorking: true }) === 'working');
  check('energy below 20 → droop', at({ energy: 12 }) === 'droop');
  check('energy at 0 → sleep', at({ energy: 0 }) === 'sleep');

  const m = new PoseMachine();
  m.update(signals({ isWorking: true }), 0);
  m.celebrate(1_000);
  check('a celebrate pulse → celebrate', m.update(signals({ isWorking: true }), 1_000) === 'celebrate');
  check('celebrate holds for its window', m.update(signals({ isWorking: true }), 6_500) === 'celebrate');
  check('then settles back to working', m.update(signals({ isWorking: true }), 7_100) === 'working');

  const s = new PoseMachine();
  s.update(signals({ energy: 0 }), 0);
  s.celebrate(100);
  check('sleep outranks celebrate', s.update(signals({ energy: 0 }), 100) === 'sleep');
  s.update(signals({ energy: 50 }), 200);
  check('a pulse swallowed in sleep does not replay on waking', s.pose !== 'celebrate');

  const d = new PoseMachine();
  d.celebrate(0);
  check('droop outranks celebrate', d.update(signals({ energy: 10 }), 0) === 'droop');

  check('every pose is named in POSES', POSES.length === 5);
  check(
    "backend hint 'drowsy' droops even above the local threshold",
    at({ energy: 45, hint: 'drowsy' }) === 'droop',
  );
  check("backend hint 'sleep' sleeps even above the local threshold", at({ energy: 30, hint: 'sleep' }) === 'sleep');
  check("backend hint 'celebrate' alone does not celebrate (pulses do)", at({ hint: 'celebrate' }) === 'idle');

  const seen = [];
  const t = new PoseMachine();
  t.onTransition((from, to) => seen.push(`${from}>${to}`));
  t.update(signals({ isWorking: true }), 0);
  t.update(signals({ energy: 5 }), 5_000);
  check('transitions are reported with from/to', seen.join(',') === 'idle>working,working>droop', seen.join(','));
}

console.log('\n2. Hysteresis and dwell keep the pose from flapping');
{
  const m = new PoseMachine();
  m.update(signals({ energy: 19 }), 0);
  check('droop at 19', m.pose === 'droop');
  m.update(signals({ energy: 21 }), 1_000);
  check('still droop at 21 (inside the margin)', m.pose === 'droop');
  m.update(signals({ energy: 23.5 }), 2_000);
  check('leaves droop once clear of the margin', m.pose === 'idle');

  const s = new PoseMachine();
  s.update(signals({ energy: 0 }), 0);
  s.update(signals({ energy: 2 }), 1_000);
  check('stays asleep at 2', s.pose === 'sleep');
  s.update(signals({ energy: 4 }), 2_000);
  check('wakes into droop, not straight to idle', s.pose === 'droop');

  const w = new PoseMachine();
  check('first reading resolves immediately', w.update(signals({ isWorking: true }), 10) === 'working');
  w.update(signals({ isWorking: false }), 500);
  check('working → idle is held for the dwell', w.pose === 'working');
  w.update(signals({ isWorking: false }), 1_600);
  check('then released', w.pose === 'idle');
  w.update(signals({ energy: 0 }), 1_700);
  check('dwell never delays sleep', w.pose === 'sleep');
}

console.log('\n3. A stale feed is never good news');
{
  const m = new PoseMachine();
  check('fresh:false → droop', m.update(signals({ fresh: false, isWorking: true }), 0) === 'droop');
  check('and flagged stale', m.isStale === true);
  check("hint 'unknown' → droop", new PoseMachine().update(signals({ hint: 'unknown' }), 0) === 'droop');
  check(
    'stale with energy 0 droops rather than claiming sleep',
    new PoseMachine().update(signals({ fresh: false, energy: 0 }), 0) === 'droop',
  );
  check('NaN energy is treated as stale', new PoseMachine().update(signals({ energy: NaN }), 0) === 'droop');
  m.celebrate(10);
  check('a stale feed swallows celebrate', m.update(signals({ fresh: false }), 20) === 'droop');
  check('stale pose targets are fully grey', poseTargets('droop', 0.8, 0.8, true).saturation === 0);
}

console.log('\n4. Pose targets and easing');
{
  const idle = poseTargets('idle', 0.5, 1, false);
  const droop = poseTargets('droop', 0.5, 1, false);
  const sleep = poseTargets('sleep', 0.5, 1, false);
  const party = poseTargets('celebrate', 0.5, 1, false);
  const work = poseTargets('working', 0.5, 1, false);
  check('sleep closes the eyes', sleep.eyeOpen === 0);
  check('sleep is fully crouched', sleep.crouch === 1);
  check('droop ears sag below idle', droop.earDroop > idle.earDroop);
  check('droop head hangs below idle', droop.headPitch > idle.headPitch);
  check('only celebrate hops', party.hop > 0 && [idle, droop, sleep, work].every((p) => p.hop === 0));
  check('working bobs faster than idle', work.bobHz > idle.bobHz);
  check('well fed is plumper', poseTargets('idle', 1, 1, false).plump > poseTargets('idle', 0, 1, false).plump);
  check(
    'low energy slows an awake pose',
    poseTargets('working', 0.5, 0.2, false).tempo < poseTargets('working', 0.5, 1, false).tempo,
  );
  check('low energy dims colour', poseTargets('idle', 0.5, 0.1, false).saturation < idle.saturation);

  const coarse = { ...idle };
  easeParams(coarse, sleep, 100);
  const fine = { ...idle };
  for (let i = 0; i < 10; i++) easeParams(fine, sleep, 10);
  check(
    'easing is frame-rate independent',
    Math.abs(coarse.crouch - fine.crouch) < 1e-9,
    `${coarse.crouch} vs ${fine.crouch}`,
  );
  const settle = { ...idle };
  for (let i = 0; i < 300; i++) easeParams(settle, sleep, 16);
  check('easing converges on the target', Math.abs(settle.crouch - 1) < 1e-3 && settle.eyeOpen < 1e-3);
  const still = { ...idle };
  easeParams(still, sleep, 0);
  check('a zero-length frame moves nothing', still.crouch === idle.crouch);
}

console.log('\n5. The capybara rig moves per pose, and renders every frame');
{
  const { renderer, backend, canvas } = makeRenderer();
  const capy = renderer.model;
  const { body, neck, legs, ears, eyes } = capy.joints;

  let meshes = 0;
  renderer.scene.traverse((node) => (meshes += node.isMesh ? 1 : 0));
  check('scene holds a multi-part capybara', meshes >= 10, `${meshes} meshes`);
  check('it is the primitive model', capy.detail === 'primitive');

  run(renderer, 50);
  check('before any snapshot the pose is an honest droop', renderer.pose === 'droop');

  feed(renderer, { energy: 90, state: 'idle' });
  run(renderer, 2_000);
  check('idle', renderer.pose === 'idle');
  const idleNeck = neck.rotation.z;
  const idleEar = Math.abs(ears[0].rotation.x);
  const idleBody = body.position.y;

  feed(renderer, { energy: 10, state: 'drowsy' });
  run(renderer, 2_000);
  check('droop', renderer.pose === 'droop');
  check('droop tips the nose down', neck.rotation.z < idleNeck - 0.2, `${neck.rotation.z} vs ${idleNeck}`);
  check('droop flattens the ears', Math.abs(ears[0].rotation.x) > idleEar + 0.5);

  feed(renderer, { energy: 0, state: 'sleep' });
  run(renderer, 2_500);
  check('sleep', renderer.pose === 'sleep');
  check('sleep folds the legs', legs.every((leg) => leg.scale.y < 0.15));
  check('sleep lowers the body', body.position.y < idleBody - 0.1);
  check('sleep closes the eyes', eyes.every((eye) => eye.scale.y < 0.12));
  check('sleep curls onto its side', body.rotation.x > 0.15);

  feed(renderer, { energy: 90, working: true, state: 'working' });
  run(renderer, 2_000);
  check('working', renderer.pose === 'working');
  renderer.celebrate();
  let peak = 0;
  run(renderer, 2_000, () => (peak = Math.max(peak, capy.root.position.y)));
  check('celebrate', renderer.pose === 'celebrate');
  check('celebrate hops off the ground', peak > 0.1, `peak ${peak.toFixed(3)}`);
  check('the popover detail names the model', renderer.detail === 'primitive', renderer.detail);
  run(renderer, 5_000);
  check('celebrate ends on its own', renderer.pose === 'working');

  const colours = () => {
    const out = [];
    capy.root.traverse((n) => n.isMesh && out.push(n.material.color));
    return out;
  };
  const warm = colours().some((c) => Math.abs(c.r - c.b) > 0.05);
  feed(renderer, { energy: 90, state: 'unknown' });
  run(renderer, 3_000);
  const grey = colours().every((c) => Math.abs(c.r - c.g) < 0.01 && Math.abs(c.g - c.b) < 0.01);
  check('fresh fur is warm-coloured', warm);
  check('stale fur is desaturated to grey', grey);

  check('renders once per frame', backend.renders > 1000, `${backend.renders}`);
  check('drawing buffer sized to the canvas', backend.sizes[0]?.join('x') === '140x140');
  canvas.clientWidth = 280;
  renderer.frame(16);
  check('resizes when the canvas does', backend.sizes.at(-1)?.join('x') === '280x140');
  check('camera aspect follows', Math.abs(renderer.camera.aspect - 2) < 1e-9);

  feed(renderer, { energy: 90, working: true, state: 'working' });
  run(renderer, 2_000);
  renderer.celebrate();
  renderer.frame(16);
  renderer.frame(60_000);
  check('a huge dt (suspended window) is clamped, not fast-forwarded', renderer.pose === 'celebrate');

  const beforeRenders = backend.renders;
  renderer.destroy();
  renderer.frame(16);
  check('destroy disposes the GL backend', backend.disposed === true);
  check('no frames render after destroy', backend.renders === beforeRenders);
}

console.log('\n6. The glTF adapter drives contract clips');
{
  const clip = (name) =>
    new THREE.AnimationClip(name, 1, [
      new THREE.NumberKeyframeTrack('.position[y]', [0, 1], [0, 1]),
    ]);

  console.warn = () => {};
  const full = new GltfCapybara(new THREE.Group(), ['Idle', 'working', 'DROOP', 'sleep', 'celebrate'].map(clip));
  console.warn = quietWarn;
  check('all five clips found, case-insensitively', full.detail === 'glb 5/5 clips', full.detail);

  const backend = stubBackend();
  const renderer = new ThreeAvatarRenderer({
    canvas: { clientWidth: 120, clientHeight: 120 },
    backend,
    model: full,
  });
  feed(renderer, { energy: 0, state: 'sleep' });
  run(renderer, 100);
  check('pose change plays the matching clip', full.activeClipName === 'sleep', full.activeClipName);
  feed(renderer, { energy: 90, working: true, state: 'working' });
  run(renderer, 100);
  check('and crossfades to the next', full.activeClipName === 'working', full.activeClipName);
  check('the renderer reports the glb', renderer.detail === 'glb 5/5 clips', renderer.detail);

  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  const partial = new GltfCapybara(new THREE.Group(), [clip('idle'), clip('sleep')]);
  console.warn = quietWarn;
  check('a half-wired model says so', partial.detail === 'glb 2/5 clips', partial.detail);
  check(
    'and names the missing clips',
    warnings.some((w) => w.includes('working, droop, celebrate')),
    warnings.join(' | '),
  );
  partial.setPose('celebrate');
  check('a missing clip falls back to idle', partial.activeClipName === 'idle');
}

console.log('\n7. Mock-mode snapshots drive the renderer through the arc');
{
  let now = 1_700_000_000_000;
  const source = new MockSource({ now: () => now });
  const { renderer } = makeRenderer();
  const pulses = new PulsePlayer();
  const seen = new Set();
  let celebrations = 0;

  // One snapshot per second — the app's poll cadence is 2s, so this is denser.
  for (let s = 0; s <= 200; s++) {
    const snap = source.snapshot();
    celebrations += driveRenderer(renderer, snap, pulses);
    // A window reopening re-reads the same snapshot: must not re-fire.
    celebrations += driveRenderer(renderer, snap, pulses);
    run(renderer, 1_000, () => seen.add(renderer.pose));
    now += 1_000;
  }
  const expectedPulses = Math.floor(200 / 20);
  check('mock arc reaches working', seen.has('working'));
  check('mock arc reaches celebrate', seen.has('celebrate'));
  check('mock arc reaches droop', seen.has('droop'));
  check('mock arc ends asleep', renderer.pose === 'sleep');
  check(
    'one celebration per completion, none on re-delivery',
    celebrations === expectedPulses,
    `${celebrations} vs ${expectedPulses}`,
  );
}

console.log('\n8. Real backend payloads land on the right pose');
{
  const payload = (state, gauges, isWorking, pulses = []) => ({
    schema: 'agentic-avatar.telemetry/1',
    at: new Date().toISOString(),
    mode: 'live',
    fresh: true,
    stale_after_seconds: 180,
    state,
    gauges: { health: 66, ...gauges },
    rive_inputs: { ...gauges, isWorking, celebrate: pulses.map((p) => p.id) },
    workstreams: [],
    drooping: [],
    pulses,
  });

  const { renderer } = makeRenderer();
  const pulses = new PulsePlayer();
  const poseFor = (body) => {
    driveRenderer(renderer, normalize(body), pulses);
    run(renderer, 2_000);
    return renderer.pose;
  };

  check('idle payload → idle', poseFor(payload('idle', { nourishment: 40, energy: 80 }, false)) === 'idle');
  check('working payload → working', poseFor(payload('working', { nourishment: 40, energy: 80 }, true)) === 'working');
  const pulse = { id: 'celebrate:commit:abc', kind: 'celebrate', at: '', label: 'x' };
  driveRenderer(renderer, normalize(payload('celebrate', { nourishment: 52, energy: 80 }, true, [pulse])), pulses);
  run(renderer, 500);
  check('completion pulse → celebrate', renderer.pose === 'celebrate');
  check('drowsy payload → droop', poseFor(payload('drowsy', { nourishment: 52, energy: 14 }, true)) === 'droop');
  check('sleep payload → sleep', poseFor(payload('sleep', { nourishment: 52, energy: 0 }, false)) === 'sleep');
  check(
    'an unfresh payload → droop',
    poseFor({ ...payload('working', { nourishment: 52, energy: 90 }, true), fresh: false }) === 'droop',
  );
  const junk = normalize({ gauges: null });
  check('junk never reaches the renderer (parser returns null)', junk === null);
}

console.log('\n9. The real Python backend drives the pose live, over loopback HTTP');
{
  const port = await freePort();
  const stateDir = await mkdtemp(path.join(tmpdir(), 'avatar-smoke-'));
  const backend = spawn(
    'python3',
    ['-m', 'avatar_telemetry', '--mock', '--port', String(port), '--state-file', path.join(stateDir, 'state.json')],
    { cwd: path.join(ROOT, 'telemetry'), stdio: 'ignore' },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    const up = await waitFor(async () => (await fetch(`${base}/healthz`)).ok, 10_000);
    check('backend came up in mock mode', up);

    const client = new TelemetryClient({
      url: `${base}/state`,
      stateFile: path.join(stateDir, 'none.json'),
      transport: {
        fetchState: async (url) => {
          try {
            const res = await fetch(url);
            return res.ok ? await res.text() : null;
          } catch {
            return null;
          }
        },
        readStateFile: async () => null,
      },
      log: () => {},
    });

    const { renderer } = makeRenderer();
    const pulses = new PulsePlayer();
    client.onSnapshot((snap) => driveRenderer(renderer, snap, pulses));

    const poseAfter = async (query) => {
      await fetch(`${base}/mock?${query}`);
      await client.poll();
      run(renderer, 2_000);
      return renderer.pose;
    };

    check('energy 85, working → working', (await poseAfter('nourishment=60&energy=85&is_working=true')) === 'working');
    check('energy 85, not working → idle', (await poseAfter('nourishment=60&energy=85&is_working=false')) === 'idle');
    check('energy 12 → droop', (await poseAfter('nourishment=60&energy=12&is_working=true')) === 'droop');
    check('energy 0 → sleep', (await poseAfter('nourishment=60&energy=0&is_working=false')) === 'sleep');
    check('energy back to 90 → wakes', (await poseAfter('nourishment=60&energy=90&is_working=true')) === 'working');

    backend.kill();
    await waitFor(async () => {
      try {
        await fetch(`${base}/healthz`);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    await client.poll();
    run(renderer, 2_000);
    check('backend gone → droop, not a frozen happy pose', renderer.pose === 'droop');
    check('and desaturated', renderer.currentParams.saturation < 0.05);
  } finally {
    backend.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
}

console.info = quietInfo;

if (failures.length) {
  console.log(`\n${failures.length} 3D check(s) FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll 3D checks passed.');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
