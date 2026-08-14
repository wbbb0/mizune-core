#!/usr/bin/env python3
"""Contract-only NeoForge Bridge peer used by the parent supervisor test."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import struct
import time
from pathlib import Path
from typing import Any


async def read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    size = struct.unpack(">I", await reader.readexactly(4))[0]
    if not 1 <= size <= 1_048_576:
        raise ValueError("invalid frame size")
    value = json.loads((await reader.readexactly(size)).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("frame root must be an object")
    return value


async def write_frame(writer: asyncio.StreamWriter, value: dict[str, Any]) -> None:
    raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    writer.write(struct.pack(">I", len(raw)) + raw)
    await writer.drain()


class FakeBridge:
    def __init__(self) -> None:
        self.runtime_instance_id = os.environ["MIZUNE_RUNTIME_INSTANCE_ID"]
        self.server_address = os.environ["MIZUNE_MC_SERVER"]
        self.token = os.environ["MIZUNE_BRIDGE_CONTROL_TOKEN"]
        self.descriptor_file = Path(os.environ["MIZUNE_BRIDGE_DESCRIPTOR_FILE"])
        self.socket_path = self.descriptor_file.with_suffix(".sock")
        self.stop_event = asyncio.Event()
        self.server: asyncio.AbstractServer | None = None
        self.capture_sequence = 0

    async def run(self) -> None:
        self.socket_path.unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self.handle, path=self.socket_path)
        self.socket_path.chmod(0o600)
        self.descriptor_file.write_text(json.dumps({
            "protocolVersion": 2,
            "runtimeInstanceId": self.runtime_instance_id,
            "transport": "unix",
            "socketPath": str(self.socket_path),
            "pid": os.getpid(),
        }, separators=(",", ":")), encoding="utf-8")
        self.descriptor_file.chmod(0o600)
        await self.stop_event.wait()
        self.server.close()
        await self.server.wait_closed()
        self.socket_path.unlink(missing_ok=True)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            hello = await read_frame(reader)
            if (
                hello.get("type") != "hello"
                or hello.get("runtimeInstanceId") != self.runtime_instance_id
                or hello.get("authToken") != self.token
            ):
                raise ValueError("invalid hello")
            session_id = "fake-session"
            await write_frame(writer, {
                "type": "hello_result",
                "requestId": hello["requestId"],
                "protocolVersion": 2,
                "bridgeVersion": "0.3.0-test",
                "runtimeInstanceId": self.runtime_instance_id,
                "controllerId": hello["controllerId"],
                "sessionId": session_id,
                "capabilities": {
                    "maxFrameBytes": 1_048_576,
                    "maxEventsPerPage": 128,
                    "heartbeatIntervalMs": 200,
                    "controllerLeaseTtlMs": 1_000,
                    "eventBufferEpoch": "fake-epoch",
                    "rpcMethods": ["events.list", "snapshot.get"],
                    "controlMethods": [],
                    "observationScopes": ["entities", "environment", "inventory", "players", "self"],
                    "mutationCapabilities": [],
                },
            })
            while True:
                request = await read_frame(reader)
                request_type = request.get("type")
                if request_type == "heartbeat":
                    await write_frame(writer, {
                        "type": "heartbeat_ack",
                        "requestId": request["requestId"],
                        "sessionId": session_id,
                    })
                elif request_type == "release":
                    await write_frame(writer, {
                        "type": "release_ack",
                        "requestId": request["requestId"],
                        "sessionId": session_id,
                    })
                    self.stop_event.set()
                    return
                elif request.get("method") == "snapshot.get":
                    self.capture_sequence += 1
                    await write_frame(writer, {
                        "type": "response",
                        "requestId": request["requestId"],
                        "ok": True,
                        "result": {
                            "protocolVersion": 2,
                            "runtimeInstanceId": self.runtime_instance_id,
                            "capturedAtMs": int(time.time() * 1_000) + self.capture_sequence,
                            "connected": True,
                            "server": {"address": self.server_address, "name": "Fake NeoForge", "lan": False},
                            "self": {
                                "entityId": 1,
                                "uuid": "00000000-0000-0000-0000-000000000001",
                                "name": "MizuneTest",
                                "position": {"x": 0, "y": 64, "z": 0},
                                "health": 20,
                                "maxHealth": 20,
                                "armor": 0,
                                "food": 20,
                                "saturation": 5,
                                "air": 300,
                                "maxAir": 300,
                                "yaw": 0,
                                "pitch": 0,
                                "onGround": True,
                                "selectedHotbarSlot": 0,
                                "dimension": "minecraft:overworld",
                            },
                            "players": [],
                            "entities": [],
                            "inventory": [],
                            "environment": {
                                "dimension": "minecraft:overworld",
                                "gameTime": 1,
                                "dayTime": 1,
                                "raining": False,
                                "thundering": False,
                                "localBrightness": 15,
                                "biome": "minecraft:plains",
                                "nearbyBlocks": [],
                            },
                            "truncatedScopes": [],
                        },
                    })
                elif request.get("method") == "events.list":
                    after = request["payload"]["afterSequence"]
                    await write_frame(writer, {
                        "type": "response",
                        "requestId": request["requestId"],
                        "ok": True,
                        "result": {
                            "bufferEpoch": "fake-epoch",
                            "requestedAfterSequence": after,
                            "afterSequence": after,
                            "nextSequence": after,
                            "oldestAvailableSequence": 1,
                            "gap": None,
                            "events": [],
                        },
                    })
                else:
                    raise ValueError("unsupported request")
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()


async def main() -> None:
    bridge = FakeBridge()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, bridge.stop_event.set)
    await bridge.run()


if __name__ == "__main__":
    asyncio.run(main())
