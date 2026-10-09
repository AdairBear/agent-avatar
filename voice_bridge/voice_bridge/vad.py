"""Energy-based end-pointing: a PCM stream in, whole utterances out.

The firmware's audio front end already does noise suppression, so a level
threshold above the room's noise floor is enough to find where an utterance
starts and stops. The floor is measured, not assumed: it is the quietest level
heard in the last few seconds, which speech always dips to between words and
steady noise never rises above. Pure Python: at 16 kHz this is ~17 small
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
        min_rms: int = 120,
        preroll_ms: int = 300,
        onset_ms: int = 120,
        noise_ratio: float = 3.0,
        noise_window_ms: int = 3000,
    ):
        self.sample_rate = sample_rate
        self.silence_ms = silence_ms
        self.min_speech_ms = min_speech_ms
        self.max_bytes = max_utterance_s * sample_rate * 2
        self.min_rms = min_rms
        self.onset_ms = onset_ms
        self.preroll_ms = preroll_ms
        self.noise_ratio = noise_ratio
        self.noise_window_ms = noise_window_ms
        # Until enough has been heard, assume a room quiet enough for min_rms.
        self._noise = float(min_rms) / noise_ratio
        self._recent: deque[tuple[float, float]] = deque()
        self._recent_ms = 0.0
        self._preroll: deque[tuple[bytes, float]] = deque()
        self._preroll_ms = 0.0
        self._onset_run_ms = 0.0
        self._buf = bytearray()
        self._speech_ms = 0.0
        self._silence_run_ms = 0.0
        self.in_speech = False
        # Running totals for the session summary in the log.
        self.frames = 0
        self.loud_frames = 0
        self.peak_rms = 0.0
        self._levels: list[float] = []

    @property
    def noise(self) -> float:
        return self._noise

    @property
    def threshold(self) -> float:
        """The level a frame must exceed to start or continue speech.

        `min_rms` is the lower bound, for a room quieter than the mic's own hiss.
        """
        return max(self.min_rms, self._noise * self.noise_ratio)

    def _track_noise(self, level: float, ms: float) -> bool:
        """Update the noise floor. Returns True if what is being heard is steady noise."""
        self._recent.append((level, ms))
        self._recent_ms += ms
        while self._recent_ms - self._recent[0][1] >= self.noise_window_ms:
            self._recent_ms -= self._recent.popleft()[1]
        if len(self._recent) < 5:
            return False
        # Second quietest and second loudest, so one odd frame decides nothing.
        levels = sorted(level for level, _ in self._recent)
        quietest, loudest = levels[1], levels[-2]
        # Speech swings widely from frame to frame. A level that has held
        # steady for the whole window is a fan or a hum, however loud it is.
        steady = self._recent_ms >= self.noise_window_ms - ms and quietest >= loudest * 0.5
        if self.in_speech and not steady:
            # Speech must not raise its own bar: mid-utterance the floor only falls.
            self._noise = min(self._noise, quietest)
        else:
            self._noise = quietest
        return steady

    @property
    def median_rms(self) -> float:
        return sorted(self._levels)[len(self._levels) // 2] if self._levels else 0.0

    def _ms(self, pcm: bytes) -> float:
        return len(pcm) / 2 / self.sample_rate * 1000

    def feed(self, pcm: bytes) -> bytes | None:
        """Add one frame. Returns a finished utterance, or None."""
        level = rms(pcm)
        ms = self._ms(pcm)
        self.frames += 1
        self.peak_rms = max(self.peak_rms, level)
        if len(self._levels) < 20000:
            self._levels.append(level)
        steady = self._track_noise(level, ms)
        loud = level > self.threshold
        self.loud_frames += loud
        if steady and self.in_speech:
            # What opened this "utterance" was the room, not a voice. Drop it.
            self._speech_ms = 0.0
            self._finish()
            return None

        if not self.in_speech:
            if not loud:
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
        # Trailing syllables are quieter than the onset, so a pause is only
        # counted below a lower bar than the one speech had to clear.
        if level > self.threshold * 0.6:
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
