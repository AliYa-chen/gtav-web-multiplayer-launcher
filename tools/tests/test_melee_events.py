#!/usr/bin/env python3
"""真实 WS 验证近战意图、动作广播与权威命中分离，不运行游戏动画。"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_world_v2 as world_tests


class MeleeEventTests(world_tests.WorldV2Harness):
    def client(self, name="近战玩家", *, events=True):
        client = super().client(name)
        if events:
            client.send({"type": "hello", "name": name,
                         "capabilities": ["world_v2", "combat", "resume", "melee_events", "world_environment", "shared_law", "session_policy"]})
            client.profile = client.expect("profile")
            self.read_snapshot(client)
            self.assertIn("melee_events", client.welcome["capabilities"])
        return client

    def pose(self, client, heading=270, *, position=None, sequence=1):
        message = {**world_tests.protocol.MultiplayerIntegrationTests.state(sequence),
                   "heading": heading, "position": position or client.spawn, "weapon": 0xa2719263}
        client.send(message)
        client.expect("player_state", lambda event: event.get("player_id") == client.player_id
                      and event.get("state", {}).get("seq") == sequence)

    def swing(self, client, request_id):
        message = {"type": "interaction_request", "world_epoch": client.world_epoch,
                   "request_id": request_id, "action": "melee"}
        client.send(message)
        return message

    def barrier(self, client, sender=None):
        sender = sender or client
        text = "近战屏障" + str(time.monotonic_ns())
        sender.send({"type": "chat", "text": text})
        client.expect("chat", lambda message: message.get("text") == text)

    def test_targetless_intent_selects_nearest_front_target_and_broadcasts_same_event(self):
        attacker, victim, observer = self.client("射手"), self.client("目标"), self.client("观察者")
        self.pose(attacker)
        self.pose(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        self.pose(observer, position=[attacker.spawn[0] - 1, attacker.spawn[1], attacker.spawn[2]])
        request = self.swing(attacker, "front-intent")
        result = attacker.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertTrue(result["accepted"]); self.assertTrue(result["hit"])
        events = [client.expect("melee_event", lambda event: event.get("request_id") == request["request_id"])
                  for client in (attacker, victim, observer)]
        self.assertEqual(events[0], events[1]); self.assertEqual(events[0], events[2])
        event = events[0]
        self.assertEqual(event["schema_version"], 2)
        self.assertEqual(event["world_epoch"], attacker.world_epoch)
        self.assertTrue(event["event_id"].startswith("m:" + attacker.world_epoch + ":"))
        self.assertEqual(event["action"], "punch")
        self.assertEqual(event["attacker_entity_id"], attacker.entity_id)
        self.assertEqual(event["target_entity_id"], victim.entity_id)
        self.assertEqual(event["damage"], 20); self.assertEqual(event["health"], 180)
        self.assertEqual(event["revision"], self.entity(victim.entity_id)["revision"])
        self.assertEqual(event["attacker_generation"], self.entity(attacker.entity_id)["generation"])
        self.assertEqual(event["target_generation"], self.entity(victim.entity_id)["generation"])
        self.assertEqual(self.entity(observer.entity_id)["components"]["combat"]["health"], 200)
        counters = self.get_json("/health")[1]
        self.assertEqual(counters["melee_requests_received"], 1)
        self.assertEqual(counters["melee_events_approved"], 1)
        self.assertEqual(counters["melee_hits"], 1)

    def test_behind_target_becomes_approved_swing_without_damage(self):
        attacker, victim = self.client("挥空"), self.client("身后")
        self.pose(attacker, heading=90)
        self.pose(victim, position=[attacker.spawn[0] + 1, attacker.spawn[1], attacker.spawn[2]])
        before = self.world()
        self.swing(attacker, "swing-only")
        event = victim.expect("melee_event", lambda event: event.get("request_id") == "swing-only")
        result = attacker.expect("interaction_result", lambda event: event.get("request_id") == "swing-only")
        self.assertTrue(result["accepted"]); self.assertFalse(event["hit"])
        self.assertEqual(event["damage"], 0)
        self.assertIsNone(event["target_entity_id"]); self.assertIsNone(event["target_generation"])
        self.assertIsNone(event["health"])
        self.assertEqual(self.world()["cut_revision"], before["cut_revision"])
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)
        self.swing(attacker, "next-swing")
        queued = attacker.expect("interaction_result", lambda event: event.get("request_id") == "next-swing")
        self.assertTrue(queued["accepted"]); self.assertTrue(queued["pending"])
        victim.expect("melee_event", lambda event: event.get("request_id") == "next-swing")

    def test_replay_is_result_only_and_unsupported_peers_receive_no_animation(self):
        attacker, victim = self.client("幂等"), self.client("目标")
        legacy = self.client("未声明动作能力", events=False)
        self.pose(attacker)
        self.pose(victim, position=[attacker.spawn[0] + 1, attacker.spawn[1], attacker.spawn[2]])
        request = self.swing(attacker, "only-once")
        original = attacker.expect("interaction_result", lambda event: event.get("request_id") == "only-once")
        attacker.expect("melee_event"); victim.expect("melee_event")
        baseline = self.world()
        attacker.send(request)
        self.assertEqual(attacker.expect("interaction_result", lambda event: event.get("request_id") == "only-once"), original)
        self.barrier(victim, attacker); self.barrier(legacy, attacker)
        self.assertFalse(any(event.get("type") == "melee_event" for event in victim.pending))
        self.assertFalse(any(event.get("type") == "melee_event" for event in legacy.pending))
        self.assertEqual(self.world()["cut_revision"], baseline["cut_revision"])
        stats = self.get_json("/health")[1]
        self.assertEqual(stats["melee_requests_received"], 2)
        self.assertEqual(stats["melee_events_approved"], 1)

    def test_explicit_invalid_target_and_client_damage_animation_fields_are_not_broadcast(self):
        attacker, victim = self.client("严格验证"), self.client("身后目标")
        self.pose(attacker, heading=90)
        self.pose(victim, position=[attacker.spawn[0] + 1, attacker.spawn[1], attacker.spawn[2]])
        self.interaction(attacker, "melee", victim.entity_id, request_id="bad-facing")
        self.error(attacker, "not_facing")
        for extra in ({"damage": 200}, {"hit": True}, {"animation": "arbitrary"}, {"clip": "arbitrary"}):
            attacker.send({"type": "interaction_request", "world_epoch": attacker.world_epoch,
                           "request_id": str(extra), "action": "melee", **extra})
            self.error(attacker, "invalid_message")
        self.barrier(victim, attacker)
        self.assertFalse(any(event.get("type") == "melee_event" for event in victim.pending))
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)
        self.assertEqual(self.get_json("/health")[1]["melee_events_approved"], 0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=world_tests.protocol.JAR_PATH)
    parser.add_argument("--java", default=world_tests.protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    world_tests.protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    world_tests.protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
