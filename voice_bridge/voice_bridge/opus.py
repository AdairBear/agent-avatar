"""Minimal ctypes binding to libopus: one decoder, one encoder.

The xiaozhi protocol carries raw Opus packets in WebSocket binary frames
(mono, 60 ms). libopus comes from Homebrew (`brew install opus`); binding it
directly avoids a compiled Python dependency.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os

_CANDIDATES = (
    os.environ.get("VOICE_BRIDGE_LIBOPUS", ""),
    "/opt/homebrew/lib/libopus.dylib",
    "/usr/local/lib/libopus.dylib",
    ctypes.util.find_library("opus") or "",
)

OPUS_APPLICATION_VOIP = 2048
OPUS_OK = 0


def _load() -> ctypes.CDLL:
    for path in _CANDIDATES:
        if path:
            try:
                return ctypes.CDLL(path)
            except OSError:
                continue
    raise RuntimeError("libopus not found. Install it with: brew install opus")


_lib = _load()
_lib.opus_decoder_create.restype = ctypes.c_void_p
_lib.opus_decoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
_lib.opus_decode.restype = ctypes.c_int
_lib.opus_decode.argtypes = [
    ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32,
    ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int,
]
_lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
_lib.opus_encoder_create.restype = ctypes.c_void_p
_lib.opus_encoder_create.argtypes = [
    ctypes.c_int32, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int),
]
_lib.opus_encode.restype = ctypes.c_int32
_lib.opus_encode.argtypes = [
    ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int,
    ctypes.c_char_p, ctypes.c_int32,
]
_lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
_lib.opus_strerror.restype = ctypes.c_char_p
_lib.opus_strerror.argtypes = [ctypes.c_int]


class OpusError(RuntimeError):
    def __init__(self, code: int):
        super().__init__(_lib.opus_strerror(code).decode())
        self.code = code


class Decoder:
    """Opus packets -> 16-bit little-endian mono PCM."""

    # 120 ms is the longest frame Opus allows.
    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        err = ctypes.c_int()
        self._st = _lib.opus_decoder_create(sample_rate, 1, ctypes.byref(err))
        if err.value != OPUS_OK or not self._st:
            raise OpusError(err.value)
        self._max = sample_rate * 120 // 1000
        self._buf = (ctypes.c_int16 * self._max)()

    def decode(self, packet: bytes) -> bytes:
        n = _lib.opus_decode(self._st, packet, len(packet), self._buf, self._max, 0)
        if n < 0:
            raise OpusError(n)
        return bytes(memoryview(self._buf).cast("B")[: n * 2])

    def __del__(self):
        st, self._st = getattr(self, "_st", None), None
        if st:
            _lib.opus_decoder_destroy(st)


class Encoder:
    """16-bit mono PCM -> Opus packets of a fixed frame duration."""

    def __init__(self, sample_rate: int = 24000, frame_ms: int = 60):
        self.sample_rate = sample_rate
        self.frame_samples = sample_rate * frame_ms // 1000
        self.frame_bytes = self.frame_samples * 2
        err = ctypes.c_int()
        self._st = _lib.opus_encoder_create(sample_rate, 1, OPUS_APPLICATION_VOIP, ctypes.byref(err))
        if err.value != OPUS_OK or not self._st:
            raise OpusError(err.value)
        self._out = ctypes.create_string_buffer(4000)

    def encode(self, pcm_frame: bytes) -> bytes:
        """Encode exactly one frame. A short final frame is zero-padded."""
        if len(pcm_frame) < self.frame_bytes:
            pcm_frame = pcm_frame + b"\x00" * (self.frame_bytes - len(pcm_frame))
        buf = (ctypes.c_int16 * self.frame_samples).from_buffer_copy(pcm_frame[: self.frame_bytes])
        n = _lib.opus_encode(self._st, buf, self.frame_samples, self._out, len(self._out))
        if n < 0:
            raise OpusError(n)
        return self._out.raw[:n]

    def encode_all(self, pcm: bytes) -> list[bytes]:
        return [self.encode(pcm[i : i + self.frame_bytes]) for i in range(0, len(pcm), self.frame_bytes)]

    def __del__(self):
        st, self._st = getattr(self, "_st", None), None
        if st:
            _lib.opus_encoder_destroy(st)
