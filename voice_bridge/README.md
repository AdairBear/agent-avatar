# Voice bridge

The Mac side of the ESP32 voice panel. A Waveshare ESP32-S3-Touch-AMOLED-2.16
running stock [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) firmware
talks to this process instead of the xiaozhi cloud.

```
board mic ──Opus over WebSocket──▶ voice bridge ──▶ whisper.cpp (loopback)
                                        │
                     plain speech       ├──▶ paste into the focused app
                     "Claude, ..."      └──▶ Claude Code CLI ──▶ text on screen + speech
```

- **Dictate** (default): tap the BOOT button, speak, pause. The text is pasted
  wherever the cursor is.
- **Ask**: start the utterance with "Claude, ...". The reply is shown on the
  board's screen and spoken through its speaker.
- Tap BOOT again to stop listening. The bridge also closes a session after 45
  seconds without speech.

Audio never leaves the LAN. Transcription is local. Only the text of an "ask"
goes to Claude.

Background and the wider plan: [`docs/proposals/esp32-voice-panel.md`](../docs/proposals/esp32-voice-panel.md).

## Run it

```bash
brew install uv opus whisper-cpp esptool
cd voice_bridge
uv venv --python 3.12 && uv pip install -e .

.venv/bin/python -m voice_bridge selftest        # Whisper, codec, permissions, Claude CLI
.venv/bin/python -m voice_bridge install-agent   # run at login (launchd)
.venv/bin/python -m voice_bridge status
tail -f ~/Library/Logs/voice-bridge.log
```

Each session ends with a log line giving the audio frames received and their
levels against the speech threshold, which is the first place to look when
speech is not picked up.

The Whisper model is expected at
`~/Library/Application Support/voice-bridge/models/ggml-large-v3-turbo-q5_0.bin`
(from `huggingface.co/ggerganov/whisper.cpp`).

Two things need a person, once:

1. **Accessibility permission** for the Python binary that runs the bridge
   (System Settings → Privacy & Security → Accessibility). Without it,
   dictation shows an error on the board instead of pasting. The binary's path
   is in the first lines of the log.
2. **Claude Code login** for answer mode: run `claude` in a terminal and `/login`.

## The device

```bash
tools/flash_device.sh backup                    # full 16 MB flash to ~/Backups, verified
tools/flash_device.sh flash merged-binary.bin   # stock xiaozhi + settings that point here
```

Put the board in download mode first: hold BOOT while plugging in USB.

The first flash used the prebuilt `v2.5.0_waveshare-esp32-s3-touch-amoled-2.16.zip`
from the xiaozhi-esp32 releases, plus one NVS key (`wifi/ota_url`) that tells
the firmware where to check in. After flashing, the board opens a Wi-Fi
hotspot for joining it to the network.

### Firmware over the air

The board checks in with the bridge on every boot. Set `firmware_path` to an
app image (`xiaozhi.bin`, not the merged image) and restart the bridge: a
board running any other build downloads it, installs it and reboots. Wi-Fi
and bridge settings are kept. The offer stops once the board reports that
build, and after three failed attempts.

[`device/build.sh`](../device/build.sh) builds our image: v2.5.0 in English,
with the wake word "Jarvis" and the patches in `device/patches/`. An over the
air update replaces the app only. The wake-word model lives in the assets
partition, which goes on over USB:

```bash
tools/flash_device.sh assets generated_assets.bin
```

`tools/fake_device.py "some phrase"` plays the device's part against the
running bridge, for testing without hardware.

## Security

- **One LAN listener**, port 8790. Everything except the three xiaozhi paths is a 404.
- The check-in and firmware URLs carry a secret key. The WebSocket needs a bearer token.
  A device allowlist (by MAC) is on top of both.
- Secrets live in `~/Library/Application Support/voice-bridge/config.json`
  (mode 0600), outside the repo.
- Traffic is plain HTTP and WebSocket on the LAN, because the stock firmware
  has no way to trust a private certificate. Anyone who can sniff the LAN can
  read the token. Rotate it by deleting `ota_key` and `ws_token` from the
  config and re-flashing the NVS settings.
- A holder of the token can make this Mac paste text into the focused app.
  That is the feature, and the reason the token matters.
- whisper.cpp binds loopback only. The Agentic Avatar telemetry backend is
  untouched and stays loopback-only.
- Claude is called with no tools and no MCP servers, so a spoken request can
  only produce text. Nothing spoken can run a command.
- Transcripts are not logged unless `log_transcripts` is set.

## Configuration

All fields are in `voice_bridge/config.py` with their defaults. The ones worth knowing:

| Field | Default | What it does |
|---|---|---|
| `default_mode` | `dictate` | `ask` sends every utterance to Claude |
| `silence_ms` | `1000` | pause that ends an utterance |
| `min_rms` | `120` | quietest level that can count as speech |
| `noise_ratio` | `3.0` | speech must be this many times louder than the room |
| `idle_close_s` | `45` | hang up after this long without speech |
| `tts` | `true` | speak replies; `false` shows text only |
| `claude_model` | `sonnet` | model alias passed to the CLI |
| `public_host` | detected | the address the board uses to reach this Mac |
| `allowed_device_ids` | `[]` | MAC allowlist; empty means any device with the secrets |
| `firmware_path` | empty | app image to install over the air; empty means never |
| `keep_session_audio` | `false` | diagnostic: keep the last session's mic audio as a WAV |

`public_host` is baked into the device's settings. If this Mac's address
changes, the board cannot find the bridge. Give the Mac a DHCP reservation.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```

33 tests: Opus round trip, end-pointing, routing, auth on every endpoint, the
firmware offer, and
the full protocol against a fake device with fake Whisper, paste and Claude.

## Known limits

- Tap-to-talk, not hold-to-talk. The stock firmware's button toggles a
  session. True push-to-talk needs a firmware fork.
- The wake word is "Jarvis" in our build (the stock image's is Chinese). There
  is no "Claude" model.
- Stock firmware powers the board off after five idle minutes, even on USB
  power. Our build fixes that; on stock, press the power button to wake it.
- End-pointing is a level threshold above the measured room noise. A long
  thinking pause ends the utterance.
- Replies use the macOS `say` voice.
- Each ask is a fresh Claude call with the last few turns pasted in as context.
