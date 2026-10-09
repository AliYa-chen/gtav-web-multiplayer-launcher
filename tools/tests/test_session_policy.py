#!/usr/bin/env python3
"""Real WebSocket checks for server-only, story-free public-session policy."""
from __future__ import annotations

import argparse
import copy
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol
from test_world_v2 import WorldV2Harness


POLICY = {"revision": 1, "story_enabled": False, "local_script_mode": "suspend_after_ready",
          "allowed_scripts": [], "mission_events": "server_only"}


class SessionPolicyIntegrationTests(WorldV2Harness):
    def world_facts(self):
        """Ignore transport clocks; retain identities and gameplay components."""
        return {entity["entity_id"]: {key: entity[key] for key in
                ("kind", "model", "player_id", "generation", "components")}
                for entity in self.world()["entities"]}

    def test_world_client_without_policy_capability_is_rejected_before_join(self):
        before = self.world_facts()
        client = self.raw_client()
        client.send({"type": "hello", "name": "过期世界客户端",
                     "capabilities": ["combat", "resume", "combat_feedback", "world_v2",
                                      "world_environment", "shared_law"]})
        self.error(client, "client_world_rules_required")
        self.assertEqual(self.world_facts(), before)
        self.assertEqual(self.world()["session_policy"], POLICY)

    def test_policy_is_published_by_server_on_every_session_baseline(self):
        client = self.client("公共战局策略")
        self.assertIn("session_policy", client.welcome["capabilities"])
        self.assertEqual(client.welcome["session_policy"], POLICY)
        self.assertEqual(client.profile["session_policy"], POLICY)
        self.assertEqual(client.initial_snapshot["session_policy"], POLICY)
        self.assertEqual(self.world()["session_policy"], POLICY)
        status, health = self.get_json("/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["session_policy"], POLICY)
        client.send({"type": "world_sync", "world_epoch": client.world_epoch,
                     "after_revision": client.cut_revision})
        begin = client.expect("snapshot_begin")
        end = client.expect("snapshot_end", lambda value: value.get("snapshot_id") == begin["snapshot_id"])
        self.assertEqual(begin["session_policy"], POLICY)
        self.assertEqual(end["session_policy"], POLICY)
        self.state(client)
        delta = client.expect("world_delta", lambda value: any(entity["entity_id"] == client.entity_id
                              for entity in value.get("entities", [])))
        self.assertEqual(delta["session_policy"], POLICY)

    def test_story_mission_and_scenario_messages_cannot_create_or_change_entities(self):
        client = self.client("禁止本地剧情")
        self.state(client)
        before = self.world_facts()
        forbidden = ("mission_start", "story_event", "script_event", "scenario_start",
                     "start_script", "entity_create")
        for kind in forbidden:
            with self.subTest(top_level=kind):
                client.send({"type": kind, "script": "main", "scenario": "WORLD_HUMAN_SMOKING",
                             "model": 0x705E61F2, "position": client.spawn})
                self.error(client, "unknown_type")
        for action in forbidden[:4]:
            with self.subTest(interaction=action):
                request_id = "denied-" + action
                client.send({"type": "interaction_request", "world_epoch": client.world_epoch,
                             "request_id": request_id, "action": action})
                result = client.expect("interaction_result", lambda value: value.get("request_id") == request_id)
                self.assertFalse(result["accepted"])
                self.assertEqual(result["reason"], "unsupported_interaction")
                self.error(client, "unsupported_interaction")
        entity = self.entity(client.entity_id)
        for kind in forbidden[:4]:
            with self.subTest(simulation=kind):
                client.send({"type": "simulation_result", "world_epoch": client.world_epoch,
                             "entity_id": entity["entity_id"], "owner_epoch": entity["owner_epoch"],
                             "input_seq": 1, "kind": kind})
                self.error(client, "unsupported_simulation")
        self.assertEqual(self.world_facts(), before)
        self.assertEqual(self.world()["session_policy"], POLICY)

    def test_client_cannot_override_policy_through_existing_message_routes(self):
        client = self.client("策略不能改写")
        self.state(client)
        before = self.world_facts()
        spoof = {"revision": 999, "story_enabled": True, "local_script_mode": "allow",
                 "allowed_scripts": ["main", "mission_triggerer_a"], "mission_events": "client"}
        client.send({"type": "session_policy", **spoof})
        self.error(client, "unknown_type")
        client.send({"type": "world_sync", "world_epoch": client.world_epoch,
                     "after_revision": client.cut_revision, "session_policy": spoof})
        self.error(client, "invalid_message")
        client.send({"type": "player_state", "seq": 2, "position": client.spawn, "heading": 90,
                     "model": 0x705E61F2, "weapon": 0xBFEFFF6D, "health": 200, "shooting": False,
                     "session_policy": copy.deepcopy(spoof)})
        self.error(client, "invalid_message")
        self.assertEqual(self.world_facts(), before)
        self.assertEqual(self.world()["session_policy"], POLICY)
        # A later valid baseline still carries the authoritative policy after rejected spoofing.
        snapshot = self.snapshot(client)
        self.assertEqual(snapshot["session_policy"], POLICY)


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
