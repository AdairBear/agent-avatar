# Agentic Avatar

A living companion that makes agentic work legible: **two gauges, one creature.**

- **Nourishment** (0–100) — fed by *completed work*. Never by tokens spent.
- **Energy** (0–100) — the remaining usage budget. At zero the creature
  **sleeps**, framed as a healthy boundary rather than a failure.
- **Health** (0–100) — *carousel liveness*: are several workstreams actually
  moving, or is one project running hot while everything else is dark.

Everything is local. No API keys, no accounts, no network egress: the backend
reads session logs already on this Mac and serves them on loopback only.

> **Status: scaffold, non-animation parts.** The telemetry is real and reads
> your actual logs. The avatar is a placeholder blob until a `.riv` is dropped
> in. Both halves are designed to be swapped without touching the other.

---

## Run it

Two processes. The backend computes; the app renders.

```bash
# 1. Telemetry backend — Python 3.9+, standard library only, no pip install
cd telemetry
python3 -m avatar_telemetry            # serves http://127.0.0.1:8787/state

# 2. Desktop app — in a second terminal, from the repo root
npm install                            # lifecycle scripts blocked by .npmrc
npm run postinstall:electron           # opt in ONCE to electron's Chromium download
npm start
```

A menu-bar item appears at the top right reading something like
`🦫 ▓▓▓░░ ▓▓▓▓░` — the glyph is the state, then Nourishment, then Energy.

- **Click it** → the stats popover (avatar, three gauges, workstream liveness).
- **"Living area"** → the free-roaming, click-through desktop pet.
- **Right-click** → menu, including Quit.

### Just want to see it move? Skip the backend entirely.

```bash
npm run mock
```

Mock mode needs no telemetry, no logs, and no `.riv`. Over ~3 minutes it walks
the whole arc — working → celebrate → drowsy → sleep — with completions landing
every 20s and one workstream deliberately quiet so a limb droops.

### Other commands

```bash
npm test                # both suites: 47 core checks + 64 telemetry tests
npm run smoke           # headless proof the desktop core works — no GUI needed
npm run test:telemetry  # the Python suite alone
npm run typecheck
npm run watch           # rebuild on change (then re-run `npx electron .`)

AVATAR_DEBUG_OPEN=1 npm start    # open both windows without clicking
```

---

## How the gauges are computed

The backend (`telemetry/avatar_telemetry/`) reads `~/.claude/projects/*/*.jsonl`
incrementally — it remembers a byte offset per file and only opens files touched
inside the lookback window, so repeat polls are nearly free.

### Nourishment — from completed work

Only work with a **verifiable artifact** feeds the gauge. Each event carries a
confidence tier, and the default config accepts `certain` only:

| Signal | Tier | Counted by default |
|---|---|---|
| `git commit` that printed a SHA | `certain` | **yes** |
| `TaskUpdate` with `status: completed` | `certain` | **yes** |
| A test run whose output says passed | `likely` | no |
| `TodoWrite` item marked completed | `likely` | no |

The split is the point. A commit SHA exists whether or not anyone claimed
success; "I marked my own todo done" does not. Loosen it with
`AVATAR_ACCEPT_CONFIDENCE=likely` if the creature feels under-fed — the
rejected count is published in the JSON so a permanently-hungry creature is
diagnosable rather than mysterious.

Each accepted completion adds **12 points**, and the gauge decays with a
**3-day half-life**. Decay is deliberately gentle: a quiet week should read as
a calm creature, not a starving one. Completion ids are stable, so re-reading
the log cannot double-feed.

### Energy — remaining usage budget

Every assistant turn in the logs carries a token count. Energy sums them over a
**rolling 5-hour window** (mirroring Claude's own rate-limit window, not a
calendar day) and reports what is left of the budget:

```
weighted = input + output + cache_creation + 0.1 × cache_read
energy   = (1 − weighted_in_window / budget) × 100
```

Cache reads are weighted to 0.1 because they are an order of magnitude cheaper
than fresh input and would otherwise dominate the total — making energy track
context size rather than real cost.

The default budget is **45M weighted tokens per 5h window**. That number is
calibrated, not invented: measured across 14 days of these logs, the heaviest
observed 5-hour burst was ~35.9M, so a peak session lands around 80% drained.
Retune with `AVATAR_ENERGY_BUDGET_TOKENS`.

Energy refills on its own as old usage ages out of the window. Nothing can be
earned back by working harder — that is what makes it a boundary rather than a
score.

### Health — carousel liveness

A workstream is one project directory (worktrees credit their parent project).
It counts as *live* if it saw a meaningful signal — a human prompt or a
completion, not tool chatter — within 6 hours. Health is how many are
concurrently live, against `healthy_workstream_count` (default 3).

### States

`unknown` > `sleep` > `drowsy` > `celebrate` > `working` > `idle`

Staleness and sleep sit at the top of the ladder because they are the two reads
where a happy creature would be a lie.

### The invariant that matters most

**No data never renders as good news.** If the backend cannot measure usage, it
reports `fresh: false` rather than `energy: 0` used — because a zero would mean
*full tank*. The app enforces this a second time: an unreachable backend, junk
JSON, or a payload older than its own staleness budget all resolve to `unknown`
(desaturated, `?`), never to numbers it cannot back up.

---

## Dropping in the `.riv`

**Building the file itself: see [`RIVE_BUILD_BRIEF.md`](RIVE_BUILD_BRIEF.md)** —
the art-prep steps, the behaviour map, the prompts for Rive's AI Agent, and the
export settings, as a ~30-minute recipe.

Put the export at **`src/assets/avatar.riv`** and run `npm run build`. That is
the whole procedure — asset presence, not a config flag, is what switches the
renderer over. A `.riv` that exists but fails to load is logged loudly rather
than silently falling back.

The artboard must expose these **four inputs**, declared in
`src/core/rive-contract.ts`:

| Input | Type | Range | Driven by |
|---|---|---|---|
| `nourishment` | number | 0–100 | completed work |
| `energy` | number | 0–100 | remaining budget; 0 = asleep |
| `isWorking` | boolean | — | true while a workstream is actively moving |
| `celebrate` | trigger | — | fired once per accepted completion |

**Data binding is preferred for the two numbers.** The renderer looks each name
up as a data-binding property first (the artboard's default view model, bound
via `autoBind`), and falls back to a state-machine input of the same name. Both
authoring styles work; you do not have to pick to match the code.

A name that resolves through **neither** path is logged as a warning naming the
input, and the popover's provenance row reports how many bound — `rive 4/4
inputs` when the contract is met, `rive 2/4 inputs` when it is half-wired. That
is deliberate — a silently-missing input would leave the app looking like it is
driving the avatar while the artboard never moves. `npm run smoke:rive` proves
the binding layer headlessly, including the case where the artboard exposes the
four names through a state machine rather than a view model.

Discrete states (`idle` / `working` / `celebrate` / `drowsy` / `sleep`) are
intentionally *not* separate inputs: they are derivable inside the artboard from
the two numbers plus `isWorking`, which keeps the contract at four names. If the
art ends up wanting an explicit state input, add it to `rive-contract.ts` and
bind it in `src/renderer/shared/rive.ts`.

---

## Why Electron

The brief was the lightest thing that runs on a 2019 Intel iMac and hosts Rive
well. Electron + `@rive-app/canvas` wins on this machine, for reasons specific
to it rather than general enthusiasm:

- **Rive's web runtime is its best-supported one.** Canvas/WASM is what Rive
  documents and ships first; the desktop bindings trail it.
- **No native toolchain.** Tauri would mean a Rust toolchain and a native
  webview, and Rive's Rust path is the least-travelled of the three. On an Intel
  Mac with no Xcode set up, that is the difference between "runs today" and "a
  weekend of toolchain yak-shaving".
- **esbuild keeps it honest.** A full rebuild is well under a second and writes
  kilobytes.

The cost, stated plainly: ~200MB of Chromium and ~150MB of RSS for a menu-bar
pet. That is the trade — iteration speed now, in exchange for a heavier process
than this deserves.

**The escape hatch is real.** `src/main/` is ~300 lines of Electron across two
files; everything else is either pure TypeScript or the Python backend. A move
to Tauri or native Swift replaces the shell, not the system.

---

## Architecture

```
telemetry/avatar_telemetry/   Python, stdlib only — reads logs, computes gauges
  scanner.py                    incremental JSONL tailing
  extract.py                    records → completions / usage / activity  ← THE SEAM
  gauges.py                     the two gauges + liveness
  state.py                      state ladder + the published JSON payload
  service.py                    poll loop, state file, loopback HTTP

src/core/                     pure TypeScript — no Electron, Node, or DOM
  types.ts                      the snapshot contract
  client.ts                     polls the backend, enforces freshness
  mock.ts                       synthetic snapshots, no backend needed
  rive-contract.ts              the four input names

src/main/                     Electron shell — tray + windows, ~300 lines
src/renderer/                 one AvatarRenderer interface, two implementations
```

**The backend owns all gauge maths; the app renders what it is told.** Two
implementations of the same gauge would drift, and the drift would be
invisible — so there is exactly one, in Python, where the data is. The TypeScript
side is a thin client with no decay curves or budget windows of its own.

**Adding a new data source is `extract.py`, not a rewrite.** Everything above it
knows only about `CompletionEvent` / `UsageSample` / `ActivitySignal` and
nothing about where they came from. Conductor, Cursor, or OpenCode each become
another extractor.

### The JSON contract

```bash
curl -s http://127.0.0.1:8787/state | python3 -m json.tool
```

```jsonc
{
  "schema": "agentic-avatar.telemetry/1",
  "at": "2026-08-18T05:12:00Z",
  "mode": "live",                          // or "mock"
  "fresh": true,                           // false ⇒ consumers MUST render unknown
  "stale_after_seconds": 180,
  "state": "working",
  "gauges":      { "nourishment": 36.0, "energy": 91.0, "health": 66.7 },
  "rive_inputs": { "nourishment": 36.0, "energy": 91.0,
                   "isWorking": true, "celebrate": [] },
  "energy_detail": { "used_ratio": 0.09, "weighted_tokens": 4050000, "...": "..." },
  "workstreams": [ { "id": "trident-forge", "live": true, "...": "..." } ]
}
```

`rive_inputs` carries the exact values to push at the artboard, keyed by the
artboard's own names — so the mapping is data, not something each consumer
re-derives.

Endpoints: `/state`, `/healthz`, and `/mock` (mock mode only). The state file is
also written to `~/.agentic-avatar/state.json`, atomically, so the app still
shows real numbers if only `--once` has ever run.

### Backend CLI

```bash
python3 -m avatar_telemetry                        # serve
python3 -m avatar_telemetry --once                 # one snapshot to stdout
python3 -m avatar_telemetry --mock                 # synthetic arc
python3 -m avatar_telemetry --mock --set energy=15 --set nourishment=80

# and live, while it's running — the slider path:
curl "http://127.0.0.1:8787/mock?energy=8&nourishment=90"
```

Tunables are environment variables, listed with their defaults in
`telemetry/avatar_telemetry/config.py`: `AVATAR_ENERGY_BUDGET_TOKENS`,
`AVATAR_ENERGY_WINDOW_HOURS`, `AVATAR_HALF_LIFE_DAYS`, `AVATAR_ACCEPT_CONFIDENCE`,
`AVATAR_LIVENESS_WINDOW_HOURS`, `AVATAR_HEALTHY_WORKSTREAMS`, `AVATAR_PORT`,
`AVATAR_STATE_FILE`, `AVATAR_IGNORE_WORKSTREAMS`.

---

## Limitations

Known and deliberate, in rough order of how likely they are to bite:

1. **The avatar art is a placeholder.** A canvas blob whose plumpness tracks
   nourishment and whose eyelids track energy. It exists to prove the signal
   path, not to be looked at.
2. **The energy budget is calibrated, not authoritative.** 45M weighted tokens
   per 5h is derived from observed local throughput, not from a published plan
   limit — the logs do not record one. If Claude's actual limit is what you want
   to track, this number needs setting by hand.
3. **The first live poll is slow.** Reading 7 days of history takes ~20–30s on
   this iMac; every poll after that is near-instant. Lower `--lookback-days` if
   the cold start annoys you.
4. **Nourishment resets when the backend restarts.** The gauge and its dedup set
   live in memory. A restart re-reads the lookback window, so recent work comes
   back, but the accumulated total does not survive. Persisting it is small and
   worth doing next.
5. **Completion detection is heuristic at the edges.** Commits and completed
   tasks are solid. Test-pass detection is regex over stdout and is deliberately
   `likely`, so it does not count by default.
6. **Workstream identity is the directory name.** Two projects with the same
   basename in different parents would merge. Not a problem in this repo layout.
7. **Nothing is packaged.** No `.app` bundle, no login item, no launchd plist.
   It runs from the terminal, and the backend must be started separately.
8. **The Rive data-binding path is written against the runtime's documented API
   but has not been exercised against a real `.riv`** — there isn't one yet. If
   the first artboard binds through the fallback (state-machine inputs) instead,
   that is the expected behaviour, and the console says which path it took.

## Security posture

- `.npmrc` sets `ignore-scripts=true`; electron's binary download is an
  explicit, separate opt-in.
- The HTTP service binds `127.0.0.1` only — verified refused on the LAN address.
- No credentials anywhere in either process. Nothing is sent off the machine.
- Renderers run with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, behind a four-function preload bridge.
- A CSP on both renderer pages; external navigation is denied and handed to the
  system browser.
