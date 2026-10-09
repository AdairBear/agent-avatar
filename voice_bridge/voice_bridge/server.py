"""The single LAN listener: xiaozhi OTA endpoint + xiaozhi WebSocket.

A stock xiaozhi-esp32 firmware does two things on boot:

1. POSTs its system info to an "OTA" URL and reads back where its server is.
   We answer with our own WebSocket URL and token, and a firmware version of
   0.0.0 so it never tries to self-update.
2. On a button press or wake word, opens that WebSocket, exchanges `hello`,
   and streams Opus frames.

Both are authenticated: the OTA URL carries a secret query key, the WebSocket
needs the bearer token that the OTA reply handed out. Everything else on this
port is a 404.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
import uuid
from typing import Awaitable, Callable, Protocol

from aiohttp import WSMsgType, web

from . import actions
from .config import Config
from .opus import Decoder, Encoder, OpusError
from .vad import Segmenter

log = logging.getLogger("voice_bridge.server")

DEVICE_SAMPLE_RATE = 16000  # what the firmware sends
REPLY_SAMPLE_RATE = 24000   # what we send back; announced in our hello
FRAME_MS = 60

BRIDGE = web.AppKey("bridge", "Bridge")


class Transcriber(Protocol):
    async def transcribe(self, pcm: bytes, sample_rate: int = ...) -> str: ...


class Bridge:
    """Shared state and the injectable side effects (so tests need no Mac APIs)."""

    def __init__(
        self,
        cfg: Config,
        asr: Transcriber,
        paste: Callable[[str, Config], Awaitable[str | None]] = actions.paste,
        ask: Callable[[str, list, Config], Awaitable[tuple[str | None, str | None]]] = actions.ask_claude,
        synthesize: Callable[[str, Config], Awaitable[bytes | None]] = actions.synthesize,
    ):
        self.cfg = cfg
        self.asr = asr
        self.paste = paste
        self.ask = ask
        self.synthesize = synthesize
        self.history: list[tuple[str, str]] = []
        self.history_at = 0.0
        # Workers outlive their socket so a tap-to-stop still gets transcribed.
        self.workers: set[asyncio.Task] = set()

    def recent_history(self) -> list[tuple[str, str]]:
        if time.monotonic() - self.history_at > self.cfg.history_ttl_s:
            self.history.clear()
        return list(self.history)

    def remember(self, question: str, answer: str) -> None:
        self.history.append((question, answer))
        del self.history[: -self.cfg.history_turns]
        self.history_at = time.monotonic()


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def _device_allowed(request: web.Request, cfg: Config) -> bool:
    if not cfg.allowed_device_ids:
        return True
    device = request.headers.get("Device-Id", "").lower()
    return device in {d.lower() for d in cfg.allowed_device_ids}


async def handle_ota(request: web.Request) -> web.Response:
    cfg = request.app[BRIDGE].cfg
    if not _eq(request.query.get("k", ""), cfg.ota_key):
        log.warning("OTA refused: bad key from %s", request.remote)
        raise web.HTTPNotFound()
    if not _device_allowed(request, cfg):
        log.warning("OTA refused: device %s not in allowlist", request.headers.get("Device-Id"))
        raise web.HTTPForbidden()
    log.info("OTA check-in from device %s at %s", request.headers.get("Device-Id"), request.remote)
    offset_min = -(time.altzone if time.localtime().tm_isdst else time.timezone) // 60
    return web.json_response({
        "websocket": {"url": cfg.ws_url, "token": cfg.ws_token, "version": 1},
        "server_time": {"timestamp": int(time.time() * 1000), "timezone_offset": offset_min},
        "firmware": {"version": "0.0.0", "url": ""},
    })


async def handle_health(request: web.Request) -> web.Response:
    if request.remote not in ("127.0.0.1", "::1"):
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


class Session:
    """One open WebSocket from the device."""

    def __init__(self, ws: web.WebSocketResponse, bridge: Bridge):
        self.ws = ws
        self.bridge = bridge
        self.cfg = bridge.cfg
        self.id = uuid.uuid4().hex[:12]
        self.decoder = Decoder(DEVICE_SAMPLE_RATE)
        self.segmenter = Segmenter(
            DEVICE_SAMPLE_RATE, self.cfg.silence_ms, self.cfg.min_speech_ms,
            self.cfg.max_utterance_s, self.cfg.min_rms,
        )
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.busy = False
        self.abort = asyncio.Event()
        self.last_activity = time.monotonic()
        self.deaf_until = 0.0

    async def send(self, **message) -> None:
        if not self.ws.closed:
            message.setdefault("session_id", self.id)
            try:
                await self.ws.send_str(json.dumps(message))
            except (ConnectionError, RuntimeError):
                pass

    async def alert(self, message: str) -> None:
        log.warning("alert to device: %s", message)
        await self.send(type="alert", status="Voice bridge", message=message, emotion="sad")

    # --- inbound -----------------------------------------------------------

    async def on_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        kind = msg.get("type")
        if kind == "hello":
            await self.send(
                type="hello", transport="websocket",
                audio_params={"format": "opus", "sample_rate": REPLY_SAMPLE_RATE,
                              "channels": 1, "frame_duration": FRAME_MS},
            )
        elif kind == "listen":
            state = msg.get("state")
            log.info("listen %s %s", state, msg.get("mode", ""))
            if state == "start":
                self.last_activity = time.monotonic()
            elif state == "stop":
                self._finish(self.segmenter.flush())
        elif kind == "abort":
            self.abort.set()

    def on_audio(self, packet: bytes) -> None:
        if self.busy or time.monotonic() < self.deaf_until:
            return
        try:
            pcm = self.decoder.decode(packet)
        except OpusError as exc:
            log.debug("dropping undecodable frame: %s", exc)
            return
        self._finish(self.segmenter.feed(pcm))
        if self.segmenter.in_speech:
            self.last_activity = time.monotonic()

    def _finish(self, utterance: bytes | None) -> None:
        if utterance:
            self.queue.put_nowait(utterance)

    def close_input(self) -> None:
        """The socket is gone: transcribe whatever was mid-utterance, then stop."""
        self._finish(self.segmenter.flush())
        self.queue.put_nowait(None)

    # --- work --------------------------------------------------------------

    async def worker(self) -> None:
        while True:
            utterance = await self.queue.get()
            if utterance is None:
                return
            self.busy = True
            try:
                await self.handle_utterance(utterance)
            except Exception:
                log.exception("utterance failed")
                await self.alert("Something went wrong")
            finally:
                self.busy = False
                self.last_activity = time.monotonic()

    async def handle_utterance(self, pcm: bytes) -> None:
        t0 = time.monotonic()
        seconds = len(pcm) / 2 / DEVICE_SAMPLE_RATE
        text = await self.bridge.asr.transcribe(pcm, DEVICE_SAMPLE_RATE)
        log.info("utterance %.1fs -> %d chars in %.2fs", seconds, len(text), time.monotonic() - t0)
        if not text:
            return
        if self.cfg.log_transcripts:
            log.info("heard: %s", text)
        mode, text = actions.route(text, self.cfg.default_mode)
        await self.send(type="stt", text=text)
        if mode == "ask":
            await self.answer(text)
        else:
            error = await self.bridge.paste(text, self.cfg)
            if error:
                await self.alert(error)

    async def answer(self, question: str) -> None:
        await self.send(type="llm", emotion="thinking")
        reply, error = await self.bridge.ask(question, self.bridge.recent_history(), self.cfg)
        if error or not reply:
            await self.alert(error or "No reply")
            return
        self.bridge.remember(question, reply)
        await self.send(type="llm", emotion="neutral")
        self.abort.clear()
        await self.send(type="tts", state="start")
        try:
            for sentence in actions.sentences(reply):
                if self.abort.is_set() or self.ws.closed:
                    break
                pcm = await self.bridge.synthesize(sentence, self.cfg) if self.cfg.tts else None
                await self.send(type="tts", state="sentence_start", text=sentence)
                if pcm:
                    await self.play(pcm)
                else:
                    # No audio: hold the sentence on screen for about reading time.
                    await self._wait(min(max(len(sentence) / 16, 1.5), 10))
        finally:
            await self.send(type="tts", state="stop")
            self.deaf_until = time.monotonic() + 0.4

    async def play(self, pcm: bytes) -> None:
        """Send Opus frames at playback speed, slightly ahead of real time."""
        frames = Encoder(REPLY_SAMPLE_RATE, FRAME_MS).encode_all(pcm)
        start = time.monotonic()
        lead = 0.18
        for i, frame in enumerate(frames):
            if self.abort.is_set() or self.ws.closed:
                return
            delay = start + i * FRAME_MS / 1000 - lead - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            try:
                await self.ws.send_bytes(frame)
            except (ConnectionError, RuntimeError):
                return
        await self._wait(lead)

    async def _wait(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.abort.wait(), seconds)
        except asyncio.TimeoutError:
            pass

    async def idle_watchdog(self) -> None:
        while not self.ws.closed:
            await asyncio.sleep(1)
            idle = time.monotonic() - self.last_activity
            if not self.busy and self.queue.empty() and idle > self.cfg.idle_close_s:
                log.info("closing idle session after %.0fs", idle)
                await self.ws.close()
                return


async def handle_ws(request: web.Request) -> web.StreamResponse:
    bridge = request.app[BRIDGE]
    cfg = bridge.cfg
    presented = request.headers.get("Authorization", "")
    presented = presented[7:] if presented.lower().startswith("bearer ") else presented
    if not _eq(presented.strip(), cfg.ws_token):
        log.warning("WebSocket refused: bad token from %s", request.remote)
        raise web.HTTPUnauthorized()
    if not _device_allowed(request, cfg):
        log.warning("WebSocket refused: device %s not in allowlist", request.headers.get("Device-Id"))
        raise web.HTTPForbidden()

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=256 * 1024)
    await ws.prepare(request)
    session = Session(ws, bridge)
    log.info("session %s opened by %s", session.id, request.headers.get("Device-Id"))
    worker = asyncio.create_task(session.worker())
    bridge.workers.add(worker)
    worker.add_done_callback(bridge.workers.discard)
    watchdog = asyncio.create_task(session.idle_watchdog())
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                session.on_audio(msg.data)
            elif msg.type == WSMsgType.TEXT:
                await session.on_text(msg.data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        watchdog.cancel()
        session.abort.set()
        # Not awaited: aiohttp may cancel this handler when the peer vanishes.
        session.close_input()
        log.info("session %s closed", session.id)
    return ws


def make_app(bridge: Bridge) -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app[BRIDGE] = bridge
    app.router.add_route("*", "/xiaozhi/ota/", handle_ota)
    app.router.add_get("/xiaozhi/v1/", handle_ws)
    app.router.add_get("/healthz", handle_health)
    return app
