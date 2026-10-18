# Panel firmware: where everything lives

Recorded 2026-10-17 during the data-safety rescue.

## Source
- Upstream: `78/xiaozhi-esp32` tag `v2.5.0` (`ac6deed`).
- Our patches, in order (also committed in the fork):
  - `patches/0001-keep-usb-powered-board-on.patch` = fork commit `a459ba8`
  - `patches/0002-louder-mic-aec.patch` = fork commit `62d9dac` (ES7210 preamp 37.5 dB, AFE gain + AGC, device-side AEC)
- `build.sh` applies both onto a clean v2.5.0 checkout; result is byte-identical to the fork branch `feature/panel-mic-gain`.

## Backups
- GitHub release `firmware-rescue-2026-10-17` on this repo (private):
  - `esp32-amoled-factory-2026-10-09.bin` — full 16 MB factory flash dump, SHA-256 `f71b850e589599a68cf2231a251b08c8e360a4754b2e849fb5ca4a70d113b4e8`
  - `xiaozhi-esp32-panel.bundle` — git bundle of the fork (`v2.5.0`, `feature/panel-mic-gain`, `panel/build-config-snapshot`). Restore: `git clone -b feature/panel-mic-gain xiaozhi-esp32-panel.bundle xiaozhi-esp32`
  - `sdkconfig.amoled-2.16` — the exact sdkconfig used for the panel builds
  - `SHA256SUMS`
- Offline copies stay on `/Volumes/Archive/_Imports/Mini-offload-2026-10-17/home/` (`esp/`, `.espressif/`, `Backups/`). Do not edit them.
- Private repo `AdairBear/xiaozhi-esp32-panel` exists but the branches could not be pushed yet: the gh token lacks the `workflow` scope (upstream ships `.github/workflows`). Fix with `gh auth refresh -s workflow`, then
  `git -C ~/Developer/_rescue/xiaozhi-esp32 push panel feature/panel-mic-gain panel/build-config-snapshot v2.5.0`.

## Toolchain (offloaded)
ESP-IDF v6.1 and `~/.espressif` live on the Archive drive (`/Volumes/Archive/_Imports/Mini-offload-2026-10-17/home/`). Nothing was moved; the mini only has symlinks:

- `~/.espressif` → Archive `.espressif`; `~/esp/esp-idf` → Archive `esp/esp-idf`; `~/Backups` → Archive `Backups`
- `~/esp/xiaozhi-esp32` → `~/Developer/_rescue/xiaozhi-esp32` (a verified copy of the fork, so builds never write to the Archive)
- `~/esp/idf-tools/` = an `IDF_TOOLS_PATH` whose `tools`, `python_env`, `dist` link to the Archive, with its own writable `idf-env.json`
- `~/esp/bin/git` = wrapper that drops `--dirty` from `git describe` for repos on the Archive (otherwise CMake stalls re-hashing ESP-IDF)

Build (Archive mounted; the sandbox profile guarantees nothing is written to it):

```sh
. ~/esp/env.sh
sandbox-exec -f ~/Developer/_rescue/no-archive-writes.sb sh device/build.sh
```

Verified 2026-10-17: exit 0, `xiaozhi.bin` 2,884,256 bytes (same size as the staged `v2.5.0-en-US-micgain` image), `CONFIG_USE_DEVICE_AEC`, `CONFIG_AFE_OUTPUT_GAIN_PERCENT=200`, `CONFIG_USE_AFE_AGC` set; zero files changed on the Archive. Homebrew's default `python3` is now 3.15, so `env.sh` pins the 3.14 IDF venv.

## Flashing
`flash_device.sh` defaults to `/dev/cu.usbmodem114201`; on 2026-10-17 only `/dev/cu.usbmodem2144201` was present (board or M8 — confirm before flashing).

Copies of the env file, git wrapper, sandbox profile and idf-env.json are in `device/archive-toolchain/`.
