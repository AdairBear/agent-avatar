"""The two gauges, plus carousel liveness.

The separation between them is structural, not stylistic. `NourishmentGauge`
has no method that accepts a `UsageSample`, and `EnergyGauge` has no method
that accepts a `CompletionEvent`. There is no code path by which burning tokens
can feed the creature -- the type signatures enforce it rather than discipline.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .config import Config, meets_confidence
from .extract import ActivitySignal, CompletionEvent, UsageSample


def clamp(value: float, low: float, high: float) -> float:
    """Clamp `value` into `[low, high]`."""
    return min(high, max(low, value))


class NourishmentGauge:
    """0-100, fed only by verified completions, decaying gently over days.

    Decay is deliberately slow: a quiet week should read as a calm creature,
    not a starving one. The gauge is a picture of recent finished work, not a
    productivity score with a streak to break.
    """

    def __init__(self, config: Config, now: float) -> None:
        """Initialize an empty gauge.

        Args:
            config: Supplies bump size, half-life, and the confidence floor.
            now: Epoch seconds; the decay clock starts here.
        """
        self._config = config
        self._value = 0.0
        self._last_decay_at = now
        self._seen: set[str] = set()
        self._accepted = 0
        self._rejected = 0

    def offer(self, event: CompletionEvent) -> bool:
        """Offer a completion to the gauge.

        Args:
            event: A candidate completion.

        Returns:
            True when the event was novel and confident enough to count.
        """
        if event.id in self._seen:
            return False
        if not meets_confidence(event.confidence, self._config.accept_confidence):
            # Counted, but not fed. Visible in the published JSON so a
            # perpetually-hungry creature is diagnosable rather than mysterious.
            self._rejected += 1
            return False

        self._seen.add(event.id)
        self._accepted += 1
        self._value = clamp(self._value + self._config.nourishment_bump, 0.0, 100.0)
        return True

    def decay_to(self, now: float) -> None:
        """Apply exponential decay for elapsed wall time.

        Args:
            now: Epoch seconds. Calls with a non-advancing clock are no-ops.
        """
        elapsed = now - self._last_decay_at
        if elapsed <= 0:
            return
        half_life_s = self._config.nourishment_half_life_days * 86_400
        if half_life_s > 0:
            self._value *= math.pow(0.5, elapsed / half_life_s)
        self._last_decay_at = now

    @property
    def value(self) -> float:
        """Current gauge reading, 0-100."""
        return clamp(self._value, 0.0, 100.0)

    @property
    def accepted(self) -> int:
        """How many completions have fed the gauge."""
        return self._accepted

    @property
    def rejected(self) -> int:
        """How many completions were seen but failed the confidence gate."""
        return self._rejected


@dataclass(frozen=True)
class EnergyReading:
    """Result of reading the Energy gauge."""

    value: float
    #: False when no usage could be measured. Forces the `unknown` state.
    fresh: bool
    used_ratio: float
    weighted_tokens: float
    budget_tokens: float
    window_hours: float
    #: Epoch seconds when the oldest sample leaves the window and energy recovers.
    recovers_at: float | None


class EnergyGauge:
    """0-100 remaining usage budget over a rolling window.

    Depleting to zero is a boundary, not a punishment: the avatar sleeps, and
    the gauge refills on its own as old usage ages out of the window. Nothing
    here can be "earned back" by working harder.
    """

    def __init__(self, config: Config) -> None:
        """Initialize with an empty sample buffer.

        Args:
            config: Supplies the window length and the budget.
        """
        self._config = config
        self._samples: list[UsageSample] = []
        self._seen_any = False

    def add(self, samples: list[UsageSample]) -> None:
        """Record new usage samples.

        Args:
            samples: Samples from this poll. Duplicates across overlapping
                reads are impossible because the scanner never re-reads bytes.
        """
        if samples:
            self._seen_any = True
            self._samples.extend(samples)

    def read(self, now: float) -> EnergyReading:
        """Compute remaining energy, pruning samples outside the window.

        Args:
            now: Epoch seconds.

        Returns:
            An `EnergyReading`. `fresh` is False when the service has never
            seen a usage sample, which must render as unknown rather than as a
            full tank.
        """
        window_s = self._config.energy_window_hours * 3_600
        cutoff = now - window_s
        self._samples = [s for s in self._samples if s.at >= cutoff]

        spent = sum(s.weighted_tokens for s in self._samples)
        budget = max(1.0, self._config.energy_budget_tokens)
        used = clamp(spent / budget, 0.0, 1.0)

        recovers_at: float | None = None
        if self._samples:
            recovers_at = min(s.at for s in self._samples) + window_s

        return EnergyReading(
            value=clamp((1.0 - used) * 100.0, 0.0, 100.0),
            # Having read the logs and found no usage at all is not the same as
            # a quiet hour: it means we cannot measure, so say so.
            fresh=self._seen_any,
            used_ratio=used,
            weighted_tokens=spent,
            budget_tokens=budget,
            window_hours=self._config.energy_window_hours,
            recovers_at=recovers_at,
        )


@dataclass(frozen=True)
class Workstream:
    """One project's liveness, as rendered."""

    id: str
    label: str
    live: bool
    last_meaningful_at: float
    age_seconds: float


class LivenessTracker:
    """Tracks per-workstream last-meaningful-signal times.

    The workstream count is discovered from data and never hardcoded: two
    active projects give two limbs of attention, nine give nine.
    """

    def __init__(self, config: Config) -> None:
        """Initialize with no known workstreams.

        Args:
            config: Supplies the liveness window and the minimum record count.
        """
        self._config = config
        self._last_meaningful: dict[str, float] = {}
        self._counts: dict[str, int] = {}

    def add(self, signals: list[ActivitySignal]) -> None:
        """Fold new activity signals into the tracker.

        Args:
            signals: Activity observed this poll.
        """
        for signal in signals:
            self._counts[signal.workstream] = self._counts.get(signal.workstream, 0) + 1
            if signal.meaningful:
                previous = self._last_meaningful.get(signal.workstream, 0.0)
                if signal.at > previous:
                    self._last_meaningful[signal.workstream] = signal.at

    def note_completion(self, event: CompletionEvent) -> None:
        """Treat a completion as a meaningful signal for its workstream.

        Args:
            event: An accepted completion.
        """
        previous = self._last_meaningful.get(event.workstream, 0.0)
        if event.at > previous:
            self._last_meaningful[event.workstream] = event.at
        self._counts[event.workstream] = self._counts.get(event.workstream, 0) + 1

    def resolve(self, now: float) -> list[Workstream]:
        """Snapshot every known workstream's liveness.

        Args:
            now: Epoch seconds.

        Returns:
            Workstreams sorted most-recently-active first.
        """
        window_s = self._config.liveness_window_hours * 3_600
        out: list[Workstream] = []
        for stream, last in self._last_meaningful.items():
            if stream in self._config.ignore_workstreams:
                # Tooling, not work. Counting it would inflate carousel health.
                continue
            if self._counts.get(stream, 0) < self._config.min_records_per_workstream:
                # Too little evidence to call this a workstream at all.
                continue
            age = max(0.0, now - last)
            out.append(
                Workstream(
                    id=stream,
                    label=_humanize(stream),
                    live=age <= window_s,
                    last_meaningful_at=last,
                    age_seconds=age,
                )
            )
        out.sort(key=lambda w: w.last_meaningful_at, reverse=True)
        return out


def carousel_health(workstreams: list[Workstream], config: Config) -> float:
    """Overall health: how many workstreams are concurrently alive.

    This is the "carousel" reading -- a single project running hot is not the
    same as a portfolio in motion, and health reports the difference.

    Args:
        workstreams: Resolved liveness for every known workstream.
        config: Supplies the count that reads as fully healthy.

    Returns:
        0-100.
    """
    live = sum(1 for w in workstreams if w.live)
    target = max(1, config.healthy_workstream_count)
    return clamp(live / target * 100.0, 0.0, 100.0)


def _humanize(stream_id: str) -> str:
    """Turn `agentic-avatar` into `Agentic Avatar` for display."""
    return " ".join(part.capitalize() for part in stream_id.replace("_", "-").split("-") if part)
