/**
 * Every tunable in one file.
 *
 * Several of these are spec §13 open questions deliberately parked as a single
 * constant rather than a design: change the number, feel the difference,
 * decide later from evidence.
 */

export interface EngineConfig {
  /** How often the engine polls adapters and emits a snapshot. */
  tickMs: number;

  // ── Nourishment (spec §4.1) ────────────────────────────────────────────
  /** Points added per accepted completion. Gauge is 0..100. */
  nourishmentBump: number;
  /**
   * Half-life of nourishment decay, in days. Gentle and never punitive —
   * a quiet creature, not a starving one. Spec §13 Q2.
   */
  nourishmentHalfLifeDays: number;
  /** Below this, the creature reads as `hungry`. */
  hungryBelow: number;
  /**
   * Whether `[Likely]` completions feed the gauge. Spec §13 Q4 says start
   * `[Certain]`-only and loosen if the creature feels under-fed.
   */
  acceptLikelyCompletions: boolean;

  // ── Stamina (spec §4.2) ────────────────────────────────────────────────
  /** Below this, the creature reads as `drowsy`. */
  drowsyBelow: number;
  /** At or below this, the creature sleeps. */
  asleepAtOrBelow: number;

  // ── Liveness (spec §2.1) ───────────────────────────────────────────────
  /** A workstream with no meaningful signal for this long droops. Spec §13 Q5. */
  livenessWindowS: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  tickMs: 1_000,

  nourishmentBump: 12,
  nourishmentHalfLifeDays: 3,
  hungryBelow: 35,
  acceptLikelyCompletions: false,

  drowsyBelow: 20,
  asleepAtOrBelow: 0,

  livenessWindowS: 6 * 60 * 60, // 6h
};

/**
 * Demo overrides for the Phase 1 fake source, so a full emotional arc —
 * thriving → hungry → drowsy → asleep, with celebrations along the way — plays
 * out in a couple of minutes instead of a couple of days. Real adapters use
 * DEFAULT_CONFIG.
 */
export const DEMO_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  nourishmentHalfLifeDays: 0.0006, // ≈ 52s half-life, so decay is visible live
  livenessWindowS: 45,
};
