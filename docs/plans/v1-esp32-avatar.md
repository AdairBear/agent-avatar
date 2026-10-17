# Plan: Agent Avatar v1 on the ESP32 panel

> **Status:** plan only. Nothing flashed. Written 2026-10-16 on `feature/voice-bridge`.
> **Builds on:** `docs/proposals/esp32-voice-panel.md` §6 (the agreed decisions).
> **Rule:** no flash, USB or over the air, until Thomas says "go" in that session.

## v1 in one paragraph

The board stops being a chat screen and becomes the creature. Home shows the
capybara with three calm arcs and a status line, and voice runs as an overlay
on top. Speech goes through Whisper as it does now. Utterances that start with
"Agent" go to a local qwen 4B router: simple ones are answered on the Mac and
never leave it, and anything else is forwarded to Claude. A Device page shows
link health and holds a few settings. Cubase, Work and Audio come later.

---

## What I checked on the mini today

- **RAM: 16 GB.** About 44% free. **3.3 M pageouts since boot**, so the mini
  already swaps. This is the main risk (see Risks).
- **Voice bridge:** running under launchd on `*:8790`. whisper-server is on
  `127.0.0.1:8791` (large-v3-turbo q5).
- **Ollama:** `127.0.0.1:11434`, loopback only. qwen3.5:4b (MLX, nvfp4,
  about 4 GB on disk) and qwen3-embedding:0.6b are pulled. Nothing is loaded
  right now.
- **Telemetry is not running on this Mac.** Nothing answers on 8787, and
  `~/.agentic-avatar/` does not exist. v1 has to start it first.
- **Telemetry does not have** real usage readings, the weekly window,
  workstream tiers or `attention[]` yet. They are designed in §6 but not built.

---

## Scope

### In v1

1. **Home:** the capybara in its five poses, three gauge arcs, one status line,
   and the voice overlay.
2. **Voice router:** Whisper, then qwen 4B on "Agent, …" commands. A closed
   list of local answers and actions; everything else goes to Claude.
3. **Device page.**
4. **Telemetry on the mini**, with real 5-hour and weekly usage.
5. **Needs you,** the calm gesture. Last in the queue, and the first thing to
   cut if time runs out.

### Not in v1

- Cubase page (v1.1).
- Work page (v1.1). Its `tier` field is cheap, so it lands in telemetry now.
- Audio spectrograph (v1.2).
- Drawn sprite art. v1 draws the capybara from LVGL shapes, like the 3D
  placeholder. Sprites can replace it later without touching the data path.
- Approving, denying or answering anything from the board. Never.

---

## Architecture

```
ESP32 ──HTTP poll 3 s──▶ bridge :8790 ──▶ telemetry 127.0.0.1:8787
  │                        │
  └──WebSocket (voice)────▶├──▶ whisper 127.0.0.1:8791
                           ├──▶ ollama 127.0.0.1:11434
                           └──▶ claude -p (no tools)
```

**Ollama stays loopback-only.** The board never talks to a model. It talks to
the bridge, which already requires the secret key, the bearer token and the MAC
allowlist, and the bridge is the only Ollama client. This is how only the
ESP32 gets to the model: no new port, nothing in Ollama's config changes.

### Why the board polls instead of using the WebSocket

xiaozhi opens its WebSocket only for a voice session, and the bridge closes it
after 45 s idle. The avatar has to stay live all day, so the fork adds one
small HTTP task: `GET /panel/state?key=…` every 3 s. It survives Wi-Fi drops
and bridge restarts with no reconnect logic, and it leaves the audio path
exactly as stock.

### The panel snapshot

The bridge reads `/state`, cuts it down, and serves about 1 KB:

- `state`, `fresh`, `celebrate`, `drooping`
- `nourishment`, `energy`, `health` (0–100, or null when unknown)
- `energy_week`, `energy_source` (`real` or `estimate`), `resets_at`
- `status_line` (built on the Mac, so the board never phrases anything)
- `attention`: project name and kind of wait only, never prompt text
- `mode` (Dictate or Ask), `ts`

**Staleness, on the device too.** If no snapshot arrives for
`stale_after_seconds`, the creature goes grey with a "?". No data never
renders as good news.

### The command router

- **Dictate** stays the default, with no LLM in the path. Dictation must not
  get slower or be misrouted.
- **"Claude, …"** goes to Claude, as today.
- **"Agent, …"**, or anything after the wake word, goes to the router.
- qwen gets the utterance and returns JSON against a fixed schema, using
  Ollama `format` with thinking off. It picks one intent from a closed list:

| Intent | Example | Answered by |
|---|---|---|
| `usage` | "how much is left?" | template + telemetry |
| `resets` | "when does it reset?" | template + telemetry |
| `waiting` | "who needs me?" | template + attention |
| `active` | "what's live?" | template + workstreams |
| `device` | "dim the screen", "go to sleep" | board action |
| `mode` | "switch to ask mode" | bridge setting |
| `time` | "what time is it?" | template |
| `forward` | anything else | Claude |

- **The model chooses; it never states facts.** Every number in a local answer
  comes from telemetry through a template, so a 4B model cannot invent your
  usage.
- **No shell, no tools, no free-form actions.** An intent outside the list
  becomes `forward`. The EXITS SACRED rule holds: nothing spoken reaches a
  live-money path.
- **Fallbacks:** if Ollama errors or is slower than 2.5 s, the regex router
  decides, and anything else is forwarded to Claude. The board says
  "thinking locally…" while it waits.
- Embeddings are not used in v1. Do not load the 0.6b model.

### The Home screen

- **Arcs:** the energy arc on the right (with a thin weekly ring inside it),
  nourishment on the left, health along the bottom. Soft colours, no red,
  nothing that counts down to zero in a scary way. Unknown is a grey arc,
  never an empty one.
- **Status line:** one calm sentence, such as "3 things moving" or
  "trident-forge is waiting for you".
- **Needs you:** the creature looks up and its ears perk, at most once a
  minute. Additive, like `drooping`: a sleeping creature stays asleep and only
  the status line changes.
- **Voice overlay:** listening ring, a Dictate, Ask or Agent chip, the
  transcript, then the reply. Voice never changes the pose.
- **Tap the energy arc:** usage detail (5-hour, weekly, source, age).
  **Tap the nourishment arc:** recent wins.
- **AMOLED care:** black background, pixel shift of a few px every few
  minutes, dims after 2 min idle, screen off when the creature sleeps. Touch
  or voice wakes it.

### The Device page

Wi-Fi name and signal, IP, bridge link (age of the last snapshot), firmware
build, free heap and PSRAM, battery. Settings: brightness, default voice mode,
dim timeout. The wake word is shown read-only in v1.

---

## Milestones and effort

Effort is my working time. Desk time is Thomas's, listed separately below.

| # | Work | Effort |
|---|---|---|
| M0 | Measure, set up | 0.5 d |
| M1 | Telemetry on the mini | 1–1.5 d |
| M2 | Bridge: panel snapshot | 0.5–1 d |
| M3 | Bridge: router | 1–1.5 d |
| M4 | Firmware fork: pages | 3–5 d |
| M5 | Needs you (cuttable) | 1 d |
| M6 | Soak and fixes | 1 d |
| | **Total** | **8–11 d** |

About two calendar weeks with gaps for desk sessions.

**M0. Measure before building.** Get qwen latency (cold and warm) and memory
with Whisper loaded and the usual Claude sessions open. Check that ESP-IDF
v6.1 still builds `device/build.sh`. Find out whether the custom font and
image assets fit the assets partition next to a MultiNet model.

**M1. Telemetry.** A launchd agent for `avatar_telemetry`. Real usage:
harvest `rate_limit_event` from each Ask, plus the probe from §6 (at most
every 15 min, only while work is moving). Add `energy_detail.weekly`, the
estimate fallback with its label, workstream `tier`, and sleep when either
window is spent. New tests only; the existing 64 are left alone.

**M2. Snapshot.** `GET /panel/state` and `POST /panel/settings` on the bridge,
behind the same key and allowlist, with tests through `fake_device.py`.

**M3. Router.** The Ollama client, schema, templates and fallbacks. An eval
set of about 40 spoken phrasings (new file) with a pass bar agreed before I
tune the prompt. qwen3.5:4b first; a smaller model only if M0 says memory or
latency is bad.

**M4. Firmware.** A new `AvatarDisplay` in the xiaozhi fork, kept as patches
in `device/patches/` like the existing one. LVGL tileview with Home and
Device (the other pages hidden until they exist), the drawn capybara and its
poses, the arcs, the poll task, staleness, burn-in care and NVS settings. It
hooks the stock display callbacks (status, chat text, emotion) to drive the
overlay, so the audio code stays untouched. This is the largest and least
certain piece.

**M5. Needs you.** `POST /attention` on telemetry (loopback), with expiry,
and the Claude Code `Notification` and clear hooks in `~/.claude/settings.json`.
Then check whether hooks fire for desktop-app and Cowork sessions.

**M6. Soak.** A day of normal use. Count false wakes, router misses, stale
flashes and memory pressure, then fix.

---

## What I need from Thomas at the desk

About an hour in total over three short sessions. I will tell you when each
one is ready; nothing happens until you say go.

**Session 1: first flash over USB (about 20 min, after M4)**
- Hold **BOOT** while plugging in the USB cable (download mode; auto-reset
  does not work on this board).
- I take a fresh full-flash backup of the current v2.5.0 state first.
- I flash the assets partition (fonts, and the "Hey Agent" model if you want
  it now) and the new app.
- You check: the creature appears, the arcs move, a swipe reaches Device, and
  BOOT still starts voice.

**Session 2: voice check (about 15 min, after M3 and M4)**
- Say about 10 phrases I give you, in Dictate, Ask and Agent forms.
- Cover the board or pull the bridge, to confirm it goes grey with a "?".

**Session 3: wake word (optional, about 10 min plus a day)**
- Only if you confirm the phrase "Hey Agent". It needs another USB assets
  flash, with BOOT held again.
- Leave it running for a day while I count false wakes in the bridge log.

**Between sessions:** app updates go over the air from the bridge. You do
nothing except maybe look at the screen. If an update ever boot-loops, I need
Session 1 again (BOOT plus USB) to restore the backup.

**Once, at the keyboard:** approve the hooks change to `~/.claude/settings.json`
for M5.

---

## Risks

**1. Memory pressure on the mini (high).** It already swaps. A loaded
qwen 4B is about 4 GB plus context, Whisper turbo about 1 GB, and two or more
Claude sessions plus Chrome are resident.
- Load only qwen, never the embedding model. Set `OLLAMA_MAX_LOADED_MODELS=1`,
  `num_ctx` 2048 and `keep_alive` of about 10 min, so it unloads when quiet.
- The cost is a cold start of a few seconds on the first "Agent" after a
  pause. The 2.5 s fallback covers that, and M0 measures it.
- If M0 shows real pressure, fall back to a smaller qwen for routing; the
  task is classification, not chat.
- **Before Cubase (v1.1):** unload the model while Cubase is open, or audio
  will drop out under swap.

**2. The firmware fork (medium-high).** xiaozhi's display layer is not
designed to be replaced, and v2.5.0 may fight a custom UI. Mitigation: keep
the fork as patches, stay on the stock audio path, and test a minimal "arcs
only" screen first. A boot loop needs USB recovery (BOOT held).

**3. Real usage numbers (medium).** `rate_limit_event` was seen once and is
not documented. If it changes, Energy falls back to the labelled estimate.
The probe spends a sliver of the budget it measures.

**4. Router quality (medium).** A 4B model may misread short commands.
Closed intents, `forward` as the default, and the eval set limit the damage:
the worst case is that Claude answers something the Mac could have.

**5. Needs-you coverage (medium).** Hooks may not fire for desktop-app or
Cowork sessions. If not, those sessions show nothing rather than something
wrong.

**6. Wake word (medium).** "Hey Agent" on MultiNet is untested on this
board. Fallback: "Computer". BOOT always works.

**7. Burn-in (low, slow).** Handled by dimming, pixel shift and screen off.

**8. LAN token (known).** Plain HTTP on the LAN, as today. The new endpoints
expose project names and usage, so they sit behind the same key. Never prompt
text.

---

## Decisions for Thomas

1. **Smallest shippable version.** I propose shipping in two drops:
   - **v0.9:** telemetry plus Home plus Device, with voice exactly as it is now.
   - **v1.0:** add the router and needs you.

   v0.9 puts the creature on the desk about four days sooner, and the router
   is the piece most likely to need tuning. Or do you want one drop?
2. **Health on Home:** a bottom arc, as proposed above, or only the droop
   pose?
3. **Wake word:** "Hey Agent" in Session 1, or after v1 settles?
4. **Command word:** is "Agent, …" right for local commands, given the wake
   word is "Hey Agent"? The alternative is that everything after the wake
   word goes to the router.
5. **Needs you:** keep it in v1, or move it to v1.1 with Cubase?
