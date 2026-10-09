"""Bridge tests. No device, no Whisper, no macOS side effects.

A fake device speaks the xiaozhi protocol at the real aiohttp app; the
transcriber, paste, Claude and speech are injected fakes.

    uv run python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from voice_bridge import actions, asr
from voice_bridge.config import Config
from voice_bridge.opus import Decoder, Encoder
from voice_bridge.server import Bridge, make_app
from voice_bridge.vad import Segmenter

RATE = 16000
FRAME = RATE * 60 // 1000


def tone(ms: int, amplitude: int = 8000, rate: int = RATE) -> bytes:
    n = rate * ms // 1000
    return struct.pack(f"<{n}h", *(int(amplitude * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n)))


def silence(ms: int, rate: int = RATE) -> bytes:
    return b"\x00" * (rate * ms // 1000 * 2)


def hiss(ms: int, level: int, rate: int = RATE) -> bytes:
    """Steady noise at about `level` RMS."""
    rng = random.Random(level)
    n = rate * ms // 1000
    return struct.pack(f"<{n}h", *(int(rng.gauss(0, level)) for _ in range(n)))


def frames(pcm: bytes, size: int = FRAME * 2):
    return [pcm[i : i + size] for i in range(0, len(pcm), size)]


class OpusTest(unittest.TestCase):
    def test_round_trip_keeps_length_and_energy(self):
        enc, dec = Encoder(RATE, 60), Decoder(RATE)
        pcm = tone(600)
        out = b"".join(dec.decode(p) for p in enc.encode_all(pcm))
        self.assertEqual(len(out), len(pcm))
        self.assertGreater(max(struct.unpack(f"<{len(out) // 2}h", out)), 2000)

    def test_short_final_frame_is_padded(self):
        enc = Encoder(24000, 60)
        self.assertEqual(len(enc.encode_all(b"\x01\x00" * 100)), 1)


class SegmenterTest(unittest.TestCase):
    def feed(self, seg: Segmenter, pcm: bytes):
        return [u for u in (seg.feed(f) for f in frames(pcm)) if u]

    def test_speech_then_silence_yields_one_utterance(self):
        seg = Segmenter(silence_ms=600)
        got = self.feed(seg, silence(300) + tone(900) + silence(900))
        self.assertEqual(len(got), 1)
        self.assertGreaterEqual(len(got[0]), len(tone(900)))

    def test_silence_alone_yields_nothing(self):
        self.assertEqual(self.feed(Segmenter(), silence(3000)), [])

    def test_click_is_too_short_to_count(self):
        seg = Segmenter(silence_ms=300, min_speech_ms=300)
        self.assertEqual(self.feed(seg, silence(300) + tone(120) + silence(900)), [])

    def test_flush_ends_an_open_utterance(self):
        seg = Segmenter()
        self.feed(seg, tone(900))
        self.assertTrue(seg.in_speech)
        self.assertIsNotNone(seg.flush())
        self.assertIsNone(seg.flush())

    def test_quiet_speech_in_a_quiet_room_is_heard(self):
        # The levels the panel's mic actually produced: floor near 50, speech 250-800.
        seg = Segmenter(silence_ms=600)
        got = self.feed(seg, hiss(600, 50) + tone(1200, 450) + hiss(900, 50))
        self.assertEqual(len(got), 1)

    def test_steady_loud_noise_is_not_speech(self):
        seg = Segmenter(silence_ms=600)
        self.assertEqual(self.feed(seg, hiss(6000, 400)), [])
        self.assertFalse(seg.in_speech)
        # ... and speech over that noise still is.
        got = self.feed(seg, tone(900, 4000) + hiss(900, 400))
        self.assertEqual(len(got), 1)

    def test_room_noise_does_not_trigger(self):
        seg = Segmenter()
        self.assertEqual(self.feed(seg, hiss(5000, 50)), [])
        self.assertEqual(seg.loud_frames, 0)

    def test_long_speech_with_short_gaps_stays_one_utterance(self):
        seg = Segmenter(silence_ms=1000)
        speech = b"".join(tone(540, 600) + hiss(120, 50) for _ in range(12))
        got = self.feed(seg, hiss(600, 50) + speech + hiss(1200, 50))
        self.assertEqual(len(got), 1)
        self.assertGreaterEqual(len(got[0]), len(speech))

    def test_max_length_forces_a_cut(self):
        seg = Segmenter(max_utterance_s=1)
        # Speech-shaped: bursts with short dips, as a floor-tracking segmenter expects.
        speech = b"".join(tone(540) + hiss(60, 50) for _ in range(4)) + tone(100)
        self.assertEqual(len(self.feed(seg, speech)), 2)


class RouteTest(unittest.TestCase):
    def test_plain_speech_dictates(self):
        self.assertEqual(actions.route("Fix the login bug.", "dictate"), ("dictate", "Fix the login bug."))

    def test_claude_prefix_asks(self):
        for said in ("Claude, what is a mutex?", "Hey Claude what is a mutex?", "ask claude: what is a mutex?"):
            self.assertEqual(actions.route(said, "dictate"), ("ask", "What is a mutex?"))

    def test_claude_mid_sentence_does_not_ask(self):
        self.assertEqual(actions.route("Tell Claude to stop.", "dictate")[0], "dictate")

    def test_bare_name_is_not_a_question(self):
        self.assertEqual(actions.route("Claude.", "dictate")[0], "dictate")

    def test_sentences_split_and_wrap(self):
        self.assertEqual(actions.sentences("One. Two! Three?"), ["One.", "Two!", "Three?"])
        self.assertTrue(all(len(s) <= 40 for s in actions.sentences("word " * 60, max_len=40)))

    def test_clean_drops_non_speech_markers(self):
        self.assertEqual(asr.clean(" [BLANK_AUDIO] "), "")
        self.assertEqual(asr.clean("hello (music)  world"), "hello world")


def fake_app_image(test: unittest.TestCase, version: str, elf: bytes) -> Path:
    """A file with a valid ESP-IDF image header and app description, and no code."""
    desc = struct.pack("<I12x32s32s16s16s32s32s", 0xABCD5432, version.encode(), b"xiaozhi",
                       b"12:00:00", b"Oct  9 2026", b"v6.1", elf)
    folder = tempfile.mkdtemp()
    test.addCleanup(shutil.rmtree, folder)
    path = Path(folder) / "xiaozhi.bin"
    path.write_bytes(b"\xe9" + bytes(23) + bytes(8) + desc + bytes(600))
    return path


class FakeAsr:
    def __init__(self, text: str):
        self.text = text
        self.calls: list[int] = []

    async def transcribe(self, pcm: bytes, sample_rate: int = RATE) -> str:
        self.calls.append(len(pcm))
        return self.text


class ProtocolTest(unittest.IsolatedAsyncioTestCase):
    async def start(self, heard: str, **overrides) -> None:
        self.cfg = Config(public_host="10.0.0.5", ota_key="otakey", ws_token="wstoken",
                          silence_ms=300, idle_close_s=30, **overrides)
        self.asr = FakeAsr(heard)
        self.pasted: list[str] = []
        self.asked: list[tuple[str, list]] = []
        self.paste_error: str | None = None

        async def paste(text, cfg):
            self.pasted.append(text)
            return self.paste_error

        async def ask(text, history, cfg):
            self.asked.append((text, history))
            return "Four. It is two plus two.", None

        async def synthesize(text, cfg):
            return tone(180, rate=24000)

        bridge = Bridge(self.cfg, self.asr, paste=paste, ask=ask, synthesize=synthesize)
        self.client = TestClient(TestServer(make_app(bridge)))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def connect(self):
        ws = await self.client.ws_connect("/xiaozhi/v1/", headers={
            "Authorization": "Bearer wstoken", "Device-Id": "aa:bb:cc:dd:ee:ff"})
        await ws.send_str(json.dumps({"type": "hello", "version": 1, "transport": "websocket",
                                      "audio_params": {"format": "opus", "sample_rate": RATE}}))
        hello = json.loads((await ws.receive()).data)
        self.assertEqual((hello["type"], hello["transport"]), ("hello", "websocket"))
        self.assertEqual(hello["audio_params"]["sample_rate"], 24000)
        return ws

    async def speak(self, ws, pcm: bytes) -> None:
        enc = Encoder(RATE, 60)
        for packet in enc.encode_all(pcm):
            await ws.send_bytes(packet)

    async def collect(self, ws, until: str, timeout: float = 5):
        """Read until a JSON message whose type or tts state equals `until`."""
        texts, audio = [], 0
        async with asyncio.timeout(timeout):
            while True:
                msg = await ws.receive()
                if msg.type == WSMsgType.BINARY:
                    audio += 1
                    continue
                if msg.type != WSMsgType.TEXT:
                    self.fail(f"socket ended early: {msg.type}")
                data = json.loads(msg.data)
                texts.append(data)
                if until in (data.get("type"), data.get("state")):
                    return texts, audio

    # --- auth ---------------------------------------------------------------

    async def test_ota_needs_the_key(self):
        await self.start("x")
        self.assertEqual((await self.client.post("/xiaozhi/ota/", json={})).status, 404)
        self.assertEqual((await self.client.post("/xiaozhi/ota/?k=wrong", json={})).status, 404)

    async def test_ota_hands_out_websocket_config_and_no_upgrade(self):
        await self.start("x")
        r = await self.client.post("/xiaozhi/ota/?k=otakey", json={"board": {}})
        body = await r.json()
        self.assertEqual(body["websocket"], {"url": "ws://10.0.0.5:8790/xiaozhi/v1/",
                                             "token": "wstoken", "version": 1})
        self.assertEqual(body["firmware"]["version"], "0.0.0")
        self.assertNotIn("activation", body)

    async def test_ota_offers_firmware_until_the_device_runs_it(self):
        image = fake_app_image(self, version="2.5.0", elf=b"\x11" * 32)
        await self.start("x", firmware_path=str(image))
        check_in = lambda elf: self.client.post(
            "/xiaozhi/ota/?k=otakey", json={"application": {"version": "2.5.0", "elf_sha256": elf}})

        offer = (await (await check_in("ab" * 32)).json())["firmware"]
        self.assertEqual(offer, {"version": "2.5.0", "force": 1,
                                 "url": "http://10.0.0.5:8790/xiaozhi/firmware/?k=otakey"})
        # Once the device reports this build, the forced offer must stop.
        current = (await (await check_in("11" * 32)).json())["firmware"]
        self.assertEqual(current, {"version": "0.0.0", "url": ""})
        # A device that does not say what it runs is never upgraded.
        r = await self.client.post("/xiaozhi/ota/?k=otakey", json={"board": {}})
        self.assertEqual((await r.json())["firmware"]["url"], "")

    async def test_ota_stops_offering_an_image_that_never_installs(self):
        image = fake_app_image(self, version="2.5.0", elf=b"\x11" * 32)
        await self.start("x", firmware_path=str(image))
        urls = []
        for _ in range(5):
            r = await self.client.post("/xiaozhi/ota/?k=otakey", headers={"Device-Id": "aa:bb"},
                                       json={"application": {"elf_sha256": "ab" * 32}})
            urls.append(bool((await r.json())["firmware"]["url"]))
        self.assertEqual(urls, [True, True, True, False, False])

    async def test_firmware_download_needs_the_key(self):
        image = fake_app_image(self, version="2.5.0", elf=b"\x11" * 32)
        await self.start("x", firmware_path=str(image))
        self.assertEqual((await self.client.get("/xiaozhi/firmware/?k=wrong")).status, 404)
        r = await self.client.get("/xiaozhi/firmware/?k=otakey")
        self.assertEqual(r.status, 200)
        self.assertEqual(int(r.headers["Content-Length"]), image.stat().st_size)
        self.assertEqual(await r.read(), image.read_bytes())

    async def test_no_firmware_configured_means_no_download(self):
        await self.start("x")
        self.assertEqual((await self.client.get("/xiaozhi/firmware/?k=otakey")).status, 404)

    async def test_websocket_needs_the_token(self):
        await self.start("x")
        for headers in ({}, {"Authorization": "Bearer nope"}):
            r = await self.client.get("/xiaozhi/v1/", headers=headers)
            self.assertEqual(r.status, 401)

    async def test_allowlist_blocks_other_devices(self):
        await self.start("x", allowed_device_ids=["02:00:00:00:00:AB"])
        r = await self.client.post("/xiaozhi/ota/?k=otakey", headers={"Device-Id": "aa:bb:cc:dd:ee:ff"})
        self.assertEqual(r.status, 403)
        r = await self.client.post("/xiaozhi/ota/?k=otakey", headers={"Device-Id": "02:00:00:00:00:ab"})
        self.assertEqual(r.status, 200)
        r = await self.client.get("/xiaozhi/v1/", headers={"Authorization": "Bearer wstoken",
                                                           "Device-Id": "aa:bb:cc:dd:ee:ff"})
        self.assertEqual(r.status, 403)

    # --- dictation ----------------------------------------------------------

    async def test_dictation_pastes_and_echoes_transcript(self):
        await self.start("Refactor the scanner module.")
        ws = await self.connect()
        await self.speak(ws, silence(240) + tone(900) + silence(600))
        texts, _ = await self.collect(ws, "stt")
        self.assertEqual(texts[-1]["text"], "Refactor the scanner module.")
        await asyncio.sleep(0.05)
        self.assertEqual(self.pasted, ["Refactor the scanner module."])
        self.assertEqual(self.asked, [])
        await ws.close()

    async def test_paste_failure_is_shown_on_the_device(self):
        await self.start("Hello there.")
        self.paste_error = "Mac needs Accessibility permission for voice bridge"
        ws = await self.connect()
        await self.speak(ws, tone(900) + silence(600))
        texts, _ = await self.collect(ws, "alert")
        self.assertIn("Accessibility", texts[-1]["message"])
        await ws.close()

    async def test_empty_transcript_does_nothing(self):
        await self.start("")
        ws = await self.connect()
        await self.speak(ws, tone(900) + silence(600))
        await asyncio.sleep(0.3)
        self.assertEqual(len(self.asr.calls), 1)
        self.assertEqual(self.pasted, [])
        await ws.close()

    async def test_closing_the_socket_mid_utterance_still_pastes(self):
        await self.start("Tap to stop works.")
        ws = await self.connect()
        await self.speak(ws, tone(900))
        await asyncio.sleep(0.2)
        await ws.close()
        await asyncio.sleep(0.3)
        self.assertEqual(self.pasted, ["Tap to stop works."])

    async def test_manual_stop_ends_the_utterance(self):
        await self.start("Push to talk.")
        ws = await self.connect()
        await self.speak(ws, tone(900))
        await ws.send_str(json.dumps({"type": "listen", "state": "stop"}))
        await self.collect(ws, "stt")
        await ws.close()

    # --- answer mode --------------------------------------------------------

    async def test_claude_prefix_asks_and_streams_a_spoken_reply(self):
        await self.start("Claude, what is two plus two?")
        ws = await self.connect()
        await self.speak(ws, tone(900) + silence(600))
        texts, audio = await self.collect(ws, "stop")
        self.assertEqual(self.asked[0][0], "What is two plus two?")
        self.assertEqual(self.pasted, [])
        states = [t.get("state") for t in texts if t["type"] == "tts"]
        self.assertEqual(states, ["start", "sentence_start", "sentence_start", "stop"])
        shown = [t["text"] for t in texts if t.get("state") == "sentence_start"]
        self.assertEqual(shown, ["Four.", "It is two plus two."])
        self.assertGreaterEqual(audio, 6)  # two sentences x three 60 ms frames
        await ws.close()

    async def test_second_question_carries_history(self):
        await self.start("Claude, and doubled?")
        ws = await self.connect()
        for _ in range(2):
            await self.speak(ws, tone(900) + silence(600))
            await self.collect(ws, "stop")
            await asyncio.sleep(0.5)  # past the post-reply deaf window
        self.assertEqual(self.asked[0][1], [])
        self.assertEqual(self.asked[1][1], [("And doubled?", "Four. It is two plus two.")])
        await ws.close()

    async def test_text_only_replies_send_no_audio(self):
        await self.start("Claude, what is two plus two?", tts=False)
        ws = await self.connect()
        await self.speak(ws, tone(900) + silence(600))
        _, audio = await self.collect(ws, "stop", timeout=8)
        self.assertEqual(audio, 0)
        await ws.close()


if __name__ == "__main__":
    unittest.main()
