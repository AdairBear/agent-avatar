"""Turn log records into the three signals the gauges consume.

Three deliberate rules shape everything here:

1. **Nourishment comes only from provable completions.** Every accepted event
   is tied to an artifact that exists whether or not anyone claimed success --
   a commit SHA, a task the harness itself marked completed. Self-declared
   "done" is admitted only at `likely`, which the default config rejects.
2. **Usage never feeds Nourishment.** Token counts are extracted by a separate
   function into a separate type. There is no code path from tokens to food.
3. **Absence is reported, never invented.** A window with no usage samples
   yields `None`, not a comfortable zero -- a zero would mean *full tank* and
   would paint a healthy creature on the strength of no data at all.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .scanner import LogRecord

#: A successful `git commit` prints `[branch abc1234] subject`.
_COMMIT_LINE = re.compile(r"\[[^\]\s]+\s+(?P<sha>[0-9a-f]{7,40})\]")
#: Commands we treat as an attempt to commit work.
_GIT_COMMIT = re.compile(r"\bgit\s+(?:-[^\s]+\s+)*commit\b")
#: Common test runners. A green run is corroborating, never proof on its own.
_TEST_RUNNER = re.compile(
    r"\b(pytest|npm\s+(?:run\s+)?test|yarn\s+test|go\s+test|cargo\s+test|unittest)\b"
)
_TEST_PASSED = re.compile(r"\b(\d+\s+passed|all tests passed|OK\b|PASS\b|✓)", re.IGNORECASE)
_TEST_FAILED = re.compile(r"\b(\d+\s+failed|FAILED|ERROR\b|Traceback)", re.IGNORECASE)


@dataclass(frozen=True)
class CompletionEvent:
    """A verified unit of finished work. The only thing that feeds Nourishment."""

    #: Stable dedup key. Replaying the log cannot double-feed the gauge.
    id: str
    workstream: str
    #: "commit" | "task_done" | "test_pass"
    kind: str
    #: "certain" | "likely" | "guessing"
    confidence: str
    at: float
    label: str
    source: str = "claude-logs"


@dataclass(frozen=True)
class UsageSample:
    """One assistant turn's token cost. The only thing that drains Energy."""

    at: float
    #: Tokens after cache-read down-weighting; see `Config.cache_read_weight`.
    weighted_tokens: float
    session_id: str


@dataclass(frozen=True)
class ActivitySignal:
    """Evidence that a workstream is alive at a point in time."""

    workstream: str
    at: float
    #: True for substantive signals (a human prompt, a completion). Spec rule:
    #: a flurry of trivial records must not resurrect a quiet workstream.
    meaningful: bool


def workstream_id(cwd: str) -> str:
    """Derive a stable workstream id from a session's working directory.

    Sessions run in worktrees and subdirectories of the same project, so the
    raw cwd is too granular. This collapses to the last path segment, which is
    what a human would call the project.

    Args:
        cwd: Absolute working directory from the log record.

    Returns:
        A short id, or "unknown" when the cwd is unusable.
    """
    if not cwd:
        return "unknown"
    parts = [p for p in cwd.rstrip("/").split("/") if p]
    if not parts:
        return "unknown"
    # Worktrees nest under `<project>/.claude/worktrees/<name>` -- credit the project.
    for marker in (".claude", "worktrees"):
        if marker in parts:
            index = parts.index(marker)
            if index > 0:
                return parts[index - 1]
    return parts[-1]


def extract_usage(record: LogRecord, cache_read_weight: float) -> UsageSample | None:
    """Pull a token-cost sample out of an assistant record.

    Args:
        record: A parsed log record.
        cache_read_weight: Multiplier applied to cached-read tokens.

    Returns:
        A `UsageSample`, or None if this record carried no usable usage block.
    """
    if record.kind != "assistant" or record.at is None:
        return None
    message = record.raw.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None

    def count(key: str) -> float:
        value = usage.get(key, 0)
        return float(value) if isinstance(value, (int, float)) else 0.0

    weighted = (
        count("input_tokens")
        + count("output_tokens")
        + count("cache_creation_input_tokens")
        + count("cache_read_input_tokens") * cache_read_weight
    )
    if weighted <= 0:
        return None
    return UsageSample(at=record.at, weighted_tokens=weighted, session_id=record.session_id)


def extract_activity(record: LogRecord) -> ActivitySignal | None:
    """Classify a record as evidence that a workstream is alive.

    Human prompts count as meaningful; tool chatter does not. That distinction
    is what stops an idle-but-chatty agent loop from keeping a limb upright.

    Args:
        record: A parsed log record.

    Returns:
        An `ActivitySignal`, or None when the record proves nothing.
    """
    if record.at is None or not record.cwd:
        return None

    meaningful = False
    if record.kind == "user":
        message = record.raw.get("message")
        # A `user` record is either a real prompt or a tool result being fed
        # back. Only the former is a human saying something.
        if isinstance(message, dict) and "toolUseResult" not in record.raw:
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                meaningful = True
            elif isinstance(content, list):
                meaningful = any(
                    isinstance(block, dict) and block.get("type") == "text"
                    for block in content
                )

    return ActivitySignal(
        workstream=workstream_id(record.cwd), at=record.at, meaningful=meaningful
    )


class CompletionExtractor:
    """Stateful extractor for completion events.

    Stateful because proving a Bash command succeeded needs two records: the
    assistant's `tool_use` (which carries the command) and the later `user`
    `tool_result` (which carries the output). Those can straddle a poll
    boundary, so pending tool calls are held across polls.
    """

    #: Bound on the pending map, so a never-answered tool call cannot leak.
    _MAX_PENDING = 512

    def __init__(self) -> None:
        """Initialize with an empty pending-tool map."""
        #: tool_use_id -> (command, workstream, timestamp)
        self._pending: dict[str, tuple[str, str, float]] = {}

    def feed(self, record: LogRecord) -> list[CompletionEvent]:
        """Offer one record and collect any completions it proves.

        Args:
            record: A parsed log record.

        Returns:
            Zero or more completion events. Ids are stable, so returning the
            same event twice across overlapping polls is safe by design.
        """
        if record.at is None:
            return []
        if record.kind == "assistant":
            return self._feed_assistant(record)
        if record.kind == "user":
            return self._feed_tool_result(record)
        return []

    def _feed_assistant(self, record: LogRecord) -> list[CompletionEvent]:
        """Scan an assistant turn's tool calls."""
        message = record.raw.get("message")
        if not isinstance(message, dict):
            return []
        content = message.get("content")
        if not isinstance(content, list):
            return []

        stream = workstream_id(record.cwd)
        events: list[CompletionEvent] = []

        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = block.get("name")
            payload = block.get("input")
            if not isinstance(payload, dict):
                continue

            if name == "Bash":
                command = str(payload.get("command", ""))
                if _GIT_COMMIT.search(command) or _TEST_RUNNER.search(command):
                    self._remember(str(block.get("id", "")), command, stream, record.at)
            elif name == "TaskUpdate":
                event = _task_completion(payload, stream, record)
                if event is not None:
                    events.append(event)
            elif name == "TodoWrite":
                events.extend(_todo_completions(payload, stream, record))

        return events

    def _feed_tool_result(self, record: LogRecord) -> list[CompletionEvent]:
        """Resolve a pending Bash call against its output."""
        result = record.raw.get("toolUseResult")
        if not isinstance(result, dict):
            return []

        tool_use_id = _tool_use_id_of(record.raw)
        if tool_use_id is None:
            return []
        pending = self._pending.pop(tool_use_id, None)
        if pending is None:
            return []

        command, stream, started_at = pending
        stdout = str(result.get("stdout", ""))
        stderr = str(result.get("stderr", ""))
        if result.get("interrupted"):
            return []

        if _GIT_COMMIT.search(command):
            match = _COMMIT_LINE.search(stdout)
            if match:
                sha = match.group("sha")
                return [
                    CompletionEvent(
                        id=f"commit:{stream}:{sha}",
                        workstream=stream,
                        kind="commit",
                        confidence="certain",
                        at=record.at or started_at,
                        label=f"{stream} — commit {sha[:7]}",
                    )
                ]
            return []

        if _TEST_RUNNER.search(command):
            combined = f"{stdout}\n{stderr}"
            if _TEST_PASSED.search(combined) and not _TEST_FAILED.search(combined):
                digest = hashlib.sha1(f"{tool_use_id}".encode()).hexdigest()[:10]
                return [
                    CompletionEvent(
                        id=f"test:{stream}:{digest}",
                        workstream=stream,
                        kind="test_pass",
                        # Corroborating, not proof: runners print "passed" in
                        # plenty of situations that are not a green suite.
                        confidence="likely",
                        at=record.at or started_at,
                        label=f"{stream} — tests passed",
                    )
                ]
        return []

    def _remember(self, tool_use_id: str, command: str, stream: str, at: float) -> None:
        """Hold a tool call until its result arrives."""
        if not tool_use_id:
            return
        if len(self._pending) >= self._MAX_PENDING:
            # Drop the oldest. Losing a completion is acceptable; unbounded
            # growth in a long-running service is not.
            self._pending.pop(next(iter(self._pending)), None)
        self._pending[tool_use_id] = (command, stream, at)


def _tool_use_id_of(raw: dict[str, Any]) -> str | None:
    """Find the tool_use_id a user record is answering."""
    message = raw.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_result":
            value = block.get("tool_use_id")
            if isinstance(value, str):
                return value
    return None


def _task_completion(
    payload: dict[str, Any], stream: str, record: LogRecord
) -> CompletionEvent | None:
    """Build a completion from a `TaskUpdate` that marked a task done."""
    if str(payload.get("status", "")).lower() != "completed":
        return None
    task_id = str(payload.get("task_id") or payload.get("taskId") or payload.get("id") or "")
    if not task_id:
        return None
    return CompletionEvent(
        id=f"task:{record.session_id}:{task_id}",
        workstream=stream,
        kind="task_done",
        # The harness marked it completed -- an artifact, not a claim in prose.
        confidence="certain",
        at=record.at or 0.0,
        label=f"{stream} — task complete",
    )


def _todo_completions(
    payload: dict[str, Any], stream: str, record: LogRecord
) -> list[CompletionEvent]:
    """Build completions from completed items in a `TodoWrite` call."""
    todos = payload.get("todos")
    if not isinstance(todos, list):
        return []

    events: list[CompletionEvent] = []
    for item in todos:
        if not isinstance(item, dict):
            continue
        if str(item.get("status", "")).lower() != "completed":
            continue
        text = str(item.get("content") or item.get("activeForm") or "")
        if not text:
            continue
        digest = hashlib.sha1(text.encode()).hexdigest()[:10]
        events.append(
            CompletionEvent(
                id=f"todo:{record.session_id}:{digest}",
                workstream=stream,
                kind="task_done",
                # Self-declared: the model wrote "completed" about its own work.
                confidence="likely",
                at=record.at or 0.0,
                label=f"{stream} — {text[:60]}",
            )
        )
    return events


def partition(records: Iterable[LogRecord], cache_read_weight: float) -> tuple[
    list[UsageSample], list[ActivitySignal], list[CompletionEvent]
]:
    """Run every extractor over a batch of records.

    Args:
        records: Parsed log records.
        cache_read_weight: Multiplier for cached-read tokens.

    Returns:
        Usage samples, activity signals, and completion events.
    """
    extractor = CompletionExtractor()
    usage: list[UsageSample] = []
    activity: list[ActivitySignal] = []
    completions: list[CompletionEvent] = []

    for record in records:
        sample = extract_usage(record, cache_read_weight)
        if sample is not None:
            usage.append(sample)
        signal = extract_activity(record)
        if signal is not None:
            activity.append(signal)
        completions.extend(extractor.feed(record))

    return usage, activity, completions
