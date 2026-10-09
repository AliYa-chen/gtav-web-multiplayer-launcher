#!/usr/bin/env python3
"""Real WebSocket coverage for public action queues and shared weapon effects.

Build a current server separately and pass --jar. These tests run no native game
engine and do not claim visual, animation or terrain-collision validation.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_world_v2 as world_tests

KNIFE = 0x99B507EA
STICKY = 0x2C3731D9
MINIGUN = 0x42BF8A85
MODEL = 0x705E61F2


class PublicActionsTests(world_tests.WorldV2Harness):
    def client(self, name="公共动作玩家"):
        client = self.raw_client()
        client.send({"type": "hello", "name": name, "capabilities": [
            "world_v2", "combat", "combat_feedback", "resume", "melee_events",
            "world_environment", "shared_law", "session_policy", "projectiles", "action_queue",
        ]})
        client.profile = client.expect("profile")
        client.player_id = client.profile["client_id"]
        client.spawn = list(client.profile["spawn"])
        client.position = list(client.spawn)
        client.world_epoch = client.profile["world_epoch"]
        client.entity_id = client.profile["entity_id"]
        client.stream_seq = None
        client.expect("room_state", lambda event: any(
            member["id"] == client.player_id for member in (event.get("room") or {}).get("members", [])))
        client.initial_world = client.expect("world_state")
        client.expect("combat_state", lambda event: any(
            player["id"] == client.player_id for player in event.get("players", [])))
        client.initial_snapshot = self.read_snapshot(client)
        client.projectiles = client.expect("projectile_state")
        return client

    def pose_message(self, client, sequence, *, position=None, heading=270, weapon=KNIFE):
        return {"type": "player_state", "seq": sequence,
                "position": list(position or client.position), "heading": heading,
                "model": MODEL, "health": 200, "weapon": weapon, "shooting": False}

    def pose(self, client, sequence=1, **values):
        message = self.pose_message(client, sequence, **values)
        client.send(message)
        result = client.expect("player_state", lambda event: event.get("player_id") == client.player_id
                               and event.get("state", {}).get("seq") == sequence)
        client.position = message["position"]
        return result["state"]

    def action(self, client, action, request_id):
        request = {"type": "interaction_request", "world_epoch": client.world_epoch,
                   "request_id": request_id, "action": action}
        client.send(request)
        return request

    def result(self, client, request_id):
        result = client.expect("interaction_result", lambda event: event.get("request_id") == request_id)
        self.assertTrue(result["accepted"], result)
        return result

    def barrier(self, client):
        marker = f"public-actions-{time.monotonic_ns()}"
        client.send({"type": "chat", "text": marker})
        client.expect("chat", lambda event: event.get("text") == marker, timeout=10)

    def health(self, client):
        return self.entity(client.entity_id)["components"]["combat"]["health"]

    def pair(self, *, distance=1.5, weapon=KNIFE):
        first, second = self.client("甲"), self.client("乙")
        self.pose(first, heading=270, weapon=weapon)
        self.pose(second, position=[first.spawn[0] + distance, first.spawn[1], first.spawn[2]],
                  heading=90, weapon=weapon)
        return first, second

    def test_knife_damage_is_authoritative_in_both_directions(self):
        first, second = self.pair()
        rules = {item["weapon"]: item for item in first.welcome["weapon_rules"]}
        self.assertEqual(rules[KNIFE]["melee_damage"], 45)
        self.action(first, "melee", "knife-a")
        first_result = self.result(first, "knife-a")
        first_event = second.expect("melee_event", lambda event: event.get("request_id") == "knife-a")
        self.assertEqual(first_result["damage"], 45)
        self.assertEqual(first_event["weapon"], KNIFE)
        self.assertEqual(first_event["target_entity_id"], second.entity_id)
        self.assertEqual(self.health(second), 155)
        self.action(second, "melee", "knife-b")
        self.assertEqual(self.result(second, "knife-b")["damage"], 45)
        second_event = first.expect("melee_event", lambda event: event.get("request_id") == "knife-b")
        self.assertEqual(second_event["target_entity_id"], first.entity_id)
        self.assertEqual(second_event["health"], 155)
        self.assertEqual(self.health(first), 155)

    def test_fast_melee_is_pending_then_runs_once_and_replays_result_only(self):
        first, second = self.pair()
        self.action(first, "melee", "initial")
        self.result(first, "initial")
        second.expect("melee_event", lambda event: event.get("request_id") == "initial")
        request = self.action(first, "melee", "queued")
        queued = self.result(first, "queued")
        self.assertTrue(queued["pending"])
        self.assertIsInstance(queued["scheduled_at"], int)
        self.assertEqual(self.health(second), 155)
        first.send(request)
        self.assertEqual(self.result(first, "queued"), queued)
        event = second.expect("melee_event", lambda event: event.get("request_id") == "queued", timeout=3)
        self.assertEqual(event["damage"], 45)
        self.assertEqual(event["health"], 110)
        first.send(request)
        completed = self.result(first, "queued")
        self.assertFalse(completed.get("pending", False))
        self.assertEqual(completed["damage"], 45)
        self.barrier(second)
        self.assertFalse(any(message.get("type") == "melee_event" and message.get("request_id") == "queued"
                             for message in second.pending))
        self.assertEqual(self.health(second), 110)
        self.assertFalse(any(message.get("type") == "error" for message in first.pending))

    def test_sticky_owner_detonation_and_late_join_projectile_baseline(self):
        first, second = self.pair(distance=6, weapon=STICKY)
        origin = [first.position[0], first.position[1], first.position[2] + .7]
        target = [second.position[0], second.position[1], second.position[2] + .7]
        first.send({"type": "shot_event", "seq": 1, "weapon": STICKY, "origin": origin, "target": target})
        shot = first.expect("shot_result", lambda event: event.get("seq") == 1)
        self.assertTrue(shot["accepted"])
        self.assertTrue(shot["pending"])
        projectile_id = shot["projectile_id"]
        first.expect("projectile_event", lambda event: event.get("projectile_id") == projectile_id
                     and event.get("phase") == "landed")
        late = self.client("晚加入")
        self.assertEqual(late.projectiles["world_epoch"], first.world_epoch)
        entry = next(item for item in late.projectiles["effects"] if item.get("projectile_id") == projectile_id)
        self.assertEqual(entry["phase"], "landed")
        self.assertEqual(entry["player_id"], first.player_id)
        self.assertEqual(entry["weapon"], STICKY)
        self.assertEqual(entry["detonation"], "remote")
        self.action(second, "detonate", "other-owner")
        self.result(second, "other-owner")
        self.barrier(second)
        self.assertEqual(self.health(second), 200)
        self.assertFalse(any(message.get("type") == "explosion_event" and message.get("projectile_id") == projectile_id
                             for message in second.pending))
        self.action(first, "detonate", "owner")
        self.result(first, "owner")
        explosion = late.expect("explosion_event", lambda event: event.get("projectile_id") == projectile_id)
        self.assertEqual(explosion["player_id"], first.player_id)
        damage = second.expect("damage", lambda event: event.get("victim_id") == second.player_id)
        self.assertEqual(damage["attacker_id"], first.player_id)
        self.assertEqual(damage["damage"], 150)
        self.assertEqual(self.health(second), 50)
        self.action(first, "detonate", "owner-again")
        self.result(first, "owner-again")
        self.barrier(late)
        self.assertFalse(any(message.get("type") == "explosion_event" and message.get("projectile_id") == projectile_id
                             for message in late.pending))
        self.assertEqual(self.health(second), 50)

    def test_hundreds_of_valid_inputs_are_accepted_without_message_or_shot_rate_errors(self):
        player = self.client("高频动作")
        self.pose(player, weapon=MINIGUN)
        for sequence in range(2, 402):
            player.send(self.pose_message(player, sequence, weapon=MINIGUN))
            self.action(player, "melee", f"burst-{sequence}")
        player.expect("player_state", lambda event: event.get("player_id") == player.player_id
                      and event.get("state", {}).get("seq") == 401, timeout=10)
        self.barrier(player)
        results = [message for message in player.pending if message.get("type") == "interaction_result"
                   and str(message.get("request_id", "")).startswith("burst-")]
        self.assertEqual(len(results), 400)
        self.assertTrue(all(message["accepted"] for message in results))
        self.assertTrue(any(message.get("pending") for message in results))
        self.pose(player, 402, weapon=MINIGUN)
        origin = [player.position[0], player.position[1], player.position[2] + .7]
        target = [origin[0], origin[1] + 50, origin[2]]
        for sequence in range(1, 201):
            player.send({"type": "shot_event", "seq": sequence, "weapon": MINIGUN, "origin": origin, "target": target})
        self.barrier(player)
        shots = [message for message in player.pending if message.get("type") == "shot_result"]
        self.assertEqual(len(shots), 200)
        self.assertTrue(all(message["accepted"] for message in shots))
        self.assertTrue(any(message.get("pending") for message in shots))
        errors = [message for message in player.pending if message.get("type") == "error"]
        self.assertEqual(errors, [], errors)
        self.assertEqual(self.get_json("/health")[1]["shot_events_received"], 200)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=world_tests.protocol.JAR_PATH)
    parser.add_argument("--java", default=world_tests.protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    world_tests.protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    world_tests.protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder], verbosity=2)
