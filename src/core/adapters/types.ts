/**
 * THE SEAM.
 *
 * Spec §11 recommends "Path A executed with Path B's seams": build the personal
 * version first, but behind an adapter interface from day one so that adding
 * Conductor, tokentelemetry, Cursor or OpenCode later is an integration, not a
 * rewrite.
 *
 * This is that interface. Everything above it (gauges, state resolver, UI)
 * knows only about `CompletionEvent` / `UsageMetric` / `WorkstreamSignal`, and
 * never about where they came from.
 *
 * Rules for implementors:
 *  - Every method is optional. An adapter that only knows about usage
 *    implements only `usage()`. Missing capabilities are absent, never errors.
 *  - `completions(since)` must be safe to call repeatedly with overlapping
 *    windows. Dedup is handled upstream by `CompletionEvent.id`, so returning
 *    the same event twice is correct behaviour, not a bug.
 *  - `usage()` returns `null` when it genuinely cannot measure. It must NOT
 *    return a zero — a fake zero would render as a healthy full-stamina
 *    creature, which is the exact failure the freshness invariant forbids.
 *  - Throwing is acceptable. The engine isolates each adapter, logs loudly, and
 *    degrades that source to unknown rather than taking the app down.
 */

import type { CompletionEvent, UsageMetric, WorkstreamSignal } from '../types.js';

export interface SourceAdapter {
  /** Stable id, used for provenance and log lines. */
  readonly id: string;
  /** Human label for the popover's source list. */
  readonly label: string;

  /** Optional lifecycle for adapters that need to open watchers or files. */
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;

  /** Completed work since the given instant. Feeds Nourishment. */
  completions?(since: Date): Promise<CompletionEvent[]>;
  /** Current usage against the budget window. Feeds Stamina. `null` if unmeasurable. */
  usage?(): Promise<UsageMetric | null>;
  /** In-flight workstreams. Feeds liveness. */
  workstreams?(): Promise<WorkstreamSignal[]>;
}
