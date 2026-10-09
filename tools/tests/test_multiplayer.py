#!/usr/bin/env python3
"""用真实 Java 服务端验证大厅协议；只用 Python 标准库，不加载游戏数据。

运行方式：python3 -B tools/tests/test_multiplayer.py
也可指定构建产物：python3 -B tools/tests/test_multiplayer.py --jar 路径
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
JAR_PATH = ROOT / "server" / "multiplayer-server.jar"
JAVA_COMMAND = os.environ.get("JAVA", "java")
TIMEOUT = 4.0


class WebSocketClient:
    """最小 RFC 6455 客户端，保留原始帧接口以验证服务端的边界检查。"""

    def __init__(self, port: int, origin: str = "http://client.example:8001"):
        self.sock = socket.create_connection(("127.0.0.1", port), TIMEOUT)
        self.sock.settimeout(TIMEOUT)
        self.pending: list[dict] = []
        self.buffer = bytearray()
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: {origin}\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            data = self.sock.recv(4096)
            if not data:
                raise AssertionError("WebSocket 握手前连接已关闭")
            self.buffer.extend(data)
        header, leftover = bytes(self.buffer).split(b"\r\n\r\n", 1)
        self.buffer = bytearray(leftover)
        lines = header.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0]:
            raise AssertionError(f"WebSocket 握手失败：{lines[0]}")
        headers = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
        headers = {k.lower(): v.strip() for k, v in headers.items()}
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != accept:
            raise AssertionError("WebSocket 握手接受值不匹配")

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def frame(self, opcode: int, payload: bytes, *, final: bool = True, masked: bool = True):
        flags = (0x80 if final else 0) | opcode
        length = len(payload)
        mask_bit = 0x80 if masked else 0
        if length < 126:
            header = bytes((flags, mask_bit | length))
        elif length < 65536:
            header = bytes((flags, mask_bit | 126)) + struct.pack("!H", length)
        else:
            header = bytes((flags, mask_bit | 127)) + struct.pack("!Q", length)
        if masked:
            mask = os.urandom(4)
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            header += mask
        self.sock.sendall(header + payload)

    def send(self, message: dict):
        self.frame(1, json.dumps(message, ensure_ascii=False).encode("utf-8"))

    def _read(self, count: int) -> bytes:
        while len(self.buffer) < count:
            data = self.sock.recv(max(4096, count - len(self.buffer)))
            if not data:
                raise EOFError("WebSocket 连接已关闭")
            self.buffer.extend(data)
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def read_frame(self) -> tuple[int, bytes]:
        first, second = self._read(2)
        if second & 0x80:
            raise AssertionError("服务端不应给 WebSocket 帧加掩码")
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read(8))[0]
        if length > 1024 * 1024:
            raise AssertionError("服务端返回了异常大的帧")
        return first & 0x0F, self._read(length)

    def receive(self) -> dict:
        while True:
            opcode, payload = self.read_frame()
            if opcode == 9:
                self.frame(10, payload)
            elif opcode == 1:
                result = json.loads(payload.decode("utf-8"))
                if not isinstance(result, dict):
                    raise AssertionError("服务端事件应为 JSON 对象")
                return result
            elif opcode == 8:
                raise EOFError("服务端发出了关闭帧")
            elif opcode != 10:
                raise AssertionError(f"服务端返回了意外的 opcode {opcode}")

    def expect(self, kind: str, predicate=None, timeout: float = TIMEOUT) -> dict:
        predicate = predicate or (lambda _: True)
        deadline = time.monotonic() + timeout
        for index, message in enumerate(self.pending):
            if message.get("type") == kind and predicate(message):
                return self.pending.pop(index)
        while time.monotonic() < deadline:
            self.sock.settimeout(max(0.01, deadline - time.monotonic()))
            message = self.receive()
            if message.get("type") == kind and predicate(message):
                self.sock.settimeout(TIMEOUT)
                return message
            self.pending.append(message)
        raise AssertionError(f"未收到事件 {kind}，已收到：{self.pending}")


class MultiplayerIntegrationTests(unittest.TestCase):
    """启动独立 JAR，并用多个真实 WebSocket 连接模拟玩家。"""

    @classmethod
    def setUpClass(cls):
        if not JAR_PATH.is_file():
            raise RuntimeError(f"找不到服务端 JAR，请先构建：{JAR_PATH}")
        cls.log_directory = tempfile.TemporaryDirectory(prefix="multiplayer-test-")
        cls.log_path = Path(cls.log_directory.name) / "server.log"
        cls.server_log = cls.log_path.open("w+b")
        cls.port = None
        cls.process = subprocess.Popen(
            [JAVA_COMMAND, "-jar", str(JAR_PATH), "--host", "127.0.0.1", "--port", "0", "--world-data", "none",
             *getattr(cls, "SERVER_ARGUMENTS", [])],
            cwd=str(ROOT), stdout=cls.server_log, stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                output = cls.log_path.read_text(encoding="utf-8", errors="replace")
                cls.server_log.close()
                cls.log_directory.cleanup()
                raise RuntimeError(f"服务端启动失败：\n{output}")
            if cls.port is None:
                output = cls.log_path.read_text(encoding="utf-8", errors="replace")
                address = re.search(r"http://127\.0\.0\.1:(\d+)", output)
                if address:
                    cls.port = int(address.group(1))
            try:
                if cls.port is not None:
                    status, _ = cls.get_json("/health")
                    if status == 200:
                        return
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.05)
        cls.process.terminate()
        cls.process.wait(timeout=3)
        output = cls.log_path.read_text(encoding="utf-8", errors="replace")
        cls.server_log.close()
        cls.log_directory.cleanup()
        raise RuntimeError(f"服务端未按时就绪：\n{output}")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=3)
        cls.server_log.close()
        cls.log_directory.cleanup()

    @classmethod
    def get_json(cls, path: str):
        connection = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=1)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()

    def setUp(self):
        self.clients: list[WebSocketClient] = []

    def tearDown(self):
        for client in self.clients:
            client.close()

    def client(self, name: str = "测试玩家", *, capabilities=None) -> WebSocketClient:
        client = WebSocketClient(self.port)
        self.clients.append(client)
        client.welcome = client.expect("welcome")
        self.assertTrue(client.welcome["public_session"])
        self.assertEqual(client.welcome["room"]["id"], "PUBLIC")
        hello = {"type": "hello", "name": name}
        if capabilities is not None:
            hello["capabilities"] = capabilities
        client.send(hello)
        client.profile = client.expect("profile")
        client.expect("room_state", lambda message: any(member["id"] == client.welcome["client_id"] for member in (message.get("room") or {}).get("members", [])))
        client.initial_world = client.expect("world_state")
        return client

    @staticmethod
    def state(sequence: int = 1) -> dict:
        return {"type": "player_state", "seq": sequence, "position": [711.5, -1088.0, 22.41], "heading": 180,
                "model": 0x705E61F2, "health": 200, "weapon": 0, "shooting": False}

    def error(self, client: WebSocketClient, code: str):
        result = client.expect("error", lambda message: message.get("code") == code)
        self.assertIsInstance(result.get("message"), str)
        self.assertTrue(result["message"])
        return result

    def test_health_and_public_metadata(self):
        """公共战局始终存在，HTTP 接口准确区分消息传输与游戏同步。"""
        status, health = self.get_json("/health")
        self.assertEqual(status, 200)
        self.assertIsInstance(health, dict)
        status, metadata = self.get_json("/api/multiplayer")
        self.assertEqual(status, 200)
        self.assertIsInstance(metadata, dict)
        for snapshot in (health, metadata):
            self.assertTrue(snapshot["public_session"])
            self.assertEqual(snapshot["rooms"], 1)
            self.assertEqual(snapshot["map"], "gta5")
            self.assertTrue(snapshot["state_transport"])
            self.assertFalse(snapshot["game_sync"])

    def test_application_heartbeat_and_snapshot_validation(self):
        """应用心跳验证双向传输；快照请求需已加入，严格拒绝附加字段。"""
        client = WebSocketClient(self.port)
        self.clients.append(client)
        welcome = client.expect("welcome")
        self.assertEqual(welcome["server_version"], "0.4.2-world-experimental")
        self.assertTrue({"heartbeat", "snapshot"}.issubset(welcome["capabilities"]))
        for nonce in (0, 123456, 9007199254740991):
            client.send({"type": "ping", "nonce": nonce})
            self.assertEqual(client.expect("pong"), {"type": "pong", "nonce": nonce})
        for invalid in ({"type": "ping"}, {"type": "ping", "nonce": None},
                        {"type": "ping", "nonce": -1}, {"type": "ping", "nonce": True},
                        {"type": "ping", "nonce": 1.5}, {"type": "ping", "nonce": "1"},
                        {"type": "ping", "nonce": 9007199254740992},
                        {"type": "ping", "nonce": 1, "health": 200},
                        {"type": 123, "nonce": 1}, {"type": "sync", "player_id": "别人"}):
            client.send(invalid)
            self.error(client, "invalid_message")
        client.send({"type": "sync"})
        self.error(client, "not_in_room")
        client.send({"type": "hello", "name": "旧客户端"})
        profile = client.expect("profile")
        client.expect("room_state")
        client.expect("world_state")
        client.send({"type": "ping", "nonce": 1})
        client.expect("pong")
        client.pending.clear()
        client.send({"type": "sync"})
        room = client.expect("room_state")["room"]
        self.assertEqual(room["members"][0]["id"], profile["client_id"])
        self.assertEqual(client.expect("world_state")["states"], [])
        client.send({"type": "ping", "nonce": 2})
        client.expect("pong")
        self.assertFalse(any(message["type"] in ("profile", "combat_state") for message in client.pending))

    def test_snapshot_replays_current_world_and_preserves_resume_sequences(self):
        """恢复快照包含最新玩家与权威血量，不重新加入或清除序号。"""
        first = self.client("恢复玩家", capabilities=["combat", "resume"])
        second = self.client("同战局玩家", capabilities=["combat"])
        restored = None
        try:
            first_id, second_id = first.profile["client_id"], second.profile["client_id"]
            rifle = 0xBFEFFF6D
            first_position = first.profile["spawn"]
            second_position = [first_position[0] + 6, first_position[1], first_position[2]]
            first_state = {**self.state(10), "position": first_position, "weapon": rifle}
            second_state = {**self.state(20), "position": second_position, "weapon": rifle}
            first.send(first_state)
            first.expect("player_state", lambda event: event.get("player_id") == first_id)
            second.send(second_state)
            first.expect("player_state", lambda event: event.get("player_id") == second_id)
            first_shot = {"type": "shot_event", "seq": 7, "weapon": rifle,
                          "origin": [first_position[0], first_position[1], first_position[2] + 0.7],
                          "target": [first_position[0], first_position[1] + 10, first_position[2] + 0.7]}
            first.send(first_shot)
            first.expect("shot_event", lambda event: event.get("player_id") == first_id)
            second.send({"type": "shot_event", "seq": 9, "weapon": rifle,
                         "origin": [second_position[0], second_position[1], second_position[2] + 0.7],
                         "target": [first_position[0], first_position[1], first_position[2] + 0.7]})
            self.assertEqual(first.expect("damage", lambda event: event.get("victim_id") == first_id)["health"], 165)
            latest = {**second_state, "seq": 21, "heading": 135}
            second.send(latest)
            first.expect("player_state", lambda event: event.get("player_id") == second_id and event["state"]["seq"] == 21)
            first.send({"type": "ping", "nonce": 10})
            first.expect("pong")
            first.pending.clear()
            first.send({"type": "sync"})
            room = first.expect("room_state")["room"]
            self.assertEqual({member["id"] for member in room["members"]}, {first_id, second_id})
            states = {item["player_id"]: item["state"] for item in first.expect("world_state")["states"]}
            self.assertEqual(states[second_id]["seq"], 21)
            self.assertEqual(states[second_id]["heading"], 135)
            self.assertEqual(states[first_id]["health"], 165)
            combat = first.expect("combat_state")
            self.assertEqual(next(player for player in combat["players"] if player["id"] == first_id)["health"], 165)
            first.send({"type": "ping", "nonce": 11})
            first.expect("pong")
            self.assertFalse(any(message["type"] == "profile" for message in first.pending))
            first.send(first_state)
            self.error(first, "stale_seq")
            first.send(first_shot)
            self.error(first, "stale_seq")
            first.close()
            second.expect("room_state", lambda event: any(
                member["id"] == first_id and not member["connected"] for member in event["room"]["members"]))
            restored = WebSocketClient(self.port)
            self.clients.append(restored)
            restored.expect("welcome")
            restored.send({"type": "hello", "name": "恢复玩家", "capabilities": ["combat", "resume"],
                           "client_id": first_id, "resume_token": first.profile["resume_token"]})
            profile = restored.expect("profile")
            self.assertEqual(profile["client_id"], first_id)
            self.assertEqual(profile["health"], 165)
            self.assertEqual(profile["last_state_seq"], 10)
            self.assertEqual(profile["last_shot_seq"], 7)
            restored.expect("room_state")
            restored.expect("world_state")
            restored.expect("combat_state")
            restored.send({**first_state, "seq": 11, "health": 200})
            state = restored.expect("player_state", lambda event:
                event.get("player_id") == first_id and event["state"]["seq"] == 11)
            self.assertEqual(state["state"]["health"], 165)
        finally:
            for client in (restored or first, second):
                try:
                    client.send({"type": "leave_room"})
                    client.expect("room_state", lambda event: event.get("room") is None)
                except (OSError, EOFError):
                    pass

    def test_three_players_public_join_chat_state_and_shot_relay(self):
        """三人自动进入同一公共战局，聊天、角色状态和射击事件被实际转发。"""
        first, second, third = [self.client(name) for name in ("玩家一", "玩家二", "玩家三")]
        joined = first.expect("room_state", lambda message: len((message.get("room") or {}).get("members", [])) == 3)["room"]
        self.assertEqual(joined["id"], "PUBLIC")
        self.assertEqual(joined["map"], "gta5")
        self.assertEqual(joined["phase"], "launched")
        self.assertIsNone(joined["host_id"])
        second.send({"type": "chat", "text": "你好，测试消息 🌍"})
        for client in (first, second, third):
            event = client.expect("chat", lambda message: message.get("text") == "你好，测试消息 🌍")
            self.assertEqual(event["room_id"], "PUBLIC")
            self.assertEqual(event["sender_id"], second.welcome["client_id"])
        state = {**self.state(), "weapon": 0x1B06D571}
        second.send(state)
        shot = {"type": "shot_event", "seq": 1, "origin": state["position"], "target": [713.5, -1090, 22.41], "weapon": 0x1B06D571}
        second.send(shot)
        for client in (first, second, third):
            event = client.expect("player_state", lambda message: message.get("player_id") == second.welcome["client_id"])
            self.assertEqual(event["state"], {**{key: value for key, value in state.items() if key != "type"}, "alive": True})
            self.assertEqual(event["room_id"], "PUBLIC")
            self.assertIsInstance(event["time"], str)
            event = client.expect("shot_event", lambda message: message.get("player_id") == second.welcome["client_id"])
            self.assertEqual({key: event["event"][key] for key in shot if key != "type"},
                             {key: value for key, value in shot.items() if key != "type"})
            self.assertEqual(event["event"]["mode"], "hitscan")
            self.assertEqual(event["room_id"], "PUBLIC")
        fourth = self.client("后来加入")
        saved = next(item for item in fourth.initial_world["states"] if item["player_id"] == second.welcome["client_id"])
        self.assertEqual(saved["state"], {**{key: value for key, value in state.items() if key != "type"}, "alive": True})

    def test_public_policy_rejects_room_launch_and_debug_injection(self):
        """客户端不能改变公共战局地图、创建私房或开启调试参数。"""
        client = self.client()
        for command in ({"type": "create_room", "map": "env_test"}, {"type": "set_ready", "ready": True},
                        {"type": "launch", "map": "gta6", "mode": "story", "debug": True}):
            client.send(command)
            self.error(client, "public_session_only")
        client.send({"type": "join_room", "room_id": "OTHER"})
        self.error(client, "public_session_only")
        client.send({"type": "hello", "name": "越权请求", "debug": True})
        self.error(client, "invalid_message")
        client.send({"type": "list_rooms"})
        rooms = client.expect("room_list")["rooms"]
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0]["id"], "PUBLIC")
        self.assertEqual(rooms[0]["map"], "gta5")

    def test_state_validation_identity_and_sequences(self):
        """状态与射击序号独立递增，越界和冒用身份的字段被拒绝。"""
        client = self.client()
        client.send(self.state())
        client.expect("player_state")
        client.send(self.state())
        self.error(client, "stale_seq")
        for changes in ({"position": [16001, 0, 0]}, {"position": [1, 2]}, {"heading": 361}, {"health": 1001},
                        {"model": -1}, {"weapon": 4294967296}, {"shooting": "yes"}, {"seq": 1.5},
                        {"player_id": "另一个玩家"}, {"debug": True}):
            client.send({**self.state(2), **changes})
            self.error(client, "invalid_message")
        client.send(self.state(2))
        self.assertEqual(client.expect("player_state", lambda message: message["state"]["seq"] == 2)["player_id"], client.welcome["client_id"])
        position = self.state()["position"]
        client.send({**self.state(3), "weapon": 0x1B06D571})
        client.expect("player_state", lambda event: event.get("state", {}).get("seq") == 3)
        shot = {"type": "shot_event", "seq": 1, "origin": position,
                "target": [position[0] + 1, position[1] + 2, position[2] + 3], "weapon": 0x1B06D571}
        client.send(shot)
        client.expect("shot_event")
        client.send(shot)
        self.error(client, "stale_seq")
        client.send({**shot, "seq": 2, "hit_player": "受害者", "damage": 1000})
        self.error(client, "invalid_message")

    def test_disconnect_leave_cleanup_and_public_session_persists(self):
        """离开和断线会清理状态，空公共战局继续存在并可重新加入。"""
        first, second = self.client("甲"), self.client("乙")
        second.send(self.state())
        first.expect("player_state", lambda message: message.get("player_id") == second.welcome["client_id"])
        second.close()
        first.expect("room_state", lambda message: len((message.get("room") or {}).get("members", [])) == 1)
        first.send({"type": "leave_room"})
        first.expect("room_state", lambda message: message.get("room") is None)
        first.send(self.state())
        self.error(first, "not_in_room")
        _, health = self.get_json("/health")
        self.assertEqual(health["rooms"], 1)
        self.assertEqual(health["players"], 0)
        first.send({"type": "join_room", "room_id": "PUBLIC"})
        first.expect("room_state", lambda message: (message.get("room") or {}).get("id") == "PUBLIC")
        self.assertEqual(first.expect("world_state")["states"], [])

    def test_bad_json_reports_error_without_losing_connection(self):
        """坏 JSON 只产生协议错误；随后仍可正常使用公共战局。"""
        client = self.client()
        for payload in (b'{"type":', b'{"type":"hello","type":"launch"}', b'{"type":"hello","value":NaN}'):
            client.frame(1, payload)
            self.error(client, "invalid_json")
        client.send(self.state())
        self.assertEqual(client.expect("player_state")["player_id"], client.welcome["client_id"])

    def test_ping_and_fragmented_utf8_json(self):
        """跨域连接、ping/pong 和拆开中文 UTF-8 字节的分片均可正常处理。"""
        client = self.client()
        client.pending.clear()
        client.frame(9, b"ping-test")
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            opcode, payload = client.read_frame()
            if opcode == 10:
                self.assertEqual(payload, b"ping-test")
                break
            self.assertEqual(opcode, 1)
            client.pending.append(json.loads(payload.decode("utf-8")))
        else:
            self.fail("没有收到 pong")
        data = json.dumps({"type": "hello", "name": "分片中文名"}, ensure_ascii=False).encode("utf-8")
        split = data.index("分".encode("utf-8")) + 1
        client.frame(1, data[:split], final=False)
        client.frame(0, data[split:], final=True)
        profile = client.expect("profile", lambda message: message.get("name") == "分片中文名")
        self.assertEqual(profile["client_id"], client.welcome["client_id"])

    def test_invalid_websocket_frames_are_closed_with_rfc_codes(self):
        """无掩码、二进制、无效 UTF-8 和超限帧分别触发 RFC 关闭码。"""
        cases = [
            ("无掩码", 1, b'{}', False, 1002),
            ("二进制", 2, b'{}', True, 1003),
            ("坏 UTF-8", 1, b'\xff', True, 1007),
            ("超限文本", 1, b'x' * 65537, True, 1009),
            ("无效关闭码", 8, struct.pack("!H", 1006), True, 1002),
        ]
        for label, opcode, payload, masked, expected in cases:
            with self.subTest(label=label):
                client = self.client()
                client.frame(opcode, payload, masked=masked)
                while True:
                    received_opcode, close_payload = client.read_frame()
                    if received_opcode == 8:
                        self.assertGreaterEqual(len(close_payload), 2)
                        self.assertEqual(struct.unpack("!H", close_payload[:2])[0], expected)
                        break
                    self.assertEqual(received_opcode, 1)
                client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=JAR_PATH, help="要测试的 Java 服务端 JAR")
    parser.add_argument("--java", default=JAVA_COMMAND, help="Java 可执行文件路径")
    arguments, remainder = parser.parse_known_args()
    JAR_PATH = arguments.jar.expanduser().resolve()
    JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
