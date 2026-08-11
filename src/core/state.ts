/**
 * The state resolver (spec §6).
 *
 * A pure function of (N, S, liveness[], fresh). No hidden state, no flags that
 * can drift out of sync with the gauges — states are *presentation over the
 * gauges*, which is what makes them testable in isolation.
 */

import type { AvatarStateName, WorkstreamLiveness } from './types.js';
import type { EngineConfig } from './config.js';

export interface StateInput {
  nourishment: number;
  stamina: number;
  liveness: WorkstreamLiveness[];
  /** False when telemetry cannot prove freshness. */
  fresh: boolean;
}

/**
 * Precedence (spec §6.2): unknown > asleep > drowsy > hungry > thriving.
 *
 * Sleep and staleness dominate because they are the safety-critical reads —
 * the two cases where showing a happy creature would be a lie.
 *
 * Drooping limbs are deliberately NOT in this ladder. They are additive and
 * travel separately in `AvatarSnapshot.drooping`, so a thriving creature can
 * have one sad limb.
 */
export function resolveState(input: StateInput, config: EngineConfig): AvatarStateName {
  if (!input.fresh) return 'unknown';
  if (input.stamina <= config.asleepAtOrBelow) return 'asleep';
  if (input.stamina < config.drowsyBelow) return 'drowsy';
  if (input.nourishment < config.hungryBelow) return 'hungry';
  return 'thriving';
}

/** One calm line of copy per state. Never guilt, never a streak, never an alarm (spec §6.3). */
export function describeState(state: AvatarStateName): string {
  switch (state) {
    case 'thriving':
      return 'Well fed and full of energy.';
    case 'hungry':
      return "Plenty of energy — let's go finish something.";
    case 'drowsy':
      return 'Getting tired. Winding down.';
    case 'asleep':
      return 'Asleep. Resting up until the budget resets.';
    case 'unknown':
      return "Can't reach telemetry — not going to guess.";
  }
}
