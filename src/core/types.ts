/**
 * The wire contract between the telemetry backend and the desktop shell.
 *
 * This mirrors the `agentic-avatar.telemetry/1` payload that
 * `telemetry/avatar_telemetry` publishes. The backend owns all gauge maths --
 * decay, budget windows, liveness, state precedence -- and this app renders
 * what it is told. That split is deliberate: two implementations of the same
 * gauge would drift, and the drift would be invisible.
 */

/** Discrete states the `.riv` reacts to. */
export type AvatarStateName =
  | 'idle'
  | 'working'
  | 'celebrate'
  | 'drowsy'
  | 'sleep'
  /** Telemetry cannot prove freshness. Desaturated + `?`, never falsely happy. */
  | 'unknown';

export const AVATAR_STATES: readonly AvatarStateName[] = [
  'idle',
  'working',
  'celebrate',
  'drowsy',
  'sleep',
  'unknown',
];

/** One project's liveness. The count is discovered from data, never hardcoded. */
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
  at: string;
  /** 'live' when fed by real logs, 'mock' when synthesized. */
  mode: 'live' | 'mock';
  /** 0..100. Fed only by completed work. */
  nourishment: number;
  /** 0..100. Remaining usage budget. At zero the avatar sleeps. */
  energy: number;
  /** 0..100. Carousel liveness: are several workstreams concurrently alive. */
  health: number;
  state: AvatarStateName;
  stateText: string;
  /** True when a workstream saw signal very recently. Drives the `isWorking` input. */
  isWorking: boolean;
  /** False when telemetry cannot prove freshness. Forces `state: 'unknown'`. */
  fresh: boolean;
  /** Workstream ids that have gone quiet — additive, overlaid on the base state. */
  drooping: string[];
  workstreams: WorkstreamLiveness[];
  /** One-shots to play. Renderers dedup by `Pulse.id`. */
  pulses: Pulse[];
  /** Provenance for the "why is my creature tired?" tap-through. */
  energyDetail: {
    usedRatio: number;
    weightedTokens: number;
    budgetTokens: number;
    windowHours: number;
    recoversAt: string | null;
  };
  nourishmentDetail: {
    acceptedCompletions: number;
    rejectedCompletions: number;
    acceptConfidence: string;
  };
  healthDetail: {
    liveWorkstreams: number;
    knownWorkstreams: number;
    healthyAt: number;
  };
  recentCompletions: Array<{
    id: string;
    workstream: string;
    kind: string;
    confidence: string;
    at: string;
    label: string;
  }>;
}

/** One calm line of copy per state. Never guilt, never a streak, never an alarm. */
export function describeState(state: AvatarStateName): string {
  switch (state) {
    case 'idle':
      return 'Resting between things.';
    case 'working':
      return 'Busy — something is moving.';
    case 'celebrate':
      return 'Something just landed.';
    case 'drowsy':
      return 'Getting tired. Winding down.';
    case 'sleep':
      return 'Asleep. Resting until the budget window rolls forward.';
    case 'unknown':
      return "Can't read telemetry — not going to guess.";
  }
}

/**
 * A snapshot that admits it knows nothing.
 *
 * Used before the first successful poll and whenever the backend is
 * unreachable. Every gauge reads zero AND `fresh` is false, so no consumer can
 * mistake "no data" for "healthy".
 */
export function unknownSnapshot(mode: 'live' | 'mock' = 'live'): AvatarSnapshot {
  return {
    at: new Date().toISOString(),
    mode,
    nourishment: 0,
    energy: 0,
    health: 0,
    state: 'unknown',
    stateText: describeState('unknown'),
    isWorking: false,
    fresh: false,
    drooping: [],
    workstreams: [],
    pulses: [],
    energyDetail: {
      usedRatio: 0,
      weightedTokens: 0,
      budgetTokens: 0,
      windowHours: 0,
      recoversAt: null,
    },
    nourishmentDetail: { acceptedCompletions: 0, rejectedCompletions: 0, acceptConfidence: '' },
    healthDetail: { liveWorkstreams: 0, knownWorkstreams: 0, healthyAt: 0 },
    recentCompletions: [],
  };
}
