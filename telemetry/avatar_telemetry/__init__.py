"""Agentic Avatar telemetry backend.

Reads Thomas's LOCAL Claude Code session logs and computes the two gauges the
avatar renders from. Python standard library only: no third-party packages, no
API keys, no network egress. Everything it reads is already on this machine and
everything it writes stays on it.
"""

__version__ = "0.1.0"
