/**
 * Wire contracts for the Agentic Avatar engine.
 *
 * Everything in `src/core` is pure TypeScript over plain data: no Electron, no
 * Node, no DOM. That is deliberate — it is what lets the Electron shell be
 * swapped for Tauri or native Swift later without touching the engine.
 *
 * Event shapes track the spec (§5.1, §5.2) so real adapters can emit them
 * verbatim.
 */

/** Ambassador-style confidence tiers. Only `certain` feeds Nourishment by default. */
export type Confidence = 'certain' | 'likely' | 'guessing';

/** A verified unit of finished work. The ONLY thing that feeds Nourishment. */
export interface CompletionEvent {
  type: 'completion';
  /** Dedup key. Stable + verifiable, e.g. `pr:repo#123`, `task:lane-7`. */
  id: string;
  /** Workstream this completion belongs to. */
  workstream: string;
  kind: 'pr_merge' | 'task_done' | 'lane_done';
  confidence: Confidence;
  /** ISO-8601 timestamp. */
  at: string;
  /** Adapter id that produced this, for provenance. */
  source: string;
  /** Optional human label for the celebrate toast. */
  label?: string;
}

/** Usage against the budget window. The ONLY thing that drains Stamina. */
export interface UsageMetric {
  type: 'usage';
  /** Human-readable window, e.g. `2026-08-01..2026-08-31`. */
  window: string;
  /** Fraction of the budget consumed, 0..1. */
  used: number;
  unit: 'ratio_of_plan';
  costUsd?: number;
  /** ISO-8601. When the window resets and stamina refills. */
  resetsAt: string;
  /** ISO-8601. When this measurement was taken. */
  freshAt: string;
  /** Older than this many seconds and the gauge must not render as healthy. */
  staleAfterS: number;
  source: string;
}

/** An in-flight workstream, auto-detected. Count is data-driven, never hardcoded. */
export interface WorkstreamSignal {
  id: string;
  label: string;
  /** ISO-8601 of the last *meaningful* signal — not commit count (spec §7 rule 4). */
  lastMeaningfulAt: string;
  source: string;
}

/** Resolved presentation state. Presentation over the gauges, not independent flags. */
export type AvatarStateName =
  | 'thriving'
  | 'hungry'
  | 'drowsy'
  | 'asleep'
  /** Telemetry cannot prove freshness. Desaturated + `?`, never falsely happy. */
  | 'unknown';

export interface WorkstreamLiveness {
  id: string;
  label: string;
  live: boolean;
  lastMeaningfulAt: string;
  ageS: number;
}

/**
 * A discrete one-shot the UI should play at most once.
 *
 * Pulses exist because the transport is a polling snapshot: edge-detecting on a
 * level would double-fire when a window reopens and re-reads the latest
 * snapshot. Renderers dedup on `id`.
 */
export interface Pulse {
  id: string;
  kind: 'celebrate';
  at: string;
  label: string;
}

/** The single object the whole UI renders from. */
export interface AvatarSnapshot {
  /** ISO-8601 of this snapshot. */
  at: string;
  /** 0..100. Fed only by verified completions. */
  nourishment: number;
  /** 0..100. Drained only by usage. */
  stamina: number;
  state: AvatarStateName;
  /** Workstream ids that have gone stale — additive, overlaid on the base state. */
  drooping: string[];
  workstreams: WorkstreamLiveness[];
  /** False when telemetry cannot prove freshness. Forces `state: 'unknown'`. */
  fresh: boolean;
  /** One-shots to play. Renderers dedup by `Pulse.id`. */
  pulses: Pulse[];
  /** Provenance for the "why is my creature tired?" tap-through. */
  usage: {
    window: string;
    used: number;
    costUsd?: number;
    resetsAt: string;
    source: string;
  } | null;
  /** Rolling count of accepted completions, for the popover copy. */
  completionsAccepted: number;
}
