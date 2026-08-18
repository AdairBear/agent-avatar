"""Mock signal source.

Exists so the desktop shell can be developed and demoed before real telemetry
is trusted and before the `.riv` exists. It replaces only the *source* of the
numbers -- state resolution, the payload shape, and the Rive input mapping are
the same code paths the live mode uses, so a mock run genuinely exercises the
thing it is standing in for.

Two ways to drive it:

* **Arc** (default) -- sweeps the whole emotional range in a few minutes, so
  idle -> working -> celebrate -> drowsy -> sleep can be watched in one sitting.
* **Pinned** -- hold specific values, the "slider" mode. Set from the CLI with
  `--set nourishment=70 --set energy=15`, or live over HTTP against
  `/mock?nourishment=70&energy=15` while the service is running.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .config import Config
from .extract import CompletionEvent
from .gauges import EnergyReading, Workstream

#: Seconds for one full pass of the arc.
ARC_PERIOD_SECONDS = 180.0

_MOCK_WORKSTREAMS = ("trident-forge", "agentic-avatar", "ebooklm", "harmony-house")


@dataclass
class MockSource:
    """Synthetic gauge values with the same shape as the live path."""

    config: Config
    started_at: float
    #: Values pinned by CLI or HTTP. Anything absent follows the arc.
    pinned: dict[str, float] = field(default_factory=dict)
    #: Monotonic counter so synthetic completion ids are stable and dedup works.
    _issued: int = 0

    def pin(self, **values: float) -> None:
        """Pin one or more gauge values.

        Args:
            **values: Any of `nourishment`, `energy`, `health`, `is_working`.
        """
        for key, value in values.items():
            if value is None:
                self.pinned.pop(key, None)
            else:
                self.pinned[key] = float(value)

    def nourishment(self, now: float) -> float:
        """Nourishment for this instant, 0-100."""
        if "nourishment" in self.pinned:
            return _clamp(self.pinned["nourishment"])
        # A sawtooth: fed by completions, decaying between them.
        phase = self._phase(now)
        return _clamp(30 + 60 * abs(math.sin(phase * math.pi)))

    def energy(self, now: float) -> EnergyReading:
        """Energy for this instant, as a full reading."""
        if "energy" in self.pinned:
            value = _clamp(self.pinned["energy"])
        else:
            # Drain 100 -> 0 across the arc, then hold asleep rather than wrap,
            # so the sleep state is actually reachable and observable.
            value = _clamp(100.0 * (1.0 - min(1.0, self._phase(now))))
        used = 1.0 - value / 100.0
        return EnergyReading(
            value=value,
            fresh=True,
            used_ratio=used,
            weighted_tokens=used * self.config.energy_budget_tokens,
            budget_tokens=self.config.energy_budget_tokens,
            window_hours=self.config.energy_window_hours,
            recovers_at=self.started_at + ARC_PERIOD_SECONDS,
        )

    def workstreams(self, now: float) -> list[Workstream]:
        """Synthetic liveness, with one workstream deliberately gone quiet."""
        target = "harmony-house"
        if "health" in self.pinned:
            # Pinned health decides how many limbs are up.
            want = round(_clamp(self.pinned["health"]) / 100.0 * self.config.healthy_workstream_count)
        else:
            want = len(_MOCK_WORKSTREAMS) - 1

        working = self.pinned.get("is_working", 1.0) >= 0.5
        out: list[Workstream] = []
        for index, stream in enumerate(_MOCK_WORKSTREAMS):
            live = index < want and stream != target
            # A live stream needs recent signal for `isWorking` to read true.
            last = now if (live and working) else now - 9 * 3_600
            out.append(
                Workstream(
                    id=stream,
                    label=stream.replace("-", " ").title(),
                    live=live,
                    last_meaningful_at=last,
                    age_seconds=max(0.0, now - last),
                )
            )
        return out

    def completions(self, now: float) -> list[CompletionEvent]:
        """Emit a synthetic completion every few seconds, so celebrate fires."""
        if "nourishment" in self.pinned:
            # Pinned mode is for holding a pose, not for animating.
            return []
        due = int((now - self.started_at) // 20)
        events: list[CompletionEvent] = []
        while self._issued < due:
            self._issued += 1
            stream = _MOCK_WORKSTREAMS[self._issued % len(_MOCK_WORKSTREAMS)]
            events.append(
                CompletionEvent(
                    id=f"mock:completion:{self._issued}",
                    workstream=stream,
                    kind="commit",
                    confidence="certain",
                    at=self.started_at + self._issued * 20,
                    label=f"{stream.replace('-', ' ').title()} — mock completion",
                    source="mock",
                )
            )
        return events

    def _phase(self, now: float) -> float:
        """Position within the arc, 0..1 (and beyond, held at the end)."""
        return (now - self.started_at) / ARC_PERIOD_SECONDS


def _clamp(value: float) -> float:
    """Clamp to the 0-100 gauge range."""
    return min(100.0, max(0.0, value))
