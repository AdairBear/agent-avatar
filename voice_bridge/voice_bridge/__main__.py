"""CLI: run the bridge, or set up the pieces around it.

    python -m voice_bridge                  run in the foreground
    python -m voice_bridge status           show config with secrets redacted
    python -m voice_bridge selftest         check Whisper, the codec and the Claude CLI
    python -m voice_bridge nvs-csv FILE     write the NVS source that points a device here
    python -m voice_bridge install-agent    run at login through launchd
    python -m voice_bridge uninstall-agent
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import plistlib
import signal
import socket
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

from aiohttp import web

from . import config as config_mod
from .asr import WhisperServer
from .server import Bridge, make_app

LABEL = "com.adairbear.voice-bridge"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LOG_FILE = Path.home() / "Library" / "Logs" / "voice-bridge.log"
SECRETS = ("ota_key", "ws_token")


def lan_address() -> str:
    """The address of the interface that holds the default route."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # no packet is sent for a UDP connect
        return s.getsockname()[0]
    finally:
        s.close()


def load_config() -> config_mod.Config:
    cfg = config_mod.load()
    if not cfg.public_host:
        cfg.public_host = lan_address()
        config_mod.save(cfg)
    return cfg


async def serve(cfg: config_mod.Config) -> None:
    from . import actions

    if not actions.accessibility_trusted(prompt=True):
        logging.getLogger("voice_bridge").warning(
            "Accessibility permission not granted to %s: dictation cannot paste yet", sys.executable)
    asr = WhisperServer(cfg)
    await asr.start()
    runner = web.AppRunner(make_app(Bridge(cfg, asr)), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, cfg.host, cfg.port).start()
    logging.getLogger("voice_bridge").info(
        "listening on %s:%d, devices reach it at %s", cfg.host, cfg.port, cfg.public_host)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await runner.cleanup()
        await asr.stop()


def cmd_run(_: argparse.Namespace) -> int:
    logging.basicConfig(level=os.environ.get("VOICE_BRIDGE_LOG", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(serve(load_config()))
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    data = asdict(load_config())
    for key in SECRETS:
        data[key] = "<set>" if data[key] else "<missing>"
    for key, value in data.items():
        print(f"{key:20} {value}")
    print(f"{'config file':20} {config_mod.CONFIG_PATH}")
    print(f"{'launchd agent':20} {'installed' if PLIST.exists() else 'not installed'}")
    return 0


async def selftest(cfg: config_mod.Config) -> int:
    """Exercise the real local pieces without a device and without pasting."""
    import time

    from . import actions
    from .opus import Decoder, Encoder

    phrase = "Claude, please open the telemetry scanner and add a test."
    pcm = await actions.synthesize(phrase, cfg, sample_rate=16000)
    if not pcm:
        print("FAIL  say could not synthesize speech")
        return 1
    dec = Decoder(16000)
    pcm = b"".join(dec.decode(p) for p in Encoder(16000, 60).encode_all(pcm))
    print(f"ok    speech synthesized and passed through Opus ({len(pcm) / 32000:.1f}s)")
    asr = WhisperServer(cfg)
    t0 = time.monotonic()
    await asr.start()
    print(f"ok    whisper-server loaded the model in {time.monotonic() - t0:.1f}s")
    try:
        for attempt in ("cold", "warm"):
            t0 = time.monotonic()
            text = await asr.transcribe(pcm)
            print(f"ok    {attempt} transcription in {time.monotonic() - t0:.2f}s: {text!r}")
    finally:
        await asr.stop()
    print(f"ok    routed as: {actions.route(text, cfg.default_mode)}")
    trusted = actions.accessibility_trusted()
    print(f"{'ok  ' if trusted else 'FAIL'}  Accessibility permission for {sys.executable}")
    binary = actions.find_claude(cfg)
    if not binary:
        print("FAIL  Claude Code CLI not found (answer mode will not work)")
        return 1
    reply, error = await actions.ask_claude("Reply with the single word: ready", [], cfg)
    if error:
        print(f"FAIL  Claude: {error}  [{binary}]")
        return 1
    print(f"ok    Claude replied: {reply!r}")
    return 0


def cmd_selftest(_: argparse.Namespace) -> int:
    return asyncio.run(selftest(load_config()))


def cmd_nvs_csv(args: argparse.Namespace) -> int:
    """Write the NVS CSV that makes a xiaozhi device check in here.

    The file contains the OTA secret, so it is written 0600 and never printed.
    """
    cfg = load_config()
    path = Path(args.file)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write("key,type,encoding,value\nwifi,namespace,,\n")
        fh.write(f"ota_url,data,string,{cfg.ota_url}\n")
    print(f"wrote {path} (points at {cfg.public_host}:{cfg.port})")
    return 0


def cmd_install_agent(_: argparse.Namespace) -> int:
    load_config()
    package_root = Path(__file__).resolve().parent.parent
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-m", "voice_bridge", "run"],
        "WorkingDirectory": str(package_root),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Interactive",
        "StandardOutPath": str(LOG_FILE),
        "StandardErrorPath": str(LOG_FILE),
        "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
    }
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    with open(PLIST, "wb") as fh:
        plistlib.dump(plist, fh)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], capture_output=True)
    result = subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], capture_output=True, text=True)
    if result.returncode:
        print(f"launchctl bootstrap failed: {result.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"installed {PLIST}\nlogs: {LOG_FILE}")
    return 0


def cmd_uninstall_agent(_: argparse.Namespace) -> int:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("removed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="voice-bridge", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run").set_defaults(func=cmd_run)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("selftest").set_defaults(func=cmd_selftest)
    nvs = sub.add_parser("nvs-csv")
    nvs.add_argument("file")
    nvs.set_defaults(func=cmd_nvs_csv)
    sub.add_parser("install-agent").set_defaults(func=cmd_install_agent)
    sub.add_parser("uninstall-agent").set_defaults(func=cmd_uninstall_agent)
    args = parser.parse_args()
    return (getattr(args, "func", None) or cmd_run)(args)


if __name__ == "__main__":
    sys.exit(main())
