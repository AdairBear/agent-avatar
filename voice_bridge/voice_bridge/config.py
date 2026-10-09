"""Configuration: one JSON file, created with fresh secrets on first run.

The file lives outside the repo so the tokens can never be committed. It is
written 0600. Every field has a default, so an old file keeps working when a
new field is added.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

APP_DIR = Path.home() / "Library" / "Application Support" / "voice-bridge"
CONFIG_PATH = Path(os.environ.get("VOICE_BRIDGE_CONFIG", APP_DIR / "config.json"))


@dataclass
class Config:
    # --- the single LAN listener -------------------------------------------
    host: str = "0.0.0.0"
    port: int = 8790
    # Address the *device* should use to reach this Mac. Baked into the OTA
    # reply as the WebSocket URL, so it must be reachable from the board.
    public_host: str = ""
    # Secret in the OTA URL the device stores (http://host:port/xiaozhi/ota/?k=...).
    ota_key: str = ""
    # Bearer token the device presents on the WebSocket handshake.
    ws_token: str = ""
    # Device-Id (MAC) allowlist. Empty list = any device holding the secrets.
    allowed_device_ids: list[str] = field(default_factory=list)
    # An app image (xiaozhi.bin, not the merged image) to install over the air.
    # A device is offered it at check-in only while it runs a different build.
    # Empty = never offer an upgrade.
    firmware_path: str = ""

    # --- speech to text (whisper.cpp server, loopback only) -----------------
    whisper_server_bin: str = "/opt/homebrew/bin/whisper-server"
    whisper_model: str = str(APP_DIR / "models" / "ggml-large-v3-turbo-q5_0.bin")
    whisper_port: int = 8791
    whisper_language: str = "en"
    # Biases spelling of words Whisper would otherwise guess at. Keep it a
    # sentence that does not *start* with "Claude": a prompt that does makes
    # Whisper drop a leading "Claude," from the transcript.
    whisper_prompt: str = "Notes dictated to Claude Code by a software developer."

    # --- end-pointing -------------------------------------------------------
    silence_ms: int = 1000
    min_speech_ms: int = 300
    max_utterance_s: int = 90
    min_rms: int = 350
    # Close the session after this long with no speech, so the mic is not
    # left open indefinitely in the firmware's continuous-listening mode.
    idle_close_s: int = 45

    # --- what to do with the text ------------------------------------------
    # "dictate": paste into the focused app. "ask": send to Claude.
    # Whatever the default, an utterance starting with "Claude, ..." asks.
    default_mode: str = "dictate"
    paste_trailing_space: bool = True

    # --- Claude (answer mode) ----------------------------------------------
    # Empty = find `claude` on PATH, else the copy bundled with Claude desktop.
    claude_bin: str = ""
    claude_model: str = "sonnet"
    claude_timeout_s: int = 120
    history_turns: int = 6
    history_ttl_s: int = 600

    # --- replies ------------------------------------------------------------
    tts: bool = True
    tts_voice: str = ""  # empty = system default voice
    tts_rate_wpm: int = 190

    log_transcripts: bool = False
    # Diagnostic: keep the last session's microphone audio as a WAV in the
    # config directory. Off by default; it is a recording of the room.
    keep_session_audio: bool = False

    @property
    def ota_url(self) -> str:
        return f"http://{self.public_host}:{self.port}/xiaozhi/ota/?k={self.ota_key}"

    @property
    def firmware_url(self) -> str:
        return f"http://{self.public_host}:{self.port}/xiaozhi/firmware/?k={self.ota_key}"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.public_host}:{self.port}/xiaozhi/v1/"


def load(path: Path = CONFIG_PATH) -> Config:
    """Load the config, creating it (with new secrets) if it does not exist."""
    known = {f.name for f in fields(Config)}
    data: dict = {}
    if path.exists():
        data = {k: v for k, v in json.loads(path.read_text()).items() if k in known}
    cfg = Config(**data)
    changed = not path.exists()
    if not cfg.ota_key:
        cfg.ota_key, changed = secrets.token_urlsafe(24), True
    if not cfg.ws_token:
        cfg.ws_token, changed = secrets.token_urlsafe(32), True
    if changed:
        save(cfg, path)
    return cfg


def save(cfg: Config, path: Path = CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(asdict(cfg), fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
