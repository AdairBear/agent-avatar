#!/usr/bin/env node
/**
 * esbuild bundling.
 *
 * Chosen over a full framework toolchain for one reason that matters on this
 * machine: it compiles nothing to native and writes kilobytes, not gigabytes.
 * A full rebuild is well under a second.
 *
 *   node scripts/build.mjs           one-shot
 *   node scripts/build.mjs --watch   rebuild on change
 */

import * as esbuild from 'esbuild';
import { cp, mkdir, rm, access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const WATCH = process.argv.includes('--watch');

const exists = async (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

/** Main + preload: CommonJS, because Electron's main process wants CJS. */
const mainConfigs = [
  {
    entryPoints: [path.join(ROOT, 'src/main/index.ts')],
    outfile: path.join(DIST, 'main/index.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
  {
    entryPoints: [path.join(ROOT, 'src/main/preload.ts')],
    outfile: path.join(DIST, 'main/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  },
];

/** Renderers: IIFE for plain <script> tags, no module loader needed. */
const rendererConfigs = [
  {
    entryPoints: [path.join(ROOT, 'src/renderer/popover/main.ts')],
    outfile: path.join(DIST, 'renderer/popover/popover.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
  {
    entryPoints: [path.join(ROOT, 'src/renderer/living/main.ts')],
    outfile: path.join(DIST, 'renderer/living/living.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
];

/** The pure core, bundled standalone so the headless smoke test can import it. */
const coreConfig = {
  entryPoints: [path.join(ROOT, 'src/core/client.ts')],
  outfile: path.join(DIST, 'core/client.mjs'),
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
};

const smokeEntryConfig = {
  entryPoints: [path.join(ROOT, 'src/core/mock.ts')],
  outfile: path.join(DIST, 'core/mock.mjs'),
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
};

/**
 * The Rive binding layer, bundled standalone so `scripts/smoke-rive.mjs` can
 * drive it headlessly against a stub runtime. `@rive-app/canvas` stays external
 * because that test injects its own module — the real package is never loaded
 * outside a browser.
 */
const riveBindingConfig = {
  entryPoints: [path.join(ROOT, 'src/renderer/shared/rive.ts')],
  outfile: path.join(DIST, 'renderer/shared/rive.mjs'),
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
  external: ['@rive-app/canvas'],
};

/** The pose machine, standalone for `scripts/smoke-three.mjs`. */
const poseConfig = {
  entryPoints: [path.join(ROOT, 'src/core/pose.ts')],
  outfile: path.join(DIST, 'core/pose.mjs'),
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
};

/**
 * The 3D render layer, bundled standalone so `scripts/smoke-three.mjs` can run
 * the whole pipeline — scene graph, pose machine, rig — against a stub GL
 * backend. `three` stays external so the test shares its instance.
 */
const threeLayerConfig = {
  entryPoints: [path.join(ROOT, 'src/renderer/shared/three/index.ts')],
  outfile: path.join(DIST, 'renderer/shared/three.mjs'),
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
  external: ['three', 'three/*'],
};

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

async function copyStaticAssets() {
  await cp(path.join(ROOT, 'src/renderer/popover/index.html'), path.join(DIST, 'renderer/popover/index.html'));
  await cp(path.join(ROOT, 'src/renderer/popover/popover.css'), path.join(DIST, 'renderer/popover/popover.css'));
  await cp(path.join(ROOT, 'src/renderer/living/index.html'), path.join(DIST, 'renderer/living/index.html'));
  await cp(path.join(ROOT, 'src/renderer/living/living.css'), path.join(DIST, 'renderer/living/living.css'));

  // The .riv, if Track 1 has dropped one in. Its presence is what switches the
  // renderer from placeholder to Rive — see src/renderer/shared/renderer.ts.
  const riv = path.join(ROOT, 'src/assets/avatar.riv');
  if (await exists(riv)) {
    for (const dir of ['popover', 'living']) {
      await cp(riv, path.join(DIST, 'renderer', dir, 'avatar.riv'));
    }
    console.log('[build] avatar.riv found → Rive renderer will be used');
  } else {
    console.log('[build] no src/assets/avatar.riv → 3D renderer will be used');
  }

  // The rigged model, if the manual asset step has produced one. Same rule as
  // the .riv: its presence swaps the primitive capybara for it.
  const glb = path.join(ROOT, 'src/assets/avatar.glb');
  if (await exists(glb)) {
    for (const dir of ['popover', 'living']) {
      await cp(glb, path.join(DIST, 'renderer', dir, 'avatar.glb'));
    }
    console.log('[build] avatar.glb found → 3D renderer will drive it');
  } else {
    console.log('[build] no src/assets/avatar.glb → primitive capybara will be used');
  }

  // Rive's WASM must be served locally; the package fetches it from a CDN by
  // default, which a desktop app cannot rely on.
  const wasmCandidates = [
    'node_modules/@rive-app/canvas/rive.wasm',
    'node_modules/@rive-app/canvas/rive_fallback.wasm',
  ];
  let copiedWasm = false;
  for (const candidate of wasmCandidates) {
    const src = path.join(ROOT, candidate);
    if (!(await exists(src))) continue;
    for (const dir of ['popover', 'living']) {
      await cp(src, path.join(DIST, 'renderer', dir, 'rive.wasm'));
    }
    copiedWasm = true;
    break;
  }
  if (!copiedWasm) {
    console.warn(
      '[build] WARNING: no rive.wasm found in @rive-app/canvas. The Rive renderer ' +
        'would have to fetch it from a CDN at runtime. Fine while the placeholder ' +
        'is in use; must be fixed before shipping real art.',
    );
  }
}

/** Electron resolves `main` from package.json; dist needs a CJS marker of its own. */
async function writeDistPackageJson() {
  await mkdir(path.join(DIST, 'main'), { recursive: true });
  await writeFile(path.join(DIST, 'main', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
}

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const configs = [
    ...mainConfigs,
    ...rendererConfigs,
    coreConfig,
    smokeEntryConfig,
    riveBindingConfig,
    poseConfig,
    threeLayerConfig,
  ].map((c) => ({
    ...common,
    ...c,
  }));

  if (WATCH) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    await copyStaticAssets();
    await writeDistPackageJson();
    console.log('[build] watching for changes — ctrl-c to stop');
    return;
  }

  await Promise.all(configs.map((c) => esbuild.build(c)));
  await copyStaticAssets();
  await writeDistPackageJson();
  console.log('[build] done →', path.relative(ROOT, DIST));
}

build().catch((error) => {
  console.error('[build] failed:', error);
  process.exit(1);
});
