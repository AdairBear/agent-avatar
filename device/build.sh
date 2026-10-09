#!/bin/sh
# Build the voice panel's firmware: xiaozhi-esp32 v2.5.0 for the Waveshare
# ESP32-S3-Touch-AMOLED-2.16, in English, with our patches.
#
#   device/build.sh             build into $ESP_DIR/xiaozhi-esp32/build
#   device/build.sh stage       also copy the app image to where the bridge serves it from
#
# Needs: brew install cmake ninja dfu-util, and ESP-IDF v6.1 in $ESP_DIR/esp-idf
# (git clone -b v6.1 --recursive, then ./install.sh esp32s3).
set -eu

ESP_DIR="${ESP_DIR:-$HOME/esp}"
SRC="$ESP_DIR/xiaozhi-esp32"
TAG=v2.5.0
BOARD=waveshare/esp32-s3-touch-amoled-2.16
LANGUAGE="${LANGUAGE:-en-US}"
# Any model from `scripts/build.py --list-wake-words`. This one answers to "Jarvis".
WAKE_WORD="${WAKE_WORD:-wn9_jarvis_tts}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$HOME/Library/Application Support/voice-bridge/firmware/$TAG-$LANGUAGE"

[ -d "$SRC" ] || git clone --depth 1 -b "$TAG" https://github.com/78/xiaozhi-esp32.git "$SRC"
cd "$SRC"
for patch in "$HERE"/patches/*.patch; do
    # Skip a patch that is already applied.
    git apply --reverse --check "$patch" 2>/dev/null || git apply "$patch"
done

. "$ESP_DIR/esp-idf/export.sh" >/dev/null
python scripts/build.py "$BOARD" --language "$LANGUAGE" --wake-word "$WAKE_WORD"

if [ "${1:-}" = stage ]; then
    mkdir -p "$STAGE"
    cp build/xiaozhi.bin build/generated_assets.bin "$STAGE/"
    echo "staged in $STAGE; set firmware_path to its xiaozhi.bin and restart the bridge"
fi
