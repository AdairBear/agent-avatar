# Rive Build Brief — making `avatar.riv`

This is the recipe for the one piece of Agentic Avatar that code cannot produce:
the art file. Everything else is built, tested, and waiting. Follow this
top-to-bottom and the Rive session should be roughly **30 minutes**, most of it
drawing rather than learning.

**The finish line is one line of text.** When the popover's provenance row reads

```
12 completions · local logs · rive 4/4 inputs
```

Phase 1 is done. `4/4` is the app telling you all four signals bound. Anything
less is named and diagnosable — see §8.

---

## 0. What you are making

A single square artboard containing one capybara, driven by **four inputs and
nothing else**. The app pushes two numbers, one boolean, and one trigger. Every
mood, pose, and transition is derived *inside* the artboard from those four.

That constraint is deliberate. It means the app can never disagree with the
picture, and it means this file is the only thing that has to change when the
creature's personality changes.

---

## 1. Before you open Rive (5 minutes)

**Plan: Cadet, $9/seat/month.** The reason is specific and unavoidable — the
Free plan **cannot export a runtime `.riv` at all**. You can draw, animate, and
even use the AI Agent on Free, and end up with nothing to put in `src/assets/`.
Cadet is the cheapest tier that unlocks runtime export. (Voyager at $32 adds
better AI models and Agent credits; not needed here.) Confirm current pricing at
[rive.app/pricing](https://rive.app/pricing).

**Install the Rive *desktop* app** (macOS). Not just the browser editor — the
MCP bridge in §2 is desktop-only.

---

## 2. The fast path — let Claude do the wiring

Rive's desktop editor exposes a local MCP server, so an agent can create the
artboard, state machine, inputs, view model, and bindings for you. This is the
difference between "learn Rive's state machine UI" and "describe what you want".

With the Rive desktop app open:

```bash
claude mcp add --transport http rive http://127.0.0.1:9791/mcp
claude
```

It is `127.0.0.1` — loopback to the app already running on your Mac. No new
service, no account linkage, nothing leaves the machine.

The MCP tools can create and rename artboards, edit state machines, states,
transitions, conditions and keyframes, and create view models, properties and
bindings — which is the whole of §5 and §6. Type **"End Prompt"** to authorize
the agent's changes to your file.

**Caveat, stated honestly:** Rive's MCP tool coverage is still expanding. If a
prompt in §6 doesn't take, do that one step by hand — each prompt maps to one
ordinary editor action, and §5 describes the intent so you can build it manually.
Drawing (§4) is yours either way.

---

## 3. The contract — four names, exactly

These are declared in [`src/core/rive-contract.ts`](src/core/rive-contract.ts).
They are **case-sensitive**. `isworking` will not bind.

| Name | Type | Range | Driven by |
|---|---|---|---|
| `nourishment` | number | 0–100 | completed, verified work |
| `energy` | number | 0–100 | remaining usage budget; 0 = asleep |
| `isWorking` | boolean | — | true while a workstream is actively moving |
| `celebrate` | trigger | — | fired once per proven completion |

**Author them both ways.** The app looks each name up as a **data-binding
property first**, then falls back to a state-machine input of the same name.
Creating both a view model *and* state-machine inputs with these names costs
nothing and removes an entire class of "why isn't it moving".

Three structural requirements that come from how the app loads the file:

- The capybara artboard must be the file's **default artboard** (the app does
  not name one).
- That artboard should have **exactly one state machine**. The app takes the
  first one it finds.
- Do **not** add a `state` string input. States are derived inside the artboard
  (§5). Four names is the whole contract.

---

## 4. Art prep — the capybara (≈10 minutes)

**Hero: capybara.** Locked. It earns the slot: a naturally placid animal with a
round, low silhouette that still reads at 140 px, plumpness that is legible as a
shape change, and — the important one — a sleeping capybara is about the least
guilt-inducing image in nature. That matters, because this creature sleeps often
and by design.

### Reference art

Generate 3–4 references in Firefly. Useful prompt seeds:

> flat vector illustration of a capybara, three-quarter side view, neutral
> calm expression, sitting, simple rounded shapes, thick clean outlines,
> limited palette, plain background, no text

> the same capybara curled up asleep, eyes closed, side view, flat vector

**Do not import the raster into Rive.** It is reference to draw over. A raster
cannot deform for plumpness, and you need named, separable layers.

### Draw it as layered vector

Trace over the reference in your vector tool of choice. **The layer names below
matter** — the AI Agent prompts in §6 address groups by name, and a rename means
editing every prompt.

| Group | Purpose |
|---|---|
| `body` | one closed path — this is what plumps |
| `head` | |
| `ear_l`, `ear_r` | perk up when working |
| `eye_l`, `eye_r` | pupil and white as separate shapes |
| `lid_l`, `lid_r` | eyelid shapes that slide down over the eyes — the drowsiness ramp |
| `snout`, `nose` | |
| `leg_fl`, `leg_fr`, `leg_bl`, `leg_br` | four separate. v1 doesn't animate them; the later carousel-liveness pass droops them individually |
| `cheek_l`, `cheek_r` | blush, opacity driven by nourishment |
| `zzz` | sleep glyph group, hidden by default |
| `spark` | celebrate burst group, hidden by default |

Then:

- Export as **one SVG**, flat structure, **no clipping masks**. Rive converts
  SVG into editable vector objects rather than embedding a file asset.
- Artboard **400 × 400, square**. The app draws into a 140 px canvas with
  contain-fit; square removes all cropping surprises.
- Set the `body` group's origin/pivot **at the feet**, so plumpness grows the
  creature upward rather than inflating it around its middle.

---

## 5. Behaviour map — what each input must do

This section is the design spec. §6 is the same thing phrased as prompts.

### `nourishment` 0 → 100: plumpness and mood

| Range | Reads as |
|---|---|
| 0–35 | lean silhouette, neutral mouth, cheeks at 0 opacity |
| 35–70 | normal |
| 70–100 | rounder body (X scale 1.0 → 1.12, Y 1.0 → 1.05), cheeks 0 → 60%, faint upward mouth curve |

**Low nourishment is lean, never starving.** No ribs, no sad face, no droop.
The floor of this gauge is a calm animal that has not eaten recently, because a
quiet week must not render as a failing grade. Blend continuously — this is one
interpolation, not three discrete states.

### `energy` 100 → 0: the drowsiness ramp, then sleep

| Energy | Reads as |
|---|---|
| 100–40 | awake, normal blink cadence, eyes open |
| 40–20 | lids down ~30%, blinks slow, idle bob slows |
| 20–1 | **drowsy** — lids ~60%, head dips, occasional long blink |
| 0 | **asleep** — lids closed, body settled, `zzz` fades in and out, slow breathing only |

**Sleep is a positive boundary, not a punishment.** The app's own copy for this
state reads *"Asleep. Resting until the budget window rolls forward."* Nothing in
the art may contradict that: no red, no alarm, no wilting, no down-arrow, no
distress. The capybara looks **comfortable**. Energy refills on its own as usage
ages out of the window — it cannot be earned back by working harder, so the art
must not imply effort would help.

Waking is a stretch, not a jolt: 600 ms ease-out when energy rises past 0.

The 20 and 0 thresholds mirror the backend's `AVATAR_DROWSY_BELOW` and
`AVATAR_ASLEEP_AT`, so the picture and the popover text always agree.

### `isWorking` boolean: the active state

- **true** — idle bob faster and larger, ears perk, tail flick.
- **false** — slow potter.
- **Sleep outranks it.** A sleeping capybara does not perk up because a
  workstream moved. Guard the transition into `Working` with `energy > 0`.

### `celebrate` trigger: a burst on real, finished work

A ~1.4 s one-shot: a small hop, the `spark` group scales up and fades, cheeks
flash, then it returns to whatever state it came from.

This one is allowed to be genuinely delightful, because **it cannot be farmed**.
The backend only fires it for completions at `certain` confidence — a real commit,
a completed task, a green test run. Consumption never triggers it.

Two requirements: it must be **re-entrant** (two completions three seconds apart
must both read), and it must **not fire while asleep** — guard on `energy > 0`.

### States are derived, never sent

The app deliberately sends only the four values. Derive the rest inside the
artboard:

```
sleep    ← energy <= 0
drowsy   ← energy < 20
working  ← isWorking && energy > 0
idle     ← otherwise
```

---

## 6. Exact prompts for the Rive AI Agent

One job per prompt, in order. Sanity-check each result before moving on — steer
with small specific prompts rather than one large one. Type **"End Prompt"** to
authorize changes.

**1 — the view model**

> Create a view model named `Avatar` with four properties: `nourishment`
> (number, default 50), `energy` (number, default 100), `isWorking` (boolean,
> default false), and `celebrate` (trigger). Make it the default view model for
> this artboard. Use these exact names and exact capitalisation.

**2 — the state machine**

> Create a state machine named `AvatarMachine` on this artboard with four
> states: `Idle`, `Working`, `Drowsy`, and `Sleep`. Add state machine inputs
> with exactly these names and types: `nourishment` (number), `energy` (number),
> `isWorking` (boolean), `celebrate` (trigger). Wire these transitions: any
> state to `Sleep` when `energy <= 0`; `Sleep` to `Idle` when `energy > 0` with
> a 600ms ease-out; any non-sleep state to `Drowsy` when `energy < 20`; `Drowsy`
> to `Idle` when `energy >= 20`; `Idle` to `Working` when `isWorking` is true
> and `energy > 0`; `Working` to `Idle` when `isWorking` is false.

**3 — the drowsiness ramp**

> Bind the Y position of the `lid_l` and `lid_r` groups to `energy`, linearly:
> at energy 100 the lids are fully raised and cover none of the eye, at energy
> 20 they cover 60% of the eye, and at energy 0 they are fully closed. Use a
> continuous interpolation, not discrete steps.

**4 — plumpness**

> Bind the `body` group's scale to `nourishment`: at nourishment 0 the X scale
> is 1.0 and the Y scale is 1.0; at nourishment 100 the X scale is 1.12 and the
> Y scale is 1.05. Keep the group's origin at the feet so it grows upward. Also
> bind `cheek_l` and `cheek_r` opacity from 0% at nourishment 40 to 60% at
> nourishment 100.

**5 — idle, working, and sleeping loops**

> On `Idle`, create a 2-second looping breathing animation where the `body`
> group scales on Y between 1.0 and 1.02 with ease-in-out. On `Working`, use the
> same loop at 1.6x speed and rotate `ear_l` and `ear_r` up by 8 degrees. On
> `Sleep`, use a 4-second breathing loop with the lids fully closed, and fade the
> `zzz` group in and out over 3 seconds.

**6 — celebrate**

> Add a one-shot state named `Celebrate` entered by the `celebrate` trigger and
> lasting 1.4 seconds: the artboard hops up 12 pixels and back with an
> ease-out-back curve, the `spark` group scales from 0 to 1 and fades to 0, and
> the cheeks flash to 80% opacity and back. When it completes, return to the
> previous state. Block entry into `Celebrate` when `energy <= 0`.

**7 — the audit (do not skip this one)**

> List every state machine input and every view model property on this artboard,
> with exact name and type. Confirm that exactly these four exist and that
> nothing is misspelled: `nourishment` (number), `energy` (number), `isWorking`
> (boolean), `celebrate` (trigger).

### Then drive it by hand

In the editor, scrub each input and watch for:

- `energy` 100 → 0 — do the lids descend smoothly, and does it land in a
  comfortable-looking sleep rather than a collapse?
- `energy` 0 → 50 — does it wake gently?
- `nourishment` 0 → 100 — does it round out without the feet sliding?
- `isWorking` on at `energy: 0` — does it **stay asleep**?
- `celebrate` twice in a row — does the second one read?

---

## 7. Export settings

- **File → Export → Runtime (`.riv`)**. Not the preview/web export, not an image
  or video export. This is the step that needs Cadet.
- Export the capybara artboard, **with the state machine included**.
- Don't embed extra artboards, fonts, or audio — none are needed for v1.
- Rename the download to exactly **`avatar.riv`**, lowercase.
- Sanity check the size: it should be **tens of KB**. If it's megabytes, a raster
  got embedded — go back to §4.

---

## 8. Drop it in and prove it

```bash
cp ~/Downloads/avatar.riv src/assets/avatar.riv
npm run build     # expect: [build] avatar.riv found → Rive renderer will be used
npm test          # must stay green
npm run mock      # then click the menu-bar den
```

Check three things, in this order:

1. **The build line** says `avatar.riv found`. If not, the file is in the wrong
   place or misnamed.
2. **The popover's bottom provenance row** ends in `rive 4/4 inputs`.
3. **Mock mode walks the whole arc** down to sleep on a 3-minute loop
   (`ARC_SECONDS` in `src/core/mock.ts`). Watch the creature follow the gauges.

Reading the failures. Every case below logs a line naming the problem — get at
them with:

```bash
npm run dev 2>&1 | grep '\[avatar\]'
```

| What you see | What it means |
|---|---|
| `placeholder` | The `.riv` didn't load at all. The load error is logged verbatim. |
| `rive 0/4 inputs` | The file loaded and draws, but not one name matched. Almost always capitalisation (`isworking` ≠ `isWorking`). Logged as an **error**. |
| `rive 2/4 inputs` | Two names bound. The warning names the missing ones, and lists which view model and state machine were searched. |
| `4/4` but nothing moves | The inputs bound but the artboard doesn't act on them — a state machine wiring problem. §6 prompt 7 will show what actually exists. |

Mock mode is the right harness for this: it walks nourishment and energy through
their full range including sleep, with no backend running.

---

## 9. v1 decisions — recommended defaults, yours to finalise

These are set as defaults so nothing blocks on a decision. **All four are
Thomas's to confirm or overrule.**

| Decision | Default | Why | Cost to change later |
|---|---|---|---|
| Hero | **Capybara** | Locked roster; placid, round, and reads well asleep | **High** — it's the art |
| Platform | **Desktop-only for v1** | The menu-bar + free-roam surfaces are the whole interaction; a port dilutes v1 | Low — `src/main/` is ~300 lines |
| Ship order | **Two gauges first** (nourishment + energy); carousel liveness later | The two gauges are the legible core; three simultaneous signals is a lot to read on one creature | Low |
| Carousel liveness | **Computed and shown as a number now, not animated yet** | The `health` gauge already ships in the popover — it just doesn't drive the art | Low — the `leg_*` groups are already named for it |

The "drooping limb" pass is additive: each quiet workstream droops one of the
four `leg_*` groups. Nothing needs removing to add it later, which is exactly why
it's safe to defer.

---

## 10. Keep the soul

The three commitments this project is built on, and what each means at the
drawing board:

**Vitality comes from completions, not consumption.** Nourishment is fed only by
proven finished work — never by tokens burned or hours logged. The gauges are
separated by type signature in the backend, not by discipline. So: the plump,
happy capybara must be unmistakably a picture of *finished work*, and nothing in
the art may reward mere activity.

**Sleep is healthy.** Energy hitting zero is a boundary the system respects, and
it refills on its own. So: the sleep pose is the most comfortable pose in the
file. No red, no alarm, no wilting, no implication that resting is failure.

**Dashes, not fake zeros.** When telemetry can't prove freshness the app shows
`?`, never a number it can't back up. The `unknown` state already renders
desaturated. So: don't design a "sad" low state that could be mistaken for the
unknown state — they must read differently.

### What not to build

No streaks. No numbers on the creature. No red anywhere. No notification badge.
No sad or sick face at low nourishment. No "you haven't fed me" state. Nothing
that turns a quiet week into an accusation.

---

## Appendix — where the contract lives in code

| File | What it holds |
|---|---|
| [`src/core/rive-contract.ts`](src/core/rive-contract.ts) | The four names, machine-readable. Single source of truth. |
| [`src/renderer/shared/rive.ts`](src/renderer/shared/rive.ts) | Binding: data binding first, state-machine inputs second, loud on failure. |
| [`src/renderer/shared/renderer.ts`](src/renderer/shared/renderer.ts) | Picks Rive vs placeholder by **asset presence**, not a config flag. |
| [`scripts/smoke-rive.mjs`](scripts/smoke-rive.mjs) | Headless proof the four inputs are actually driven. |
| [`src/assets/README.md`](src/assets/README.md) | The one-paragraph version of this brief. |

If the artboard ever needs a fifth signal, add it to `rive-contract.ts` and bind
it in `rive.ts`. Those two files, in that order — nothing else.
