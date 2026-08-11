/**
 * The contract between this app and the `.riv` artboard.
 *
 * These three names are agreed with the Rive file being authored in Track 1.
 * They live here — in pure core, imported by the renderer — so the app and the
 * art have exactly one written source of truth. If the artboard renames an
 * input, this file changes and the renderer follows.
 */

export const RIVE_INPUTS = {
  /** Number input, 0–100. Fed by completed work. */
  nourishment: 'nourishment',
  /** Number input, 0–100. Drained by usage budget. */
  stamina: 'stamina',
  /** Trigger. Fired once per accepted completion. */
  celebrate: 'celebrate',
} as const;

export type RiveInputName = (typeof RIVE_INPUTS)[keyof typeof RIVE_INPUTS];

/** Artboard + state machine the renderer looks for. `null` = use the file default. */
export const RIVE_ARTBOARD: string | null = null;
export const RIVE_STATE_MACHINE: string | null = null;

/** Where the build drops the `.riv`, relative to the renderer HTML. */
export const RIVE_ASSET_URL = 'avatar.riv';
/** Local copy of the Rive WASM. A desktop app must not fetch this from a CDN. */
export const RIVE_WASM_URL = 'rive.wasm';
