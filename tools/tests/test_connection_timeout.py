#!/usr/bin/env python3
"""真实 JAR 连接超时测试：无响应断开、有效心跳存活与断线身份恢复。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol


class ConnectionTimeoutTests(unittest.TestCase):
    get_json = classmethod(protocol.MultiplayerIntegrationTests.get_json.__func__)

    def setUp(self):
        type(self).SERVER_ARGUMENTS = ["--max-clients", "4", "--idle-timeout", "2", "--hello-timeout", "1"]
        if self._testMethodName == "test_five_second_loading_heartbeat_keeps_connection":
            type(self).SERVER_ARGUMENTS = ["--idle-timeout", "6", "--hello-timeout", "1"]
        protocol.MultiplayerIntegrationTests.setUpClass.__func__(type(self))
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        protocol.MultiplayerIntegrationTests.tearDownClass.__func__(type(self))

    def client(self, name=None, *, credentials=None):
        client = protocol.WebSocketClient(self.port)
        self.clients.append(client)
        client.welcome = client.expect("welcome")
        if name is None:
            return client
        hello = {"type": "hello", "name": name, "capabilities": ["combat", "resume", "heartbeat"]}
        if credentials:
            hello.update(client_id=credentials["client_id"], resume_token=credentials["resume_token"])
        client.send(hello)
        client.profile = client.expect("profile")
        client.expect("world_state")
        return client

    def heartbeat(self, client, nonce):
        client.send({"type": "ping", "nonce": nonce})
        client.expect("pong", lambda message: message.get("nonce") == nonce)

    def await_counts(self, **expected):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            _, health = self.get_json("/health")
            if all(health[key] == value for key, value in expected.items()):
                return health
            time.sleep(0.04)
        self.fail(f"连接统计未及时变为 {expected}，当前 {health}")

    def await_closed(self, client, timeout=4):
        """故意不回应 RFC ping，避免测试客户端意外替静默连接续命。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            client.sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                opcode, _ = client.read_frame()
                if opcode == 8:
                    return
            except (EOFError, ConnectionError):
                return
        self.fail("超时连接仍未关闭")

    def read_error_without_pong(self, client):
        while True:
            opcode, payload = client.read_frame()
            if opcode == 1:
                event = json.loads(payload.decode("utf-8"))
                if event.get("type") == "error":
                    return event
            elif opcode == 8:
                raise EOFError("连接已关闭")

    def test_unjoined_websocket_expires_despite_application_pings(self):
        """未发送 hello 的空连接有固定期限，ping 不能永久占用名额。"""
        client = self.client()
        started = time.monotonic()
        for nonce in range(3):
            self.heartbeat(client, nonce)
            time.sleep(0.2)
        self.await_closed(client)
        self.assertLess(time.monotonic() - started, 2.3)
        self.await_counts(clients=0, players=0, retained_players=0)

    def test_idle_player_releases_connection_but_can_restore_identity(self):
        """静默玩家断开 socket，并保留可恢复的身份、状态与序号。"""
        client = self.client("静默玩家")
        credentials = dict(client.profile)
        state = {**protocol.MultiplayerIntegrationTests.state(7), "position": credentials["spawn"]}
        client.send(state)
        client.expect("player_state", lambda event: event.get("state", {}).get("seq") == 7)
        self.await_closed(client)
        self.await_counts(clients=0, players=0, state_players=0, retained_players=1)
        restored = self.client("恢复玩家", credentials=credentials)
        self.assertEqual(restored.profile["client_id"], credentials["client_id"])
        self.assertEqual(restored.profile["last_state_seq"], 7)
        self.assertEqual(restored.profile["health"], 200)
        self.await_counts(clients=1, players=1, retained_players=1)
        self.heartbeat(restored, 9)

    def test_invalid_messages_and_partial_frames_do_not_extend_liveness(self):
        """坏 JSON、错误字段和未完成帧不能让读取线程永久阻塞。"""
        client = self.client("坏包连接")
        started = time.monotonic()
        payloads = (b'{"type":', b'{"type":"ping","nonce":-1}',
                    b'{"type":"list_rooms","debug":true}')
        for index in range(6):
            client.frame(1, payloads[index % len(payloads)])
            self.assertIn(self.read_error_without_pong(client)["code"], ("invalid_json", "invalid_message"))
            time.sleep(0.2)
        # 一个只发了头部的掩码文本帧，readExact 会阻塞；维护线程必须主动关掉 socket。
        client.sock.sendall(b"\x81\x85\x01")
        self.await_closed(client)
        self.assertLess(time.monotonic() - started, 3.3)
        self.await_counts(clients=0, players=0, retained_players=1)

    def test_legal_messages_refresh_liveness_without_role_state(self):
        """合法请求刷新活性；引擎尚未发送角色状态时仍能保持在线。"""
        client = self.client("加载中的玩家")
        deadline = time.monotonic() + 3.2
        while time.monotonic() < deadline:
            client.send({"type": "sync"})
            client.expect("world_state")
            time.sleep(0.35)
        self.await_counts(clients=1, players=1, state_players=0)
        self.await_closed(client)
        self.await_counts(clients=0, players=0, retained_players=1)

    def test_five_second_loading_heartbeat_keeps_connection(self):
        """实际每五秒的应用心跳可跨越空闲期限，不要求加载期间上报角色。"""
        client = self.client("五秒心跳玩家")
        for nonce in range(2):
            time.sleep(5)
            self.heartbeat(client, nonce)
        health = self.await_counts(clients=1, players=1, state_players=0)
        self.assertEqual(health["idle_timeout_seconds"], 6)
        self.assertEqual(health["hello_timeout_seconds"], 1)

    def test_transport_pongs_do_not_mask_application_timeout(self):
        """浏览器自动回应 RFC pong 不代替应用消息，停滞脚本仍应被断开。"""
        client = self.client("协议心跳玩家")
        started = time.monotonic()
        deadline = started + 4
        pongs = 0
        closed = False
        while time.monotonic() < deadline:
            client.sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                opcode, payload = client.read_frame()
            except (EOFError, ConnectionError):
                closed = True
                break
            if opcode == 9:
                client.frame(10, payload)
                pongs += 1
            elif opcode == 8:
                closed = True
                break
        self.assertTrue(closed, "只有自动 pong 的连接不应一直在线")
        self.assertGreater(pongs, 0)
        self.assertLess(time.monotonic() - started, 3.3)
        self.await_counts(clients=0, players=0)

    def test_timeout_releases_readers_writers_and_connection_slots(self):
        """到期关闭后可重新占满连接上限，读写线程不会留在旧 socket 上。"""
        batch = [self.client() for _ in range(4)]
        for client in batch:
            self.await_closed(client)
        self.await_counts(clients=0, players=0)
        jcmd = shutil.which("jcmd")
        if jcmd:
            result = subprocess.run([jcmd, str(self.process.pid), "Thread.print"], capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=8)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("offline.multiplayer.Main$Client.readMessages", result.stdout)
            self.assertNotIn('"大厅发送-', result.stdout)
        second_batch = [self.client() for _ in range(4)]
        self.await_counts(clients=4, players=0)
        for client in second_batch:
            self.await_closed(client)
        self.await_counts(clients=0, players=0)

    def test_incomplete_http_upgrade_has_bounded_handshake_time(self):
        """连 HTTP 握手也未完成的连接会在八秒内释放阻塞的请求线程。"""
        raw = socket.create_connection(("127.0.0.1", self.port), 2)
        try:
            raw.settimeout(10)
            raw.sendall(b"GET /ws HTTP/1.1\r\nHost: localhost\r\n")
            started = time.monotonic()
            self.assertEqual(raw.recv(1), b"")
            elapsed = time.monotonic() - started
            self.assertGreater(elapsed, 7)
            self.assertLess(elapsed, 9.5)
        finally:
            raw.close()
        self.await_counts(clients=0, players=0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=protocol.JAR_PATH)
    parser.add_argument("--java", default=protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
