#!/usr/bin/env python3
"""用真实 Java/WebSocket 验证统一世界协议，不能据此声明游戏 native 复制可用。

运行前先构建测试 JAR，再使用 --jar 指定；测试只访问独立的本机随机端口。
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol
import test_combat_world as combat_tests


class WorldV2Harness(unittest.TestCase):
    """只提供 helper，不继承其它测试类，避免 unittest 重复发现旧场景。"""
    get_json = classmethod(protocol.MultiplayerIntegrationTests.get_json.__func__)
    setUp = combat_tests.CombatWorldIntegrationTests.setUp
    tearDown = combat_tests.CombatWorldIntegrationTests.tearDown
    raw_client = combat_tests.CombatWorldIntegrationTests.raw_client
    state = combat_tests.CombatWorldIntegrationTests.state
    error = combat_tests.CombatWorldIntegrationTests.error

    def client(self, name="世界玩家", *, v2=True, resume=None):
        client = self.raw_client()
        capabilities = ["combat", "resume", "combat_feedback"] + (["world_v2"] if v2 else [])
        hello = {"type": "hello", "name": name, "capabilities": capabilities}
        if resume:
            hello.update(client_id=resume["client_id"], resume_token=resume["resume_token"])
        client.send(hello)
        client.profile = client.expect("profile")
        client.player_id = client.profile["client_id"]
        client.spawn = list(client.profile["spawn"])
        client.expect("room_state", lambda event: any(member["id"] == client.player_id
            for member in (event.get("room") or {}).get("members", [])))
        client.initial_world = client.expect("world_state")
        client.expect("combat_state", lambda event: any(player["id"] == client.player_id for player in event.get("players", [])))
        client.world_epoch = client.profile["world_epoch"]
        client.entity_id = client.profile["entity_id"]
        client.stream_seq = None
        if v2:
            self.assertIn("world_v2", client.welcome["capabilities"])
            client.initial_snapshot = self.read_snapshot(client)
        return client

    def read_snapshot(self, client):
        begin = client.expect("snapshot_begin")
        self.assertEqual(begin["schema_version"], 2)
        self.assertEqual(begin["world_epoch"], client.world_epoch)
        snapshot_id = begin["snapshot_id"]
        end = client.expect("snapshot_end", lambda event: event.get("snapshot_id") == snapshot_id)
        self.assertEqual(end["world_epoch"], begin["world_epoch"])
        self.assertEqual(end["cut_revision"], begin["cut_revision"])
        self.assertEqual(end["stream_seq"], begin["stream_seq"])
        chunks = [event for event in client.pending if event.get("type") == "snapshot_chunk" and event.get("snapshot_id") == snapshot_id]
        client.pending = [event for event in client.pending if event not in chunks]
        self.assertEqual(sorted(chunk["index"] for chunk in chunks), list(range(len(chunks))))
        entities, tombstones = [], []
        for chunk in sorted(chunks, key=lambda event: event["index"]):
            self.assertEqual(chunk["schema_version"], 2)
            self.assertEqual(chunk["world_epoch"], begin["world_epoch"])
            self.assertEqual(chunk["cut_revision"], begin["cut_revision"])
            entities.extend(chunk["entities"]); tombstones.extend(chunk["tombstones"])
        self.assertEqual(len({entity["entity_id"] for entity in entities}), len(entities))
        self.assertTrue(any(entity["entity_id"] == client.entity_id for entity in entities))
        client.stream_seq = begin["stream_seq"]
        client.cut_revision = begin["cut_revision"]
        return {**begin, "entities": entities, "tombstones": tombstones}

    def snapshot(self, client):
        client.send({"type": "world_sync", "world_epoch": client.world_epoch, "after_revision": client.cut_revision})
        return self.read_snapshot(client)

    def world(self):
        status, snapshot = self.get_json("/world")
        self.assertEqual(status, 200)
        self.assertEqual(snapshot["schema_version"], 2)
        return snapshot

    def entity(self, entity_id, snapshot=None):
        return next(item for item in (snapshot or self.world())["entities"] if item["entity_id"] == entity_id)

    def delta(self, client, entity_id, predicate=lambda entity: True):
        event = client.expect("world_delta", lambda event: any(item["entity_id"] == entity_id and predicate(item)
            for item in event.get("entities", [])))
        self.assertEqual(event["schema_version"], 2)
        self.assertEqual(event["world_epoch"], client.world_epoch)
        return event, next(item for item in event["entities"] if item["entity_id"] == entity_id)

    def interaction(self, client, action, target, *, seat=None, revision=None, request_id=None, **extra):
        entity = self.entity(target)
        message = {"type": "interaction_request", "world_epoch": client.world_epoch,
                   "request_id": request_id or f"{action}-{time.monotonic_ns()}", "action": action,
                   "entity_id": target, "expected_revision": entity["revision"] if revision is None else revision}
        if seat is not None:
            message["seat"] = seat
        message.update(extra)
        client.send(message)
        return message

    def accepted_interaction(self, client, action, target, **fields):
        message = self.interaction(client, action, target, **fields)
        result = client.expect("interaction_result", lambda event: event.get("request_id") == message["request_id"])
        self.assertTrue(result["accepted"], result)
        return result

    def heading_state(self, client, heading, sequence=1):
        message = {"type": "player_state", "seq": sequence, "position": list(client.spawn), "heading": heading,
            "model": combat_tests.MODEL, "health": 200, "weapon": combat_tests.RIFLE, "shooting": False}
        client.send(message)
        event = client.expect("player_state", lambda event: event.get("player_id") == client.player_id
            and event.get("state", {}).get("seq") == sequence)
        client.position = list(client.spawn); client.state_seq = sequence
        return event["state"]

    def life(self, client, *, sequence=1, health=0, reason="dead", entity=None, owner_epoch=None, **extra):
        current = entity or self.entity(client.entity_id)
        client.send({"type": "simulation_result", "world_epoch": client.world_epoch,
            "entity_id": current["entity_id"], "owner_epoch": current["owner_epoch"] if owner_epoch is None else owner_epoch,
            "input_seq": sequence, "kind": "life_report", "reason": reason, "health": health, **extra})


class WorldV2IntegrationTests(WorldV2Harness):
    def test_world_capability_required_and_player_input_has_one_validated_entry(self):
        legacy = self.client("无世界能力", v2=False); self.state(legacy)
        legacy.send({"type": "world_sync"}); self.error(legacy, "capability_required")
        player = self.client("有世界能力"); self.state(player)
        before = self.entity(player.entity_id)
        player.send({"type": "entity_input", "world_epoch": player.world_epoch, "entity_id": player.entity_id,
            "owner_epoch": before["owner_epoch"], "input_seq": 2, "based_on_revision": before["revision"],
            "transform": before["components"]["transform"]})
        self.error(player, "player_input_required")
        self.assertEqual(self.entity(player.entity_id)["revision"], before["revision"])

    def test_v1_and_v2_share_one_player_entity_and_late_snapshot(self):
        legacy = self.client("旧玩家", v2=False)
        self.state(legacy, 1)
        initial = self.entity(legacy.entity_id)
        current = self.client("统一世界玩家")
        snapshot = current.initial_snapshot
        old = self.entity(legacy.entity_id, snapshot)
        self.assertEqual(old["components"]["transform"]["position"], legacy.position)
        self.assertEqual(old["components"]["combat"]["health"], 200)
        self.assertEqual(old["entity_id"], initial["entity_id"])
        self.state(legacy, 2, position=[legacy.position[0] + .5, legacy.position[1], legacy.position[2]], health=0)
        _, moved = self.delta(current, legacy.entity_id, lambda item: item["revision"] > old["revision"])
        self.assertEqual(moved["components"]["combat"]["health"], 200)
        after = self.world()
        matching = [item for item in after["entities"] if item["player_id"] == legacy.player_id]
        self.assertEqual(len(matching), 1, "v1/v2 不得复制出两份玩家事实")
        self.assertEqual(matching[0]["revision"], moved["revision"])

    def test_snapshot_cut_followed_by_continuous_stream_and_resync(self):
        player = self.client()
        baseline = player.initial_snapshot
        previous_seq, previous_revision = baseline["stream_seq"], baseline["cut_revision"]
        for sequence in range(1, 4):
            destination = [player.spawn[0] + .2 * sequence, player.spawn[1], player.spawn[2]]
            self.state(player, sequence, position=destination)
            event, item = self.delta(player, player.entity_id, lambda item: item["components"]["transform"]["position"] == destination)
            self.assertEqual(event["stream_seq"], previous_seq + 1)
            self.assertGreater(event["world_revision"], previous_revision)
            self.assertEqual(item["entity_id"], player.entity_id)
            previous_seq, previous_revision = event["stream_seq"], event["world_revision"]
            time.sleep(.06)
        snapshot = self.snapshot(player)
        self.assertGreaterEqual(snapshot["stream_seq"], previous_seq)
        self.assertGreaterEqual(snapshot["cut_revision"], previous_revision)
        self.assertEqual(self.entity(player.entity_id, snapshot)["components"]["transform"]["position"], destination)

    def test_unknown_world_and_forbidden_authority_fields_do_not_mutate_registry(self):
        player = self.client(); self.state(player)
        before = self.entity(player.entity_id)
        base = {"type": "entity_input", "world_epoch": player.world_epoch, "entity_id": player.entity_id,
            "owner_epoch": before["owner_epoch"], "input_seq": 2, "based_on_revision": before["revision"],
            "transform": copy.deepcopy(before["components"]["transform"])}
        for field, value in (("health", 0), ("owner_id", "attacker"), ("combat", {"health": 0}), ("generation", 999)):
            player.send({**base, field: value}); self.error(player, "invalid_message")
        player.send({**base, "world_epoch": "other-world"}); self.error(player, "wrong_world")
        after = self.entity(player.entity_id)
        self.assertEqual(after["revision"], before["revision"])
        self.assertEqual(after["components"], before["components"])

    def test_identity_resume_keeps_entity_and_revokes_old_owner_epoch(self):
        player = self.client(); self.state(player, 4)
        old = self.entity(player.entity_id)
        credentials = dict(player.profile); player.close()
        deadline = time.monotonic() + 3
        while self.entity(player.entity_id)["owner_id"] is not None:
            self.assertLess(time.monotonic(), deadline); time.sleep(.03)
        resumed = self.client("恢复玩家", resume=credentials)
        self.assertEqual(resumed.entity_id, player.entity_id)
        restored = self.entity(resumed.entity_id)
        self.assertGreater(restored["owner_epoch"], old["owner_epoch"])
        self.assertEqual(resumed.profile["last_state_seq"], 4)
        self.life(resumed, sequence=1, health=0, owner_epoch=old["owner_epoch"])
        self.error(resumed, "stale_owner")
        self.assertEqual(self.entity(resumed.entity_id)["components"]["combat"]["health"], 200)

    def test_life_candidate_is_self_only_decreasing_and_respawns_same_entity(self):
        first, other = self.client("本机生命候选"), self.client("另一玩家")
        self.state(first); self.state(other)
        before = self.entity(first.entity_id)
        self.life(first, health=0, entity=self.entity(other.entity_id)); self.error(first, "stale_owner")
        self.life(first, sequence=1, health=140, reason="environmental")
        first.expect("combat_state", lambda event: any(item["id"] == first.player_id and item["health"] == 140 for item in event["players"]))
        self.life(first, sequence=2, health=200, reason="environmental"); self.error(first, "health_increase_denied")
        self.life(first, sequence=1, health=130, reason="environmental"); self.error(first, "stale_input")
        started = time.monotonic(); self.life(first, sequence=2, reason="arrest", health=100)
        death = first.expect("death", lambda event: event.get("player_id") == first.player_id)
        dead = self.entity(first.entity_id)
        self.assertFalse(dead["components"]["combat"]["alive"])
        self.assertEqual(dead["components"]["combat"]["health"], 0)
        self.assertIsNone(death["killer_id"])
        first.expect("respawn", lambda event: event.get("player_id") == first.player_id, timeout=6)
        self.assertGreaterEqual(time.monotonic() - started, 3.8)
        revived = self.entity(first.entity_id)
        self.assertEqual(revived["entity_id"], before["entity_id"])
        self.assertEqual(revived["generation"], before["generation"] + 1)
        self.assertEqual(revived["components"]["combat"]["health"], 200)
        self.assertEqual(revived["components"]["combat"]["deaths"], 1)

    def test_melee_is_server_distance_cooldown_and_damage_not_client_fields(self):
        first, victim = self.client("近战攻击"), self.client("近战目标")
        self.heading_state(first, 270)
        self.state(victim, position=[first.spawn[0] + 1.5, first.spawn[1], first.spawn[2]])
        initial = self.entity(victim.entity_id)
        self.interaction(first, "melee", victim.entity_id, damage=200)
        self.error(first, "invalid_message")
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)
        self.accepted_interaction(first, "melee", victim.entity_id)
        damage = victim.expect("damage", lambda event: event.get("victim_id") == victim.player_id)
        self.assertEqual(damage["damage"], 20)
        self.assertEqual(damage["health"], 180)
        self.interaction(first, "melee", victim.entity_id)
        self.error(first, "rate_limited")
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 180)
        self.interaction(first, "melee", victim.entity_id, revision=initial["revision"])
        self.error(first, "rate_limited",)
        remote = self.client("远距离目标")
        self.state(remote, position=[first.spawn[0] + 8, first.spawn[1], first.spawn[2]])
        self.interaction(first, "melee", remote.entity_id); self.error(first, "too_far")

    def test_melee_rejects_backwards_and_vertical_offset_before_damage(self):
        attacker, victim = self.client("朝向攻击"), self.client("前方目标")
        self.heading_state(attacker, 90)
        self.state(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        self.interaction(attacker, "melee", victim.entity_id)
        self.error(attacker, "not_facing")
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)
        self.heading_state(attacker, 270, 2)
        self.state(victim, 2, position=[attacker.spawn[0] + .5, attacker.spawn[1], attacker.spawn[2] + 1.6])
        self.interaction(attacker, "melee", victim.entity_id)
        self.error(attacker, "too_far")
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)

    def test_successful_melee_request_replay_is_idempotent_payload_conflicts_rejected(self):
        attacker, victim = self.client("重放攻击"), self.client("幂等目标")
        self.heading_state(attacker, 270)
        self.state(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        request = self.interaction(attacker, "melee", victim.entity_id, request_id="melee-once")
        original = attacker.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertTrue(original["accepted"])
        victim.expect("damage", lambda event: event.get("victim_id") == victim.player_id)
        before = self.world()
        attacker.send(request)
        replayed = attacker.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertEqual(replayed, original)
        after = self.world()
        self.assertEqual(after["cut_revision"], before["cut_revision"])
        self.assertEqual(after["entities"], before["entities"], "重放成功动作不能重新扣血或续写实体")
        self.assertEqual(self.entity(victim.entity_id, after)["components"]["combat"]["health"], 180)
        attacker.send({**request, "expected_revision": request["expected_revision"] + 1})
        self.error(attacker, "invalid_request")
        self.assertEqual(self.world()["cut_revision"], before["cut_revision"])

    def test_same_generation_old_basis_melee_is_accepted_but_future_basis_rejected(self):
        attacker, victim = self.client("移动目标攻击者"), self.client("移动目标")
        self.heading_state(attacker, 270)
        self.state(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        old = self.entity(victim.entity_id)
        self.state(victim, 2, position=[attacker.spawn[0] + 1.6, attacker.spawn[1], attacker.spawn[2]])
        self.assertGreater(self.entity(victim.entity_id)["revision"], old["revision"])
        self.accepted_interaction(attacker, "melee", victim.entity_id, revision=old["revision"], target_generation=old["generation"])
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 180)
        self.interaction(attacker, "melee", victim.entity_id, revision=self.entity(victim.entity_id)["revision"] + 10)
        self.error(attacker, "invalid_revision")

    def test_respawn_rejects_old_generation_even_if_target_generation_is_omitted(self):
        attacker, victim = self.client("跨生命输入"), self.client("新生命目标")
        self.heading_state(attacker, 270)
        self.state(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        old = self.entity(victim.entity_id)
        self.life(victim, sequence=1, health=0)
        victim.expect("death", lambda event: event.get("player_id") == victim.player_id)
        victim.expect("respawn", lambda event: event.get("player_id") == victim.player_id, timeout=6)
        current = self.entity(victim.entity_id)
        self.assertGreater(current["generation"], old["generation"])
        self.interaction(attacker, "melee", victim.entity_id, revision=old["revision"])
        self.error(attacker, "stale_generation")
        self.interaction(attacker, "melee", victim.entity_id, revision=current["revision"], target_generation=old["generation"])
        self.error(attacker, "stale_generation")
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 200)

    def test_first_life_accepts_zero_safe_interaction_basis(self):
        attacker, victim = self.client("首生命基线"), self.client("零基线目标")
        self.heading_state(attacker, 270)
        self.state(victim, position=[attacker.spawn[0] + 1.5, attacker.spawn[1], attacker.spawn[2]])
        self.accepted_interaction(attacker, "melee", victim.entity_id, revision=0)
        self.assertEqual(self.entity(victim.entity_id)["components"]["combat"]["health"], 180)

    def test_leave_emits_tombstone_without_removing_public_population(self):
        first, observer = self.client("离开玩家"), self.client("观察玩家")
        self.state(first); self.state(observer)
        population_before = {item["entity_id"] for item in self.world()["entities"] if item.get("population_cell")}
        first.send({"type": "leave_room"})
        event = observer.expect("world_delta", lambda event: any(item["entity_id"] == first.entity_id for item in event["tombstones"]))
        self.assertEqual(event["world_epoch"], observer.world_epoch)
        self.assertTrue(all(item["entity_id"] != first.entity_id for item in self.world()["entities"]))
        self.assertEqual({item["entity_id"] for item in self.world()["entities"] if item.get("population_cell")}, population_before)


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
