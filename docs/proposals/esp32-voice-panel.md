# Proposal: ESP32 touch screen as voice input and physical face for Agentic Avatar

> **Status:** Phases 1 and 2 are built in `voice_bridge/` and `device/`. Section 6 records
> the decisions for what comes next. Written 2026-10-09.
> **Device:** Waveshare ESP32-S3-Touch-AMOLED-2.16 on `/dev/cu.usbmodem114201`.
> **Primary goal:** speak to Claude for work instead of typing.
> **Secondary goal:** a Claude task panel that is the same creature as Agentic Avatar.

## Recommendation in brief

1. Use the board as a **Wi-Fi microphone with a push-to-talk button**, running the
   open-source **xiaozhi-esp32** firmware, which already supports this exact board.
2. Point it at a **small voice bridge on the Mac** instead of the xiaozhi cloud.
   The bridge runs Whisper locally and either pastes the text into the focused
   app (dictation) or sends it to Claude and returns the reply (assistant).
   Options (a) and (c) below are the same firmware with two server modes.
3. The same bridge forwards a reduced Agentic Avatar snapshot to the screen, so
   the board becomes a fourth renderer of the existing telemetry contract. The
   telemetry backend stays loopback-only.
4. Start speaking today with Claude Code's built-in `/voice`, before any hardware
   work. This Mac mini has no built-in microphone, so that needs a mic plugged
   into the PreSonus Studio 1824c interface, or some other input.

One decision is needed before Phase 1: whether the board should instead present
itself as a **USB microphone plus a keyboard button** (option b2 below). It is the
simplest thing that could work and it needs no server, but it gives up the path
to spoken replies and the status panel.

---

## 1. Agentic Avatar: what it is and where the screen fits

### What it is

A companion creature that makes agentic work legible through three gauges:

| Gauge | Meaning | Source |
|---|---|---|
| Nourishment | completed work, never tokens spent | commits with a SHA, completed tasks |
| Energy | remaining usage budget in a rolling 5-hour window | token counts in session logs |
| Health | how many workstreams are concurrently alive | human prompts and completions per project |

### Architecture

- **`telemetry/avatar_telemetry/`** (Python, standard library only) tails
  `~/.claude/projects/*/*.jsonl`, computes the gauges and the state ladder
  (`unknown > sleep > drowsy > celebrate > working > idle`), and publishes
  `agentic-avatar.telemetry/1` JSON on `http://127.0.0.1:8787/state` and in
  `~/.agentic-avatar/state.json`.
- **`src/core/`** (pure TypeScript) is a thin client: it polls, enforces
  freshness, and resolves four signals into five poses.
- **`src/main/` and `src/renderer/`** are an Electron menu-bar app with a stats
  popover and a click-through desktop pet. One `AvatarRenderer` interface has
  three implementations: Rive, three.js and a 2D canvas fallback.
- The backend owns all gauge maths. Renderers draw what they are told.
- Two rules run through the whole codebase: **no data never renders as good
  news** (`fresh: false` forces `unknown`), and **nothing leaves the machine**
  (loopback only, no keys).

### Status

- Four commits, default branch `track2/scaffold-menubar-two-gauge`, Phase 1.
- Telemetry is real and has 64 tests. The 3D layer is real. The art is a
  placeholder capybara built from primitives; no `avatar.riv` or `avatar.glb`
  exists yet.
- Not built: nourishment persistence across restarts, packaging, a login item,
  the Conductor extractor, the per-workstream droop in 3D.
- It was developed on a 2019 Intel iMac. **On this Mac mini it is not running:**
  nothing answers on port 8787, `~/.agentic-avatar/` does not exist and Node is
  not installed. Python 3.9.6 is present, which is enough for the backend.

### How the screen fits

The board is a natural fourth renderer. The contract it needs is already
written down: `nourishment`, `energy`, `isWorking`, `celebrate` pulses, `state`
and `fresh`, plus `workstreams[]` and `recentCompletions[]` for the panel.

| Screen page | Data it shows | Already in the payload |
|---|---|---|
| Face | creature in one of the five poses, two gauge arcs around the edge | yes |
| Workstreams | one row per project, live or quiet, age | yes (`workstreams[]`) |
| Recent wins | last completions with labels | yes (`recentCompletions[]`) |
| Energy detail | used ratio and time until the window recovers | yes (`energyDetail.recoversAt`) |
| Needs you | a session is waiting for input or permission | **no, new signal** |

Design points that follow from the repo's own rules:

- **Keep telemetry loopback-only.** The board cannot reach `127.0.0.1`. Rather
  than open port 8787 to the LAN, the voice bridge (which must listen on the
  LAN anyway) reads `/state` locally and pushes a reduced snapshot down the
  WebSocket the device already holds open. One LAN-facing process, with a token.
- **Enforce staleness on the device too.** If no snapshot arrives within
  `stale_after_seconds`, the face goes grey with a `?`. This is a fourth layer
  of the existing invariant.
- **The device cannot run Rive or three.js.** It needs its own art: sprite
  sheets or Lottie clips named after the five poses in
  `src/core/model-contract.ts`. That is one more asset job on top of the missing
  `.riv` and `.glb`.
- **"Needs you" is the most useful panel feature and is not in telemetry
  today.** It can come from Claude Code hooks (Notification and Stop) posting to
  the bridge, or from a new extractor. The screen should notify only; approving
  a permission prompt by tapping a screen is a risk I would not take.
- **AMOLED burn-in.** An always-on panel needs a dark layout, dimming and
  slight pixel shifting.

### The wider ecosystem

- **the-conductor** holds `conductor.md`, the canonical projection of all
  projects, with the brain server as state authority. The avatar README already
  names Conductor as a future extractor. The panel should read Conductor
  through avatar telemetry, not directly, so there is one source.
- **open-brain** is the shared memory server. Its README is one line, so I do
  not know its API. A later voice use is spoken notes written to it as deltas.
- **concierge** is a skill router and has no bearing on this.
- Conductor's **EXITS SACRED** rule applies: no voice command may reach a
  Trident Forge live-money exit path. The bridge should only type text or talk
  to Claude; it should have no direct action hooks.

---

## 2. Board identification

**Waveshare ESP32-S3-Touch-AMOLED-2.16.** Wiki:
<https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16>

What the Mac sees: Espressif's stock "USB JTAG/serial debug unit" (vendor ID
`0x303A`, product ID `0x1001`), serial `02:00:00:00:00:AB` (the MAC address).
The other `usbmodem` port on this Mac is the Dirtywave M8, not the board.
esptool's automatic reset does not reach the bootloader on this board, so
flashing needs the hold-BOOT download mode.

### Hardware

| Part | Chip | Notes |
|---|---|---|
| MCU | ESP32-S3R8 | dual core 240 MHz, 8 MB PSRAM, 16 MB flash, Wi-Fi 2.4 GHz, BLE 5 |
| Display | CO5300, QSPI | 2.16" AMOLED, 480×480, brightness set by panel command |
| Touch | CST9220, I2C | xiaozhi drives it with the CST9217 driver |
| Mic ADC | ES7210 | dual microphones, with a hardware echo reference |
| Speaker DAC | ES8311 | amplifier enabled by GPIO46 |
| PMIC | AXP2101 | battery charging, MX1.25 connector for a 3.7 V cell |
| IMU | QMI8658 | 6-axis |
| RTC | PCF85063 | |
| Storage | microSD slot | confirmed present |

### Pinout

| Function | GPIO |
|---|---|
| Display QSPI data 0–3 | 4, 5, 6, 7 |
| Display clock / CS / reset | 38 / 12 / 39 |
| Shared I2C SCL / SDA (touch, PMIC, IMU, RTC, codecs) | 14 / 15 |
| Touch interrupt / reset | 11 / 40 |
| I2S MCLK / BCLK / LRCK | 42 / 9 / 45 |
| I2S to speaker (ES8311) | 8 |
| I2S from mics (ES7210) | 10 |
| Amplifier enable | 46 |
| SD card CMD / CLK / D0 / CS | 1 / 2 / 3 / 41 |
| User button (Key3) | 18 |
| BOOT button | 0 |
| IMU interrupts | 17, 21 |
| RTC interrupt | 13 |
| USB D− / D+ | 19 / 20 |

The audio, display and touch pins are confirmed twice: by the wiki and by the
xiaozhi board file. The SD pins come from the wiki only, and the wiki is
inconsistent about the bus (it says "SD SPI" but names the pins like 1-bit
SDMMC). Check the schematic before writing SD code.

### Factory firmware

Per the wiki, the board ships with an **ESP-Brookesia** phone-style demo:
Settings, drawing pad, calculator, spectrum analyser, gravity ball, an AVI
player that reads from the SD card, and an "AIChats" app that is XiaoZhi AI
connected to the xiaozhi cloud.

**Do not use the AIChats app for work speech.** It sends audio to a third-party
cloud service.

### Firmware stack options

| Stack | What you get | Verdict |
|---|---|---|
| **xiaozhi-esp32** (MIT, v2.5.0) | Board supported in tree. Wake word, device echo cancellation, Opus over WebSocket, LVGL chat UI, device-side MCP tools, documented server protocol | **Start here.** The whole audio path is done |
| Fork of xiaozhi | The same, plus custom screens for the avatar face and panel | **Target for Phase 3** |
| ESP-IDF 5.5 + Waveshare BSP + LVGL 9 + ESP-SR, from scratch | Full control | Only if the fork becomes a fight. Re-doing the audio pipeline is weeks of work |
| Waveshare demos | Five ESP-IDF examples (PMIC, LVGL 9, Brookesia, IMU, spectrum analyser). No recording, SD or wake-word example | Reference only |
| Arduino | Fast for UI experiments | Weak for wake word and echo cancellation |

Details that matter:

- Waveshare publishes a prebuilt xiaozhi image for this board (v2.4.0) in
  `waveshareteam/ESP32-AIChats`. Upstream has the board at
  `main/boards/waveshare/esp32-s3-touch-amoled-2.16/`.
- The upstream board file wires up the BOOT button, touch, PMIC and audio. It
  does **not** mount the SD card or use the Key3 user button. Both would be
  small additions in a fork.
- The xiaozhi protocol is simple: a JSON `hello` each way, then binary Opus
  frames (16 kHz mono, 60 ms) up and Opus down, with JSON text frames for
  speech-to-text results, reply text and MCP calls.
- ESP-SR on the device is right for the **wake word and audio clean-up only**.
  Transcription belongs on the Mac.

---

## 3. Voice-control options

### The options

**(a) Wi-Fi mic to a Mac server.** Board captures audio on button press or wake
word and streams it to a bridge on the Mac. The bridge runs Whisper and types
the text into the focused app or hands it to Claude.

**(b1) HID dictation button.** Board acts as a USB or BLE keyboard and sends
the hotkey for macOS dictation, Wispr Flow or Claude Code `/voice`. Audio comes
from whatever mic the Mac has. **This Mac mini has no built-in mic**, so the
button alone solves nothing unless you already have a mic.

**(b2) USB mic plus HID button.** Board presents itself as a USB audio
microphone and a keyboard on one cable. Every Mac dictation tool then works
with it unchanged. This rests on Espressif's USB audio device component, which
I have not tested on this board.

**(c) xiaozhi-style full assistant with Claude as the LLM.** Wake word, spoken
question, spoken answer. Either a self-hosted `xiaozhi-esp32-server` with Claude
behind an OpenAI-compatible proxy, or the bridge from (a) in assistant mode.

### Comparison

Latency figures are my estimates, not measurements.

| | (a) Wi-Fi mic + local Whisper | (b1) HID button | (b2) USB mic + HID | (c) Full assistant |
|---|---|---|---|---|
| Text appears after you stop speaking | about 1 s | under 1 s, tool dependent | under 1 s, tool dependent | n/a |
| First spoken reply | n/a | n/a | n/a | about 2–3 s |
| Where audio goes | stays on your LAN | the dictation tool's servers | the dictation tool's servers | LAN if self-hosted |
| Where text goes | Claude, as now | Claude, as now | Claude, as now | Claude API |
| Works with Dispatch, Cowork, any app | yes, by pasting | yes | yes | no, separate conversation |
| Firmware effort | flash stock xiaozhi | small custom firmware | medium custom firmware | flash stock xiaozhi |
| Mac-side effort | bridge, about 300 lines | none | none | bridge plus Claude and TTS, or a Docker stack |
| Replies on screen or speaker | yes, bridge can push both | no | no | yes, both |
| Status panel on same firmware | yes | separate work | separate work | yes |
| Needs Wi-Fi | yes | no | no | yes |

Notes on each:

- **(a)** needs macOS Accessibility permission for the bridge to paste. Whisper
  large-v3-turbo on the M6 through MLX or whisper.cpp transcribes far faster
  than real time. Nothing needed is installed yet (`esptool`, ESP-IDF, `ffmpeg`
  and Whisper are all absent).
- **(b1)** Wispr Flow is not installed on this Mac. Its push-to-talk key is
  rebindable, so a board button could drive it. Claude Code's `/voice` is also
  rebindable through `~/.claude/keybindings.json`. Both send audio to a cloud
  service (Wispr's, or Anthropic's for `/voice`).
- **(b2)** is the lowest-friction daily driver if it works, because nothing on
  the Mac changes. Combining USB audio with other USB functions may run into
  the ESP32-S3's endpoint limit.
- **(c)** through `xiaozhi-esp32-server` is a heavy stack whose defaults are
  Chinese cloud providers, and Claude is not a named provider. The bridge route
  is lighter and keeps one codebase.

### How replies come back

- **Dictation mode:** no reply path needed. The screen shows the transcript for
  a second as confirmation, which is useful when your eyes are elsewhere.
- **Assistant mode:** the reply streams to the screen as text, and optionally
  to the speaker. Text-to-speech can be macOS `say` (instant, robotic) or a
  local neural voice. The board's echo cancellation lets you interrupt.
- For work, I expect **text on screen plus a short earcon** to be better than
  full speech. Long code-heavy replies read aloud are slow.

### Recommendation

Build **(a)** and grow it into **(c)**: one firmware, one bridge, two modes.

- **Dictate** (default): hold the button, speak, release. Text is pasted
  wherever the cursor is, which covers Claude Code, Dispatch and Cowork.
- **Ask**: a second gesture or a spoken prefix sends the text to Claude through
  Claude Code headless mode and returns the reply to the screen.

Choose **(b2)** instead if you would rather have zero moving parts on the Mac
and are happy for the panel to be a separate project.

---

## 4. Other uses, ranked

| Rank | Use | Value | Effort | Notes |
|---|---|---|---|---|
| 1 | Voice input | high | medium | Section 3 |
| 2 | Claude task panel and avatar face | high | medium | Section 1. The "needs you" alert is the best part |
| 3 | SD card as offline voice buffer and asset store | medium | low | Record notes with no Wi-Fi and sync later. Hold sprite frames, fonts and earcons. Needs the SD bus confirmed |
| 4 | Energy window clock | medium | low | Countdown to `recoversAt`. Nearly free once the panel exists |
| 5 | Flip to mute | medium | low | IMU: face down means do not disturb, mic off, screen dark |
| 6 | Cubase touch controller | medium | medium | Transport, mute, solo and macro pads over BLE-MIDI or USB-MIDI, mapped with Cubase MIDI Remote. USB has less latency. Two-way feedback needs a MIDI Remote script |
| 7 | Serato now-playing | low | medium | Serato has no official API that I know of. It means reading its history files on the DJ machine, which is fragile |

Cubase and Serato are not installed on this Mac mini. Both ideas depend on
which machine runs them. BLE-MIDI pairs with any Mac. The Serato idea needs a
helper on the DJ machine.

A battery on the MX1.25 connector makes the voice button portable around the room.

---

## 5. Phased plan

**Phase 0: speak today, no hardware (minutes)**
- Turn on `/voice` in Claude Code, or dictate in the Dispatch input.
- Requires a microphone on the Mac mini.
- Purpose: build the habit and find out what you dictate versus type.

**Phase 1: board as a dictation mic (one evening)**
- Install `esptool`. Back up the full 16 MB factory flash first.
- Flash the prebuilt xiaozhi image for this board.
- Write the minimal bridge: xiaozhi `hello`, Opus decode, local Whisper, paste
  into the focused app. Token on the WebSocket.
- Done when: hold the button, speak, and the text lands in Claude Code.

**Phase 2: Claude answers (one or two days)**
- Add Ask mode: send to Claude Code headless, stream the reply text to the screen.
- Optional speech through the speaker.
- Done when: a spoken question gets an on-screen answer without touching the keyboard.

**Phase 3: the avatar's face (about a week, art dependent)**
- Get telemetry running on this Mac mini.
- Bridge forwards a reduced snapshot. Fork xiaozhi and add the face and panel
  pages, with on-device staleness.
- Add Claude Code hooks for the "needs you" alert.
- Done when: the screen shows the same state as the menu-bar app, and goes grey
  when the feed stops.

**Phase 4: hands-free and offline**
- Wake word. Mount the SD card for offline notes and assets. Flip to mute.
- Conductor extractor in `extract.py`, so the panel shows portfolio state.

**Phase 5: studio extras**
- MIDI controller page for Cubase. Serato only if it still appeals.

### Where the code should live

- `device/` in this repo for the firmware fork or its board overlay.
- `voice_bridge/` as its own Python package with its own virtual environment.
  It needs Whisper and Opus, so it must stay separate from `telemetry/`, which
  is deliberately standard-library only.
- No change to `telemetry/` until the Conductor extractor in Phase 4.

---

## 6. Decisions (2026-10-09)

Made by Thomas after Phases 1 and 2. Where a decision changes something
earlier in this document, this section wins.

### Where things stand

- The board runs xiaozhi v2.5.0 built in English, installed over the air by
  the bridge. The factory flash is backed up in `~/Backups/`.
- Dictation and Ask work through `voice_bridge/`. The speech threshold is
  measured from the room, not fixed.
- Still to do on the device: the wake word (below), and a firmware fork for
  the pages.

### Screen pages, in order

1. **Home: the Avatar, with voice built in.** The creature, with nourishment
   and energy as two arcs at the edge and one calm status line. Voice is an
   overlay here (listening ring, Dictate or Ask chip, transcript, reply), not a
   page. Voice never changes the telemetry pose: a sleeping creature stays
   asleep. Tapping the energy arc opens the usage detail; tapping the
   nourishment arc opens recent wins.
2. **Cubase.** A must. See below.
3. **Work.** The project list. See below.
4. **Audio.** Spectrograph and mic level.
5. **Device.** Wi-Fi, bridge link, brightness, default voice mode, wake word.

The BOOT button is voice on every page.

### Wake word: "Agent"

Thomas wants "Agent". What the firmware can do:

| Route | Feasible | Notes |
|---|---|---|
| WakeNet model for "Agent" | no | WakeNet models are trained per phrase and ship as a fixed list. There is no "Agent". A new one means Espressif's custom-training service. |
| MultiNet custom phrase, bare "Agent" | yes, not advised | xiaozhi's custom wake word mode runs the English MultiNet model (`mn7_en` or `mn6_en`) against a phrase given as text. One common two-syllable word will fire on ordinary speech, and in this house "agent" is said all day. In dictation mode a false wake pastes into the focused app. |
| MultiNet custom phrase, "Hey Agent" | yes, **proposed** | Same mechanism, three syllables with a lead-in, so far fewer accidental wakes. Needs `CONFIG_USE_CUSTOM_WAKE_WORD`, an English MultiNet model, and an assets flash over USB (the model lives in the assets partition). Untested on this board. |
| WakeNet "Computer" or "Jarvis" | yes, fallback | Trained wake models, the most robust option. "Jarvis" is what the current build is configured for. |

Plan: build "Hey Agent", flash the assets, and count false wakes from the
bridge log for a day. If it misfires, lower the sensitivity
(`CONFIG_CUSTOM_WAKE_WORD_THRESHOLD`), and if that is not enough fall back to
"Computer". Nothing is flashed until Thomas confirms the phrase.

### Needs-attention: yes

A session waiting on Thomas shows on the creature. Rules:

- **Notify only.** The board never approves, denies or answers anything.
- **A calm gesture, per the art brief.** The creature looks up and perks its
  ears, at most about once a minute, and the status line names the project:
  "trident-forge is waiting for you". No red, no badge, no count, no sound by
  default.
- **Additive, like `drooping`.** It is not a state on the ladder. A sleeping or
  `unknown` creature does not get up; only the status line changes.
- **Only the project and the kind of wait leave the Mac.** Never the prompt
  text or the command.

Source: Claude Code hooks, as HTTP hooks posting to loopback.

| Hook | Use |
|---|---|
| `Notification` matching `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input` | raise attention for that `session_id` and `cwd` |
| `UserPromptSubmit`, `PostToolUse`, `SessionEnd` | clear it for that session |

- It belongs in the telemetry backend, not the bridge, so the menu-bar app
  gets it too and there is still one source of state: a loopback-only
  `POST /attention` and an additive `attention[]` in the
  `agentic-avatar.telemetry/1` payload. The bridge forwards it with the rest.
- Entries expire on their own (proposed: two hours), because a missed clear
  must not leave the creature asking forever.
- **To verify:** that these hooks fire for sessions run from the Claude desktop
  app (Dispatch) and from Cowork. Hooks do run in desktop Code sessions, but
  whether a permission prompt handled by the app raises `Notification` is not
  confirmed, and Cowork sessions may not load `~/.claude` hooks at all. If
  they do not, those sessions need another source or are out of scope.

### Energy: Thomas's actual usage

Energy must match Claude's own meter, for both the 5-hour window and the
weekly limit. Today it is an estimate: tokens summed from the logs against a
budget of 45M that was calibrated by hand.

| Source | Gives | Verdict |
|---|---|---|
| Claude Code status line input, `rate_limits.five_hour` and `.seven_day` (`used_percentage`, `resets_at`) | the real numbers | Documented. Only reaches a status line script in an interactive terminal session, on Pro and Max, after the first response. Thomas mostly works in the desktop app, so this alone would often be silent. |
| `rate_limit_event` in `claude -p --output-format stream-json` | the same two windows as `utilization` and `resetsAt` | **Proposed primary.** Observed on this Mac on 2026-10-09 (5-hour 18%, weekly 9%). The bridge already runs this command for Ask. Not yet checked against the SDK documentation. |
| API response headers | the same | Only visible to the process making the call. Not reachable. |
| The endpoint behind `/usage` | the same | Undocumented and needs his OAuth token. Not used. |
| `~/.claude` session logs | token counts, no limits | What the estimate uses today. |
| Scraping claude.ai | | Ruled out. |

Design:

- Each Ask harvests a reading for free. Between Asks, a small probe (one
  short Haiku call) refreshes it while work is happening, at most every 15
  minutes, and not at all when nothing is moving. Each probe spends a sliver
  of the budget it measures.
- Energy becomes `100 − five_hour used`. The weekly window is a second
  reading in `energy_detail`, shown on the usage detail view.
- The token sum stays, as the estimate between readings. Each real reading
  recalibrates the budget (`tokens in window ÷ utilization`), which replaces
  the hand-set 45M.
- The payload says which it is showing and how old the last real reading is.
  With no real reading at all, energy is the estimate and labelled as one.
- The creature sleeps when either window is spent. A spent weekly window is a
  long sleep, and the status line says until when.
- A status line script can be added later as a second feed for terminal
  sessions. It costs nothing when it runs.

### Work page: 48 hours and 7 days

| Last meaningful signal | Shown as |
|---|---|
| within 6 hours | live (counts toward Health) |
| within 48 hours | active |
| 48 hours to 7 days | stale, dimmed |
| older than 7 days | hidden |

- "Meaningful" keeps its meaning: a human prompt or a completion, not tool
  chatter.
- **Health does not change.** It stays "how many projects are live in the last
  6 hours, against a target of 3". Health asks whether several things are
  moving today. The Work page answers what has been touched this week. If
  Health used the 48-hour window it would sit near 100 and say nothing.
- `drooping` stays tied to the 6-hour window.
- The 7-day cut-off is already the scanner's lookback
  (`AVATAR_LOOKBACK_DAYS`), so older projects are not in the payload at all.
- Change needed: the backend adds a `tier` to each workstream
  (`live`, `active`, `stale`), from a new `AVATAR_ACTIVE_WINDOW_HOURS`
  (default 48), so no renderer works the tiers out for itself.

### Cubase page

Right after Home. Planning only.

- **Top:** position (bars and beats, timecode as an alternate), tempo and time
  signature.
- **Middle:** return to start, stop, play, record, cycle.
- **Below:** previous marker, next marker, add marker, click.
- **Bottom:** selected track name with record-arm, mute and solo.
- **Swipe down:** the patch cheat-sheet, loaded from the bridge or the SD card.

| Route | How | When |
|---|---|---|
| Mackie Control over the bridge | the bridge opens a virtual MIDI port; the board sends presses over its websocket | Cubase on this Mac. Two-way with no Cubase script: transport state, track names, position, arm, mute, solo. |
| BLE-MIDI from the board | the board pairs with any Mac as a Bluetooth MIDI device | Cubase on another machine. More firmware work; Bluetooth shares the radio with Wi-Fi. |
| Cubase MIDI Remote script | a custom script in place of Mackie | Only for what Mackie lacks. |

Mackie Control carries neither tempo nor marker names. Tempo can come from
MIDI clock. Marker names would need a MIDI Remote script. Neither is verified
against Cubase.

Open: which machine runs Cubase, what the cheat-sheet holds, and whether the
board's mic should mute while Cubase records.

---

## Open questions

Answered in section 6: the route (Wi-Fi bridge), the LAN listener (approved),
spoken replies (yes), the microphone (the board is the dedicated mic).

Still open:

1. Which machine runs Cubase and Serato?
2. What does the Cubase patch cheat-sheet hold?
3. Do Claude Code hooks fire for desktop-app and Cowork sessions?
4. Should needs-attention have an optional sound?

## Sources

- Waveshare wiki: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16>
- Factory firmware: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16/Instructions-For-Use>
- ESP-IDF examples: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16/ESP-IDF>
- AI tutorials index: <https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-2.16/ESP32-AI-Tutorials>
- Waveshare examples repo: <https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-2.16>
- Waveshare xiaozhi builds: <https://github.com/waveshareteam/ESP32-AIChats>
- Waveshare BSP component: <https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_2_16>
- xiaozhi-esp32: <https://github.com/78/xiaozhi-esp32> (board folder
  `main/boards/waveshare/esp32-s3-touch-amoled-2.16/`, protocol in `docs/websocket.md`)
- xiaozhi-esp32-server: <https://github.com/xinnan-tech/xiaozhi-esp32-server>
- Claude Code voice dictation: <https://code.claude.com/docs/en/voice-dictation>
- Wispr Flow shortcuts: <https://docs.wisprflow.ai/articles/2612050838-supported-unsupported-keyboard-hotkey-shortcuts>
