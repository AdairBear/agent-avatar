#!/usr/bin/env node
/**
 * Headless proof that the four Rive inputs are actually driven.
 *
 * Phase 2's whole promise is "drop `avatar.riv` into `src/assets/`, rebuild,
 * and it lights up". Nothing about that is self-evident: the binding layer can
 * load a file, draw it, log nothing, and still be pushing every value into the
 * void. This test drives the real `tryCreateRiveRenderer()` against a stub that
 * reproduces `@rive-app/canvas`'s documented semantics, and asserts the values
 * land.
 *
 * The stub models three behaviours read directly out of the runtime source
 * (`node_modules/@rive-app/canvas/rive.js`, v2.39):
 *
 *   1. `Animator.atLeastOne()` — with no names given, autoplay instances the
 *      first *timeline animation*, and only falls through to a state machine
 *      when the artboard has none. This is why `ensureStateMachineInstanced()`
 *      exists.
 *   2. `Rive.stateMachineInputs(name)` returns `undefined` for a state machine
 *      that is not *instanced* — a name being present on the artboard is not
 *      enough.
 *   3. `ViewModelInstance.number/boolean/trigger(path)` throw on an unknown
 *      path rather than returning null.
 *
 * What this does NOT prove: that a real `.riv` parses, or that Rive's own
 * state-machine logic does what the art intends. Only a real export can show
 * that — see RIVE_BUILD_BRIEF.md.
 *
 * Run:  npm run smoke:rive
 */

import { tryCreateRiveRenderer } from '../dist/renderer/shared/rive.mjs';

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    failures.push(label);
  }
};

/** Silences the deliberate warn/error output so the test log stays readable. */
function quietly(fn) {
  const warn = console.warn;
  const error = console.error;
  const captured = [];
  console.warn = (...args) => captured.push(String(args[0]));
  console.error = (...args) => captured.push(String(args[0]));
  return Promise.resolve(fn()).then(
    (value) => {
      console.warn = warn;
      console.error = error;
      return { value, captured };
    },
    (err) => {
      console.warn = warn;
      console.error = error;
      throw err;
    },
  );
}

// ── The stub runtime ────────────────────────────────────────────────────

function makeInput(name, type) {
  const input = { name, value: type === 'boolean' ? false : 0, fired: 0 };
  if (type === 'trigger') input.fire = () => void (input.fired += 1);
  return input;
}

function makeViewModel(names) {
  const props = new Map();
  for (const [name, type] of Object.entries(names)) {
    props.set(name, type === 'trigger' ? { fired: 0, trigger() { this.fired += 1; } } : { value: 0 });
  }
  const lookup = (name, kind) => {
    const prop = props.get(name);
    // Rive throws on an unknown path; absence must not read as a binding.
    if (!prop) throw new Error(`no ${kind} property "${name}"`);
    return prop;
  };
  return {
    props,
    number: (name) => lookup(name, 'number'),
    boolean: (name) => lookup(name, 'boolean'),
    trigger: (name) => lookup(name, 'trigger'),
  };
}

/**
 * @param options.animations   timeline animations on the artboard
 * @param options.machines     `{ [name]: { [inputName]: 'number'|'boolean'|'trigger' } }`
 * @param options.viewModel    `{ [name]: type }`, or null for no data binding
 */
function makeRiveModule({ animations = ['Idle'], machines = {}, viewModel = null }) {
  const state = {
    stopped: 0,
    played: [],
    instancedMachines: new Set(),
    instancedAnimations: new Set(),
    inputs: {},
    viewModel: viewModel ? makeViewModel(viewModel) : null,
    wasmUrl: null,
  };

  for (const [machine, inputs] of Object.entries(machines)) {
    state.inputs[machine] = Object.entries(inputs).map(([name, type]) => makeInput(name, type));
  }

  class Rive {
    constructor(opts) {
      this.opts = opts;
      // Animator.atLeastOne(): the animation branch wins whenever one exists.
      if (opts.stateMachines) {
        state.instancedMachines.add(opts.stateMachines);
      } else if (animations.length > 0) {
        state.instancedAnimations.add(animations[0]);
      } else if (Object.keys(machines).length > 0) {
        state.instancedMachines.add(Object.keys(machines)[0]);
      }
      queueMicrotask(() => opts.onLoad?.());
    }
    get stateMachineNames() {
      return Object.keys(machines);
    }
    get viewModelInstance() {
      return this.opts.autoBind ? state.viewModel : null;
    }
    stateMachineInputs(name) {
      return state.instancedMachines.has(name) ? state.inputs[name] : undefined;
    }
    play(name) {
      state.played.push(name);
      if (name in machines) state.instancedMachines.add(name);
    }
    stop() {
      state.stopped += 1;
      state.instancedAnimations.clear();
    }
    resizeDrawingSurfaceToCanvas() {}
    cleanup() {}
  }

  return {
    module: {
      Rive,
      RuntimeLoader: { setWasmUrl: (url) => void (state.wasmUrl = url) },
    },
    state,
  };
}

const CONTRACT = {
  nourishment: 'number',
  energy: 'number',
  isWorking: 'boolean',
  celebrate: 'trigger',
};

const canvas = {};

// ── 1. The defect this fix exists for ───────────────────────────────────

console.log('\n1. A state-machine artboard binds all four inputs');
{
  const { module, state } = makeRiveModule({
    // An artboard authored with a state machine also carries the timelines it
    // drives. This is the ordinary case, and the one that used to bind nothing.
    animations: ['Idle', 'Blink'],
    machines: { 'Avatar Machine': CONTRACT },
  });
  const { value: renderer } = await quietly(() => tryCreateRiveRenderer(canvas, async () => module));

  check('a renderer was produced', renderer !== null);
  check('it reports as rive', renderer?.kind === 'rive');
  check('the state machine was explicitly started', state.played.includes('Avatar Machine'));
  check('the default timeline was stopped first', state.stopped === 1);
  check('all four inputs bound', renderer?.detail === '4/4 inputs', `got ${renderer?.detail}`);

  const byName = Object.fromEntries(state.inputs['Avatar Machine'].map((i) => [i.name, i]));
  renderer.setNourishment(0.425);
  renderer.setEnergy(0.775);
  renderer.setWorking(true);
  renderer.celebrate();

  check('nourishment scaled 0..1 → 0–100', byName.nourishment.value === 42.5);
  check('energy scaled 0..1 → 0–100', byName.energy.value === 77.5);
  check('isWorking set as a boolean', byName.isWorking.value === true);
  check('celebrate fired exactly once', byName.celebrate.fired === 1);

  renderer.setWorking(false);
  check('isWorking clears again', byName.isWorking.value === false);

  renderer.setNourishment(2);
  renderer.setEnergy(-1);
  check('out-of-range values clamp to 0–100', byName.nourishment.value === 100 && byName.energy.value === 0);
}

// ── 2. The data-binding path ────────────────────────────────────────────

console.log('\n2. A data-binding artboard binds through the view model');
{
  const { module, state } = makeRiveModule({
    animations: ['Idle'],
    machines: {},
    viewModel: CONTRACT,
  });
  const { value: renderer } = await quietly(() => tryCreateRiveRenderer(canvas, async () => module));

  check('all four inputs bound', renderer?.detail === '4/4 inputs', `got ${renderer?.detail}`);
  check('a local rive.wasm was pinned', state.wasmUrl === 'rive.wasm');

  renderer.setNourishment(0.1);
  renderer.setEnergy(1);
  renderer.setWorking(true);
  renderer.celebrate();
  renderer.celebrate();

  check('nourishment reached the view model at 0–100', state.viewModel.props.get('nourishment').value === 10);
  check('energy reached the view model at 0–100', state.viewModel.props.get('energy').value === 100);
  check('isWorking reached the view model', state.viewModel.props.get('isWorking').value === true);
  check('the trigger fired per call', state.viewModel.props.get('celebrate').fired === 2);
}

// ── 3. Precedence, and partial contracts ────────────────────────────────

console.log('\n3. Data binding wins over a state-machine input of the same name');
{
  const { module, state } = makeRiveModule({
    animations: ['Idle'],
    machines: { Main: CONTRACT },
    viewModel: { nourishment: 'number' },
  });
  const { value: renderer } = await quietly(() => tryCreateRiveRenderer(canvas, async () => module));

  renderer.setNourishment(0.5);
  const smInput = state.inputs.Main.find((i) => i.name === 'nourishment');

  check('the view-model property took the value', state.viewModel.props.get('nourishment').value === 50);
  check('the state-machine input was left alone', smInput.value === 0);
  check('the other three still bound via the state machine', renderer?.detail === '4/4 inputs');
}

console.log('\n4. A partially-wired artboard reports honestly');
{
  const { module } = makeRiveModule({
    animations: ['Idle'],
    machines: { Main: { nourishment: 'number', energy: 'number' } },
  });
  const { value: renderer, captured } = await quietly(() =>
    tryCreateRiveRenderer(canvas, async () => module),
  );

  check('bind count is reported, not rounded up', renderer?.detail === '2/4 inputs', `got ${renderer?.detail}`);
  check('the missing names are warned about by name', captured.some((m) => m.includes('"isWorking"')));
  check('driving an unbound signal does not throw', (() => {
    try {
      renderer.setWorking(true);
      renderer.celebrate();
      return true;
    } catch {
      return false;
    }
  })());
}

console.log('\n5. An artboard that ignores the contract entirely is an error, not a shrug');
{
  const { module } = makeRiveModule({ animations: ['Idle'], machines: { Main: { wiggle: 'number' } } });
  const { value: renderer, captured } = await quietly(() =>
    tryCreateRiveRenderer(canvas, async () => module),
  );

  check('nothing bound', renderer?.detail === '0/4 inputs', `got ${renderer?.detail}`);
  check(
    'and it says so loudly',
    captured.some((m) => m.includes('NONE of the four contract inputs bound')),
  );
}

console.log('\n6. Load failures fall back rather than pretending');
{
  const { module } = makeRiveModule({ machines: { Main: CONTRACT } });
  class Failing extends module.Rive {
    constructor(opts) {
      super({ ...opts, onLoad: undefined });
      queueMicrotask(() => opts.onLoadError?.(new Error('corrupt file')));
    }
  }
  const { value: renderer } = await quietly(() =>
    tryCreateRiveRenderer(canvas, async () => ({ ...module, Rive: Failing })),
  );
  check('a failed load yields null so the placeholder takes over', renderer === null);

  const { value: missing } = await quietly(() =>
    tryCreateRiveRenderer(canvas, async () => {
      throw new Error('package not installed');
    }),
  );
  check('a missing Rive package yields null too', missing === null);
}

// ── 7. The end-to-end mapping ───────────────────────────────────────────

console.log('\n7. A real telemetry snapshot drives the four inputs end to end');
{
  const { MockSource } = await import('../dist/core/mock.mjs');
  const { module, state } = makeRiveModule({
    animations: ['Idle'],
    machines: { Main: CONTRACT },
  });
  const { value: renderer } = await quietly(() => tryCreateRiveRenderer(canvas, async () => module));

  // Exactly what popover/main.ts and living/main.ts do with every snapshot.
  const snapshot = new MockSource().snapshot();
  renderer.setNourishment(snapshot.nourishment / 100);
  renderer.setEnergy(snapshot.energy / 100);
  renderer.setWorking(snapshot.isWorking);

  const byName = Object.fromEntries(state.inputs.Main.map((i) => [i.name, i]));
  check(
    'nourishment round-trips within rounding',
    Math.abs(byName.nourishment.value - snapshot.nourishment) < 1e-6,
    `${byName.nourishment.value} vs ${snapshot.nourishment}`,
  );
  check(
    'energy round-trips within rounding',
    Math.abs(byName.energy.value - snapshot.energy) < 1e-6,
    `${byName.energy.value} vs ${snapshot.energy}`,
  );
  check('isWorking round-trips', byName.isWorking.value === snapshot.isWorking);
  check(
    'both numbers are inside the artboard range',
    [byName.nourishment.value, byName.energy.value].every((v) => v >= 0 && v <= 100),
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`FAILED — ${failures.length} check(s):\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
console.log('All Rive binding checks passed.\n');
