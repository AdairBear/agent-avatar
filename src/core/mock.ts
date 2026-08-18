/**
 * In-app mock snapshots -- no backend, no logs, no Python.
 *
 * This is the "run it before anything is real" path: `npm start -- --mock`
 * gives a working app with the gauges sweeping their whole range, so the shell
 * and (later) the `.riv` can be developed before telemetry is trusted.
 *
 * It produces the same `AvatarSnapshot` shape the live client produces, so
 * every downstream code path -- tray, popover, living area, Rive binding --
 * is genuinely exercised rather than bypassed.
 */

import type { AvatarSnapshot, AvatarStateName } from './types.js';
import { describeState } from './types.js';

/** Seconds for one full pass of the arc. */
export const ARC_SECONDS = 180;

const WORKSTREAMS = [
  { id: 'trident-forge', label: 'Trident Forge' },
  { id: 'agentic-avatar', label: 'Agentic Avatar' },
  { id: 'ebooklm', label: 'EbookLM' },
  /** Deliberately quiet, so the drooping-limb path gets exercised. */
  { id: 'harmony-house', label: 'HarmonyHouse' },
];

export interface MockOptions {
  now?: () => number;
  /** Pin gauges instead of sweeping. The "slider" mode. */
  pinned?: Partial<Record<'nourishment' | 'energy' | 'health', number>>;
}

/**
 * Synthetic snapshot source.
 *
 * Arc: energy drains 100 -> 0 across `ARC_SECONDS` and holds asleep, so every
 * state including `sleep` is reachable in one sitting. A completion lands every
 * 20s, which fires `celebrate`.
 */
export class MockSource {
  private readonly startedAt: number;
  private readonly now: () => number;
  private pinned: MockOptions['pinned'];
  private issued = 0;
  private pulses: AvatarSnapshot['pulses'] = [];
  private accepted = 0;

  constructor(options: MockOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.pinned = options.pinned ?? {};
  }

  /** Pin or clear gauge values at runtime. */
  pin(values: MockOptions['pinned']): void {
    this.pinned = { ...this.pinned, ...values };
  }

  snapshot(): AvatarSnapshot {
    const now = this.now();
    const phase = (now - this.startedAt) / 1000 / ARC_SECONDS;

    const energy = this.pinned?.energy ?? clamp100(100 * (1 - Math.min(1, phase)));
    const nourishment =
      this.pinned?.nourishment ?? clamp100(30 + 60 * Math.abs(Math.sin(phase * Math.PI)));
    const health = this.pinned?.health ?? 66.7;

    this.issueCompletions(now);
    const lastCompletionAt = this.pulses.length
      ? Date.parse(this.pulses[this.pulses.length - 1].at)
      : null;

    const workstreams = WORKSTREAMS.map((w, index) => {
      const quiet = w.id === 'harmony-house';
      const lastMs = quiet ? this.startedAt - 9 * 3600 * 1000 : now - index * 1000;
      return {
        id: w.id,
        label: w.label,
        live: !quiet,
        lastMeaningfulAt: new Date(lastMs).toISOString(),
        ageS: Math.max(0, (now - lastMs) / 1000),
      };
    });

    const state = resolveMockState(energy, lastCompletionAt, now);

    return {
      at: new Date(now).toISOString(),
      mode: 'mock',
      nourishment: round1(nourishment),
      energy: round1(energy),
      health: round1(health),
      state,
      stateText: describeState(state),
      isWorking: state === 'working' || state === 'celebrate',
      fresh: true,
      drooping: workstreams.filter((w) => !w.live).map((w) => w.id),
      workstreams,
      pulses: [...this.pulses],
      energyDetail: {
        usedRatio: 1 - energy / 100,
        weightedTokens: Math.round((1 - energy / 100) * 45_000_000),
        budgetTokens: 45_000_000,
        windowHours: 5,
        recoversAt: new Date(this.startedAt + ARC_SECONDS * 1000).toISOString(),
      },
      nourishmentDetail: {
        acceptedCompletions: this.accepted,
        rejectedCompletions: 0,
        acceptConfidence: 'certain',
      },
      healthDetail: {
        liveWorkstreams: workstreams.filter((w) => w.live).length,
        knownWorkstreams: workstreams.length,
        healthyAt: 3,
      },
      recentCompletions: [],
    };
  }

  private issueCompletions(now: number): void {
    if (this.pinned?.nourishment !== undefined) return; // pinned = hold a pose
    const due = Math.floor((now - this.startedAt) / 1000 / 20);
    while (this.issued < due) {
      this.issued += 1;
      this.accepted += 1;
      const stream = WORKSTREAMS[this.issued % WORKSTREAMS.length];
      this.pulses.push({
        id: `mock:celebrate:${this.issued}`,
        kind: 'celebrate',
        at: new Date(this.startedAt + this.issued * 20_000).toISOString(),
        label: `${stream.label} - mock completion`,
      });
      // Bounded: a long-running mock must not accumulate pulses forever.
      if (this.pulses.length > 8) this.pulses = this.pulses.slice(-8);
    }
  }
}

function resolveMockState(
  energy: number,
  lastCompletionAt: number | null,
  now: number,
): AvatarStateName {
  if (energy <= 0) return 'sleep';
  if (energy < 20) return 'drowsy';
  if (lastCompletionAt !== null && now - lastCompletionAt <= 6_000) return 'celebrate';
  return 'working';
}

const clamp100 = (v: number): number => Math.min(100, Math.max(0, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;
