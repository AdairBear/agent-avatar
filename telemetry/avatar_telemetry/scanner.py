"""Incremental reader for Claude Code session logs.

The logs are append-only JSONL, one directory per project. A full re-parse of
every historical file on every poll would be wasteful, so the scanner remembers
a byte offset per file and reads only what has been appended since. Files whose
mtime falls outside the lookback window are never opened at all.

Nothing here interprets meaning -- it only turns bytes into `LogRecord`s. The
interpretation lives in `extract.py`, which keeps the parsing testable without
a filesystem.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from .config import Config

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class LogRecord:
    """One JSONL line, narrowed to the fields the gauges care about."""

    #: "assistant", "user", "attachment", ...
    kind: str
    #: Epoch seconds, or None when the line carried no usable timestamp.
    at: float | None
    session_id: str
    #: Working directory of the session -- the basis for workstream identity.
    cwd: str
    #: The raw decoded object, for extractors that need more.
    raw: dict[str, Any]


def parse_timestamp(value: Any) -> float | None:
    """Parse an ISO-8601 timestamp into epoch seconds.

    The logs write UTC with a trailing `Z`. `time.strptime` has no timezone
    handling worth trusting here, so parse the fixed-width prefix and treat it
    as UTC explicitly.

    Args:
        value: Candidate timestamp, usually `2026-08-18T04:44:33.408Z`.

    Returns:
        Epoch seconds, or None if the value is unusable.
    """
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        parsed = time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return _timegm(parsed)


def _timegm(parsed: time.struct_time) -> float:
    """UTC-safe inverse of `time.gmtime`, without importing `calendar`."""
    import calendar

    return float(calendar.timegm(parsed))


class LogScanner:
    """Stateful incremental scanner over `<projects_dir>/*/*.jsonl`."""

    def __init__(self, config: Config) -> None:
        """Initialize the scanner.

        Args:
            config: Runtime configuration; supplies the projects directory and
                the lookback window.
        """
        self._config = config
        #: path -> (byte offset already consumed, file size when consumed)
        self._offsets: dict[str, tuple[int, int]] = {}

    def poll(self, now: float | None = None) -> Iterator[LogRecord]:
        """Yield every record appended since the previous poll.

        The first poll of a fresh process reads the whole lookback window, so
        the gauges start from real history rather than from zero.

        Args:
            now: Injectable clock, epoch seconds. Defaults to wall time.

        Yields:
            `LogRecord` values in file order.
        """
        now = time.time() if now is None else now
        cutoff = now - self._config.lookback_days * 86_400

        for path in self._candidate_files(cutoff):
            yield from self._read_new(path)

    def _candidate_files(self, cutoff: float) -> list[Path]:
        """List log files modified since `cutoff`, oldest first."""
        root = self._config.projects_dir
        if not root.is_dir():
            # Loud, not fatal: a machine with no logs yet is a legitimate state,
            # but silently reporting "no work done" would be a lie.
            log.warning("projects dir not found: %s", root)
            return []

        found: list[tuple[float, Path]] = []
        for path in root.glob("*/*.jsonl"):
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime >= cutoff:
                found.append((mtime, path))
        found.sort()
        return [path for _, path in found]

    def _read_new(self, path: Path) -> Iterator[LogRecord]:
        """Read and parse the bytes appended to `path` since the last poll."""
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            return

        offset, previous_size = self._offsets.get(key, (0, 0))
        if size < previous_size:
            # File shrank -- rotated or rewritten. Start over rather than
            # reading from a now-meaningless offset.
            offset = 0
        if size == offset:
            return

        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                handle.seek(offset)
                payload = handle.read()
                consumed = handle.tell()
        except OSError as error:
            log.warning("could not read %s: %s", path, error)
            return

        lines = payload.split("\n")
        # A trailing partial line means the writer is mid-append. Leave it
        # unconsumed so the next poll sees it whole.
        if payload and not payload.endswith("\n"):
            partial = lines.pop()
            consumed -= len(partial.encode("utf-8"))
        self._offsets[key] = (consumed, size)

        for line in lines:
            record = _parse_line(line)
            if record is not None:
                yield record


def _parse_line(line: str) -> LogRecord | None:
    """Decode one JSONL line into a `LogRecord`, or None if unusable."""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None

    return LogRecord(
        kind=str(obj.get("type", "")),
        at=parse_timestamp(obj.get("timestamp")),
        session_id=str(obj.get("sessionId", "")),
        cwd=str(obj.get("cwd", "")),
        raw=obj,
    )
