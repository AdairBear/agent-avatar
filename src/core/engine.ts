/**
 * AvatarEngine — polls adapters, drives the two gauges, emits snapshots.
 *
 * Still pure core: it takes a `setInterval`-shaped scheduler and a clock as
 * constructor arguments rather than reaching for globals, so it runs unchanged
 * in Electron main, in a headless smoke test, or in a future Tauri/Swift host.
 */

import type { AvatarSnapshot, Pulse, UsageMetric, WorkstreamSignal } from './types.js';
import type { EngineConfig } from './config.js';
import { DEFAULT_CONFIG } from './config.js';
import type { SourceAdapter } from './adapters/types.js';
import { NourishmentGauge, StaminaGauge } from './gauges.js';
import { resolveLiveness, droopingIds } from './liveness.js';
import { resolveState } from './state.js';

export type SnapshotListener = (snapshot: AvatarSnapshot) => void;
export type LogFn = (level: 'info' | 'warn', message: string) => void;

export interface EngineOptions {
  adapters: SourceAdapter[];
  config?: EngineConfig;
  now?: () => number;
  log?: LogFn;
}

/** How many pulses ride along on a snapshot before the oldest are dropped. */
const MAX_PULSES = 8;

export class AvatarEngine {
  private readonly config: EngineConfig;
  private readonly adapters: SourceAdapter[];
  private readonly now: () => number;
  private readonly log: LogFn;

  private readonly nourishment: NourishmentGauge;
  private readonly stamina: StaminaGauge;

  private readonly listeners = new Set<SnapshotListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastCompletionPoll: Date;
  private pendingPulses: Pulse[] = [];
  private latest: AvatarSnapshot | null = null;
  /** Guards against overlapping ticks if an adapter is slower than tickMs. */
  private ticking = false;

  constructor(options: EngineOptions) {
    this.config = options.config ?? DEFAULT_CONFIG;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});

    const start = this.now();
    this.nourishment = new NourishmentGauge(this.config, start);
    this.stamina = new StaminaGauge();
    this.lastCompletionPoll = new Date(start);
  }

  onSnapshot(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    // Late subscribers get the current state immediately, so a window opened
    // mid-run is never blank. Pulse dedup on the renderer side makes this safe.
    if (this.latest) listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  get lastSnapshot(): AvatarSnapshot | null {
    return this.latest;
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        await adapter.start?.();
      } catch (error) {
        this.log('warn', `adapter ${adapter.id} failed to start: ${describe(error)}`);
      }
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const adapter of this.adapters) {
      try {
        await adapter.stop?.();
      } catch (error) {
        this.log('warn', `adapter ${adapter.id} failed to stop: ${describe(error)}`);
      }
    }
  }

  /** One full pass: poll → gauges → state → snapshot → listeners. */
  async tick(): Promise<AvatarSnapshot | null> {
    if (this.ticking) return this.latest;
    this.ticking = true;
    try {
      const now = this.now();

      await this.pollCompletions(now);
      const usage = await this.pollUsage();
      const signals = await this.pollWorkstreams();

      this.nourishment.decayTo(now);
      this.stamina.update(usage);
      const staminaReading = this.stamina.read(now);

      const liveness = resolveLiveness(signals, this.config, now);
      const state = resolveState(
        {
          nourishment: this.nourishment.current,
          stamina: staminaReading.value,
          liveness,
          fresh: staminaReading.fresh,
        },
        this.config,
      );

      const pulses = this.pendingPulses;
      this.pendingPulses = [];

      const snapshot: AvatarSnapshot = {
        at: new Date(now).toISOString(),
        nourishment: round1(this.nourishment.current),
        stamina: round1(staminaReading.value),
        state,
        drooping: droopingIds(liveness),
        workstreams: liveness,
        fresh: staminaReading.fresh,
        pulses,
        usage: staminaReading.metric
          ? {
              window: staminaReading.metric.window,
              used: staminaReading.metric.used,
              costUsd: staminaReading.metric.costUsd,
              resetsAt: staminaReading.metric.resetsAt,
              source: staminaReading.metric.source,
            }
          : null,
        completionsAccepted: this.nourishment.acceptedCount,
      };

      this.latest = snapshot;
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch (error) {
          this.log('warn', `snapshot listener threw: ${describe(error)}`);
        }
      }
      return snapshot;
    } finally {
      this.ticking = false;
    }
  }

  private async pollCompletions(now: number): Promise<void> {
    const since = this.lastCompletionPoll;
    for (const adapter of this.adapters) {
      if (!adapter.completions) continue;
      try {
        const events = await adapter.completions(since);
        for (const event of events) {
          if (!this.nourishment.offer(event)) continue;
          this.queuePulse({
            id: `celebrate:${event.id}`,
            kind: 'celebrate',
            at: event.at,
            label: event.label ?? `${event.workstream} — ${event.kind}`,
          });
          this.log('info', `nourishment +: ${event.id} (${event.confidence})`);
        }
      } catch (error) {
        // Loud, and scoped to this adapter. One bad source must not blind the app.
        this.log('warn', `adapter ${adapter.id}.completions() failed: ${describe(error)}`);
      }
    }
    this.lastCompletionPoll = new Date(now);
  }

  /**
   * First adapter to return a usage metric wins.
   *
   * Returning `null` here is meaningful, not a fallback: it means no source
   * could measure usage, and the gauge must then read as stale rather than as
   * a full tank.
   */
  private async pollUsage(): Promise<UsageMetric | null> {
    for (const adapter of this.adapters) {
      if (!adapter.usage) continue;
      try {
        const metric = await adapter.usage();
        if (metric) return metric;
      } catch (error) {
        this.log('warn', `adapter ${adapter.id}.usage() failed: ${describe(error)}`);
      }
    }
    return null;
  }

  private async pollWorkstreams(): Promise<WorkstreamSignal[]> {
    const merged = new Map<string, WorkstreamSignal>();
    for (const adapter of this.adapters) {
      if (!adapter.workstreams) continue;
      try {
        for (const signal of await adapter.workstreams()) {
          const existing = merged.get(signal.id);
          // Freshest signal wins when two adapters see the same workstream.
          if (!existing || Date.parse(signal.lastMeaningfulAt) > Date.parse(existing.lastMeaningfulAt)) {
            merged.set(signal.id, signal);
          }
        }
      } catch (error) {
        this.log('warn', `adapter ${adapter.id}.workstreams() failed: ${describe(error)}`);
      }
    }
    return [...merged.values()];
  }

  private queuePulse(pulse: Pulse): void {
    this.pendingPulses.push(pulse);
    if (this.pendingPulses.length > MAX_PULSES) {
      this.pendingPulses = this.pendingPulses.slice(-MAX_PULSES);
    }
  }
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
