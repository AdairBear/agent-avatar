# How real telemetry plugs in later

> **Not built yet — this is the interface, not the integration.** Phase 1 ships
> one `FakeAdapter`. This document is the contract Track 3 implements against.

## The seam

Everything above the adapter layer — gauges, state resolver, tray, popover,
living area — knows only about three plain data types and nothing about where
they came from. The whole integration surface is
`src/core/adapters/types.ts`:

```ts
export interface SourceAdapter {
  readonly id: string;
  readonly label: string;

  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;

  completions?(since: Date): Promise<CompletionEvent[]>;  // → Nourishment
  usage?(): Promise<UsageMetric | null>;                   // → Stamina
  workstreams?(): Promise<WorkstreamSignal[]>;             // → liveness
}
```

Every method is optional. An adapter that only knows about usage implements
only `usage()`.

## The swap, concretely

`src/main/index.ts`, one function:

```ts
function buildAdapters(): SourceAdapter[] {
  return [new FakeAdapter({ drainSeconds: 180, completionEverySeconds: 8 })];
}
```

becomes

```ts
function buildAdapters(): SourceAdapter[] {
  return [new ConductorAdapter(), new TokenTelemetryAdapter()];
}
```

and `DEMO_CONFIG` becomes `DEFAULT_CONFIG`. Nothing else in the app changes.

## Adapter 1 — Nourishment, from Conductor / ambassador

**Implements:** `completions()`, `workstreams()`

The ambassador loop already classifies signals as
`completed | waiting | blocked | …` with `[Certain] | [Likely] | [Guessing]`
confidence. The adapter's job is pure translation into `CompletionEvent`:

```ts
{
  type: 'completion',
  id: 'pr:trident-forge#412',   // dedup key — stable + verifiable
  workstream: 'trident-forge',
  kind: 'pr_merge',
  confidence: 'certain',
  at: '2026-08-11T17:04:00Z',
  source: 'conductor',
  label: 'Trident Forge — risk engine guard',
}
```

Three rules the adapter must honour:

1. **`id` must be tied to a verifiable artifact** — a merged PR SHA, a closed
   task id — never a self-declared flag. This is what makes fake completions
   hard (spec §7 rule 2). The engine dedups on it, so idempotency is free.
2. **Do not filter by confidence in the adapter.** Emit what the ambassador
   said and let `NourishmentGauge` apply the gate. The policy lives in
   `config.acceptLikelyCompletions`, in one place, where it can be changed and
   reasoned about.
3. **Overlapping windows are expected.** `completions(since)` is called every
   tick and may legitimately return events it already returned. Dedup upstream
   handles it — do not build your own cursor bookkeeping.

`workstreams()` maps detected projects to `WorkstreamSignal`, where
`lastMeaningfulAt` keys off **completions and substantive sessions**, not commit
count — a flurry of empty commits must not un-droop a limb (spec §7 rule 4).

## Adapter 2 — Stamina, from tokentelemetry

**Implements:** `usage()`

```ts
{
  type: 'usage',
  window: '2026-08-01..2026-08-31',
  used: 0.63,                            // ratio of plan, 0..1
  unit: 'ratio_of_plan',
  costUsd: 41.20,
  resetsAt: '2026-09-01T00:00:00Z',
  freshAt: '2026-08-11T19:22:11Z',       // when THIS measurement was taken
  staleAfterS: 1800,
  source: 'tokentelemetry',
}
```

**The one rule that matters most: return `null`, never a zero.**

If tokentelemetry is unreachable, its output is missing, or the numbers cannot
be trusted, `usage()` returns `null`. It must not return `used: 0`, because
`used: 0` means *a full tank* and would render a bright, healthy creature on the
strength of no data at all.

That is enforced downstream too — `StaminaGauge.read()` marks any absent or
past-`staleAfterS` metric as `fresh: false`, and `resolveState()` turns
`fresh: false` into `unknown` (desaturated, `?`) regardless of the numbers. But
adapters should not lean on that: **fail loud at the source**.

This is the tokentelemetry "no fake zeros" contract and the wrist-ops freshness
invariant, both already load-bearing elsewhere in the stack.

## Error handling contract

Adapters may throw. The engine isolates each one per-method, logs at `warn`
with the adapter id, and continues — one bad source degrades that signal
rather than blinding the whole app. What an adapter must **not** do is swallow
its own failure and return plausible-looking data; that is the silent-failure
pattern the fail-loud rule exists to prevent.

## Multi-adapter resolution

- **Completions:** all adapters are polled and all events pooled; `id` dedups.
- **Usage:** first adapter returning a non-null metric wins. Order matters, so
  list the authoritative source first.
- **Workstreams:** merged by `id`, freshest `lastMeaningfulAt` winning.

## What is deliberately not here yet

- **Carousel mode** (spec §2.2) — named categories, expected slots, lane
  semantics. It rides on top of `workstreams()` as *labels and expected counts*,
  not new mechanics. Nothing in Phase 1 blocks it.
- **Cursor / OpenCode / Hermes adapters** — each is a new file implementing the
  same interface.
- **Persistence.** Nourishment currently resets on app restart. Real use wants
  the gauge and the dedup set persisted, so a restart doesn't wipe a well-fed
  creature. Small, and worth doing when the first real adapter lands.
