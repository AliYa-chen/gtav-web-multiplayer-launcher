#!/usr/bin/env python3
"""用真实 WebSocket 验证服务端战斗判定和身份恢复，不加载游戏资源。

运行：python3 -B tools/tests/test_combat_world.py --jar 路径
这些测试验证射线与玩家胶囊的交点，不代表已实现地图遮挡或完整 GTA 联机。
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol

RIFLE = 0xBFEFFF6D
PISTOL = 0x1B06D571
MINIGUN = 0x42BF8A85
MODEL = 0x705E61F2
APPEARANCE = {
    "components": [[0, 0, 0]] * 12,
    "props": [[-1, 0]] * 8,
}
ACTIONS = {"aiming": True, "reloading": False, "jumping": False, "ducking": True, "sprinting": False}


class CombatWorldIntegrationTests(unittest.TestCase):
    """每个场景用独立 JAR 进程，避免恢复期中的离线角色影响另一场景。"""

    get_json = classmethod(protocol.MultiplayerIntegrationTests.get_json.__func__)

    def setUp(self):
        protocol.MultiplayerIntegrationTests.setUpClass.__func__(type(self))
        self.clients: list[protocol.WebSocketClient] = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        protocol.MultiplayerIntegrationTests.tearDownClass.__func__(type(self))

    def raw_client(self):
        client = protocol.WebSocketClient(self.port)
        self.clients.append(client)
        client.welcome = client.expect("welcome")
        return client

    def client(self, name: str, *, resume=None, feedback=False):
        client = self.raw_client()
        hello = {"type": "hello", "name": name, "capabilities": ["combat", "resume"]}
        if feedback:
            hello["capabilities"].append("combat_feedback")
        if resume:
            hello.update(client_id=resume["client_id"], resume_token=resume["resume_token"])
        client.send(hello)
        client.profile = client.expect("profile")
        client.player_id = client.profile["client_id"]
        client.spawn = list(client.profile["spawn"])
        self.assertTrue(client.profile["resume_token"])
        client.expect("room_state", lambda message: any(
            member["id"] == client.player_id for member in (message.get("room") or {}).get("members", [])))
        client.initial_world = client.expect("world_state")
        client.expect("combat_state", lambda message: any(
            player["id"] == client.player_id for player in message.get("players", [])))
        return client

    def state(self, client, sequence: int = 1, *, position=None, health=200, weapon=RIFLE):
        position = list(position or client.spawn)
        message = {
            "type": "player_state", "seq": sequence, "position": position, "heading": 90,
            "model": MODEL, "health": health, "weapon": weapon, "shooting": False,
            "appearance": APPEARANCE,
        }
        client.send(message)
        event = client.expect("player_state", lambda event:
            event.get("player_id") == client.player_id and event.get("state", {}).get("seq") == sequence)
        client.position = position
        client.state_seq = sequence
        return event["state"]

    @staticmethod
    def body(position):
        return [position[0], position[1], position[2] + 0.7]

    def shot(self, shooter, sequence: int, target, *, origin=None, weapon=RIFLE):
        message = {
            "type": "shot_event", "seq": sequence,
            "origin": list(origin or self.body(shooter.position)),
            "target": list(target), "weapon": weapon,
        }
        shooter.send(message)
        return message

    def accepted_shot(self, shooter, sequence: int, target):
        message = self.shot(shooter, sequence, target)
        shooter.expect("shot_event", lambda event:
            event.get("player_id") == shooter.player_id and event.get("event", {}).get("seq") == sequence)
        return message

    def error(self, client, code=None):
        error = client.expect("error", lambda event: code is None or event.get("code") == code)
        self.assertIsInstance(error.get("code"), str)
        self.assertTrue(error["code"])
        self.assertIsInstance(error.get("message"), str)
        self.assertTrue(error["message"])
        return error

    def combat_player(self, client, player_id, **expected):
        def matching(event):
            player = next((item for item in event.get("players", []) if item.get("id") == player_id), None)
            return player is not None and all(player.get(key) == value for key, value in expected.items())
        event = client.expect("combat_state", matching, timeout=6)
        return next(item for item in event["players"] if item["id"] == player_id)

    def pair(self):
        first, second = self.client("射手"), self.client("目标")
        self.state(first)
        target = [first.spawn[0] + 6, first.spawn[1], first.spawn[2]]
        self.state(second, position=target)
        return first, second

    def test_server_health_overrides_client_health_and_preserves_appearance(self):
        """客户端不能通过上报血量回血或自杀，外观仍能正常转发。"""
        first, second = self.pair()
        for sequence, reported in ((2, 1000), (3, 1), (4, 0)):
            accepted = self.state(second, sequence, position=second.position, health=reported)
            self.assertEqual(accepted["health"], 200)
            self.assertEqual(accepted["appearance"], APPEARANCE)
        self.accepted_shot(first, 1, self.body(second.position))
        damage = second.expect("damage", lambda event: event.get("victim_id") == second.player_id)
        self.assertEqual(damage["attacker_id"], first.player_id)
        self.assertEqual(damage["health"], 165)
        self.assertEqual(damage["damage"], 35)
        self.assertEqual(self.state(second, 5, position=second.position, health=1000)["health"], 165)

    def test_ray_hits_only_nearest_player(self):
        """一发穿过两名角色的射线只扣最近目标的血量。"""
        first, second = self.pair()
        third = self.client("后方目标")
        self.state(third, position=[first.spawn[0] + 12, first.spawn[1], first.spawn[2]])
        target = [first.spawn[0] + 20, first.spawn[1], first.spawn[2] + 0.7]
        self.accepted_shot(first, 1, target)
        damage = first.expect("damage", lambda event: event.get("shot_seq") == 1)
        self.assertEqual(damage["victim_id"], second.player_id)
        event = first.expect("combat_state", lambda event: any(
            player["id"] == second.player_id and player["health"] == 165
            for player in event.get("players", [])))
        states = {player["id"]: player for player in event["players"]}
        self.assertEqual(states[first.player_id]["health"], 200)
        self.assertEqual(states[third.player_id]["health"], 200)

    def test_actions_and_aim_target_are_validated_and_legacy_states_still_work(self):
        """可选行为字段完整转发；原客户端不发新字段时保持原状态格式。"""
        first = self.client("行为玩家")
        legacy = self.raw_client()
        legacy.send({"type": "hello", "name": "原协议玩家"})
        legacy.expect("profile")
        legacy.expect("world_state")
        base = {"type": "player_state", "seq": 1, "position": first.spawn, "heading": 90,
                "model": MODEL, "health": 200, "weapon": RIFLE, "shooting": False}
        aim = [first.spawn[0] + 20, first.spawn[1], first.spawn[2] + .7]
        first.send({**base, "actions": ACTIONS, "aim_target": aim})
        accepted = legacy.expect("player_state", lambda event: event.get("player_id") == first.player_id)["state"]
        self.assertEqual(accepted["actions"], ACTIONS)
        self.assertEqual(accepted["aim_target"], aim)
        for changes in (
            {"actions": {"aiming": True}}, {"actions": {**ACTIONS, "flying": True}},
            {"actions": {**ACTIONS, "aiming": 1}}, {"actions": []},
            {"aim_target": [1, 2]}, {"aim_target": [16001, 0, 0]},
            {"aim_target": [1, "2", 3]},
        ):
            first.send({**base, "seq": 2, **changes})
            self.error(first, "invalid_message")
        first.send({**base, "seq": 2})
        old = first.expect("player_state", lambda event: event.get("state", {}).get("seq") == 2)["state"]
        self.assertNotIn("actions", old)
        self.assertNotIn("aim_target", old)

    def test_minigun_is_one_bullet_per_event_and_unknown_weapon_is_rejected(self):
        """本项目普通加特林有单发伤害；未知武器不再静默广播零伤害。"""
        first = self.client("武器玩家", feedback=True)
        second = self.client("目标")
        self.state(first, weapon=0xffffffff)
        self.state(second, position=[first.spawn[0] + 6, first.spawn[1], first.spawn[2]])
        self.shot(first, 1, self.body(second.position), weapon=0xffffffff)
        error = self.error(first, "unsupported_weapon")
        self.assertIn("0xffffffff", error["message"])
        self.assertEqual(error["seq"], 1)
        self.assertEqual(error["weapon"], 0xffffffff)
        rejected = first.expect("shot_result", lambda event: event.get("seq") == 1)
        self.assertFalse(rejected["accepted"])
        self.assertEqual(rejected["reason"], "unsupported_weapon")
        self.assertEqual(self.get_json("/health")[1]["shot_events_received"], 0)
        self.state(first, 2, weapon=MINIGUN)
        self.shot(first, 2, self.body(second.position), weapon=MINIGUN)
        damage = first.expect("damage", lambda event: event.get("shot_seq") == 2)
        self.assertEqual(damage["damage"], 25)
        self.assertEqual(damage["health"], 175)
        result = first.expect("shot_result", lambda event: event.get("seq") == 2)
        self.assertTrue(result["accepted"])
        self.assertTrue(result["hit"])
        self.assertEqual(result["damage"], 25)
        self.assertEqual(result["health"], 175)

    def test_shot_feedback_distinguishes_hit_miss_rejection_and_is_sender_only(self):
        """同一合法射线可区分未命中、命中和被拒绝，回执只发射手。"""
        first = self.client("回执射手", feedback=True)
        second = self.client("回执目标", feedback=True)
        self.state(first)
        self.state(second, position=[first.spawn[0] + 6, first.spawn[1], first.spawn[2]])
        miss_target = [first.spawn[0], first.spawn[1] + 20, first.spawn[2] + .7]
        self.accepted_shot(first, 1, miss_target)
        missed = first.expect("shot_result", lambda event: event.get("seq") == 1)
        self.assertTrue(missed["accepted"])
        self.assertFalse(missed["hit"])
        self.assertNotIn("victim_id", missed)
        self.assertNotIn("damage", missed)
        time.sleep(.13)
        self.accepted_shot(first, 2, self.body(second.position))
        hit = first.expect("shot_result", lambda event: event.get("seq") == 2)
        self.assertEqual({key: hit[key] for key in ("accepted", "hit", "victim_id", "damage", "health")},
                         {"accepted": True, "hit": True, "victim_id": second.player_id, "damage": 35, "health": 165})
        damage = first.expect("damage", lambda event: event.get("shot_seq") == 2)
        self.assertEqual(hit["revision"], damage["revision"])
        first.send({"type": "shot_event", "seq": 3, "origin": self.body(first.position),
                    "target": self.body(second.position), "weapon": RIFLE, "victim_id": second.player_id,
                    "shot_count": 20})
        self.error(first, "invalid_message")
        rejected = first.expect("shot_result", lambda event: event.get("seq") == 3)
        self.assertFalse(rejected["accepted"])
        self.assertEqual(rejected["reason"], "invalid_message")
        first.send({"type": "chat", "text": "回执验证完成"})
        second.expect("chat", lambda event: event.get("text") == "回执验证完成")
        self.assertFalse(any(event.get("type") == "shot_result" for event in second.pending))

    def test_weapon_rules_are_authoritative_and_cooldown_stays_strict(self):
        """公开枪械规则与实际伤害相同，冷却拒绝带剩余时间且不能注入自选规则。"""
        first = self.client("规则射手", feedback=True)
        second = self.client("规则目标")
        self.assertIn("weapon_rules", first.welcome["capabilities"])
        rules = first.welcome["weapon_rules"]
        self.assertEqual(len(rules), 22)
        self.assertEqual(len({rule["weapon"] for rule in rules}), len(rules))
        for rule in rules:
            self.assertEqual(set(rule), {"weapon", "cooldown_ms", "damage"})
            self.assertIsInstance(rule["weapon"], int)
            self.assertGreater(rule["cooldown_ms"], 0)
            self.assertGreater(rule["damage"], 0)
        catalog = {rule["weapon"]: rule for rule in rules}
        self.assertEqual(catalog[MINIGUN], {"weapon": MINIGUN, "cooldown_ms": 20, "damage": 25})
        # 慢枪可稳定验证公网消息突发也不能绕过严格服务端冷却。
        shotgun = 0x1D073A89
        self.state(first, weapon=shotgun)
        self.state(second, position=[first.spawn[0] + 6, first.spawn[1], first.spawn[2]])
        self.shot(first, 1, self.body(second.position), weapon=shotgun)
        result = first.expect("shot_result", lambda event: event.get("seq") == 1)
        self.assertEqual(result["damage"], catalog[shotgun]["damage"])
        self.assertEqual(result["health"], 200 - catalog[shotgun]["damage"])
        self.shot(first, 2, self.body(second.position), weapon=shotgun)
        rejected = first.expect("shot_result", lambda event: event.get("seq") == 2)
        self.assertFalse(rejected["accepted"])
        self.assertEqual(rejected["reason"], "rate_limited")
        self.assertGreater(rejected["retry_after_ms"], 0)
        self.assertLessEqual(rejected["retry_after_ms"], catalog[shotgun]["cooldown_ms"])
        error = self.error(first, "rate_limited")
        self.assertEqual(error["retry_after_ms"], rejected["retry_after_ms"])
        first.send({"type": "shot_event", "seq": 3, "origin": self.body(first.position),
                    "target": self.body(second.position), "weapon": shotgun, "cooldown_ms": 0, "damage": 200})
        self.error(first, "invalid_message")
        time.sleep(rejected["retry_after_ms"] / 1000 + .05)
        self.shot(first, 4, self.body(second.position), weapon=shotgun)
        final = first.expect("shot_result", lambda event: event.get("seq") == 4)
        self.assertTrue(final["accepted"])
        self.assertEqual(final["damage"], catalog[shotgun]["damage"])
        self.assertGreater(final["revision"], result["revision"])
        self.assertEqual(final["health"], 200 - 2 * catalog[shotgun]["damage"])

    def test_client_without_feedback_capability_receives_no_shot_result(self):
        """原客户端仍收到射击和伤害广播，不额外接收新回执类型。"""
        first, second = self.pair()
        self.accepted_shot(first, 1, self.body(second.position))
        first.expect("damage", lambda event: event.get("shot_seq") == 1)
        first.send({"type": "chat", "text": "旧客户端屏障"})
        first.expect("chat", lambda event: event.get("text") == "旧客户端屏障")
        self.assertFalse(any(event.get("type") == "shot_result" for event in first.pending))

    def test_shot_checks_origin_weapon_rate_sequence_and_client_damage_fields(self):
        """远程起点、错误武器、超快连发和伪造受害者等消息不能产生伤害。"""
        first, second = self.pair()
        target = self.body(second.position)
        for sequence, changes in (
            (1, {"origin": [first.spawn[0] + 100, first.spawn[1], first.spawn[2]]}),
            (2, {"weapon": PISTOL}),
            (3, {"victim_id": second.player_id, "damage": 200}),
            (4, {"target": [first.spawn[0] + 301, first.spawn[1], first.spawn[2] + 0.7]}),
        ):
            message = {"type": "shot_event", "seq": sequence,
                       "origin": self.body(first.position), "target": target, "weapon": RIFLE, **changes}
            first.send(message)
            self.error(first)
        self.accepted_shot(first, 5, target)
        first.expect("damage", lambda event: event.get("shot_seq") == 5)
        self.shot(first, 6, target)
        self.error(first)
        self.shot(first, 5, target)
        self.error(first, "stale_seq")
        self.assertEqual(self.state(second, 2, position=second.position, health=1000)["health"], 165)

    def test_stale_state_cannot_shoot(self):
        """过期位置不作为命中判定依据，重发新位置后才可射击。"""
        first, second = self.pair()
        time.sleep(2.15)
        self.shot(first, 1, self.body(second.position))
        self.error(first)
        self.assertEqual(self.state(second, 2, position=second.position)["health"], 200)
        self.state(first, 2, position=first.position)
        self.accepted_shot(first, 2, self.body(second.position))
        second.expect("damage", lambda event: event.get("health") == 165)

    def test_impossible_movement_is_corrected_and_sequence_is_consumed(self):
        """超出出生范围或瞬移会收到服务端纠正，不能重放被拒绝的序号。"""
        first = self.client("移动校验")
        impossible = [first.spawn[0] + 100, first.spawn[1], first.spawn[2]]
        message = {"type": "player_state", "seq": 1, "position": impossible,
                   "heading": 90, "model": MODEL, "health": 200, "weapon": RIFLE, "shooting": False}
        first.send(message)
        correction = first.expect("correction")
        self.assertEqual(correction["position"], first.spawn)
        self.assertEqual(correction["state_seq"], 1)
        first.send({**message, "position": first.spawn})
        self.error(first, "stale_seq")
        self.state(first, 2)
        first.send({**message, "seq": 3})
        correction = first.expect("correction", lambda event: event.get("state_seq") == 3)
        self.assertEqual(correction["position"], first.spawn)
        self.assertEqual(self.state(first, 4)["position"], first.spawn)

    def test_movement_tolerance_cannot_be_reused_for_every_packet(self):
        """连续状态包共用移动预算，不能靠每包重复宽容高速瞬移。"""
        first = self.client("连续移动校验")
        self.state(first)
        for sequence in range(2, 8):
            first.send({"type": "player_state", "seq": sequence,
                        "position": [first.spawn[0] + 2 * (sequence - 1), first.spawn[1], first.spawn[2]],
                        "heading": 90, "model": MODEL, "health": 200, "weapon": RIFLE, "shooting": False})
        correction = first.expect("correction", lambda event: event.get("state_seq", 0) >= 3)
        self.assertLessEqual(correction["position"][0] - first.spawn[0], 2)
        self.assertEqual(correction["reason"], "invalid_movement")

    def test_death_blocks_firing_and_server_respawns_same_player(self):
        """击杀、分数与重生由服务端发出；死亡角色不能继续开火。"""
        first, second = self.pair()
        original_id, original_spawn = second.player_id, second.spawn
        for sequence in range(1, 7):
            if sequence > 1:
                time.sleep(0.13)
            self.accepted_shot(first, sequence, self.body(second.position))
            first.expect("damage", lambda event: event.get("shot_seq") == sequence)
        death = second.expect("death", lambda event: event.get("player_id") == original_id)
        self.assertEqual(death["killer_id"], first.player_id)
        self.assertEqual(death["kills"], 1)
        self.assertEqual(death["deaths"], 1)
        self.assertGreater(death["respawn_at"], int(time.time() * 1000))
        dead = self.combat_player(first, original_id, health=0, alive=False)
        self.assertEqual(dead["deaths"], 1)
        self.shot(second, 1, self.body(first.position))
        self.error(second)
        respawn = second.expect("respawn", lambda event: event.get("player_id") == original_id, timeout=6)
        self.assertEqual(respawn["health"], 200)
        self.assertEqual(respawn["position"], original_spawn)
        revived = self.combat_player(first, original_id, health=200, alive=True, deaths=1)
        self.assertEqual(revived["deaths"], 1)
        self.assertEqual(self.state(second, 2, position=original_spawn)["appearance"], APPEARANCE)

    def test_reconnect_preserves_identity_health_appearance_and_sequence(self):
        """掉线后持有效恢复凭据可继续原角色，旧状态和射击序号不能重放。"""
        first, second = self.pair()
        self.state(first, 10, position=first.position)
        self.state(second, 12, position=second.position)
        self.accepted_shot(first, 8, self.body(second.position))
        second.expect("damage", lambda event: event.get("health") == 165)
        credentials = dict(second.profile)
        second.close()
        first.expect("room_state", lambda message: any(
            member["id"] == second.player_id and member.get("connected") is False
            for member in (message.get("room") or {}).get("members", [])))
        self.combat_player(first, second.player_id, connected=False, health=165)
        time.sleep(0.13)
        self.accepted_shot(first, 9, self.body(second.position))
        restored = self.client("重新连接目标", resume=credentials)
        self.assertEqual(restored.player_id, second.player_id)
        self.assertEqual(restored.profile["health"], 165)
        self.assertEqual(restored.profile["last_state_seq"], 12)
        self.assertEqual(restored.profile["spawn"], credentials["spawn"])
        saved = next(item for item in restored.initial_world["states"] if item["player_id"] == restored.player_id)
        self.assertEqual(saved["state"]["appearance"], APPEARANCE)
        restored.send({"type": "player_state", "seq": 12, "position": second.position,
                       "heading": 90, "model": MODEL, "health": 200, "weapon": RIFLE, "shooting": False})
        self.error(restored, "stale_seq")
        self.assertEqual(self.state(restored, 13, position=second.position, health=1000)["health"], 165)
        first_credentials = dict(first.profile)
        first.close()
        restored.expect("room_state", lambda message: any(
            member["id"] == first.player_id and member.get("connected") is False
            for member in (message.get("room") or {}).get("members", [])))
        shooter = self.client("重新连接射手", resume=first_credentials)
        self.assertEqual(shooter.profile["last_state_seq"], 10)
        self.assertEqual(shooter.profile["last_shot_seq"], 9)
        self.state(shooter, 11, position=first.position)
        self.shot(shooter, 9, self.body(restored.position))
        self.error(shooter, "stale_seq")

    def test_invalid_resume_token_cannot_take_over_existing_player(self):
        """知道玩家 ID 但不知道 token，不能恢复或篡改原玩家。"""
        first = self.client("真正玩家")
        self.state(first, 4)
        credentials = dict(first.profile)
        first.close()
        impersonator = self.raw_client()
        impersonator.send({"type": "hello", "name": "冒用者", "capabilities": ["combat", "resume"],
                           "client_id": credentials["client_id"], "resume_token": "wrong-token"})
        self.error(impersonator)
        restored = self.client("真正玩家", resume=credentials)
        self.assertEqual(restored.player_id, credentials["client_id"])
        self.assertEqual(restored.profile["last_state_seq"], 4)
        self.assertEqual(self.state(restored, 5)["health"], 200)

    def test_replacement_connection_survives_old_connection_cleanup(self):
        """同一凭据替换旧连接后，旧 socket 的清理不能删除新连接。"""
        first = self.client("原连接")
        self.state(first, 4)
        restored = self.client("替换连接", resume=dict(first.profile))
        self.assertEqual(restored.player_id, first.player_id)
        first.close()
        time.sleep(0.15)
        accepted = self.state(restored, 5)
        self.assertEqual(accepted["seq"], 5)
        restored.send({"type": "chat", "text": "新连接仍然可用"})
        chat = restored.expect("chat", lambda message: message.get("text") == "新连接仍然可用")
        self.assertEqual(chat["sender_id"], restored.player_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=protocol.JAR_PATH)
    parser.add_argument("--java", default=protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
