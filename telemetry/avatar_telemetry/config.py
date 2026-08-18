"""Every tunable in one place.

Each field can be overridden by an environment variable so the service can be
retuned without editing code -- useful because several of these numbers are
honest guesses that only real use can calibrate (see README "Limitations").
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_float(name: str, default: float) -> float:
    """Read a float from the environment, falling back on a bad value."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    """Read an int from the environment, falling back on a bad value."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass
class Config:
    """Runtime configuration for the telemetry service."""

    # -- Where to read from ------------------------------------------------
    #: Directory holding one subdirectory per project, each with *.jsonl logs.
    projects_dir: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AVATAR_PROJECTS_DIR", Path.home() / ".claude" / "projects")
        ).expanduser()
    )
    #: Files untouched for longer than this are skipped entirely, which is what
    #: keeps a full scan cheap across ~1800 historical logs.
    lookback_days: float = field(default_factory=lambda: _env_float("AVATAR_LOOKBACK_DAYS", 7.0))

    # -- Where to write to -------------------------------------------------
    state_file: Path = field(
        default_factory=lambda: Path(
            os.environ.get("AVATAR_STATE_FILE", Path.home() / ".agentic-avatar" / "state.json")
        ).expanduser()
    )
    #: Loopback only. This service must never be reachable off this machine.
    host: str = "127.0.0.1"
    port: int = field(default_factory=lambda: _env_int("AVATAR_PORT", 8787))
    poll_seconds: float = field(default_factory=lambda: _env_float("AVATAR_POLL_SECONDS", 20.0))

    # -- Nourishment: fed by completed work only ---------------------------
    #: Points added per accepted completion. Gauge is 0-100.
    nourishment_bump: float = field(default_factory=lambda: _env_float("AVATAR_BUMP", 12.0))
    #: Gentle exponential decay, so a quiet day reads as calm rather than starving.
    nourishment_half_life_days: float = field(
        default_factory=lambda: _env_float("AVATAR_HALF_LIFE_DAYS", 3.0)
    )
    #: Only completions at or above this tier feed the gauge.
    #: "certain" = provable artifacts (commits, completed tasks, green test runs).
    accept_confidence: str = field(
        default_factory=lambda: os.environ.get("AVATAR_ACCEPT_CONFIDENCE", "certain")
    )

    # -- Energy: remaining usage budget ------------------------------------
    #: Rolling window the budget is measured over. Mirrors Claude's own
    #: rolling rate-limit window rather than a calendar day.
    energy_window_hours: float = field(
        default_factory=lambda: _env_float("AVATAR_ENERGY_WINDOW_HOURS", 5.0)
    )
    #: Weighted tokens that constitute a full budget for one window. Calibrated
    #: from observed local throughput; see README. Override per plan/appetite.
    energy_budget_tokens: float = field(
        default_factory=lambda: _env_float("AVATAR_ENERGY_BUDGET_TOKENS", 45_000_000.0)
    )
    #: Cache reads are an order of magnitude cheaper than fresh input, and
    #: dominate raw counts. Weighting them down keeps energy tracking real cost
    #: rather than context size.
    cache_read_weight: float = field(
        default_factory=lambda: _env_float("AVATAR_CACHE_READ_WEIGHT", 0.1)
    )

    # -- State thresholds --------------------------------------------------
    hungry_below: float = field(default_factory=lambda: _env_float("AVATAR_HUNGRY_BELOW", 35.0))
    drowsy_below: float = field(default_factory=lambda: _env_float("AVATAR_DROWSY_BELOW", 20.0))
    asleep_at_or_below: float = field(default_factory=lambda: _env_float("AVATAR_ASLEEP_AT", 0.0))

    # -- Liveness / health -------------------------------------------------
    #: A workstream with no meaningful signal for this long stops counting as live.
    liveness_window_hours: float = field(
        default_factory=lambda: _env_float("AVATAR_LIVENESS_WINDOW_HOURS", 6.0)
    )
    #: Health is "carousel liveness": how many workstreams are concurrently
    #: alive, as a fraction of this. Reaching this count reads as 100.
    healthy_workstream_count: int = field(
        default_factory=lambda: _env_int("AVATAR_HEALTHY_WORKSTREAMS", 3)
    )
    #: A workstream must show at least this much activity to be counted at all,
    #: so a single stray file read does not manufacture a workstream.
    min_records_per_workstream: int = field(
        default_factory=lambda: _env_int("AVATAR_MIN_RECORDS", 3)
    )
    #: Directory names that are tooling, not work. Sessions rooted here are
    #: infrastructure chatter and would otherwise inflate carousel health.
    #: Comma-separated override via AVATAR_IGNORE_WORKSTREAMS.
    ignore_workstreams: frozenset[str] = field(
        default_factory=lambda: frozenset(
            part.strip()
            for part in os.environ.get(
                "AVATAR_IGNORE_WORKSTREAMS",
                "observer-sessions,scratchpad,memory,agent,.claude,tmp",
            ).split(",")
            if part.strip()
        )
    )

    # -- Freshness ---------------------------------------------------------
    #: Published state older than this must not render as healthy. The consumer
    #: is required to treat a stale file as unknown rather than as good news.
    stale_after_seconds: float = field(
        default_factory=lambda: _env_float("AVATAR_STALE_AFTER_S", 180.0)
    )


#: Confidence tiers, weakest first. Used to compare against `accept_confidence`.
CONFIDENCE_ORDER = ("guessing", "likely", "certain")


def meets_confidence(confidence: str, minimum: str) -> bool:
    """Return True when `confidence` is at least as strong as `minimum`.

    Args:
        confidence: Tier attached to a completion event.
        minimum: Configured acceptance floor.

    Returns:
        True if the event should feed the Nourishment gauge.
    """
    try:
        return CONFIDENCE_ORDER.index(confidence) >= CONFIDENCE_ORDER.index(minimum)
    except ValueError:
        return False
