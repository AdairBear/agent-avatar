/**
 * The contract between this app and the `.riv` artboard.
 *
 * These four names are the whole interface. They live here -- in pure core,
 * imported by the renderer -- so the app and the art have exactly one written
 * source of truth. If the artboard renames an input, this file changes and the
 * renderer follows.
 *
 * The 0-100 values are looked up as **data-binding properties first**, because
 * that is what Rive recommends for continuously-varying numbers, and fall back
 * to state-machine inputs of the same name. An artboard may expose them either
 * way; both paths are tried, and a name that resolves through neither is
 * logged loudly rather than silently ignored.
 */

export const RIVE_INPUTS = {
  /** Number, 0-100. Fed by completed work. */
  nourishment: 'nourishment',
  /** Number, 0-100. Remaining usage budget; 0 means asleep. */
  energy: 'energy',
  /** Boolean. True while a workstream is actively moving. */
  isWorking: 'isWorking',
  /** Trigger. Fired once per accepted completion. */
  celebrate: 'celebrate',
} as const;

export type RiveInputName = (typeof RIVE_INPUTS)[keyof typeof RIVE_INPUTS];

/** Number inputs, preferably bound via data binding. */
export const RIVE_NUMBER_INPUTS: RiveInputName[] = [RIVE_INPUTS.nourishment, RIVE_INPUTS.energy];
/** Boolean inputs. */
export const RIVE_BOOLEAN_INPUTS: RiveInputName[] = [RIVE_INPUTS.isWorking];
/** Trigger inputs. */
export const RIVE_TRIGGER_INPUTS: RiveInputName[] = [RIVE_INPUTS.celebrate];

/** Artboard + state machine the renderer looks for. `null` = use the file default. */
export const RIVE_ARTBOARD: string | null = null;
export const RIVE_STATE_MACHINE: string | null = null;

/** Where the build drops the `.riv`, relative to the renderer HTML. */
export const RIVE_ASSET_URL = 'avatar.riv';
/** Local copy of the Rive WASM. A desktop app must not fetch this from a CDN. */
export const RIVE_WASM_URL = 'rive.wasm';
