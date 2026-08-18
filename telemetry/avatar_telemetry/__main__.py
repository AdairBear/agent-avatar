"""Command line entry point.

    python3 -m avatar_telemetry                 # live, serving on 127.0.0.1:8787
    python3 -m avatar_telemetry --mock          # synthetic arc, no logs read
    python3 -m avatar_telemetry --once          # one tick to stdout, then exit
    python3 -m avatar_telemetry --mock --set energy=15 --set nourishment=80
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import Config
from .service import TelemetryService, serve


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI parser.

    Returns:
        A configured `ArgumentParser`.
    """
    parser = argparse.ArgumentParser(
        prog="avatar_telemetry",
        description="Local telemetry for the Agentic Avatar. Reads only this machine.",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="drive the gauges from synthetic values instead of session logs",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="compute one snapshot, print it, and exit (no server)",
    )
    parser.add_argument("--port", type=int, help="loopback port for the HTTP endpoint")
    parser.add_argument("--state-file", help="where to publish the JSON state file")
    parser.add_argument(
        "--lookback-days",
        type=float,
        help="how far back to read session logs on the first poll",
    )
    parser.add_argument(
        "--set",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="pin a mock gauge: nourishment, energy, health, is_working",
    )
    parser.add_argument("--verbose", action="store_true", help="debug logging")
    return parser


def apply_overrides(config: Config, args: argparse.Namespace) -> Config:
    """Fold CLI flags into the config.

    Args:
        config: Config built from defaults and environment.
        args: Parsed CLI arguments.

    Returns:
        The same config, mutated in place.
    """
    if args.port is not None:
        config.port = args.port
    if args.state_file:
        from pathlib import Path

        config.state_file = Path(args.state_file).expanduser()
    if args.lookback_days is not None:
        config.lookback_days = args.lookback_days
    return config


def parse_pins(pairs: list[str]) -> dict[str, float]:
    """Parse `--set key=value` pairs into gauge pins.

    Args:
        pairs: Raw `KEY=VALUE` strings.

    Returns:
        A mapping of gauge name to value.

    Raises:
        SystemExit: On a malformed pair.
    """
    pins: dict[str, float] = {}
    allowed = {"nourishment", "energy", "health", "is_working"}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit(f"--set expects KEY=VALUE, got {pair!r}")
        key, _, raw = pair.partition("=")
        key = key.strip()
        if key not in allowed:
            raise SystemExit(f"--set key must be one of {sorted(allowed)}, got {key!r}")
        raw = raw.strip().lower()
        if raw in ("true", "yes", "on"):
            pins[key] = 1.0
        elif raw in ("false", "no", "off"):
            pins[key] = 0.0
        else:
            try:
                pins[key] = float(raw)
            except ValueError:
                raise SystemExit(f"--set value must be a number, got {raw!r}") from None
    return pins


def main(argv: list[str] | None = None) -> int:
    """Run the CLI.

    Args:
        argv: Argument vector; defaults to `sys.argv[1:]`.

    Returns:
        Process exit code.
    """
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    config = apply_overrides(Config(), args)
    pins = parse_pins(args.set)
    if pins and not args.mock:
        raise SystemExit("--set only applies with --mock")

    if args.once:
        service = TelemetryService(config, mock=args.mock)
        if pins:
            service.pin_mock(**pins)
        payload = service.tick()
        service.write_state(payload)
        json.dump(payload, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    if pins:
        # Serve mode builds its own service, so pins go in via a pre-tick.
        import avatar_telemetry.service as service_module

        original = service_module.TelemetryService

        def _with_pins(*a, **kw):  # type: ignore[no-untyped-def]
            instance = original(*a, **kw)
            instance.pin_mock(**pins)
            return instance

        service_module.TelemetryService = _with_pins  # type: ignore[assignment]

    serve(config, mock=args.mock)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
