"""Speech to text through a local whisper.cpp server.

The bridge owns a `whisper-server` child bound to loopback, so the model is
loaded once and each utterance is a single HTTP request. No audio leaves the
Mac.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import wave

import aiohttp

from .config import Config

log = logging.getLogger("voice_bridge.asr")

# Whisper emits these for silence or noise. They are never dictation.
_NON_SPEECH = re.compile(r"[\[\(][^\]\)]{0,40}[\]\)]|♪+")


def clean(text: str) -> str:
    text = _NON_SPEECH.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()


class WhisperServer:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._proc: asyncio.subprocess.Process | None = None
        self._http: aiohttp.ClientSession | None = None
        self._url = f"http://127.0.0.1:{cfg.whisper_port}/inference"

    async def start(self) -> None:
        cfg = self.cfg
        self._proc = await asyncio.create_subprocess_exec(
            cfg.whisper_server_bin,
            "-m", cfg.whisper_model,
            "--host", "127.0.0.1",
            "--port", str(cfg.whisper_port),
            "-l", cfg.whisper_language,
            "--prompt", cfg.whisper_prompt,
            "-nt", "-sns",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
        for _ in range(120):
            if self._proc.returncode is not None:
                raise RuntimeError(f"whisper-server exited with code {self._proc.returncode}")
            try:
                async with self._http.get(f"http://127.0.0.1:{cfg.whisper_port}/") as r:
                    if r.status < 500:
                        log.info("whisper-server ready on 127.0.0.1:%d", cfg.whisper_port)
                        return
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("whisper-server did not become ready")

    async def stop(self) -> None:
        if self._http:
            await self._http.close()
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), 5)
            except asyncio.TimeoutError:
                self._proc.kill()

    async def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> str:
        assert self._http is not None, "start() first"
        form = aiohttp.FormData()
        form.add_field("file", wav_bytes(pcm, sample_rate), filename="u.wav", content_type="audio/wav")
        form.add_field("response_format", "json")
        form.add_field("temperature", "0.0")
        async with self._http.post(self._url, data=form) as r:
            r.raise_for_status()
            body = await r.json(content_type=None)
        return clean(body.get("text", ""))
