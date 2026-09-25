/**
 * The 3D avatar's pose layer: four telemetry signals → five body poses.
 *
 * The `.riv` contract (see `rive-contract.ts`) deliberately leaves discrete
 * states to the artboard, which derives them from `nourishment`, `energy` and
 * `isWorking` plus the `celebrate` trigger. The 3D renderer has no artboard to
 * do that for it, so this file *is* its state machine: pure, clock-injected,
 * and exercised headlessly by `scripts/smoke-three.mjs`.
 *
 *   sleep > droop > celebrate > working > idle
 *
 * mirrors the backend's ladder (`telemetry/avatar_telemetry/state.py`). `droop`
 * is the body's read of the backend's `drowsy`, and also of `unknown`: a stale
 * feed never renders as a happy creature. Thresholds default to the backend's
 * own defaults; when the backend's state name is supplied as a hint, a sleep or
 * drowsy verdict from it wins, so retuning `AVATAR_DROWSY_BELOW` there still
 * lands here without a second config.
 *
 * Nothing in here imports three.js. Poses resolve to plain numbers
 * (`PoseParams`) that any rig — the primitive placeholder today, a rigged glTF
 * later — turns into transforms.
 */

import type { AvatarStateName } from './types.js';

export type PoseName = 'idle' | 'working' | 'droop' | 'sleep' | 'celebrate';

export const POSES: readonly PoseName[] = ['idle', 'working', 'droop', 'sleep', 'celebrate'];

/** One reading of the four telemetry signals, as the renderer receives them. */
export interface PoseInput {
  /** 0..100. */
  nourishment: number;
  /** 0..100. */
  energy: number;
  isWorking: boolean;
  /** False when telemetry cannot prove freshness. Forces `droop`, desaturated. */
  fresh: boolean;
  /** The backend's resolved state, when known. Only its sleep/drowsy/unknown verdicts are used. */
  hint?: AvatarStateName;
}

export interface PoseTuning {
  /** Asleep at or below this energy. Backend default: `AVATAR_ASLEEP_AT` = 0. */
  sleepAtOrBelow: number;
  /** Droops below this energy. Backend default: `AVATAR_DROWSY_BELOW` = 20. */
  droopBelow: number;
  /**
   * Energy must climb this far past a threshold before the pose leaves it.
   * Energy refills slowly as usage ages out of the window, so without this a
   * reading hovering at 20 would flip the body between poses every poll.
   */
  hysteresis: number;
  /** How long one `celebrate` holds the pose. Backend: `CELEBRATE_SECONDS` = 6. */
  celebrateMs: number;
  /** Minimum time in `working` or `idle` before swapping between the two. */
  minDwellMs: number;
}

export const DEFAULT_POSE_TUNING: PoseTuning = {
  sleepAtOrBelow: 0,
  droopBelow: 20,
  hysteresis: 3,
  celebrateMs: 6_000,
  minDwellMs: 1_500,
};

export type PoseListener = (from: PoseName, to: PoseName, atMs: number) => void;

/**
 * Resolves the current pose from the latest signals, with hysteresis on the
 * energy thresholds and a hold on `celebrate`.
 *
 * Time is always passed in, never read, so a test can walk it deterministically.
 */
export class PoseMachine {
  private current: PoseName = 'idle';
  private enteredAt = 0;
  private stale = true;
  /** Wall-clock deadline of the celebrate hold; 0 when none is pending. */
  private celebrateUntil = 0;
  /** The first reading resolves directly; dwell only damps changes after it. */
  private settled = false;
  private readonly listeners = new Set<PoseListener>();

  constructor(private readonly tuning: PoseTuning = DEFAULT_POSE_TUNING) {}

  get pose(): PoseName {
    return this.current;
  }

  /** True when the last input could not prove freshness. The rig desaturates on it. */
  get isStale(): boolean {
    return this.stale;
  }

  /** When the current pose was entered, in the caller's clock. */
  get since(): number {
    return this.enteredAt;
  }

  onTransition(listener: PoseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register one accepted completion. Callers dedup pulses before this
   * (`PulsePlayer`), so every call is a real, new completion.
   */
  celebrate(nowMs: number): void {
    this.celebrateUntil = nowMs + this.tuning.celebrateMs;
  }

  update(input: PoseInput, nowMs: number): PoseName {
    const next = this.resolve(input, nowMs);
    this.settled = true;
    if (next !== this.current) {
      const from = this.current;
      this.current = next;
      this.enteredAt = nowMs;
      for (const listener of this.listeners) listener(from, next, nowMs);
    }
    return this.current;
  }

  private resolve(input: PoseInput, nowMs: number): PoseName {
    const t = this.tuning;
    // A non-finite energy is unreadable, not empty: treat it like a stale feed.
    const energy = finiteOr(input.energy, 0);
    this.stale = !input.fresh || input.hint === 'unknown' || !Number.isFinite(input.energy);

    // Leaving a low-energy pose needs energy to clear the threshold by a margin.
    const wasAsleep = this.current === 'sleep';
    const wasLow = wasAsleep || this.current === 'droop';
    const sleepLine = t.sleepAtOrBelow + (wasAsleep ? t.hysteresis : 0);
    const droopLine = t.droopBelow + (wasLow ? t.hysteresis : 0);

    const asleep = input.hint === 'sleep' || (!this.stale && energy <= sleepLine);
    if (asleep) {
      this.celebrateUntil = 0; // swallowed: a sleeping creature doesn't leap up
      return 'sleep';
    }

    // A stale feed droops rather than sleeping: sleep is a claim about energy
    // that an unreadable feed cannot back up.
    const drooping = this.stale || input.hint === 'drowsy' || energy < droopLine;
    if (drooping) {
      this.celebrateUntil = 0;
      return 'droop';
    }

    if (this.celebrateUntil > nowMs) return 'celebrate';
    this.celebrateUntil = 0;

    const wanted: PoseName = input.isWorking ? 'working' : 'idle';
    const swapping =
      (this.current === 'working' || this.current === 'idle') && wanted !== this.current;
    if (swapping && this.settled && nowMs - this.enteredAt < t.minDwellMs) return this.current;
    return wanted;
  }
}

/**
 * Everything a rig needs to strike a pose, as plain numbers.
 *
 * Levels (crouch, head pitch, ear droop, eye openness) are *targets* the rig
 * eases toward; rhythms (bob, sway, hop) are amplitudes and rates the rig
 * multiplies by its own clock. Keeping the two apart is what lets a transition
 * blend smoothly instead of snapping.
 */
export interface PoseParams {
  /** 0 standing tall … 1 flat on the ground (legs tucked). */
  crouch: number;
  /** Head pitch in radians; positive tips the nose down. */
  headPitch: number;
  /** 0 perked … 1 flat against the head. */
  earDroop: number;
  /** 0 closed … 1 wide open. */
  eyeOpen: number;
  /** Idle bob amplitude, in body heights. */
  bobAmp: number;
  /** Idle bob rate, Hz. */
  bobHz: number;
  /** Side-to-side sway amplitude, radians. */
  sway: number;
  /** Celebrate hop amplitude, in body heights. 0 outside celebrate. */
  hop: number;
  /** Sleep curl: 0 upright … 1 rolled onto its side, radians-scaled by the rig. */
  curl: number;
  /** Breathing depth (sleep reads mostly through this). */
  breathe: number;
  /** Playback speed, 0.6..1: a tired awake capybara moves slower. Clip rigs scale time by it. */
  tempo: number;
  /** Uniform girth scale from nourishment: a well-fed capybara is rounder. */
  plump: number;
  /** 0 grey … 1 full colour. Energy-tinted; 0 when the feed is stale. */
  saturation: number;
}

export const POSE_PARAM_KEYS = [
  'crouch',
  'headPitch',
  'earDroop',
  'eyeOpen',
  'bobAmp',
  'bobHz',
  'sway',
  'hop',
  'curl',
  'breathe',
  'tempo',
  'plump',
  'saturation',
] as const satisfies readonly (keyof PoseParams)[];

/** The per-pose shape, before the continuous signals modulate it. */
const BASE: Record<PoseName, Omit<PoseParams, 'tempo' | 'plump' | 'saturation'>> = {
  idle: {
    crouch: 0.1,
    headPitch: 0.05,
    earDroop: 0.15,
    eyeOpen: 0.85,
    bobAmp: 0.015,
    bobHz: 0.35,
    sway: 0.02,
    hop: 0,
    curl: 0,
    breathe: 0.02,
  },
  working: {
    crouch: 0,
    headPitch: 0.22, // nose down, focused
    earDroop: 0,
    eyeOpen: 1,
    bobAmp: 0.03,
    bobHz: 1.6,
    sway: 0.05,
    hop: 0,
    curl: 0,
    breathe: 0.02,
  },
  droop: {
    crouch: 0.45,
    headPitch: 0.45,
    earDroop: 0.9,
    eyeOpen: 0.35,
    bobAmp: 0.008,
    bobHz: 0.2,
    sway: 0.01,
    hop: 0,
    curl: 0,
    breathe: 0.035,
  },
  sleep: {
    crouch: 1,
    headPitch: 0.35,
    earDroop: 1,
    eyeOpen: 0,
    bobAmp: 0,
    bobHz: 0,
    sway: 0,
    hop: 0,
    curl: 0.35,
    breathe: 0.06,
  },
  celebrate: {
    crouch: 0,
    headPitch: -0.3, // chin up
    earDroop: 0,
    eyeOpen: 1,
    bobAmp: 0,
    bobHz: 0,
    sway: 0.14,
    hop: 0.35,
    curl: 0,
    breathe: 0.02,
  },
};

/**
 * Resolve a pose plus the live signals into rig targets.
 *
 * @param nourishment01 0..1
 * @param energy01 0..1
 */
export function poseTargets(
  pose: PoseName,
  nourishment01: number,
  energy01: number,
  stale: boolean,
): PoseParams {
  const n = clamp01(nourishment01);
  const e = clamp01(energy01);
  const base = BASE[pose];

  // Energy modulates only the awake poses: a tired-but-working capybara still
  // works, just with heavier lids and a slower rhythm.
  const awake = pose === 'idle' || pose === 'working' || pose === 'celebrate';
  const tired = awake ? 1 - e : 0;
  const tempo = 1 - tired * 0.4;

  return {
    ...base,
    eyeOpen: base.eyeOpen * (1 - tired * 0.35),
    bobHz: base.bobHz * tempo,
    tempo,
    earDroop: Math.min(1, base.earDroop + tired * 0.25),
    plump: 0.9 + n * 0.2,
    saturation: stale ? 0 : 0.45 + e * 0.55,
  };
}

/**
 * Ease `current` toward `target`, frame-rate independently.
 *
 * Exponential smoothing with time constant `tauMs`: after `tauMs` a param has
 * covered ~63% of the gap regardless of how many frames that took, so a
 * throttled background window blends at the same pace as a 60fps one.
 * Mutates and returns `current`.
 */
export function easeParams(
  current: PoseParams,
  target: PoseParams,
  dtMs: number,
  tauMs = 280,
): PoseParams {
  const k = dtMs <= 0 ? 0 : 1 - Math.exp(-dtMs / Math.max(1, tauMs));
  for (const key of POSE_PARAM_KEYS) {
    current[key] += (target[key] - current[key]) * k;
  }
  return current;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, finiteOr(v, 0)));
const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
