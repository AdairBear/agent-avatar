"""Energy-based end-pointing: a PCM stream in, whole utterances out.

The firmware's audio front end already does noise suppression and gain
control, so a level threshold against a tracked noise floor is enough to find
where an utterance starts and stops. Pure Python: at 16 kHz this is ~17 small
frames a second.
"""

from __future__ import annotations

from array import array
from collections import deque


def rms(pcm: bytes) -> float:
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) & ~1])
    if not samples:
        return 0.0
    return (sum(s * s for s in samples) / len(samples)) ** 0.5


class Segmenter:
    def __init__(
        self,
        sample_rate: int = 16000,
        silence_ms: int = 1000,
        min_speech_ms: int = 300,
        max_utterance_s: int = 90,
        min_rms: int = 350,
        preroll_ms: int = 300,
        onset_ms: int = 120,
    ):
        self.sample_rate = sample_rate
        self.silence_ms = silence_ms
        self.min_speech_ms = min_speech_ms
        self.max_bytes = max_utterance_s * sample_rate * 2
        self.min_rms = min_rms
        self.onset_ms = onset_ms
        self.preroll_ms = preroll_ms
        self._noise = float(min_rms) / 3
        self._preroll: deque[tuple[bytes, float]] = deque()
        self._preroll_ms = 0.0
        self._onset_run_ms = 0.0
        self._buf = bytearray()
        self._speech_ms = 0.0
        self._silence_run_ms = 0.0
        self.in_speech = False

    def _ms(self, pcm: bytes) -> float:
        return len(pcm) / 2 / self.sample_rate * 1000

    def feed(self, pcm: bytes) -> bytes | None:
        """Add one frame. Returns a finished utterance, or None."""
        level = rms(pcm)
        ms = self._ms(pcm)
        loud = level > max(self.min_rms, self._noise * 3)

        if not self.in_speech:
            if not loud:
                # Track the floor only on quiet frames, slowly.
                self._noise += (level - self._noise) * 0.05
                self._onset_run_ms = 0.0
            else:
                self._onset_run_ms += ms
            self._preroll.append((pcm, ms))
            self._preroll_ms += ms
            while self._preroll_ms - self._preroll[0][1] >= self.preroll_ms + self.onset_ms:
                self._preroll_ms -= self._preroll.popleft()[1]
            if self._onset_run_ms >= self.onset_ms:
                self.in_speech = True
                self._buf = bytearray(b"".join(p for p, _ in self._preroll))
                self._speech_ms = self._onset_run_ms
                self._silence_run_ms = 0.0
                self._preroll.clear()
                self._preroll_ms = 0.0
            return None

        self._buf += pcm
        if loud:
            self._speech_ms += ms
            self._silence_run_ms = 0.0
        else:
            self._silence_run_ms += ms
        if self._silence_run_ms >= self.silence_ms or len(self._buf) >= self.max_bytes:
            return self._finish()
        return None

    def flush(self) -> bytes | None:
        """Force the end of the current utterance (button released, socket closed)."""
        if not self.in_speech:
            return None
        return self._finish()

    def _finish(self) -> bytes | None:
        buf, speech_ms = bytes(self._buf), self._speech_ms
        self._buf = bytearray()
        self.in_speech = False
        self._onset_run_ms = self._speech_ms = self._silence_run_ms = 0.0
        return buf if speech_ms >= self.min_speech_ms else None
