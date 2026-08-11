# Agentic Avatar

A living companion that makes agentic work legible: **two gauges, one creature.**

- **Nourishment** (0–100) — fed by *completed work*. Never by tokens spent.
- **Stamina** (0–100) — drained by usage budget. At zero the creature **sleeps**,
  framed as a healthy boundary rather than a failure.

Spec: `~/projects/outputs/agentic_avatar_spec_2026-08-11.md`

> **Status: Track 2, Phase 1 — scaffold.** The engine is real and tested. The
> avatar is a placeholder blob, and the data source is fake. Both are designed
> to be swapped without touching anything around them.

---

## Run it

```bash
npm install                     # lifecycle scripts are blocked by .npmrc
npm run postinstall:electron    # opt in ONCE to electron's Chromium download
npm start
```

The menu-bar item appears at the top right, reading something like `🦫 ▓▓▓░░ ▓▓▓▓░`
— the glyph is the state, then Nourishment, then Stamina.

- **Click it** → the stats popover (avatar, both gauges, workstream liveness).
- **"Living area"** → the free-roaming, click-through desktop pet.
- **Right-click** → menu, including Quit.

Over ~3 minutes the demo source walks the whole arc: hungry → thriving →
drowsy → asleep, with completions landing every 8s and one workstream going
deliberately quiet so a limb droops.

### Other commands

```bash
npm run smoke       # headless proof the core loop works — no GUI needed
npm run watch       # rebuild on change (then re-run `npx electron .`)
npm run typecheck
AVATAR_DEBUG_OPEN=1 npm start   # open both windows without clicking
```

---

## What's real vs. stubbed

| | Status |
|---|---|
| Two-gauge engine, decay, dedup, confidence gate | **Real**, 15 assertions in `npm run smoke` |
| State resolver + precedence ladder | **Real**, pure function |
| Freshness invariant (no fake zeros) | **Real**, enforced two layers deep |
| Menu-bar den, popover, click-through living area | **Real** |
| Rive render slot | **Real and wired** — loads the runtime, binds the three inputs, falls back loudly |
| The avatar art | **Placeholder** — canvas blob. Drop `avatar.riv` into `src/assets/` |
| The data source | **Fake** — see `docs/TELEMETRY.md` for the real interface |

---

## Architecture in one paragraph

`src/core/` is pure TypeScript with no Electron, Node, or DOM imports: the
gauges, the state resolver, and the adapter seam all live there. `src/main/` is
the Electron shell — tray and windows, ~300 lines. `src/renderer/` drives the
avatar through one `AvatarRenderer` interface with two implementations, Rive
and placeholder. That split is deliberate: Electron was chosen for iteration
speed on a machine with no Xcode and a failing SSD, and the split is what keeps
a later move to Tauri or native Swift a shell swap rather than a rewrite.

Full reasoning: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.
Real telemetry contract: **[`docs/TELEMETRY.md`](docs/TELEMETRY.md)**.

## Dropping in the Rive file

Put the export at `src/assets/avatar.riv` and rebuild. That's it — asset
presence, not a config flag, is what switches the renderer over.

The artboard must expose these state-machine inputs (declared in
`src/core/rive-contract.ts`):

| Input | Type | Range |
|---|---|---|
| `nourishment` | number | 0–100 |
| `stamina` | number | 0–100 |
| `celebrate` | trigger | — |

A missing input is logged loudly rather than silently ignored, so a
partially-wired artboard can't masquerade as a working one.

## Security posture

- `.npmrc` sets `ignore-scripts=true`; electron's binary download is an
  explicit, separate opt-in.
- Renderers run with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, behind a four-function preload bridge.
- A CSP on both renderer pages; external navigation is denied and handed to the
  system browser.
