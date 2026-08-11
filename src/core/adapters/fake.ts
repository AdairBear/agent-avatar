/**
 * Phase 1 stub data source.
 *
 * Its whole job is to make the core loop *visible* before any real telemetry
 * exists: stamina drains steadily, completions land every few seconds and bump
 * nourishment (and fire a celebrate pulse), and one workstream deliberately
 * goes quiet so the drooping-limb path gets exercised too.
 *
 * Deleting this file and registering the real adapters is the entire Track 3
 * swap. Nothing above the seam knows the difference.
 */

import type { SourceAdapter } from './types.js';
import type { CompletionEvent, UsageMetric, WorkstreamSignal } from '../types.js';

export interface FakeAdapterOptions {
  /** Seconds for stamina to go 100 → 0. Short so the arc is felt in one sitting. */
  drainSeconds?: number;
  /** Seconds between synthetic completions. */
  completionEverySeconds?: number;
  /** Injectable clock, so tests are deterministic. */
  now?: () => number;
}

const WORKSTREAMS: Array<{ id: string; label: string }> = [
  { id: 'trident-forge', label: 'Trident Forge' },
  { id: 'agentic-avatar', label: 'Agentic Avatar' },
  { id: 'ebooklm', label: 'EbookLM' },
  { id: 'harmony-house', label: 'HarmonyHouse' },
];

/** The one that deliberately goes quiet, so a limb droops. */
const QUIET_WORKSTREAM = 'harmony-house';

const COMPLETION_KINDS: Array<CompletionEvent['kind']> = ['pr_merge', 'task_done', 'lane_done'];

export class FakeAdapter implements SourceAdapter {
  readonly id = 'fake';
  readonly label = 'Fake source (Phase 1 demo)';

  private readonly startedAt: number;
  private readonly drainSeconds: number;
  private readonly completionEverySeconds: number;
  private readonly now: () => number;

  /** Monotonic counter, so ids are stable and dedup is meaningfully exercised. */
  private issued = 0;
  private readonly emitted: CompletionEvent[] = [];

  constructor(options: FakeAdapterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.drainSeconds = options.drainSeconds ?? 180;
    this.completionEverySeconds = options.completionEverySeconds ?? 8;
  }

  async completions(since: Date): Promise<CompletionEvent[]> {
    const elapsedS = (this.now() - this.startedAt) / 1000;
    const due = Math.floor(elapsedS / this.completionEverySeconds);

    while (this.issued < due) {
      this.issued += 1;
      const n = this.issued;
      const workstream = WORKSTREAMS[n % WORKSTREAMS.length];
      this.emitted.push({
        type: 'completion',
        id: `fake:completion:${n}`,
        workstream: workstream.id,
        kind: COMPLETION_KINDS[n % COMPLETION_KINDS.length],
        // Every 4th one is deliberately low-confidence, to prove the gate works:
        // it will show up in the log and be *rejected* rather than feeding the gauge.
        confidence: n % 4 === 0 ? 'guessing' : 'certain',
        at: new Date(this.startedAt + n * this.completionEverySeconds * 1000).toISOString(),
        source: this.id,
        label: `${workstream.label} — ${COMPLETION_KINDS[n % COMPLETION_KINDS.length]}`,
      });
    }

    // Return an overlapping window on purpose: upstream dedup must handle it.
    const sinceMs = since.getTime();
    return this.emitted.filter((e) => Date.parse(e.at) >= sinceMs - 30_000);
  }

  async usage(): Promise<UsageMetric | null> {
    const elapsedS = (this.now() - this.startedAt) / 1000;
    // Ramp 0 → 1 over drainSeconds, then hold at 1 (asleep) rather than wrapping.
    const used = Math.min(1, elapsedS / this.drainSeconds);
    const nowIso = new Date(this.now()).toISOString();

    return {
      type: 'usage',
      window: 'demo-window',
      used,
      unit: 'ratio_of_plan',
      costUsd: Number((used * 65).toFixed(2)),
      resetsAt: new Date(this.startedAt + this.drainSeconds * 1000 * 1.2).toISOString(),
      freshAt: nowIso,
      staleAfterS: 30,
      source: this.id,
    };
  }

  async workstreams(): Promise<WorkstreamSignal[]> {
    const now = this.now();
    return WORKSTREAMS.map((w) => {
      // Everything but the quiet one keeps getting fresh signal.
      const lastMs = w.id === QUIET_WORKSTREAM ? this.startedAt : now;
      return {
        id: w.id,
        label: w.label,
        lastMeaningfulAt: new Date(lastMs).toISOString(),
        source: this.id,
      };
    });
  }
}
