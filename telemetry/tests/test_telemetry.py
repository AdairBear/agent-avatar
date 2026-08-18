"""Tests for the telemetry backend. Standard library `unittest`, no deps.

Run with:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from avatar_telemetry.config import Config, meets_confidence
from avatar_telemetry.extract import (
    CompletionEvent,
    CompletionExtractor,
    UsageSample,
    extract_activity,
    extract_usage,
    partition,
    workstream_id,
)
from avatar_telemetry.gauges import (
    EnergyGauge,
    LivenessTracker,
    NourishmentGauge,
    Workstream,
    carousel_health,
)
from avatar_telemetry.scanner import LogRecord, LogScanner, parse_timestamp
from avatar_telemetry.service import TelemetryService
from avatar_telemetry.state import build_payload, is_working, resolve_state

T0 = 1_787_000_000.0


def cfg(**overrides) -> Config:
    """Build a config with test-friendly defaults."""
    config = Config()
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def completion(id_: str, *, confidence: str = "certain", at: float = T0, stream: str = "proj"):
    """Build a completion event."""
    return CompletionEvent(
        id=id_, workstream=stream, kind="commit", confidence=confidence, at=at, label=id_
    )


def assistant_record(blocks, *, at: str = "2026-08-18T00:00:00Z", cwd="/Users/t/projects/proj"):
    """Build an assistant log record carrying tool_use blocks."""
    return LogRecord(
        kind="assistant",
        at=parse_timestamp(at),
        session_id="sess",
        cwd=cwd,
        raw={"message": {"content": blocks}},
    )


def tool_result_record(tool_use_id, result, *, at="2026-08-18T00:00:05Z", cwd="/Users/t/projects/proj"):
    """Build a user record carrying a tool result."""
    return LogRecord(
        kind="user",
        at=parse_timestamp(at),
        session_id="sess",
        cwd=cwd,
        raw={
            "message": {"content": [{"type": "tool_result", "tool_use_id": tool_use_id}]},
            "toolUseResult": result,
        },
    )


class TestNourishment(unittest.TestCase):
    """The gauge fed only by completed work."""

    def test_accepts_certain_and_bumps(self):
        gauge = NourishmentGauge(cfg(), T0)
        self.assertTrue(gauge.offer(completion("a")))
        self.assertEqual(gauge.value, 12.0)
        self.assertEqual(gauge.accepted, 1)

    def test_dedups_by_id(self):
        """Replaying the log must not double-feed the creature."""
        gauge = NourishmentGauge(cfg(), T0)
        gauge.offer(completion("a"))
        self.assertFalse(gauge.offer(completion("a")))
        self.assertEqual(gauge.value, 12.0)

    def test_confidence_gate_rejects_likely_by_default(self):
        gauge = NourishmentGauge(cfg(), T0)
        self.assertFalse(gauge.offer(completion("a", confidence="likely")))
        self.assertEqual(gauge.value, 0.0)
        self.assertEqual(gauge.rejected, 1)

    def test_confidence_gate_can_be_loosened(self):
        gauge = NourishmentGauge(cfg(accept_confidence="likely"), T0)
        self.assertTrue(gauge.offer(completion("a", confidence="likely")))

    def test_guessing_never_counts(self):
        gauge = NourishmentGauge(cfg(accept_confidence="guessing"), T0)
        self.assertTrue(gauge.offer(completion("a", confidence="guessing")))
        self.assertTrue(meets_confidence("certain", "guessing"))
        self.assertFalse(meets_confidence("guessing", "certain"))

    def test_decays_by_half_life(self):
        gauge = NourishmentGauge(cfg(nourishment_half_life_days=1.0), T0)
        gauge.offer(completion("a"))
        gauge.offer(completion("b"))
        self.assertEqual(gauge.value, 24.0)
        gauge.decay_to(T0 + 86_400)
        self.assertAlmostEqual(gauge.value, 12.0, places=6)

    def test_decay_is_monotonic_and_never_negative(self):
        gauge = NourishmentGauge(cfg(nourishment_half_life_days=0.01), T0)
        gauge.offer(completion("a"))
        gauge.decay_to(T0 + 10_000_000)
        self.assertGreaterEqual(gauge.value, 0.0)

    def test_caps_at_100(self):
        gauge = NourishmentGauge(cfg(), T0)
        for i in range(20):
            gauge.offer(completion(f"c{i}"))
        self.assertEqual(gauge.value, 100.0)

    def test_tokens_cannot_feed_the_gauge(self):
        """Structural: there is no method taking a UsageSample."""
        gauge = NourishmentGauge(cfg(), T0)
        self.assertFalse(hasattr(gauge, "add"))
        for name in dir(gauge):
            self.assertNotIn("usage", name.lower())


class TestEnergy(unittest.TestCase):
    """The gauge drained by usage budget."""

    def test_no_data_is_not_a_full_tank(self):
        """The load-bearing invariant: absence must never read as healthy."""
        reading = EnergyGauge(cfg()).read(T0)
        self.assertFalse(reading.fresh)

    def test_full_budget_when_unused(self):
        gauge = EnergyGauge(cfg(energy_budget_tokens=1000))
        gauge.add([UsageSample(at=T0, weighted_tokens=0.0, session_id="s")])
        self.assertEqual(gauge.read(T0).value, 100.0)

    def test_drains_proportionally(self):
        gauge = EnergyGauge(cfg(energy_budget_tokens=1000))
        gauge.add([UsageSample(at=T0, weighted_tokens=250, session_id="s")])
        self.assertAlmostEqual(gauge.read(T0).value, 75.0)

    def test_bottoms_out_at_zero_not_below(self):
        gauge = EnergyGauge(cfg(energy_budget_tokens=1000))
        gauge.add([UsageSample(at=T0, weighted_tokens=99_999, session_id="s")])
        self.assertEqual(gauge.read(T0).value, 0.0)

    def test_recovers_as_usage_ages_out_of_window(self):
        """Energy refills on its own. It is a boundary, not a punishment."""
        gauge = EnergyGauge(cfg(energy_budget_tokens=1000, energy_window_hours=1.0))
        gauge.add([UsageSample(at=T0, weighted_tokens=1000, session_id="s")])
        self.assertEqual(gauge.read(T0).value, 0.0)
        self.assertEqual(gauge.read(T0 + 3_601).value, 100.0)

    def test_reports_when_it_recovers(self):
        gauge = EnergyGauge(cfg(energy_window_hours=5.0))
        gauge.add([UsageSample(at=T0, weighted_tokens=10, session_id="s")])
        self.assertAlmostEqual(gauge.read(T0).recovers_at, T0 + 5 * 3600)


class TestUsageExtraction(unittest.TestCase):
    """Turning assistant records into token cost."""

    def test_weights_cache_reads_down(self):
        record = LogRecord(
            kind="assistant",
            at=T0,
            session_id="s",
            cwd="/p",
            raw={
                "message": {
                    "usage": {
                        "input_tokens": 100,
                        "output_tokens": 200,
                        "cache_creation_input_tokens": 300,
                        "cache_read_input_tokens": 1000,
                    }
                }
            },
        )
        sample = extract_usage(record, 0.1)
        self.assertEqual(sample.weighted_tokens, 100 + 200 + 300 + 100)

    def test_ignores_non_assistant_records(self):
        record = LogRecord(kind="user", at=T0, session_id="s", cwd="/p", raw={})
        self.assertIsNone(extract_usage(record, 0.1))

    def test_ignores_records_without_usage(self):
        record = LogRecord(kind="assistant", at=T0, session_id="s", cwd="/p", raw={"message": {}})
        self.assertIsNone(extract_usage(record, 0.1))


class TestCompletionExtraction(unittest.TestCase):
    """Proving work actually finished."""

    def test_git_commit_success_is_certain(self):
        extractor = CompletionExtractor()
        blocks = [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git commit -m x"}}]
        self.assertEqual(extractor.feed(assistant_record(blocks)), [])
        events = extractor.feed(
            tool_result_record("t1", {"stdout": "[main a1b2c3d] feat: thing\n 1 file changed"})
        )
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].kind, "commit")
        self.assertEqual(events[0].confidence, "certain")
        self.assertIn("a1b2c3d", events[0].id)

    def test_failed_git_commit_yields_nothing(self):
        extractor = CompletionExtractor()
        blocks = [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git commit -m x"}}]
        extractor.feed(assistant_record(blocks))
        events = extractor.feed(tool_result_record("t1", {"stdout": "nothing to commit, working tree clean"}))
        self.assertEqual(events, [])

    def test_interrupted_command_yields_nothing(self):
        extractor = CompletionExtractor()
        blocks = [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git commit -m x"}}]
        extractor.feed(assistant_record(blocks))
        events = extractor.feed(
            tool_result_record("t1", {"stdout": "[main a1b2c3d] x", "interrupted": True})
        )
        self.assertEqual(events, [])

    def test_commit_id_is_stable_across_reparse(self):
        """Same commit seen twice must produce the same dedup key."""
        ids = []
        for _ in range(2):
            extractor = CompletionExtractor()
            blocks = [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git commit -m x"}}]
            extractor.feed(assistant_record(blocks))
            ids.append(extractor.feed(tool_result_record("t1", {"stdout": "[main a1b2c3d] x"}))[0].id)
        self.assertEqual(ids[0], ids[1])

    def test_task_update_completed_is_certain(self):
        extractor = CompletionExtractor()
        blocks = [
            {"type": "tool_use", "id": "t9", "name": "TaskUpdate",
             "input": {"task_id": "42", "status": "completed"}}
        ]
        events = extractor.feed(assistant_record(blocks))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].confidence, "certain")
        self.assertEqual(events[0].kind, "task_done")

    def test_task_update_in_progress_is_not_a_completion(self):
        extractor = CompletionExtractor()
        blocks = [
            {"type": "tool_use", "id": "t9", "name": "TaskUpdate",
             "input": {"task_id": "42", "status": "in_progress"}}
        ]
        self.assertEqual(extractor.feed(assistant_record(blocks)), [])

    def test_todo_completion_is_only_likely(self):
        """Self-declared done is not proof, so it stays below the default gate."""
        extractor = CompletionExtractor()
        blocks = [
            {"type": "tool_use", "id": "t2", "name": "TodoWrite",
             "input": {"todos": [{"content": "ship it", "status": "completed"},
                                 {"content": "later", "status": "pending"}]}}
        ]
        events = extractor.feed(assistant_record(blocks))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].confidence, "likely")
        self.assertFalse(NourishmentGauge(cfg(), T0).offer(events[0]))

    def test_passing_tests_are_likely_not_certain(self):
        extractor = CompletionExtractor()
        blocks = [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "pytest tests/"}}]
        extractor.feed(assistant_record(blocks))
        events = extractor.feed(tool_result_record("t3", {"stdout": "12 passed in 1.2s"}))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].confidence, "likely")

    def test_failing_tests_yield_nothing(self):
        extractor = CompletionExtractor()
        blocks = [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "pytest tests/"}}]
        extractor.feed(assistant_record(blocks))
        events = extractor.feed(tool_result_record("t3", {"stdout": "3 passed, 2 failed"}))
        self.assertEqual(events, [])

    def test_pending_map_is_bounded(self):
        """A never-answered tool call must not leak in a long-running service."""
        extractor = CompletionExtractor()
        for i in range(700):
            blocks = [{"type": "tool_use", "id": f"t{i}", "name": "Bash",
                       "input": {"command": "git commit -m x"}}]
            extractor.feed(assistant_record(blocks))
        self.assertLessEqual(len(extractor._pending), CompletionExtractor._MAX_PENDING)


class TestWorkstreams(unittest.TestCase):
    """Identity, liveness, and carousel health."""

    def test_id_from_project_dir(self):
        self.assertEqual(workstream_id("/Users/t/projects/agentic-avatar"), "agentic-avatar")

    def test_worktree_credits_the_parent_project(self):
        self.assertEqual(
            workstream_id("/Users/t/projects/trident-forge/.claude/worktrees/abc"), "trident-forge"
        )

    def test_empty_cwd_is_unknown(self):
        self.assertEqual(workstream_id(""), "unknown")

    def test_human_prompt_is_meaningful_tool_result_is_not(self):
        prompt = LogRecord(kind="user", at=T0, session_id="s", cwd="/p/proj",
                           raw={"message": {"content": "do the thing"}})
        self.assertTrue(extract_activity(prompt).meaningful)

        tool_echo = LogRecord(kind="user", at=T0, session_id="s", cwd="/p/proj",
                              raw={"message": {"content": []}, "toolUseResult": {"stdout": ""}})
        self.assertFalse(extract_activity(tool_echo).meaningful)

    def test_liveness_window_droops_quiet_streams(self):
        tracker = LivenessTracker(cfg(liveness_window_hours=6.0, min_records_per_workstream=1))
        tracker.note_completion(completion("a", at=T0, stream="loud"))
        tracker.note_completion(completion("b", at=T0 - 8 * 3600, stream="quiet"))
        streams = {w.id: w for w in tracker.resolve(T0)}
        self.assertTrue(streams["loud"].live)
        self.assertFalse(streams["quiet"].live)

    def test_thin_evidence_does_not_manufacture_a_workstream(self):
        tracker = LivenessTracker(cfg(min_records_per_workstream=3))
        tracker.note_completion(completion("a", stream="barely"))
        self.assertEqual(tracker.resolve(T0), [])

    def test_ignored_dirs_do_not_count(self):
        tracker = LivenessTracker(cfg(min_records_per_workstream=1))
        tracker.note_completion(completion("a", stream="scratchpad"))
        self.assertEqual(tracker.resolve(T0), [])

    def test_health_is_concurrent_liveness(self):
        config = cfg(healthy_workstream_count=3)
        live = [Workstream(f"w{i}", f"W{i}", True, T0, 0.0) for i in range(2)]
        dead = [Workstream("w9", "W9", False, T0, 99999.0)]
        self.assertAlmostEqual(carousel_health(live + dead, config), 200 / 3, places=3)

    def test_health_caps_at_100(self):
        config = cfg(healthy_workstream_count=2)
        live = [Workstream(f"w{i}", f"W{i}", True, T0, 0.0) for i in range(5)]
        self.assertEqual(carousel_health(live, config), 100.0)

    def test_health_is_zero_with_nothing_live(self):
        self.assertEqual(carousel_health([], cfg()), 0.0)


class TestStateResolution(unittest.TestCase):
    """The precedence ladder."""

    def _energy(self, value, fresh=True):
        from avatar_telemetry.gauges import EnergyReading

        return EnergyReading(value, fresh, 0.0, 0.0, 1.0, 5.0, None)

    def test_stale_beats_everything(self):
        state = resolve_state(self._energy(100, fresh=False), [], T0, cfg(), T0)
        self.assertEqual(state, "unknown")

    def test_zero_energy_sleeps(self):
        self.assertEqual(resolve_state(self._energy(0), [], T0, cfg(), T0), "sleep")

    def test_low_energy_is_drowsy(self):
        self.assertEqual(resolve_state(self._energy(10), [], None, cfg(), T0), "drowsy")

    def test_sleep_beats_a_fresh_completion(self):
        """A celebration must never override the boundary."""
        self.assertEqual(resolve_state(self._energy(0), [], T0, cfg(), T0), "sleep")

    def test_recent_completion_celebrates(self):
        self.assertEqual(resolve_state(self._energy(90), [], T0 - 1, cfg(), T0), "celebrate")

    def test_celebration_expires(self):
        self.assertEqual(resolve_state(self._energy(90), [], T0 - 600, cfg(), T0), "idle")

    def test_live_work_reads_as_working(self):
        streams = [Workstream("w", "W", True, T0, 0.0)]
        self.assertEqual(resolve_state(self._energy(90), streams, None, cfg(), T0), "working")

    def test_quiet_reads_as_idle(self):
        streams = [Workstream("w", "W", True, T0 - 7200, 7200.0)]
        self.assertEqual(resolve_state(self._energy(90), streams, None, cfg(), T0), "idle")

    def test_is_working_needs_recency_not_just_liveness(self):
        old = [Workstream("w", "W", True, T0 - 3600, 3600.0)]
        self.assertFalse(is_working(old, T0))
        self.assertTrue(is_working([Workstream("w", "W", True, T0 - 60, 60.0)], T0))


class TestPayload(unittest.TestCase):
    """The published contract."""

    def _payload(self, **kw):
        from avatar_telemetry.gauges import EnergyReading

        defaults = dict(
            now=T0,
            mode="live",
            nourishment=42.0,
            energy=EnergyReading(77.0, True, 0.23, 100.0, 1000.0, 5.0, T0 + 60),
            workstreams=[Workstream("w", "W", True, T0, 0.0)],
            pulses=[],
            last_completion_at=None,
            recent_completions=[],
            accepted=3,
            rejected=1,
            config=cfg(),
        )
        defaults.update(kw)
        return build_payload(**defaults)

    def test_rive_input_names_are_exact(self):
        """These four names are the contract with the .riv artboard."""
        self.assertEqual(
            set(self._payload()["rive_inputs"]),
            {"nourishment", "energy", "isWorking", "celebrate"},
        )

    def test_gauge_names_are_exact(self):
        self.assertEqual(set(self._payload()["gauges"]), {"nourishment", "energy", "health"})

    def test_rive_inputs_match_gauges(self):
        payload = self._payload()
        self.assertEqual(payload["rive_inputs"]["nourishment"], payload["gauges"]["nourishment"])
        self.assertEqual(payload["rive_inputs"]["energy"], payload["gauges"]["energy"])

    def test_is_json_serializable(self):
        json.dumps(self._payload())

    def test_carries_freshness_and_staleness_budget(self):
        payload = self._payload()
        self.assertIn("fresh", payload)
        self.assertGreater(payload["stale_after_seconds"], 0)


class TestScanner(unittest.TestCase):
    """Incremental reads over JSONL."""

    def test_reads_then_tails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "proj"
            project.mkdir()
            log_file = project / "s.jsonl"
            log_file.write_text(json.dumps({"type": "user", "timestamp": "2026-08-18T00:00:00Z",
                                            "sessionId": "s", "cwd": "/p/proj"}) + "\n")

            scanner = LogScanner(cfg(projects_dir=root, lookback_days=3650))
            self.assertEqual(len(list(scanner.poll())), 1)
            self.assertEqual(len(list(scanner.poll())), 0)

            with log_file.open("a") as handle:
                handle.write(json.dumps({"type": "assistant", "timestamp": "2026-08-18T00:00:01Z",
                                         "sessionId": "s", "cwd": "/p/proj"}) + "\n")
            self.assertEqual(len(list(scanner.poll())), 1)

    def test_skips_partial_trailing_line(self):
        """A half-written line must be left for the next poll, not parsed."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "proj").mkdir()
            log_file = root / "proj" / "s.jsonl"
            log_file.write_text('{"type":"user","timestamp":"2026-08-18T00:00:00Z"}\n{"type":"assi')

            scanner = LogScanner(cfg(projects_dir=root, lookback_days=3650))
            self.assertEqual(len(list(scanner.poll())), 1)

            with log_file.open("a") as handle:
                handle.write('stant","timestamp":"2026-08-18T00:00:01Z"}\n')
            self.assertEqual(len(list(scanner.poll())), 1)

    def test_survives_corrupt_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "proj").mkdir()
            (root / "proj" / "s.jsonl").write_text('not json\n{"type":"user"}\n')
            self.assertEqual(len(list(LogScanner(cfg(projects_dir=root, lookback_days=3650)).poll())), 1)

    def test_missing_projects_dir_is_not_fatal(self):
        scanner = LogScanner(cfg(projects_dir=Path("/nonexistent/nope")))
        self.assertEqual(list(scanner.poll()), [])

    def test_partition_runs_every_extractor(self):
        records = [
            LogRecord("assistant", T0, "s", "/p/proj",
                      {"message": {"usage": {"output_tokens": 10}}}),
            LogRecord("user", T0, "s", "/p/proj", {"message": {"content": "hi"}}),
        ]
        usage, activity, _ = partition(records, 0.1)
        self.assertEqual(len(usage), 1)
        self.assertEqual(len(activity), 2)


class TestService(unittest.TestCase):
    """End-to-end wiring."""

    def test_mock_tick_produces_a_valid_payload(self):
        service = TelemetryService(cfg(), mock=True, now=T0)
        payload = service.tick(T0)
        self.assertEqual(payload["mode"], "mock")
        self.assertIn(payload["state"], {"idle", "working", "celebrate", "drowsy", "sleep", "unknown"})

    def test_mock_pins_hold(self):
        service = TelemetryService(cfg(), mock=True, now=T0)
        service.pin_mock(nourishment=70.0, energy=15.0)
        payload = service.tick(T0)
        self.assertEqual(payload["gauges"]["nourishment"], 70.0)
        self.assertEqual(payload["gauges"]["energy"], 15.0)
        self.assertEqual(payload["state"], "drowsy")

    def test_mock_can_reach_sleep(self):
        service = TelemetryService(cfg(), mock=True, now=T0)
        service.pin_mock(energy=0.0)
        self.assertEqual(service.tick(T0)["state"], "sleep")

    def test_pinning_requires_mock_mode(self):
        service = TelemetryService(cfg(projects_dir=Path("/nonexistent")), mock=False, now=T0)
        with self.assertRaises(RuntimeError):
            service.pin_mock(energy=10.0)

    def test_live_tick_with_no_logs_is_unknown_not_healthy(self):
        """No data must never render as a happy creature."""
        service = TelemetryService(cfg(projects_dir=Path("/nonexistent/nope")), now=T0)
        payload = service.tick(T0)
        self.assertFalse(payload["fresh"])
        self.assertEqual(payload["state"], "unknown")

    def test_state_file_is_written_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested" / "state.json"
            service = TelemetryService(cfg(state_file=target), mock=True, now=T0)
            service.write_state(service.tick(T0))
            self.assertTrue(target.exists())
            self.assertEqual(json.loads(target.read_text())["mode"], "mock")
            self.assertFalse(list(target.parent.glob("*.tmp")))

    def test_pulses_are_bounded(self):
        service = TelemetryService(cfg(), mock=True, now=T0)
        payload = service.tick(T0 + 10_000)
        self.assertLessEqual(len(payload["pulses"]), 8)


if __name__ == "__main__":
    unittest.main()
