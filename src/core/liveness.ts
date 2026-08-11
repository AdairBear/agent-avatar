/**
 * Workstream liveness (spec §2.1).
 *
 * The count of workstreams is discovered from data, never hardcoded — a user
 * with 2 gets 2 limbs-of-attention, a user with 9 gets 9. Carousel mode later
 * layers *labels and expected slots* on top of this, not new mechanics.
 */

import type { WorkstreamSignal, WorkstreamLiveness } from './types.js';
import type { EngineConfig } from './config.js';

export function resolveLiveness(
  signals: WorkstreamSignal[],
  config: EngineConfig,
  now: number,
): WorkstreamLiveness[] {
  return signals.map((signal) => {
    const lastMs = Date.parse(signal.lastMeaningfulAt);
    const ageS = Number.isNaN(lastMs) ? Infinity : Math.max(0, (now - lastMs) / 1000);
    return {
      id: signal.id,
      label: signal.label,
      live: ageS <= config.livenessWindowS,
      lastMeaningfulAt: signal.lastMeaningfulAt,
      ageS,
    };
  });
}

/** Stale workstreams droop a limb. Additive — the rest of the creature is unaffected. */
export function droopingIds(liveness: WorkstreamLiveness[]): string[] {
  return liveness.filter((w) => !w.live).map((w) => w.id);
}
