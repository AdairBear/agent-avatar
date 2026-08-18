/**
 * The real Rive implementation.
 *
 * Three things here exist because of known Rive-on-desktop gotchas:
 *
 *  1. `RuntimeLoader.setWasmUrl()` points at a LOCAL copy of `rive.wasm`.
 *     `@rive-app/canvas` otherwise fetches it from a CDN at runtime, which a
 *     desktop app must never depend on.
 *  2. The 0–100 values are bound through **data binding when the artboard
 *     exposes a view model**, and through state-machine inputs otherwise.
 *     Both paths use the same four names from `rive-contract.ts`, so the art
 *     can be authored either way without a code change here.
 *  3. Every name that resolves through NEITHER path is logged loudly. A
 *     silently-absent input would mean the app *looks* like it is driving the
 *     avatar while the artboard never moves — exactly the class of silent
 *     failure that must not be possible.
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
 * @returns a live renderer, or `null` if the Rive package or the file is
 *          unavailable — the caller then falls back to the placeholder.
 */
export async function tryCreateRiveRenderer(
  canvas: HTMLCanvasElement,
): Promise<AvatarRenderer | null> {
  let riveModule: any;
  try {
    // Dynamic so a missing/optional dependency degrades instead of breaking the bundle.
    riveModule = await import('@rive-app/canvas');
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
            settle(new RiveAvatarRenderer(instance));
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

class RiveAvatarRenderer implements AvatarRenderer {
  readonly kind = 'rive' as const;

  private readonly nourishment: Binding | null;
  private readonly energy: Binding | null;
  private readonly working: Binding | null;
  private readonly celebrateTrigger: Binding | null;

  constructor(private readonly instance: any) {
    const viewModel = instance.viewModelInstance ?? null;
    const machine =
      RIVE_STATE_MACHINE ?? instance.stateMachineNames?.[0] ?? undefined;
    const inputs: RiveStateMachineInput[] = machine
      ? (instance.stateMachineInputs?.(machine) ?? [])
      : [];
    const byName = new Map(inputs.map((input) => [input.name, input]));

    this.nourishment = bindNumber(viewModel, byName, RIVE_INPUTS.nourishment);
    this.energy = bindNumber(viewModel, byName, RIVE_INPUTS.energy);
    this.working = bindBoolean(viewModel, byName, RIVE_INPUTS.isWorking);
    this.celebrateTrigger = bindTrigger(viewModel, byName, RIVE_INPUTS.celebrate);

    for (const [name, binding] of [
      [RIVE_INPUTS.nourishment, this.nourishment],
      [RIVE_INPUTS.energy, this.energy],
      [RIVE_INPUTS.isWorking, this.working],
      [RIVE_INPUTS.celebrate, this.celebrateTrigger],
    ] as const) {
      if (!binding) {
        console.warn(
          `[avatar] Rive artboard exposes no data-binding property and no state-machine ` +
            `input named "${name}" — that signal is NOT driving the avatar.`,
        );
      }
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
