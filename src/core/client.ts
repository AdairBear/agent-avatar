/**
 * Client for the local telemetry backend.
 *
 * Polls `http://127.0.0.1:<port>/state`, and falls back to reading the state
 * file directly when the HTTP service is not running -- so the app still shows
 * real numbers if only the `--once` writer has ever run.
 *
 * Two invariants this file must never break:
 *
 *  1. **A failed poll is never a healthy snapshot.** Unreachable backend, bad
 *     JSON, or a payload older than its own staleness budget all resolve to
 *     `unknown`, not to zeros that look like a calm creature.
 *  2. **Pulses are passed through, not invented.** Dedup happens in the
 *     renderer on pulse id.
 */

import type { AvatarSnapshot, AvatarStateName, Pulse, WorkstreamLiveness } from './types.js';
import { AVATAR_STATES, describeState, unknownSnapshot } from './types.js';

export type SnapshotListener = (snapshot: AvatarSnapshot) => void;
export type LogFn = (level: 'info' | 'warn', message: string) => void;

/** Minimal reader seams, so this module stays free of Node and DOM imports. */
export interface ClientTransport {
  /** GET the endpoint; resolve to the raw body, or null when unreachable. */
  fetchState(url: string): Promise<string | null>;
  /** Read the state file; resolve to its contents, or null when absent. */
  readStateFile(path: string): Promise<string | null>;
}

export interface TelemetryClientOptions {
  /** e.g. `http://127.0.0.1:8787/state` */
  url: string;
  /** e.g. `~/.agentic-avatar/state.json`, already expanded. */
  stateFile: string;
  transport: ClientTransport;
  pollMs?: number;
  now?: () => number;
  log?: LogFn;
}

export class TelemetryClient {
  private readonly listeners = new Set<SnapshotListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: AvatarSnapshot | null = null;
  private polling = false;
  /** Suppresses a repeated "backend unreachable" line every single poll. */
  private warnedUnreachable = false;

  constructor(private readonly options: TelemetryClientOptions) {}

  onSnapshot(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    // Late subscribers get current state immediately, so a window opened
    // mid-run is never blank. Pulse dedup makes re-delivery safe.
    if (this.latest) listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  get lastSnapshot(): AvatarSnapshot | null {
    return this.latest;
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 2_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll: fetch → parse → freshness check → emit. */
  async poll(): Promise<AvatarSnapshot> {
    if (this.polling) return this.latest ?? unknownSnapshot();
    this.polling = true;
    try {
      const body = await this.read();
      const snapshot = body === null ? unknownSnapshot() : this.parse(body);
      this.emit(snapshot);
      return snapshot;
    } finally {
      this.polling = false;
    }
  }

  private async read(): Promise<string | null> {
    const { transport, url, stateFile } = this.options;

    try {
      const body = await transport.fetchState(url);
      if (body !== null) {
        if (this.warnedUnreachable) {
          this.log('info', 'telemetry backend reachable again');
          this.warnedUnreachable = false;
        }
        return body;
      }
    } catch (error) {
      // Fall through to the file; the warning below covers both paths.
      void error;
    }

    try {
      const body = await transport.readStateFile(stateFile);
      if (body !== null) return body;
    } catch (error) {
      void error;
    }

    if (!this.warnedUnreachable) {
      this.warnedUnreachable = true;
      this.log(
        'warn',
        `no telemetry at ${url} and no readable ${stateFile} — showing "unknown". ` +
          'Start it with: python3 -m avatar_telemetry',
      );
    }
    return null;
  }

  private parse(body: string): AvatarSnapshot {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      this.log('warn', `telemetry payload was not JSON: ${describeError(error)}`);
      return unknownSnapshot();
    }
    const snapshot = normalize(raw);
    if (snapshot === null) {
      this.log('warn', 'telemetry payload did not match the expected schema');
      return unknownSnapshot();
    }
    return this.enforceFreshness(snapshot, raw);
  }

  /**
   * A payload that is itself stale must not render as healthy.
   *
   * The backend publishes how long its own snapshot stays valid; if the file
   * has sat there past that budget (the service died, the Mac slept), the
   * numbers are history, not status.
   */
  private enforceFreshness(snapshot: AvatarSnapshot, raw: unknown): AvatarSnapshot {
    const staleAfterS = numberOf(raw, 'stale_after_seconds');
    if (staleAfterS === null || staleAfterS <= 0) return snapshot;

    const at = Date.parse(snapshot.at);
    if (Number.isNaN(at)) return snapshot;

    const now = this.options.now?.() ?? Date.now();
    const ageS = (now - at) / 1000;
    if (ageS <= staleAfterS) return snapshot;

    this.log('warn', `telemetry snapshot is ${Math.round(ageS)}s old — rendering as unknown`);
    return { ...unknownSnapshot(snapshot.mode), at: snapshot.at };
  }

  private emit(snapshot: AvatarSnapshot): void {
    this.latest = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log('warn', `snapshot listener threw: ${describeError(error)}`);
      }
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.options.log?.(level, message);
  }
}

/**
 * Map the backend's snake_case payload onto the app's camelCase snapshot.
 *
 * @returns the snapshot, or null when the payload is unrecognisable.
 */
export function normalize(raw: unknown): AvatarSnapshot | null {
  if (!isRecord(raw)) return null;
  const gauges = raw.gauges;
  if (!isRecord(gauges)) return null;

  const riveInputs = isRecord(raw.rive_inputs) ? raw.rive_inputs : {};
  const energyDetail = isRecord(raw.energy_detail) ? raw.energy_detail : {};
  const nourishmentDetail = isRecord(raw.nourishment_detail) ? raw.nourishment_detail : {};
  const healthDetail = isRecord(raw.health_detail) ? raw.health_detail : {};

  const state = asState(raw.state);
  const fresh = raw.fresh === true;

  return {
    at: asString(raw.at) ?? new Date().toISOString(),
    mode: raw.mode === 'mock' ? 'mock' : 'live',
    nourishment: clamp100(asNumber(gauges.nourishment) ?? 0),
    energy: clamp100(asNumber(gauges.energy) ?? 0),
    health: clamp100(asNumber(gauges.health) ?? 0),
    state,
    stateText: asString(raw.state_text) ?? describeState(state),
    isWorking: riveInputs.isWorking === true,
    fresh,
    drooping: asStringArray(raw.drooping),
    workstreams: asWorkstreams(raw.workstreams),
    pulses: asPulses(raw.pulses),
    energyDetail: {
      usedRatio: asNumber(energyDetail.used_ratio) ?? 0,
      weightedTokens: asNumber(energyDetail.weighted_tokens) ?? 0,
      budgetTokens: asNumber(energyDetail.budget_tokens) ?? 0,
      windowHours: asNumber(energyDetail.window_hours) ?? 0,
      recoversAt: asString(energyDetail.recovers_at),
    },
    nourishmentDetail: {
      acceptedCompletions: asNumber(nourishmentDetail.accepted_completions) ?? 0,
      rejectedCompletions: asNumber(nourishmentDetail.rejected_completions) ?? 0,
      acceptConfidence: asString(nourishmentDetail.accept_confidence) ?? '',
    },
    healthDetail: {
      liveWorkstreams: asNumber(healthDetail.live_workstreams) ?? 0,
      knownWorkstreams: asNumber(healthDetail.known_workstreams) ?? 0,
      healthyAt: asNumber(healthDetail.healthy_at) ?? 0,
    },
    recentCompletions: asCompletions(raw.recent_completions),
  };
}

function asWorkstreams(value: unknown): WorkstreamLiveness[] {
  if (!Array.isArray(value)) return [];
  const out: WorkstreamLiveness[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    out.push({
      id,
      label: asString(item.label) ?? id,
      live: item.live === true,
      lastMeaningfulAt: asString(item.last_meaningful_at) ?? '',
      ageS: asNumber(item.age_seconds) ?? 0,
    });
  }
  return out;
}

function asPulses(value: unknown): Pulse[] {
  if (!Array.isArray(value)) return [];
  const out: Pulse[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    out.push({
      id,
      kind: 'celebrate',
      at: asString(item.at) ?? '',
      label: asString(item.label) ?? '',
    });
  }
  return out;
}

function asCompletions(value: unknown): AvatarSnapshot['recentCompletions'] {
  if (!Array.isArray(value)) return [];
  const out: AvatarSnapshot['recentCompletions'] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    if (!id) continue;
    out.push({
      id,
      workstream: asString(item.workstream) ?? '',
      kind: asString(item.kind) ?? '',
      confidence: asString(item.confidence) ?? '',
      at: asString(item.at) ?? '',
      label: asString(item.label) ?? '',
    });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const clamp100 = (v: number): number => Math.min(100, Math.max(0, v));
const numberOf = (raw: unknown, key: string): number | null =>
  isRecord(raw) ? asNumber(raw[key]) : null;

function asState(value: unknown): AvatarStateName {
  const name = asString(value);
  return name !== null && (AVATAR_STATES as readonly string[]).includes(name)
    ? (name as AvatarStateName)
    : 'unknown';
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
