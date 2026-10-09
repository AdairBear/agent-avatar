#!/bin/sh
# Back up the board's flash, then flash stock xiaozhi firmware pointed at this bridge.
#
#   tools/flash_device.sh backup            read the whole 16 MB flash to ~/Backups and verify it
#   tools/flash_device.sh flash FIRMWARE    write a xiaozhi merged-binary.bin plus our NVS settings
#   tools/flash_device.sh restore BACKUP    put a backup back
#
# The board must be in download mode: hold BOOT while plugging in USB, then release.
# PORT defaults to the Waveshare board on this Mac. The other usbmodem port is
# the Dirtywave M8; never point this script at it.
set -eu

PORT="${PORT:-/dev/cu.usbmodem114201}"
BAUD="${BAUD:-921600}"
FLASH_SIZE=0x1000000
NVS_OFFSET=0x9000
NVS_SIZE=0x4000
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ESPTOOL="esptool --chip esp32s3 --port $PORT --baud $BAUD --before no-reset"

case "${1:-}" in
backup)
    mkdir -p "$HOME/Backups"
    out="$HOME/Backups/esp32-amoled-factory-$(date +%Y-%m-%d).bin"
    [ -e "$out" ] && { echo "refusing to overwrite $out" >&2; exit 1; }
    $ESPTOOL --after no-reset read-flash 0 $FLASH_SIZE "$out"
    # Verify: the chip hashes its own flash and esptool compares it with the file.
    $ESPTOOL --after no-reset verify-flash 0 "$out"
    shasum -a 256 "$out" | tee "$out.sha256"
    chmod 444 "$out"
    echo "backup verified: $out"
    ;;
flash)
    firmware="${2:?path to merged-binary.bin}"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    "$HERE/.venv/bin/python" -m voice_bridge nvs-csv "$work/nvs.csv"
    uvx -q --from esp-idf-nvs-partition-gen python -m esp_idf_nvs_partition_gen \
        generate "$work/nvs.csv" "$work/nvs.bin" $NVS_SIZE
    # The merged image covers the NVS region with blanks, so NVS goes on second.
    $ESPTOOL --after no-reset write-flash 0 "$firmware"
    $ESPTOOL --after hard-reset write-flash $NVS_OFFSET "$work/nvs.bin"
    echo "flashed. If the screen stays dark, press the PWR button or replug USB."
    ;;
restore)
    backup="${2:?path to backup .bin}"
    $ESPTOOL --after hard-reset write-flash 0 "$backup"
    ;;
*)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
