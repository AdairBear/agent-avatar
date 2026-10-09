"""What the bridge does with a transcript: paste it, ask Claude, speak a reply.

Everything here uses what is already on the Mac (`pbcopy`, a synthetic
Cmd-V, `say`, the Claude Code CLI). Each function reports failure to its
caller instead of raising past it, so the device can show what went wrong.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import re
import shutil
import tempfile
import wave
from pathlib import Path

from . import macos
from .config import Config

log = logging.getLogger("voice_bridge.actions")

ASK_SYSTEM_PROMPT = (
    "You are answering through a small voice panel on the user's desk. The reply is "
    "shown on a 2-inch screen and may be read aloud, so answer in plain spoken "
    "English: no markdown, no lists, no code blocks, and at most three short "
    "sentences unless the user asks for more. If the question needs a long or "
    "code-heavy answer, give the short version and say it is better asked at the keyboard."
)

# "Claude, ..." / "Hey Claude ..." / "Ask Claude ..." with Whisper's usual misspellings.
_ASK_PREFIX = re.compile(
    r"^\s*(?:(?:hey|hi|ok|okay)[\s,]+)?(?:ask\s+)?(?:claude|claud|clawed|clod)\b[\s,.:;!?-]*",
    re.IGNORECASE,
)


def route(text: str, default_mode: str) -> tuple[str, str]:
    """Decide ("dictate" | "ask", text) for one utterance."""
    m = _ASK_PREFIX.match(text)
    if m:
        rest = text[m.end():].strip()
        if rest:
            return "ask", rest[0].upper() + rest[1:]
    return default_mode, text


async def _run(*argv: str, stdin: bytes | None = None, timeout: float = 30) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "", "timed out"
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def accessibility_trusted(prompt: bool = False) -> bool:
    """Whether macOS lets this process post keystrokes.

    With prompt=True, macOS shows its "allow in System Settings" dialog once
    if the process is not yet trusted.
    """
    return macos.ax_trusted(prompt)


async def paste(text: str, cfg: Config) -> str | None:
    """Paste into the focused app. Returns an error string, or None on success."""
    if not accessibility_trusted():
        return "Mac needs Accessibility permission for voice bridge"
    if cfg.paste_trailing_space:
        text += " "
    code, _, err = await _run("/usr/bin/pbcopy", stdin=text.encode())
    if code:
        return f"Clipboard failed: {err.strip()}"
    # Give the pasteboard a moment to settle before Cmd-V reads it.
    await asyncio.sleep(0.05)
    macos.press_cmd_v()
    return None


def find_claude(cfg: Config) -> str | None:
    if cfg.claude_bin:
        return cfg.claude_bin if os.access(cfg.claude_bin, os.X_OK) else None
    found = shutil.which("claude")
    if found:
        return found
    for extra in ("~/.local/bin/claude", "~/.claude/local/claude", "/opt/homebrew/bin/claude"):
        path = os.path.expanduser(extra)
        if os.access(path, os.X_OK):
            return path
    # The copy bundled with the Claude desktop app. The path changes per version.
    bundled = sorted(glob.glob(os.path.expanduser(
        "~/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"
    )))
    return bundled[-1] if bundled else None


async def ask_claude(text: str, history: list[tuple[str, str]], cfg: Config) -> tuple[str | None, str | None]:
    """Ask Claude through the Claude Code CLI. Returns (reply, error)."""
    binary = find_claude(cfg)
    if not binary:
        return None, "Claude Code CLI not found on this Mac"
    prompt = text
    if history:
        turns = "\n".join(f"User: {q}\nYou: {a}" for q, a in history)
        prompt = f"Earlier in this spoken conversation:\n{turns}\n\nUser now says: {text}"
    code, out, err = await _run(
        binary, "-p", prompt,
        "--model", cfg.claude_model,
        "--system-prompt", ASK_SYSTEM_PROMPT,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        timeout=cfg.claude_timeout_s,
    )
    reply = out.strip()
    if code == 124:
        return None, "Claude took too long"
    if "Not logged in" in reply or "Not logged in" in err or "/login" in reply:
        return None, "Claude Code is not logged in on this Mac"
    if code or not reply:
        log.warning("claude exited %d: %s", code, (err or reply).strip()[:300])
        return None, "Claude call failed"
    return reply, None


_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def sentences(text: str, max_len: int = 220) -> list[str]:
    """Split a reply into display- and speech-sized pieces."""
    out: list[str] = []
    for part in _SENTENCE.split(text.replace("\n", " ").strip()):
        part = part.strip()
        while len(part) > max_len:
            cut = part.rfind(" ", 0, max_len)
            cut = cut if cut > 0 else max_len
            out.append(part[:cut])
            part = part[cut:].strip()
        if part:
            out.append(part)
    return out


async def synthesize(text: str, cfg: Config, sample_rate: int = 24000) -> bytes | None:
    """Text to 16-bit mono PCM with the macOS `say` voice. None on failure."""
    with tempfile.TemporaryDirectory(prefix="voice-bridge-") as tmp:
        path = Path(tmp) / "tts.wav"
        argv = ["/usr/bin/say", "-o", str(path), f"--data-format=LEI16@{sample_rate}",
                "-r", str(cfg.tts_rate_wpm)]
        if cfg.tts_voice:
            argv += ["-v", cfg.tts_voice]
        code, _, err = await _run(*argv, text, timeout=30)
        if code or not path.exists():
            log.warning("say failed: %s", err.strip()[:200])
            return None
        with wave.open(str(path), "rb") as w:
            return w.readframes(w.getnframes())
