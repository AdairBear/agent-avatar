# Agentic Avatar — Track 2 Architecture Plan

> **Status:** Phase 1 (scaffold). Written 2026-08-11.
> **Scope:** the macOS menu-bar companion + the two-gauge engine (spec §4, §6, §10.3, §12).
> **Source spec:** `~/projects/outputs/agentic_avatar_spec_2026-08-11.md`

---

## 1. Stack decision — Electron + TypeScript

**Chosen: Electron (Chromium renderer) + TypeScript + esbuild, with the engine
kept in a zero-dependency `core/` that imports nothing from Electron.**

### The constraints that decided it

Measured on this machine, not assumed:

| Fact | Command | Result |
|---|---|---|
| Node toolchain | `node -v` / `npm -v` | v24.12.0 / 11.6.2 — ready |
| Rust toolchain | `rustc --version` | 1.97.1 — ready (Tauri *is* viable) |
| Xcode | `xcode-select -p` | `/Library/Developer/CommandLineTools` — **no full Xcode** |
| Free disk | `df -h /Users` | **49 GB free, 97% used**, on a failing SSD |

### Scoring the three candidates

| | **Electron** | Tauri v2 | Native Swift / SwiftUI `MenuBarExtra` |
|---|---|---|---|
| Rive rendering | **Chromium — Rive's best-tested web target** | WKWebView; Rive web runtime works but is the less-trodden path (WASM over a custom scheme) | `rive-ios` on macOS: least-trodden of the three, needs SPM + a real Xcode |
| Toolchain on *this* box | **Already installed, nothing to add** | Installed, but every build compiles Rust | **Blocked** — CommandLineTools only; no Xcode to build/sign an `.app` bundle |
| Disk write churn per iteration | **~0** (no compile step; Chromium downloaded once, ~150 MB) | **Bad** — `target/` runs 2–4 GB and rewrites hundreds of MB on any Rust-side change | Moderate, but moot |
| Iteration speed | **Sub-second** — esbuild rebundle + window reload | Seconds-to-minutes on a cold or dependency-touched Rust build | Slowest; no working toolchain |
| Tray / menu-bar item | `Tray` — mature, first-class | Supported | Native, best-in-class |
| Transparent click-through roaming window | `transparent` + `setIgnoreMouseEvents(true, {forward:true})` — battle-tested | `set_ignore_cursor_events` — supported | Native `NSWindow`, best-in-class |
| Runtime footprint | ~200–300 MB RSS, ~200 MB bundle | ~60–100 MB RSS, ~10 MB bundle | Smallest |

### Why Electron wins here, plainly

Tauri produces the nicer artifact. It is the wrong tool for *this* machine
*today* for one dominating reason: **a failing SSD makes repeated multi-gigabyte
Rust rebuilds the single most expensive thing we could choose to do.** Cargo
writes GBs into `target/` on the first build and hundreds of MB again on every
dependency or Rust-side change. Electron compiles nothing — it downloads
Chromium once and then every iteration is an esbuild rebundle measured in
milliseconds and kilobytes. On a drive with 49 GB left and a known failure mode,
that difference is the whole argument.

Second reason: **Rive.** The `.riv` is the art pipeline, so the renderer's
fidelity to Rive's own test target is load-bearing. Rive's web runtime is
developed and tested against Chrome first. Electron *is* Chrome. WKWebView
(Tauri) is supported but is where you'd go to find the edge cases, and finding
Rive edge cases is not the job of Track 2.

Native Swift is not a trade-off, it's a block: without full Xcode there is no
supported path to building and signing a menu-bar `.app`, and installing Xcode
means ~15 GB onto the failing drive before writing line one.

### The cost, stated honestly

Electron's fat runtime is a real and permanent cost, and Tauri would be the
better *shipping* choice once the concept is proven. That is why the escape
hatch is structural, not aspirational:

> **`src/core/` imports nothing from Electron, Node, or the DOM.** It is pure
> TypeScript over plain data. The gauges, the state resolver, and the adapter
> seam are all in there.

Porting to Tauri later means rewriting `src/main/` (≈300 lines of window and
tray plumbing) and keeping `src/core/` and `src/renderer/` verbatim. Porting to
native Swift means reimplementing `core/` against the same documented types.
Neither is a rewrite. **Revisit the shell at the v1→v2 gate**, from evidence
about whether the thing is fun — exactly the fork the spec §11 defers.

---

## 2. How the `.riv` renders

The renderer never talks to Rive directly. It talks to one interface:

```ts
interface AvatarRenderer {
  setNourishment(value01: number): void;   // 0..1
  setEnergy(value01: number): void;        // 0..1
  setWorking(working: boolean): void;
  setStateName(state: AvatarStateName): void;
  celebrate(): void;                       // fire-and-forget trigger
  frame(dtMs: number): void;               // placeholder animation tick
  destroy(): void;
}
```

Two implementations, chosen at runtime by `createAvatarRenderer()`:

1. **`RiveAvatarRenderer`** — loads `src/assets/avatar.riv` via
   `@rive-app/canvas` and binds each of the four agreed names:

   | Interface call | Rive name | Type |
   |---|---|---|
   | `setNourishment(v)` | `nourishment` | number, **0–100** |
   | `setEnergy(v)` | `energy` | number, **0–100** |
   | `setWorking(b)` | `isWorking` | boolean |
   | `celebrate()` | `celebrate` | trigger |

   The 0..1 → 0–100 scaling happens at this boundary so the artboard sees the
   number range the spec names.

   **Each name is resolved twice over.** The renderer first asks the artboard's
   data-binding view model (`autoBind: true`) for a property of that name, and
   falls back to a state-machine input of the same name. Data binding is the
   preferred path for continuously-varying numbers; the input path keeps
   artboards authored the older way working. The art does not have to know
   which the code prefers.

2. **`PlaceholderAvatarRenderer`** — a canvas-2D blob reading the same four
   signals. Plumpness tracks nourishment, saturation and eyelid droop track
   energy, `isWorking` speeds up the idle bob, `celebrate()` triggers a hop.
   **This is what ships until art exists**, so the loop is felt first.

**Selection is by asset presence, not by a flag:** if `src/assets/avatar.riv`
exists it is used; otherwise the placeholder runs and logs one line saying so.
Dropping the real `.riv` in and rebuilding is the entire integration step.

### Two Rive gotchas already handled in the scaffold

- **WASM must be local.** `@rive-app/canvas` fetches `rive.wasm` from a CDN by
  default. A desktop app cannot depend on that. `scripts/build.mjs` copies the
  wasm into `dist/renderer/` and the renderer calls `RuntimeLoader.setWasmUrl()`
  at a local path before instantiating.
- **Input names are a contract with the artboard.** The four names are declared
  once in `src/core/rive-contract.ts` and imported by the renderer, so the app
  and the art file have a single written source of truth. A name that resolves
  through neither data binding nor a state-machine input is warned about by
  name — the renderer does **not** silently pretend to be driving the avatar.

---

## 3. Data → state → avatar

The gauge maths lives in **one** place: the Python backend. The desktop app is
a thin client. Two implementations of the same decay curve would drift, and the
drift would be silent — so there is only one, on the side that has the data.

```
  ~/.claude/projects/*/*.jsonl        (append-only session logs, read-only)
                  │
                  ▼
  ┌── telemetry/avatar_telemetry ──────────────────────────────────┐
  │  scanner.py   incremental tail — byte offset per file,         │
  │               mtime-gated by lookback window                   │
  │  extract.py   records → CompletionEvent / UsageSample /        │
  │               ActivitySignal            ← THE SEAM             │
  │  gauges.py    NourishmentGauge ← completions (dedup by id,     │
  │                                  [certain] only, 3d half-life) │
  │               EnergyGauge      ← rolling 5h token window       │
  │               LivenessTracker  → live | quiet, carousel health │
  │  state.py     resolve_state(...) → pure function               │
  │               unknown > sleep > drowsy > celebrate >           │
  │               working > idle;  drooping[] is ADDITIVE          │
  │  service.py   poll loop → state.json (atomic) + 127.0.0.1 HTTP │
  └───────────────┬────────────────────────────────────────────────┘
                  │  agentic-avatar.telemetry/1 JSON
                  │  { gauges, rive_inputs, state, fresh, workstreams }
                  ▼
  ┌── src/core/client.ts ──────────────────────────────────────────┐
  │  polls /state, falls back to the state file, and enforces      │
  │  freshness a SECOND time: unreachable / malformed / older than │
  │  stale_after_seconds  ⇒  unknown, never numbers it can't back  │
  └───────────────┬────────────────────────────────────────────────┘
                  │  AvatarSnapshot
                  ▼
  ┌── src/main/ (Electron main) ───────────────────────────────────┐
  │  tray.ts     snapshot → menu-bar title (the "den")             │
  │  windows.ts  webContents.send('avatar:snapshot', snapshot)     │
  └───────────────┬────────────────────────────────────────────────┘
                  │  contextBridge (contextIsolation, sandboxed)
        ┌─────────┴──────────┐
        ▼                    ▼
  popover window       living-area window
  (three gauges,       (transparent, click-through,
   workstream list)     always-on-top, roaming avatar)
        │                    │
        └────────┬───────────┘
                 ▼
    AvatarRenderer  →  nourishment / energy / isWorking / celebrate
```

`src/core/mock.ts` substitutes for the whole left-hand column under
`--mock`, producing the same `AvatarSnapshot` — so mock mode exercises every
downstream path rather than bypassing them.

### Nourishment

- Only completions at confidence `certain` feed it; `likely` is behind
  `AVATAR_ACCEPT_CONFIDENCE`, defaulting off.
- Dedup on `event.id`, whose components are verifiable artifacts (a commit SHA,
  a task id) — so replaying the log cannot double-feed.
- Each accepted completion adds 12 pts, clamped at 100.
- Decay is exponential with a **3-day half-life** — gentle, never punitive.
- **Token spend cannot reach this gauge.** `NourishmentGauge` has no method
  that accepts a `UsageSample`. That is structural, not a discipline.

### Energy

- `energy = (1 − weighted_tokens_in_window / budget) × 100` over a rolling 5h
  window, with cache reads weighted to 0.1.
- Refills as usage ages out of the window. It cannot be earned back by working
  harder, which is what makes it a boundary rather than a score.
- If no usage could be measured at all, the reading is `fresh: false` — **not**
  `used: 0`, which would mean a full tank and paint a healthy creature on the
  strength of no data. The state resolver turns that into `unknown`.

### Health

Carousel liveness: how many workstreams saw a *meaningful* signal (a human
prompt or a completion — not tool chatter) inside the liveness window, over
`healthy_workstream_count`. One project running hot is not the same as a
portfolio in motion, and health is what reports the difference.

### Celebrate

Discrete events need at-most-once delivery across a polling boundary, so they
travel as **pulses** rather than as edge-detection on a level:

- On acceptance the backend appends
  `{ id: 'celebrate:<completionId>', kind: 'celebrate', at, label }` to the
  payload's `pulses[]`.
- Each renderer keeps a `Set` of pulse ids already played, so a snapshot
  redelivered on window reopen cannot re-fire the animation.
- On a new pulse the renderer calls `celebrate()` → the Rive trigger fires, and
  the living-area avatar does a happy dash.

The same mechanism generalizes to future one-shots (waking, falling asleep)
without touching the transport.

---

## 4. Repo layout

```
telemetry/               ← Python 3, standard library only. No pip install.
  avatar_telemetry/
    config.py            every tunable, env-overridable
    scanner.py           incremental JSONL reader
    extract.py           records → signals            ← THE SEAM
    gauges.py            NourishmentGauge, EnergyGauge, LivenessTracker
    state.py             state ladder + published payload
    mock.py              synthetic source (arc + pinned "sliders")
    service.py           poll loop, atomic state file, loopback HTTP
    __main__.py          CLI
  tests/test_telemetry.py  64 tests, stdlib unittest

src/
  core/                  ← PURE. no electron, no node, no DOM. portable.
    types.ts             snapshot contract + state copy
    client.ts            backend poller, freshness enforcement, payload mapping
    mock.ts              synthetic snapshots — no backend needed
    rive-contract.ts     the four Rive names, single source of truth
  main/                  ← Electron main process (the swappable shell)
    index.ts  tray.ts  windows.ts  preload.ts
  renderer/
    shared/              renderer.ts (AvatarRenderer iface + factory),
                         placeholder.ts, rive.ts, bridge.ts
    popover/             index.html + main.ts + popover.css
    living/              index.html + main.ts + living.css
  assets/                drop avatar.riv here
scripts/
  build.mjs              esbuild bundling + asset/wasm copy
  smoke-core.mjs         headless proof the client + mock work (no GUI)
docs/
  ARCHITECTURE.md        this file
  TELEMETRY.md           what the backend reads and how to extend it
```
