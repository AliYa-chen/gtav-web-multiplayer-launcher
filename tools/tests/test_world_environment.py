#!/usr/bin/env python3
"""统一天气/时间协议回归；使用已构建 JAR，不编译，不运行游戏资源。

此测试需包含 world_environment 能力的服务端；旧 JAR 不可验证新源码。
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol
import test_world_v2 as world_tests


class WorldEnvironmentIntegrationTests(world_tests.WorldV2Harness):
    def test_outdated_world_clients_cannot_join_shared_simulation(self):
        for missing in ("world_environment", "shared_law"):
            client = self.raw_client()
            capabilities = [item for item in ("world_v2", "world_environment", "shared_law") if item != missing]
            client.send({"type": "hello", "name": "未更新规则客户端", "capabilities": capabilities})
            self.error(client, "client_world_rules_required")
        _, health = self.get_json("/health")
        self.assertEqual(health["players"], 0)
        self.assertEqual(health["retained_players"], 0)

    def test_full_server_capability_declaration_is_accepted(self):
        client = self.raw_client()
        self.assertGreater(len(client.welcome["capabilities"]), 16)
        client.send({"type": "hello", "name": "完整能力声明", "capabilities": client.welcome["capabilities"]})
        profile = client.expect("profile")
        self.assertTrue(profile["world_epoch"])
        self.assertTrue(client.expect("snapshot_end")["environment"])

    def assert_environment(self, value, world_tick):
        self.assertGreaterEqual(value["revision"], 1)
        weather, clock = value["weather"], value["clock"]
        self.assertIn(weather["type"], {"EXTRASUNNY", "CLEAR", "CLOUDS", "OVERCAST", "RAIN", "CLEARING"})
        self.assertGreaterEqual(weather["rain"], 0); self.assertLessEqual(weather["rain"], 1)
        self.assertGreaterEqual(weather["wind"], 0); self.assertLessEqual(weather["wind"], 1)
        self.assertLessEqual(weather["anchor_tick"], world_tick)
        self.assertGreaterEqual(clock["hour"], 0); self.assertLess(clock["hour"], 24)
        self.assertGreaterEqual(clock["minute"], 0); self.assertLess(clock["minute"], 60)
        self.assertGreaterEqual(clock["second"], 0); self.assertLess(clock["second"], 60)
        self.assertEqual(clock["rate"], 30); self.assertFalse(clock["paused"])
        self.assertLessEqual(clock["anchor_tick"], world_tick)
        self.assertLess(world_tick - clock["anchor_tick"], 5_000)

    def test_snapshot_cut_has_one_complete_global_environment(self):
        player = self.client()
        self.assertIn("world_environment", player.welcome["capabilities"])
        begin = player.initial_snapshot
        self.assert_environment(begin["environment"], begin["world_tick"])
        player.send({"type": "world_sync", "world_epoch": player.world_epoch})
        next_begin = player.expect("snapshot_begin")
        end = player.expect("snapshot_end", lambda item: item["snapshot_id"] == next_begin["snapshot_id"])
        self.assertEqual(next_begin["environment"], end["environment"])
        self.assertEqual(next_begin["world_tick"], end["world_tick"])

    def test_stationary_player_receives_environment_checkpoint_in_continuous_stream(self):
        player = self.client()
        initial = player.initial_snapshot
        checkpoint = player.expect("world_delta", lambda item:
            item["environment"]["revision"] > initial["environment"]["revision"], timeout=7)
        self.assertGreater(checkpoint["stream_seq"], initial["stream_seq"])
        self.assert_environment(checkpoint["environment"], checkpoint["world_tick"])
        self.assertGreater(checkpoint["world_tick"], initial["world_tick"])

    def test_late_join_and_resume_take_current_world_environment(self):
        first = self.client("先加入")
        second = self.client("晚加入")
        self.assertEqual(first.world_epoch, second.world_epoch)
        a, b = first.initial_snapshot, second.initial_snapshot
        if a["environment"]["revision"] == b["environment"]["revision"]:
            self.assertEqual(a["environment"], b["environment"])
        credentials = {key: second.profile[key] for key in ("client_id", "resume_token")}
        second.close()
        resumed = self.client("恢复", resume=credentials)
        self.assertEqual(resumed.world_epoch, first.world_epoch)
        self.assertGreaterEqual(resumed.initial_snapshot["environment"]["revision"], b["environment"]["revision"])
        self.assert_environment(resumed.initial_snapshot["environment"], resumed.initial_snapshot["world_tick"])

    def test_clients_cannot_set_world_environment(self):
        player = self.client()
        before = self.world()["environment"]
        player.send({"type": "environment_state", "world_epoch": player.world_epoch,
            "environment": {"revision": 9_999, "weather": {"type": "THUNDER"}, "clock": {"hour": 0}}})
        self.error(player, "unknown_type")
        after = self.world()["environment"]
        self.assertEqual(after["weather"], before["weather"])
        self.assertLess(after["revision"], 9_999)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=protocol.JAR_PATH)
    parser.add_argument("--java", default=protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])


if __name__ == "__main__":
    main()
