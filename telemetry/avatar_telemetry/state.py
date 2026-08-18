"""State resolution and the published JSON payload.

The state names here are the ones the `.riv` reacts to: `idle`, `working`,
`celebrate`, `drowsy`, `sleep`, plus `unknown` when telemetry cannot prove it
is fresh.

State is *presentation over the gauges*, never an independent flag that can
drift out of sync with them. That is what makes it a pure function and what
makes the precedence ladder auditable in one place.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .config import Config
from .extract import CompletionEvent
from .gauges import EnergyReading, Workstream, carousel_health

#: Precedence, strongest first. Sleep and staleness dominate because those are
#: the two reads where a happy creature would be a lie.
STATES = ("unknown", "sleep", "drowsy", "celebrate", "working", "idle")

#: How long after an accepted completion the avatar stays in `celebrate`.
CELEBRATE_SECONDS = 6.0
#: A workstream touched within this window means work is actively happening.
WORKING_RECENCY_SECONDS = 15 * 60.0


@dataclass(frozen=True)
class Pulse:
    """A one-shot the renderer should play at most once.

    Pulses exist because the transport is a polling snapshot: edge-detecting on
    a level would re-fire every time a window reopens and re-reads the latest
    state. Consumers dedup on `id`.
    """

    id: str
    kind: str
    at: float
    label: str


def resolve_state(
    energy: EnergyReading,
    workstreams: list[Workstream],
    last_completion_at: float | None,
    config: Config,
    now: float,
) -> str:
    """Resolve the discrete avatar state.

    Args:
        energy: Current energy reading, including freshness.
        workstreams: Resolved liveness.
        last_completion_at: Epoch seconds of the most recent accepted
            completion, or None.
        config: Supplies the drowsy/sleep thresholds.
        now: Epoch seconds.

    Returns:
        One of `STATES`.
    """
    if not energy.fresh:
        return "unknown"
    if energy.value <= config.asleep_at_or_below:
        return "sleep"
    if energy.value < config.drowsy_below:
        return "drowsy"
    if last_completion_at is not None and (now - last_completion_at) <= CELEBRATE_SECONDS:
        return "celebrate"
    if is_working(workstreams, now):
        return "working"
    return "idle"


def is_working(workstreams: list[Workstream], now: float) -> bool:
    """Return True when at least one workstream was touched very recently.

    Deliberately stricter than liveness: a limb stays up for hours, but
    `isWorking` should mean *right now*, so the avatar settles into idle when
    Thomas steps away.

    Args:
        workstreams: Resolved liveness.
        now: Epoch seconds.

    Returns:
        True if any workstream saw meaningful signal inside the recency window.
    """
    return any(
        w.live and (now - w.last_meaningful_at) <= WORKING_RECENCY_SECONDS for w in workstreams
    )


def describe(state: str) -> str:
    """One calm line of copy per state. Never guilt, never a streak.

    Args:
        state: A member of `STATES`.

    Returns:
        Human-readable status text.
    """
    return {
        "idle": "Resting between things.",
        "working": "Busy — something is moving.",
        "celebrate": "Something just landed.",
        "drowsy": "Getting tired. Winding down.",
        "sleep": "Asleep. Resting until the budget window rolls forward.",
        "unknown": "Can't read telemetry — not going to guess.",
    }.get(state, "")


def build_payload(
    *,
    now: float,
    mode: str,
    nourishment: float,
    energy: EnergyReading,
    workstreams: list[Workstream],
    pulses: list[Pulse],
    last_completion_at: float | None,
    recent_completions: list[CompletionEvent],
    accepted: int,
    rejected: int,
    config: Config,
) -> dict[str, Any]:
    """Assemble the JSON document published to the state file and HTTP endpoint.

    Args:
        now: Epoch seconds for this snapshot.
        mode: "live" or "mock".
        nourishment: Current Nourishment reading, 0-100.
        energy: Current Energy reading.
        workstreams: Resolved liveness.
        pulses: One-shots to play.
        last_completion_at: Epoch seconds of the most recent accepted completion.
        recent_completions: Newest-first list for the "why" tap-through.
        accepted: Lifetime accepted completion count.
        rejected: Lifetime count that failed the confidence gate.
        config: Runtime configuration, echoed for provenance.

    Returns:
        A JSON-serializable dict.
    """
    health = carousel_health(workstreams, config)
    state = resolve_state(energy, workstreams, last_completion_at, config, now)
    working = is_working(workstreams, now)

    return {
        "schema": "agentic-avatar.telemetry/1",
        "at": _iso(now),
        "at_epoch": round(now, 3),
        "mode": mode,
        # Freshness is not advisory. A consumer that sees `fresh: false` must
        # render `unknown`, never the numbers.
        "fresh": energy.fresh,
        "stale_after_seconds": config.stale_after_seconds,
        "state": state,
        "state_text": describe(state),
        "gauges": {
            "nourishment": round(nourishment, 1),
            "energy": round(energy.value, 1),
            "health": round(health, 1),
        },
        # The exact values to push at the .riv, named as the artboard names
        # them. Keeping this block in the payload means the mapping is data,
        # not something each consumer re-derives.
        "rive_inputs": {
            "nourishment": round(nourishment, 1),
            "energy": round(energy.value, 1),
            "isWorking": working,
            "celebrate": [p.id for p in pulses if p.kind == "celebrate"],
        },
        "nourishment_detail": {
            "accepted_completions": accepted,
            "rejected_completions": rejected,
            "bump_per_completion": config.nourishment_bump,
            "half_life_days": config.nourishment_half_life_days,
            "accept_confidence": config.accept_confidence,
        },
        "energy_detail": {
            "used_ratio": round(energy.used_ratio, 4),
            "weighted_tokens": round(energy.weighted_tokens),
            "budget_tokens": round(energy.budget_tokens),
            "window_hours": energy.window_hours,
            "recovers_at": _iso(energy.recovers_at) if energy.recovers_at else None,
        },
        "health_detail": {
            "live_workstreams": sum(1 for w in workstreams if w.live),
            "known_workstreams": len(workstreams),
            "healthy_at": config.healthy_workstream_count,
        },
        "workstreams": [
            {
                "id": w.id,
                "label": w.label,
                "live": w.live,
                "last_meaningful_at": _iso(w.last_meaningful_at),
                "age_seconds": round(w.age_seconds),
            }
            for w in workstreams
        ],
        "drooping": [w.id for w in workstreams if not w.live],
        "pulses": [
            {"id": p.id, "kind": p.kind, "at": _iso(p.at), "label": p.label} for p in pulses
        ],
        "recent_completions": [
            {
                "id": c.id,
                "workstream": c.workstream,
                "kind": c.kind,
                "confidence": c.confidence,
                "at": _iso(c.at),
                "label": c.label,
            }
            for c in recent_completions
        ],
    }


def _iso(epoch: float) -> str:
    """Format epoch seconds as an ISO-8601 UTC string."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))
