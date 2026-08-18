# Telemetry: what it reads, and how to extend it

> **This is built.** It reads real session logs on this machine and computes
> real gauges. What follows is what it looks at, what it deliberately ignores,
> and where a new data source plugs in.

Everything runs locally. No API keys, no accounts, no outbound requests. The
HTTP service binds `127.0.0.1` only.

## What it reads

`~/.claude/projects/*/*.jsonl` — append-only session logs already on disk.

The scanner keeps a byte offset per file and only opens files whose mtime falls
inside the lookback window (default 7 days), so a poll after the first is
nearly free. A partially-written trailing line is left unconsumed for the next
poll rather than parsed as corrupt.

Three signals come out, in `extract.py`:

| Type | Source records | Feeds |
|---|---|---|
| `CompletionEvent` | tool calls that prove work finished | Nourishment |
| `UsageSample` | `message.usage` on assistant turns | Energy |
| `ActivitySignal` | human prompts, completions | liveness → Health |

## Completions: what counts as "done"

The rule is that an accepted completion must be tied to an artifact that exists
whether or not anyone claimed success.

| Detected from | `kind` | Confidence | Counted by default |
|---|---|---|---|
| `Bash` running `git commit`, whose result printed `[branch <sha>]` | `commit` | `certain` | **yes** |
| `TaskUpdate` with `status: "completed"` and a task id | `task_done` | `certain` | **yes** |
| `Bash` running a test runner, output says passed and not failed | `test_pass` | `likely` | no |
| `TodoWrite` item with `status: "completed"` | `task_done` | `likely` | no |

Three rules the extractors honour:

1. **The dedup `id` is built from the artifact**, not from a position in the
   file: `commit:<workstream>:<sha>`, `task:<session>:<taskId>`. Re-reading the
   same history produces the same ids, so idempotency is free.
2. **Extractors do not filter by confidence.** They emit what they saw and let
   `NourishmentGauge` apply the gate, so the policy lives in one place
   (`AVATAR_ACCEPT_CONFIDENCE`) where it can be reasoned about and changed.
3. **Proving a Bash command succeeded takes two records** — the assistant's
   `tool_use` (which has the command) and the later `tool_result` (which has the
   output). Those can straddle a poll boundary, so `CompletionExtractor` holds
   pending tool calls across polls, in a bounded map so an unanswered call
   cannot leak.

The rejected count is published in `nourishment_detail.rejected_completions`.
That is deliberate: a creature that is permanently hungry should be
*diagnosable* — you can see it saw 48 candidates and admitted 3 — rather than
mysterious.

## Usage: the one rule that matters most

```
weighted = input_tokens
         + output_tokens
         + cache_creation_input_tokens
         + cache_read_input_tokens × 0.1
```

Summed over a rolling `energy_window_hours` (default 5) and divided by
`energy_budget_tokens` (default 45,000,000).

**Absence is reported, never invented.** If no usage sample has ever been seen,
`EnergyGauge.read()` returns `fresh: False` — it does not return a zero, because
`used: 0` means *a full tank* and would render a bright, healthy creature on the
strength of no data at all.

That is enforced twice more downstream: `resolve_state()` turns `fresh: False`
into `unknown` regardless of the numbers, and `src/core/client.ts` independently
downgrades any payload older than its own `stale_after_seconds`. Three layers,
because this is the failure mode that hides incidents.

## Liveness and Health

A workstream is a project directory, derived from the session `cwd`. Worktrees
under `<project>/.claude/worktrees/<name>` credit the parent project.

`lastMeaningfulAt` advances on **human prompts and completions only** — not on
tool chatter. A busy agent loop talking to itself must not keep a limb upright.

Filters that keep the count honest:

- `min_records_per_workstream` (default 3) — a single stray file read must not
  manufacture a workstream.
- `ignore_workstreams` — tooling directories (`scratchpad`, `observer-sessions`,
  `memory`, …) that would otherwise inflate carousel health.

## Extending it: add an extractor, not a rewrite

Everything above `extract.py` knows only about `CompletionEvent`,
`UsageSample`, and `ActivitySignal`, and nothing about where they came from.
A new source — Conductor, Cursor, OpenCode, Hermes — is a function that produces
those types.

To add one:

1. Write the extractor. If it needs to correlate two records, follow the
   `CompletionExtractor` pattern: hold pending state in a **bounded** map.
2. Give completions an `id` derived from a verifiable artifact.
3. Set confidence honestly. `certain` means an artifact exists; `likely` means
   something said so. When in doubt, `likely` — the gate defaults to excluding
   it, which fails toward an under-fed creature rather than a lying one.
4. Return `None` rather than a plausible zero when you cannot measure.
5. Add tests to `telemetry/tests/test_telemetry.py`.

Throwing is acceptable — the poll loop logs at `exception` and survives. What an
extractor must **not** do is swallow its own failure and return plausible data;
that is the silent-failure pattern all of the above exists to prevent.

## Configuration

Every tunable is an environment variable, defined with its default in
`config.py`:

| Variable | Default | What it does |
|---|---|---|
| `AVATAR_PROJECTS_DIR` | `~/.claude/projects` | where logs are read from |
| `AVATAR_LOOKBACK_DAYS` | `7` | how far back the first poll reads |
| `AVATAR_STATE_FILE` | `~/.agentic-avatar/state.json` | published state file |
| `AVATAR_PORT` | `8787` | loopback HTTP port |
| `AVATAR_POLL_SECONDS` | `20` | poll interval |
| `AVATAR_BUMP` | `12` | points per accepted completion |
| `AVATAR_HALF_LIFE_DAYS` | `3` | nourishment decay |
| `AVATAR_ACCEPT_CONFIDENCE` | `certain` | the gate: `certain` / `likely` / `guessing` |
| `AVATAR_ENERGY_WINDOW_HOURS` | `5` | rolling budget window |
| `AVATAR_ENERGY_BUDGET_TOKENS` | `45000000` | weighted tokens = a full tank |
| `AVATAR_CACHE_READ_WEIGHT` | `0.1` | how much a cached read costs |
| `AVATAR_DROWSY_BELOW` | `20` | energy threshold for drowsy |
| `AVATAR_ASLEEP_AT` | `0` | energy threshold for sleep |
| `AVATAR_LIVENESS_WINDOW_HOURS` | `6` | how long a workstream stays live |
| `AVATAR_HEALTHY_WORKSTREAMS` | `3` | live count that reads as health 100 |
| `AVATAR_MIN_RECORDS` | `3` | evidence needed to count as a workstream |
| `AVATAR_IGNORE_WORKSTREAMS` | tooling dirs | comma-separated denylist |
| `AVATAR_STALE_AFTER_S` | `180` | how long a published snapshot stays valid |

## Not built yet

- **Persistence.** Nourishment and its dedup set live in memory, so a backend
  restart re-reads the lookback window but loses the accumulated total. Small,
  and the obvious next thing.
- **Carousel mode proper** — named categories and expected slots. It rides on
  top of liveness as *labels and expected counts*, not new mechanics. Nothing
  here blocks it.
- **A published plan limit.** The logs do not record one, so the energy budget
  is calibrated from observed throughput rather than from an authoritative
  number. See the README's Limitations.
