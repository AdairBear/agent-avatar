/**
 * The real Rive implementation.
 *
 * Two things here exist because of known Rive-on-desktop gotchas:
 *
 *  1. `RuntimeLoader.setWasmUrl()` points at a LOCAL copy of `rive.wasm`.
 *     `@rive-app/canvas` otherwise fetches it from a CDN at runtime, which a
 *     desktop app must never depend on.
 *  2. Every input is looked up by the name declared in `rive-contract.ts` and a
 *     miss is logged loudly. A silently-absent input would mean the app *looks*
 *     like it is driving the avatar while the artboard never moves — the exact
 *     class of silent failure the fail-loud rule exists to prevent.
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
interface RiveNumberInput {
  value: number;
}
interface RiveTriggerInput {
  fire(): void;
}
type RiveInput = Partial<RiveNumberInput & RiveTriggerInput> & { name?: string };

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
        artboard: RIVE_ARTBOARD ?? undefined,
        stateMachines: RIVE_STATE_MACHINE ?? undefined,
        onLoad: () => {
          try {
            instance.resizeDrawingSurfaceToCanvas?.();
            const machine =
              RIVE_STATE_MACHINE ?? instance.stateMachineNames?.[0] ?? undefined;
            const inputs: RiveInput[] = machine
              ? (instance.stateMachineInputs(machine) ?? [])
              : [];
            settle(new RiveAvatarRenderer(instance, inputs));
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

  private readonly nourishmentInput?: RiveInput;
  private readonly staminaInput?: RiveInput;
  private readonly celebrateInput?: RiveInput;

  constructor(
    private readonly instance: { cleanup?: () => void },
    inputs: RiveInput[],
  ) {
    const byName = new Map(inputs.map((i) => [i.name, i]));
    this.nourishmentInput = byName.get(RIVE_INPUTS.nourishment);
    this.staminaInput = byName.get(RIVE_INPUTS.stamina);
    this.celebrateInput = byName.get(RIVE_INPUTS.celebrate);

    for (const [label, input] of [
      [RIVE_INPUTS.nourishment, this.nourishmentInput],
      [RIVE_INPUTS.stamina, this.staminaInput],
      [RIVE_INPUTS.celebrate, this.celebrateInput],
    ] as const) {
      if (!input) {
        console.warn(
          `[avatar] Rive artboard has no input named "${label}" — that signal is NOT driving the avatar.`,
        );
      }
    }
  }

  /** The 0..1 → 0–100 scaling the artboard expects happens here, at the boundary. */
  setNourishment(value01: number): void {
    if (this.nourishmentInput) this.nourishmentInput.value = clamp01(value01) * 100;
  }

  setStamina(value01: number): void {
    if (this.staminaInput) this.staminaInput.value = clamp01(value01) * 100;
  }

  /**
   * Intentionally a no-op for now: state is derivable inside the artboard from
   * the two numbers. If Track 1's art ends up wanting an explicit state input,
   * add it to `rive-contract.ts` and bind it here.
   */
  setStateName(_state: AvatarStateName): void {}

  celebrate(): void {
    this.celebrateInput?.fire?.();
  }

  frame(_dtMs: number): void {
    // Rive drives its own animation loop.
  }

  destroy(): void {
    this.instance.cleanup?.();
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
