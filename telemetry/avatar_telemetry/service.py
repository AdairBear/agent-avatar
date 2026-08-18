"""The service: poll loop, state file, and a loopback HTTP endpoint.

Nothing here reaches the network outward. The HTTP server binds 127.0.0.1 only,
there are no credentials anywhere in the process, and the only files read are
the session logs already on this machine.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import Config
from .extract import CompletionEvent, partition
from .gauges import EnergyGauge, LivenessTracker, NourishmentGauge
from .mock import MockSource
from .scanner import LogScanner
from .state import Pulse, build_payload

log = logging.getLogger(__name__)

#: How many recent completions ride along in the payload.
_RECENT_LIMIT = 12
#: How many pulses ride along before the oldest are dropped.
_MAX_PULSES = 8


class TelemetryService:
    """Computes the avatar payload from local logs (or from the mock source)."""

    def __init__(self, config: Config, *, mock: bool = False, now: float | None = None) -> None:
        """Initialize the service.

        Args:
            config: Runtime configuration.
            mock: When True, gauges are driven by `MockSource` instead of logs.
            now: Injectable clock for deterministic tests.
        """
        self.config = config
        self.mock = mock
        started = time.time() if now is None else now

        self._scanner = LogScanner(config)
        self._nourishment = NourishmentGauge(config, started)
        self._energy = EnergyGauge(config)
        self._liveness = LivenessTracker(config)
        self._mock_source = MockSource(config=config, started_at=started) if mock else None

        self._pulses: list[Pulse] = []
        self._recent: list[CompletionEvent] = []
        self._last_completion_at: float | None = None
        self._payload: dict[str, Any] | None = None
        self._lock = threading.Lock()

    @property
    def payload(self) -> dict[str, Any] | None:
        """The most recently computed payload, or None before the first tick."""
        with self._lock:
            return self._payload

    def pin_mock(self, **values: float) -> None:
        """Pin mock gauge values (the slider affordance).

        Args:
            **values: Any of `nourishment`, `energy`, `health`, `is_working`.

        Raises:
            RuntimeError: If the service is not running in mock mode.
        """
        if self._mock_source is None:
            raise RuntimeError("not running in mock mode")
        self._mock_source.pin(**values)

    def tick(self, now: float | None = None) -> dict[str, Any]:
        """Run one full pass and return the fresh payload.

        Args:
            now: Injectable clock, epoch seconds.

        Returns:
            The JSON-serializable payload.
        """
        now = time.time() if now is None else now
        payload = self._tick_mock(now) if self._mock_source else self._tick_live(now)
        with self._lock:
            self._payload = payload
        return payload

    def _tick_live(self, now: float) -> dict[str, Any]:
        """One pass over real session logs."""
        records = self._scanner.poll(now)
        usage, activity, completions = partition(records, self.config.cache_read_weight)

        self._energy.add(usage)
        self._liveness.add(activity)

        for event in sorted(completions, key=lambda c: c.at):
            if not self._nourishment.offer(event):
                continue
            self._liveness.note_completion(event)
            self._remember_completion(event, now)

        self._nourishment.decay_to(now)
        energy = self._energy.read(now)
        workstreams = self._liveness.resolve(now)

        return build_payload(
            now=now,
            mode="live",
            nourishment=self._nourishment.value,
            energy=energy,
            workstreams=workstreams,
            pulses=list(self._pulses),
            last_completion_at=self._last_completion_at,
            recent_completions=self._recent[:_RECENT_LIMIT],
            accepted=self._nourishment.accepted,
            rejected=self._nourishment.rejected,
            config=self.config,
        )

    def _tick_mock(self, now: float) -> dict[str, Any]:
        """One pass driven by the mock source."""
        source = self._mock_source
        assert source is not None

        for event in source.completions(now):
            if self._nourishment.offer(event):
                self._remember_completion(event, now)

        return build_payload(
            now=now,
            mode="mock",
            nourishment=source.nourishment(now),
            energy=source.energy(now),
            workstreams=source.workstreams(now),
            pulses=list(self._pulses),
            last_completion_at=self._last_completion_at,
            recent_completions=self._recent[:_RECENT_LIMIT],
            accepted=self._nourishment.accepted,
            rejected=self._nourishment.rejected,
            config=self.config,
        )

    def _remember_completion(self, event: CompletionEvent, now: float) -> None:
        """Record a completion for pulses, recency, and the payload's list."""
        self._recent.insert(0, event)
        del self._recent[_RECENT_LIMIT:]
        self._last_completion_at = max(self._last_completion_at or 0.0, event.at)
        self._pulses.append(
            Pulse(id=f"celebrate:{event.id}", kind="celebrate", at=event.at, label=event.label)
        )
        del self._pulses[:-_MAX_PULSES]

    def write_state(self, payload: dict[str, Any]) -> None:
        """Write the payload to the state file atomically.

        A partially-written file would be parsed as corrupt by a consumer
        mid-poll, so write a sibling temp file and rename over the target.

        Args:
            payload: The document to publish.
        """
        target = self.config.state_file
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix(".json.tmp")
            temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            os.replace(temp, target)
        except OSError as error:
            # Loud: a consumer reading a stale file must not be the first place
            # this surfaces.
            log.error("could not write state file %s: %s", target, error)


class _Handler(BaseHTTPRequestHandler):
    """Read-only JSON endpoint over loopback."""

    service: TelemetryService

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        """Route GET requests."""
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"

        if route in ("/", "/state"):
            payload = self.service.payload
            if payload is None:
                self._json({"error": "no snapshot yet"}, status=503)
            else:
                self._json(payload)
        elif route == "/healthz":
            payload = self.service.payload
            self._json(
                {
                    "ok": payload is not None,
                    "mode": "mock" if self.service.mock else "live",
                    "at": payload.get("at") if payload else None,
                }
            )
        elif route == "/mock":
            self._handle_mock(parse_qs(parsed.query))
        else:
            self._json({"error": "not found"}, status=404)

    def _handle_mock(self, query: dict[str, list[str]]) -> None:
        """Pin mock gauge values from query parameters."""
        if not self.service.mock:
            self._json({"error": "service is not in mock mode"}, status=409)
            return

        values: dict[str, float] = {}
        for key in ("nourishment", "energy", "health", "is_working"):
            if key not in query:
                continue
            raw = query[key][0]
            if raw.lower() in ("true", "yes", "on"):
                values[key] = 1.0
            elif raw.lower() in ("false", "no", "off"):
                values[key] = 0.0
            else:
                try:
                    values[key] = float(raw)
                except ValueError:
                    self._json({"error": f"bad value for {key}: {raw!r}"}, status=400)
                    return

        self.service.pin_mock(**values)
        self._json({"pinned": values, "state": self.service.tick()})

    def _json(self, body: dict[str, Any], status: int = 200) -> None:
        """Write a JSON response."""
        encoded = json.dumps(body, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        # The renderer fetches this from a file:// page.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Route access logs through logging instead of stderr spam."""
        log.debug("http %s", fmt % args)


def serve(config: Config, *, mock: bool = False) -> None:
    """Run the poll loop and the HTTP endpoint until interrupted.

    Args:
        config: Runtime configuration.
        mock: When True, drive gauges from the mock source.
    """
    service = TelemetryService(config, mock=mock)

    handler = type("_BoundHandler", (_Handler,), {"service": service})
    # Loopback only, always. This service must not be reachable off-machine.
    httpd = ThreadingHTTPServer((config.host, config.port), handler)

    stop = threading.Event()

    def poll_loop() -> None:
        """Tick, publish, sleep -- forever."""
        while not stop.is_set():
            try:
                payload = service.tick()
                service.write_state(payload)
            except Exception as error:  # noqa: BLE001 - the loop must survive one bad tick
                # Loud and specific. A silent poll loop is indistinguishable
                # from a healthy idle one, which is the failure mode this
                # whole gauge design exists to avoid.
                log.exception("tick failed: %s", error)
            stop.wait(config.poll_seconds)

    worker = threading.Thread(target=poll_loop, name="avatar-poll", daemon=True)
    worker.start()

    log.info(
        "agentic-avatar telemetry (%s) on http://%s:%d/state — writing %s",
        "mock" if mock else "live",
        config.host,
        config.port,
        config.state_file,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        stop.set()
        httpd.shutdown()
        httpd.server_close()


def resolve_state_path(config: Config) -> Path:
    """Return the configured state file path.

    Args:
        config: Runtime configuration.

    Returns:
        The absolute path the service publishes to.
    """
    return config.state_file
