/**
 * The two gauges (spec §4).
 *
 * The separation is structural, not stylistic: `NourishmentGauge` has no method
 * that accepts a UsageMetric, and `StaminaGauge` has no method that accepts a
 * CompletionEvent. There is no code path by which burning tokens can feed the
 * creature. That is spec §7 rule 1 enforced by the type system rather than by
 * discipline.
 */

import type { CompletionEvent, UsageMetric } from './types.js';
import type { EngineConfig } from './config.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Nourishment: 0..100, fed only by verified completions, decaying gently.
 */
export class NourishmentGauge {
  private value = 0;
  /** Dedup set — replaying the event log cannot double-feed (spec §7 rule 6). */
  private readonly seen = new Set<string>();
  private lastDecayAt: number;
  private accepted = 0;

  constructor(
    private readonly config: EngineConfig,
    now: number,
    initialValue = 0,
  ) {
    this.value = clamp(initialValue, 0, 100);
    this.lastDecayAt = now;
  }

  /**
   * Offer a completion to the gauge.
   *
   * @returns true if it was accepted (novel, and confident enough to count).
   */
  offer(event: CompletionEvent): boolean {
    if (this.seen.has(event.id)) return false;
    if (!this.isConfidentEnough(event.confidence)) return false;

    this.seen.add(event.id);
    this.accepted += 1;
    this.value = clamp(this.value + this.config.nourishmentBump, 0, 100);
    return true;
  }

  /** Apply exponential decay for the elapsed wall time. Idempotent per instant. */
  decayTo(now: number): void {
    const elapsedMs = now - this.lastDecayAt;
    if (elapsedMs <= 0) return;

    const halfLifeMs = this.config.nourishmentHalfLifeDays * 24 * 60 * 60 * 1000;
    if (halfLifeMs > 0) {
      this.value *= Math.pow(0.5, elapsedMs / halfLifeMs);
    }
    this.lastDecayAt = now;
  }

  get current(): number {
    return clamp(this.value, 0, 100);
  }

  get acceptedCount(): number {
    return this.accepted;
  }

  private isConfidentEnough(confidence: CompletionEvent['confidence']): boolean {
    if (confidence === 'certain') return true;
    if (confidence === 'likely') return this.config.acceptLikelyCompletions;
    return false; // `guessing` never counts — already the ambassador rule.
  }
}

export interface StaminaReading {
  /** 0..100. */
  value: number;
  /** False when the underlying metric cannot prove it is fresh. */
  fresh: boolean;
  metric: UsageMetric | null;
}

/**
 * Stamina: 0..100, derived from usage against the budget window.
 *
 * Freshness is not advisory. An absent or stale metric yields `fresh: false`,
 * which the state resolver turns into `unknown` — never a falsely-happy
 * creature (spec §5.2, and the fail-loud-observability rule).
 */
export class StaminaGauge {
  private metric: UsageMetric | null = null;

  update(metric: UsageMetric | null): void {
    this.metric = metric;
  }

  read(now: number): StaminaReading {
    if (!this.metric) {
      return { value: 0, fresh: false, metric: null };
    }

    const freshAtMs = Date.parse(this.metric.freshAt);
    const ageS = Number.isNaN(freshAtMs) ? Infinity : (now - freshAtMs) / 1000;
    const fresh = ageS <= this.metric.staleAfterS;

    const value = clamp((1 - this.metric.used) * 100, 0, 100);
    return { value, fresh, metric: this.metric };
  }
}
