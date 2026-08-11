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
  setStamina(value01: number): void;       // 0..1
  setStateName(state: AvatarStateName): void;
  celebrate(): void;                       // fire-and-forget trigger
  frame(dtMs: number): void;               // placeholder animation tick
  destroy(): void;
}
```

Two implementations, chosen at runtime by `createAvatarRenderer()`:

1. **`RiveAvatarRenderer`** — loads `src/assets/avatar.riv` via
   `@rive-app/canvas`, binds a `StateMachineInput` for each of the three agreed
   input names, and maps interface calls onto them:

   | Interface call | Rive input | Type |
   |---|---|---|
   | `setNourishment(v)` | `nourishment` | number, **0–100** |
   | `setStamina(v)` | `stamina` | number, **0–100** |
   | `celebrate()` | `celebrate` | trigger |

   The 0..1 → 0–100 scaling happens at this boundary so the Rive artboard sees
   the number range the spec names.

2. **`PlaceholderAvatarRenderer`** — a canvas-2D blob that reads the same three
   signals. Body plumpness tracks nourishment, colour saturation and eyelid
   droop track stamina, `celebrate()` triggers a hop. **This is what ships in
   Phase 1**, so the loop is felt before any art exists.

**Selection is by asset presence, not by a flag:** if `src/assets/avatar.riv`
exists it is used; otherwise the placeholder runs and logs one line saying so.
Dropping the real `.riv` into `src/assets/` and rebuilding is the entire
integration step — no code change.

### Two Rive gotchas already handled in the scaffold

- **WASM must be local.** `@rive-app/canvas` fetches `rive.wasm` from a CDN by
  default. A desktop app cannot depend on that. `scripts/build.mjs` copies the
  wasm into `dist/renderer/` and the renderer calls `RuntimeLoader.setWasmUrl()`
  at a local path before instantiating.
- **Input names are a contract with the artboard.** The three names are
  declared once in `src/core/rive-contract.ts` and imported by the renderer, so
  the app and the art file have a single written source of truth. If an input
  is missing at load time the renderer warns loudly and keeps running with the
  ones it found — it does **not** silently pretend to be driving the avatar
  (spec §5.2 freshness invariant, and the fail-loud rule).

---

## 3. Data → state → avatar

```
  ┌── adapters (the seam) ────────────────┐
  │  FakeAdapter          [Phase 1]        │   completions(since) → CompletionEvent[]
  │  ConductorAdapter     [Track 3]        │   usage()            → UsageMetric | null
  │  TokenTelemetryAdapter[Track 3]        │   workstreams()      → WorkstreamSignal[]
  └───────────────┬───────────────────────┘
                  │  poll every ENGINE_TICK_MS (1s)
                  ▼
  ┌── src/core/engine.ts ──────────────────────────────────────────┐
  │  gauges.ts   NourishmentGauge  ← completions (dedup by id,      │
  │                                   [certain] only, gentle decay) │
  │              StaminaGauge      ← usage ratio + freshness check  │
  │  liveness.ts workstream freshness windows → live | stale        │
  │  state.ts    resolveState(N, S, liveness[], fresh) → pure fn    │
  │              precedence: unknown > asleep > drowsy > hungry     │
  │                          > thriving;  drooping[] is ADDITIVE    │
  └───────────────┬────────────────────────────────────────────────┘
                  │  emits AvatarSnapshot { nourishment, stamina,
                  │       state, drooping[], workstreams[], fresh,
                  │       pulses[] }
                  ▼
  ┌── src/main/ (Electron main) ───────────────────────────────────┐
  │  tray.ts     snapshot → menu-bar title (the "den")             │
  │  windows.ts  webContents.send('avatar:snapshot', snapshot)     │
  └───────────────┬────────────────────────────────────────────────┘
                  │  contextBridge (contextIsolation, sandboxed)
        ┌─────────┴──────────┐
        ▼                    ▼
  popover window       living-area window
  (two gauges,         (transparent, click-through,
   workstream list)     always-on-top, roaming avatar)
        │                    │
        └────────┬───────────┘
                 ▼
        AvatarRenderer  →  nourishment / stamina / celebrate
```

### Nourishment (spec §4.1)

- Only `type:'completion'` events at confidence `certain` feed it. `likely` is
  behind a config flag defaulting **off** (spec §13 open question 4).
- Dedup on `event.id` — an idempotent set, so replaying the log cannot
  double-feed (spec §7 rule 6).
- Each accepted completion adds `NOURISHMENT_BUMP` (12 pts), clamped at 100.
- Decay is exponential with a **3-day half-life**, applied continuously per
  tick — gentle, never punitive. Tunable in `src/core/config.ts`; the exact
  curve is spec §13 open question 2, deliberately left as one constant.
- **Token spend cannot reach this gauge.** There is no code path from a usage
  metric into `NourishmentGauge`. That's structural, per spec §7 rule 1.

### Stamina (spec §4.2)

- `stamina = (1 − usage.used) × 100`, from a single `UsageMetric`.
- Freshness is enforced: if `now − freshAt > staleAfterS`, the snapshot is
  marked `fresh: false` and the state resolver returns `unknown`. **A gauge
  that cannot prove its data is fresh never renders as healthy** (spec §5.2).
  This also satisfies the fail-loud-observability rule — no fake zeros, no
  falsely-happy creature.

### Celebrate (spec §10.3)

Discrete events need at-most-once delivery across a polling boundary, so they
travel as **pulses** rather than as edge-detection on a level:

- When a completion is accepted, the engine appends
  `{ id: 'celebrate:<completionId>', kind: 'celebrate', at, label }` to the
  next snapshot's `pulses[]`.
- Each renderer keeps a `Set` of pulse ids it has already played, so a snapshot
  redelivered on window reopen cannot re-fire the animation.
- On a new pulse the renderer calls `renderer.celebrate()` → the Rive
  `celebrate` trigger fires, and the living-area avatar does a happy dash.

Same mechanism generalizes to future one-shots (waking up, entering sleep)
without touching the transport.

---

## 4. Repo layout

```
src/
  core/                  ← PURE. no electron, no node, no DOM. portable.
    types.ts             event + snapshot contracts
    config.ts            every tunable constant, one file
    rive-contract.ts     the three Rive input names, single source of truth
    gauges.ts            NourishmentGauge, StaminaGauge
    liveness.ts          workstream freshness
    state.ts             resolveState() — pure function
    engine.ts            AvatarEngine: poll adapters → snapshot → subscribers
    adapters/
      types.ts           SourceAdapter — THE SEAM
      fake.ts            FakeAdapter (Phase 1 stub data source)
  main/                  ← Electron main process (the swappable shell)
    index.ts  tray.ts  windows.ts  preload.ts
  renderer/
    shared/              renderer.ts (AvatarRenderer iface + factory),
                         placeholder.ts, rive.ts, gauge-bar.ts
    popover/             index.html + main.ts
    living/              index.html + main.ts
  assets/                drop avatar.riv here (absent in Phase 1)
scripts/
  build.mjs              esbuild bundling + asset/wasm copy
  smoke-core.mjs         headless proof the engine ticks (no GUI needed)
docs/
  ARCHITECTURE.md        this file
  TELEMETRY.md           how real adapters plug in later
```
