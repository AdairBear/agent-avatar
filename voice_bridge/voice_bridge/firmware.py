"""Read the identity of an ESP-IDF application image (the file an OTA serves).

Every app image carries an `esp_app_desc_t` right after the image header and
the first segment header. The device reports the same ELF hash at check-in,
which is how the bridge knows whether the board already runs this build.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

_DESC_OFFSET = 24 + 8  # esp_image_header_t + esp_image_segment_header_t
_DESC_MAGIC = 0xABCD5432
_IMAGE_MAGIC = 0xE9


@dataclass(frozen=True)
class Firmware:
    path: Path
    version: str
    elf_sha256: str
    size: int


def describe(path: str | Path) -> Firmware | None:
    """Return the image's version and ELF hash, or None if it is not an app image."""
    path = Path(path).expanduser()
    try:
        with path.open("rb") as fh:
            head = fh.read(_DESC_OFFSET + 256)
        size = path.stat().st_size
    except OSError:
        return None
    if len(head) < _DESC_OFFSET + 176 or head[0] != _IMAGE_MAGIC:
        return None
    desc = head[_DESC_OFFSET:]
    if struct.unpack_from("<I", desc)[0] != _DESC_MAGIC:
        return None
    version = desc[16:48].split(b"\0", 1)[0].decode(errors="replace")
    return Firmware(path, version, desc[144:176].hex(), size)
