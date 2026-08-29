/**
 * The real Rive implementation.
 *
 * Four things here exist because of known Rive-on-desktop gotchas:
 *
 *  1. `RuntimeLoader.setWasmUrl()` points at a LOCAL copy of `rive.wasm`.
 *     `@rive-app/canvas` otherwise fetches it from a CDN at runtime, which a
 *     desktop app must never depend on.
 *  2. **A state machine is not instanced just because autoplay is on.** See
 *     `ensureStateMachineInstanced()` — without this the state-machine
 *     fallback below binds nothing at all.
 *  3. The 0–100 values are bound through **data binding when the artboard
 *     exposes a view model**, and through state-machine inputs otherwise.
 *     Both paths use the same four names from `rive-contract.ts`, so the art
 *     can be authored either way without a code change here.
 *  4. Every name that resolves through NEITHER path is logged loudly, and the
 *     bound count is surfaced in the popover. A silently-absent input would
 *     mean the app *looks* like it is driving the avatar while the artboard
 *     never moves — exactly the class of silent failure that must not be
 *     possible.
 */

import type { AvatarRenderer } from './renderer.js';
import type { AvatarStateName } from '../../core/types.js';
import {
  RIVE_ARTBOARD,
  RIVE_ASSET_URL,
  RIVE_INPUTS,
  RIVE_STATE_MACHINE,
  RIVE_WASM_URL,
} from '../../core/rive-contract.js';

/** Minimal structural types — avoids a hard compile-time dep on the Rive package. */
interface RiveStateMachineInput {
  name?: string;
  value?: number | boolean;
  fire?(): void;
}

/** A bound value, however it was resolved. */
interface Binding {
  setNumber?(value: number): void;
  setBoolean?(value: boolean): void;
  fire?(): void;
}

/**
 * How the Rive package is obtained.
 *
 * Injectable so the binding contract can be exercised headlessly against a
 * stub that reproduces the runtime's documented semantics. Production always
 * uses the default.
 */
export type RiveModuleLoader = () => Promise<any>;

/** Dynamic so a missing/optional dependency degrades instead of breaking the bundle. */
const importRiveModule: RiveModuleLoader = () => import('@rive-app/canvas');

/**
 * @returns a live renderer, or `null` if the Rive package or the file is
 *          unavailable — the caller then falls back to the placeholder.
 */
export async function tryCreateRiveRenderer(
  canvas: HTMLCanvasElement,
  loadRiveModule: RiveModuleLoader = importRiveModule,
): Promise<AvatarRenderer | null> {
  let riveModule: any;
  try {
    riveModule = await loadRiveModule();
  } catch (error) {
    console.warn('[avatar] @rive-app/canvas not available:', error);
    return null;
  }

  try {
    riveModule.RuntimeLoader?.setWasmUrl?.(RIVE_WASM_URL);
  } catch (error) {
    console.warn('[avatar] could not pin a local rive.wasm — continuing:', error);
  }

  return new Promise<AvatarRenderer | null>((resolve) => {
    let settled = false;
    const settle = (value: AvatarRenderer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const instance = new riveModule.Rive({
        src: RIVE_ASSET_URL,
        canvas,
        autoplay: true,
        // Binds the artboard's default view model, when it has one. Harmless
        // on runtimes/files without data binding.
        autoBind: true,
        artboard: RIVE_ARTBOARD ?? undefined,
        stateMachines: RIVE_STATE_MACHINE ?? undefined,
        onLoad: () => {
          try {
            instance.resizeDrawingSurfaceToCanvas?.();
            const machine = ensureStateMachineInstanced(instance);
            settle(new RiveAvatarRenderer(instance, machine));
          } catch (error) {
            console.warn('[avatar] Rive loaded but inputs could not be bound:', error);
            settle(null);
          }
        },
        onLoadError: (error: unknown) => {
          console.warn('[avatar] Rive load error:', error);
          settle(null);
        },
      });
    } catch (error) {
      console.warn('[avatar] Rive construction threw:', error);
      settle(null);
    }
  });
}

/**
 * Make sure a state machine is actually *running*, not merely present.
 *
 * This is the gotcha that would otherwise make the state-machine fallback a
 * lie. `@rive-app/canvas`'s autoplay-with-no-names path (`Animator.atLeastOne`)
 * reads:
 *
 *     if (artboard.animationCount() > 0)        → instance the first ANIMATION
 *     else if (artboard.stateMachineCount() > 0) → instance the first state machine
 *
 * An artboard authored with a state machine also contains the timelines that
 * machine drives, so `animationCount()` is > 0 and the **animation branch
 * always wins**. Nothing instances the state machine. `stateMachineInputs()`
 * then returns `undefined` (it searches *instanced* machines only), so all four
 * names fail to bind and the avatar renders a frozen pose forever.
 *
 * We cannot pass the name up front — it is not knowable until the file loads —
 * so resolve it here and start it explicitly. The default timeline is stopped
 * first: an animation and a state machine driving the same artboard fight over
 * the same properties.
 *
 * @param instance A loaded `Rive` instance.
 * @returns The state machine name now driving the artboard, or `null` when the
 *          artboard has none (a pure data-binding file, which is fine).
 */
function ensureStateMachineInstanced(instance: any): string | null {
  const available: string[] = instance.stateMachineNames ?? [];
  const target = RIVE_STATE_MACHINE ?? available[0] ?? null;
  if (!target) return null;

  // `undefined` means "not instanced"; an instanced machine with no inputs
  // still returns an array.
  if (instance.stateMachineInputs?.(target) !== undefined) return target;

  try {
    instance.stop?.();
  } catch (error) {
    console.warn('[avatar] could not stop the default timeline — continuing:', error);
  }
  instance.play?.(target);
  return target;
}

class RiveAvatarRenderer implements AvatarRenderer {
  readonly kind = 'rive' as const;
  /** e.g. `4/4 inputs` — surfaced in the popover so a dead contract is visible. */
  readonly detail: string;

  private readonly nourishment: Binding | null;
  private readonly energy: Binding | null;
  private readonly working: Binding | null;
  private readonly celebrateTrigger: Binding | null;

  constructor(private readonly instance: any, machine: string | null) {
    const viewModel = instance.viewModelInstance ?? null;
    const inputs: RiveStateMachineInput[] = machine
      ? (instance.stateMachineInputs?.(machine) ?? [])
      : [];
    const byName = new Map(inputs.map((input) => [input.name, input]));

    this.nourishment = bindNumber(viewModel, byName, RIVE_INPUTS.nourishment);
    this.energy = bindNumber(viewModel, byName, RIVE_INPUTS.energy);
    this.working = bindBoolean(viewModel, byName, RIVE_INPUTS.isWorking);
    this.celebrateTrigger = bindTrigger(viewModel, byName, RIVE_INPUTS.celebrate);

    const bindings = [
      [RIVE_INPUTS.nourishment, this.nourishment],
      [RIVE_INPUTS.energy, this.energy],
      [RIVE_INPUTS.isWorking, this.working],
      [RIVE_INPUTS.celebrate, this.celebrateTrigger],
    ] as const;

    for (const [name, binding] of bindings) {
      if (!binding) {
        console.warn(
          `[avatar] Rive artboard exposes no data-binding property and no state-machine ` +
            `input named "${name}" — that signal is NOT driving the avatar. ` +
            `Searched view model: ${viewModel ? 'yes' : 'none'}; ` +
            `state machine: ${machine ?? 'none'} ` +
            `(inputs: ${inputs.map((i) => i.name).join(', ') || 'none'}).`,
        );
      }
    }

    const bound = bindings.filter(([, binding]) => binding).length;
    this.detail = `${bound}/${bindings.length} inputs`;

    if (bound === 0) {
      // Louder than a warning: the file loaded and will draw, but the contract
      // in rive-contract.ts is not implemented, so the avatar is decoration.
      // Kept rather than swapped for the placeholder, because hiding the art
      // Thomas just exported would obscure the actual problem.
      console.error(
        `[avatar] ${RIVE_ASSET_URL} loaded but NONE of the four contract inputs bound. ` +
          'The avatar will render a static pose and ignore all telemetry. ' +
          'See RIVE_BUILD_BRIEF.md — the names are case-sensitive.',
      );
    }
  }

  /** The 0..1 → 0–100 scaling the artboard expects happens here, at the boundary. */
  setNourishment(value01: number): void {
    this.nourishment?.setNumber?.(clamp01(value01) * 100);
  }

  setEnergy(value01: number): void {
    this.energy?.setNumber?.(clamp01(value01) * 100);
  }

  setWorking(working: boolean): void {
    this.working?.setBoolean?.(working);
  }

  /**
   * Intentionally a no-op: state is derivable inside the artboard from the two
   * numbers plus `isWorking`. If the art ends up wanting an explicit state
   * input, add it to `rive-contract.ts` and bind it here.
   */
  setStateName(_state: AvatarStateName): void {}

  celebrate(): void {
    this.celebrateTrigger?.fire?.();
  }

  frame(_dtMs: number): void {
    // Rive drives its own animation loop.
  }

  destroy(): void {
    this.instance.cleanup?.();
  }
}

/**
 * Resolve a number by data binding first, then by state-machine input.
 *
 * Data binding is preferred for continuously-varying values; the input path is
 * the compatibility fallback for artboards authored without a view model.
 */
function bindNumber(
  viewModel: any,
  inputs: Map<string | undefined, RiveStateMachineInput>,
  name: string,
): Binding | null {
  const property = safeCall(() => viewModel?.number?.(name));
  if (property) return { setNumber: (value) => void (property.value = value) };

  const input = inputs.get(name);
  if (input) return { setNumber: (value) => void (input.value = value) };

  return null;
}

function bindBoolean(
  viewModel: any,
  inputs: Map<string | undefined, RiveStateMachineInput>,
  name: string,
): Binding | null {
  const property = safeCall(() => viewModel?.boolean?.(name));
  if (property) return { setBoolean: (value) => void (property.value = value) };

  const input = inputs.get(name);
  if (input) return { setBoolean: (value) => void (input.value = value) };

  return null;
}

function bindTrigger(
  viewModel: any,
  inputs: Map<string | undefined, RiveStateMachineInput>,
  name: string,
): Binding | null {
  const property = safeCall(() => viewModel?.trigger?.(name));
  if (property?.trigger) return { fire: () => property.trigger() };

  const input = inputs.get(name);
  if (input?.fire) return { fire: () => input.fire?.() };

  return null;
}

/** Rive's view-model lookups throw on a missing name; absence is not an error here. */
function safeCall<T>(fn: () => T): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
