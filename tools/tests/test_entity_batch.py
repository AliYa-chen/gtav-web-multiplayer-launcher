#!/usr/bin/env python3
"""真实 WebSocket 验证通用实体批输入原子性和负载预算；不运行游戏资源。"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_world_v2 as world_tests


class EntityBatchTests(world_tests.WorldV2Harness):
    def owner(self, count=16):
        player = self.client("批实体模拟者")
        self.assertIn("entity_batch", player.welcome["capabilities"])
        # 步行 NPC 与交通载具自身是可提议实体，附座司机由载具事务一起更新。
        candidates = [item for item in player.initial_snapshot["entities"] if item.get("population_cell")
            and item["owner_id"] == player.player_id and item["kind"] in ("ped", "vehicle")
            and not item["components"].get("attachment")]
        candidates.sort(key=lambda item: (item["kind"] != "ped", item["entity_id"]))
        self.assertGreaterEqual(len(candidates), count)
        values = []
        for entity in candidates[:count]:
            player.send({"type": "entity_ready", "world_epoch": player.world_epoch,
                "entity_id": entity["entity_id"], "owner_epoch": entity["owner_epoch"]})
            _, active = self.delta(player, entity["entity_id"], lambda item: item["ownership"] == "active")
            values.append(active)
        return player, values

    def proposal(self, entity, sequence=None, offset=.1):
        transform = copy.deepcopy(entity["components"]["transform"])
        transform["position"][0] += offset
        value = {"entity_id": entity["entity_id"], "owner_epoch": entity["owner_epoch"],
            "input_seq": entity["last_input_seq"] + 1 if sequence is None else sequence,
            "based_on_revision": entity["revision"], "transform": transform}
        if entity["kind"] == "vehicle":
            value["view"] = {"engine_on": True, "lights_on": False}
        else:
            ped = entity["components"]["ped"]
            value["view"] = {"weapon": ped["weapon"], "shooting": False, "actions": copy.deepcopy(ped["actions"])}
        return value

    def batch(self, client, updates, **extra):
        message = {"type": "entity_batch", "world_epoch": client.world_epoch, "updates": updates, **extra}
        client.send(message)
        return message

    def accepted_batch(self, player, entities, offset=.1):
        before = self.world()
        proposals = [self.proposal(self.entity(item["entity_id"], before), offset=offset) for item in entities]
        self.batch(player, proposals)
        by_id = {item["entity_id"]: item for item in proposals}
        event = player.expect("world_delta", lambda event: all(any(item["entity_id"] == entity_id
            and item["last_input_seq"] == proposal["input_seq"] for item in event.get("entities", []))
            for entity_id, proposal in by_id.items()))
        after = self.world()
        self.assertEqual(after["cut_revision"], before["cut_revision"] + 1, "一批提议与乘客移动必须只提交一个世界事务")
        self.assertEqual(event["world_revision"], after["cut_revision"])
        for entity_id, proposal in by_id.items():
            old = self.entity(entity_id, before); new = self.entity(entity_id, after)
            self.assertEqual(new["revision"], old["revision"] + 1)
            self.assertEqual(new["last_input_seq"], proposal["input_seq"])
            self.assertEqual(new["components"]["transform"]["position"], proposal["transform"]["position"])
            self.assertEqual(new["owner_epoch"], old["owner_epoch"])
            if new["kind"] == "vehicle":
                for occupant in new["components"]["vehicle"]["seats"].values():
                    if occupant:
                        moved = self.entity(occupant, after)
                        self.assertEqual(moved["components"]["transform"], new["components"]["transform"])
                        self.assertTrue(any(item["entity_id"] == occupant for item in event["entities"]),
                                        "同一 world_delta 必须交付乘客变更")
        return after

    def assert_unchanged(self, before):
        after = self.world()
        self.assertEqual(after["cut_revision"], before["cut_revision"], "坏批输入不可提交世界事务")
        self.assertEqual(after["entities"], before["entities"], "坏批输入不可部分改变实体、输入序号或租约")
        self.assertEqual(after["tombstones"], before["tombstones"])

    def test_eight_and_sixteen_inputs_commit_once_with_vehicle_occupants(self):
        player, entities = self.owner()
        self.accepted_batch(player, entities[:8])
        self.accepted_batch(player, entities)

    def test_one_stale_owner_rolls_back_whole_batch_including_valid_prefix(self):
        player, entities = self.owner()
        before = self.world()
        values = [self.proposal(self.entity(item["entity_id"], before)) for item in entities]
        values[8]["owner_epoch"] -= 1
        self.batch(player, values); self.error(player, "stale_owner")
        self.assert_unchanged(before)
        self.accepted_batch(player, entities)

    def test_one_invalid_motion_or_component_never_partially_advances_sequences(self):
        player, entities = self.owner()
        for mutation in ("movement", "view"):
            before = self.world()
            values = [self.proposal(self.entity(item["entity_id"], before)) for item in entities]
            if mutation == "movement":
                values[-1]["transform"]["position"][0] += 1000
            else:
                values[-1]["view"]["health"] = 0
            self.batch(player, values); self.error(player, "invalid_movement" if mutation == "movement" else "invalid_message")
            self.assert_unchanged(before)

    def test_authority_fields_epoch_duplicate_and_oversized_batches_are_rejected(self):
        player, entities = self.owner()
        for field, value in (("health", 0), ("owner_id", player.player_id), ("generation", 999), ("combat", {"health": 0})):
            before = self.world()
            updates = [self.proposal(self.entity(item["entity_id"], before)) for item in entities[:8]]
            updates[-1][field] = value
            self.batch(player, updates); self.error(player, "invalid_message")
            self.assert_unchanged(before)
        before = self.world(); update = self.proposal(self.entity(entities[0]["entity_id"], before))
        player.send({"type": "entity_batch", "world_epoch": "previous-world", "updates": [update]})
        self.error(player, "wrong_world"); self.assert_unchanged(before)
        for updates in ([update, copy.deepcopy(update)], [copy.deepcopy(update) for _ in range(25)], []):
            self.batch(player, updates); self.error(player)
            self.assert_unchanged(before)

    def test_repeated_sequence_in_middle_rejects_other_new_inputs(self):
        player, entities = self.owner()
        self.accepted_batch(player, entities)
        before = self.world()
        updates = [self.proposal(self.entity(item["entity_id"], before)) for item in entities]
        updates[7]["input_seq"] -= 1
        self.batch(player, updates); self.error(player, "stale_input")
        self.assert_unchanged(before)
        self.accepted_batch(player, entities)

    def test_sixteen_entity_batches_and_player_states_fit_aggregate_budget(self):
        player, entities = self.owner()
        # 持续五秒：30Hz 玩家状态 + 10Hz 批消息（16实体）+ 20Hz 瞄空射击，共60消息/秒。
        # 每个批次是一次消息/批次预算，不能按16个实体扣掉玩家状态预算。
        started = time.monotonic()
        states = batches = shots = 0
        for step in range(301):
            wait = started + step / 60 - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            if step % 2 == 0:
                states += 1
                self.state(player, states, weapon=world_tests.combat_tests.MINIGUN)
            if step % 6 == 0:
                snapshot = self.world()
                updates = [self.proposal(self.entity(item["entity_id"], snapshot), offset=.01) for item in entities]
                self.batch(player, updates)
                event = player.expect("world_delta", lambda event: all(any(item["entity_id"] == update["entity_id"]
                    and item["last_input_seq"] == update["input_seq"] for item in event.get("entities", [])) for update in updates))
                batches += 1
                self.assertTrue(event["entities"])
            if step % 3 == 0:
                shots += 1
                origin = [player.spawn[0], player.spawn[1], player.spawn[2] + .7]
                player.send({"type": "shot_event", "seq": shots, "origin": origin,
                    "target": [origin[0], origin[1], origin[2] + 100], "weapon": world_tests.combat_tests.MINIGUN})
                result = player.expect("shot_result", lambda event: event.get("seq") == shots)
                self.assertTrue(result["accepted"], result)
                self.assertFalse(result["hit"], "负载场景瞄空，不能用击杀改变测试世界")
        player.send({"type": "ping", "nonce": 765})
        player.expect("pong", lambda event: event.get("nonce") == 765)
        self.assertGreaterEqual(time.monotonic() - started, 5)
        self.assertEqual((states, batches, shots), (151, 51, 101))
        errors = [event for event in player.pending if event.get("type") == "error"]
        self.assertEqual(errors, [], "正常聚合负载不应因高频状态和攻击受到拒绝")

    def test_fast_batch_burst_is_accepted_atomically_without_disconnect(self):
        player, entities = self.owner()
        before = self.world()
        # 一次突发超过旧10Hz/burst20预算，全部有效批次应得到处理。
        for sequence in range(1, 41):
            updates = [self.proposal(self.entity(item["entity_id"], before), sequence=sequence, offset=.01) for item in entities]
            self.batch(player, updates)
        player.send({"type": "ping", "nonce": 766})
        player.expect("pong", lambda event: event.get("nonce") == 766)
        errors = [event for event in player.pending if event.get("type") == "error"]
        self.assertEqual(errors, [], "正常批次突发不应触发旧玩法限流")
        after = self.world()
        sequences = {self.entity(item["entity_id"], after)["last_input_seq"] for item in entities}
        self.assertEqual(sequences, {40}, "每批保持原子提交，最后一批完整生效")
        # 快速提交后连接和玩家状态仍可用。
        self.state(player, 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=world_tests.protocol.JAR_PATH)
    parser.add_argument("--java", default=world_tests.protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    world_tests.protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    world_tests.protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
