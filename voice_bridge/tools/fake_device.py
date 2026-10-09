"""Stand in for the ESP32: speak a phrase at the running bridge and print what comes back.

Does the same two steps as the firmware (OTA check-in, then the WebSocket),
using the real config, so it proves the listener, auth, Opus, Whisper and
routing without any hardware. The phrase is spoken by `say`.

    .venv/bin/python tools/fake_device.py "Refactor the scanner module"
    .venv/bin/python tools/fake_device.py "Claude, what is a mutex?"

Careful: in dictation mode a working bridge really pastes into the focused app.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import aiohttp

from voice_bridge import actions, config
from voice_bridge.opus import Encoder


async def main(phrase: str) -> int:
    cfg = config.load()
    device_id = (cfg.allowed_device_ids or ["02:00:00:00:00:01"])[0]
    pcm = await actions.synthesize(phrase, cfg, sample_rate=16000)
    packets = Encoder(16000, 60).encode_all(b"\x00" * 9600 + pcm + b"\x00" * 64000)
    async with aiohttp.ClientSession() as http:
        async with http.post(cfg.ota_url, json={"fake": True}, headers={"Device-Id": device_id}) as r:
            print(f"OTA check-in: HTTP {r.status}")
            ota = await r.json()
        ws_cfg = ota["websocket"]
        print(f"told to use {ws_cfg['url']}, firmware {ota['firmware']['version']}")
        headers = {"Authorization": f"Bearer {ws_cfg['token']}", "Device-Id": device_id,
                   "Protocol-Version": "1"}
        async with http.ws_connect(ws_cfg["url"], headers=headers) as ws:
            await ws.send_str(json.dumps({"type": "hello", "version": 1, "transport": "websocket"}))
            print("hello <-", (await ws.receive()).data)
            await ws.send_str(json.dumps({"type": "listen", "state": "start", "mode": "realtime"}))

            async def speak():
                for packet in packets:
                    await ws.send_bytes(packet)
                    await asyncio.sleep(0.06)

            sender = asyncio.create_task(speak())
            spoken_at = time.monotonic() + len(packets) * 0.06 - 2.0
            audio = 0
            try:
                async with asyncio.timeout(len(packets) * 0.06 + 150):
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.BINARY:
                            audio += 1
                            continue
                        data = json.loads(msg.data)
                        print(f"+{time.monotonic() - spoken_at:5.2f}s after speech ended <-",
                              {k: v for k, v in data.items() if k != "session_id"})
                        if data.get("type") == "alert" or data.get("state") == "stop":
                            break
                        if data.get("type") == "stt" and not actions.route(phrase, "dictate")[0] == "ask":
                            await asyncio.sleep(1.0)
                            break
            except TimeoutError:
                print("timed out waiting for the bridge")
                return 1
            finally:
                sender.cancel()
            print(f"reply audio frames: {audio}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(" ".join(sys.argv[1:]) or "Testing the voice bridge.")))
