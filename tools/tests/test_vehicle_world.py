#!/usr/bin/env python3
"""真实 WebSocket 验证载具座位、ready 门槛与所有权迁移；不运行游戏物理。"""

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


class VehicleWorldTests(world_tests.WorldV2Harness):
    def test_population_is_one_public_set_and_ready_required_for_each_simulator(self):
        first = self.client("首位人口模拟者")
        initial = [item for item in first.initial_snapshot["entities"] if item.get("population_cell")]
        self.assertEqual(sum(item["kind"] == "ped" for item in initial), 16)
        self.assertEqual(sum(item["kind"] == "vehicle" for item in initial), 8)
        identifiers = {item["entity_id"] for item in initial}
        second = self.client("后来人口观察者")
        self.assertEqual({item["entity_id"] for item in second.initial_snapshot["entities"] if item.get("population_cell")}, identifiers)
        npc = next(item for item in initial if item["kind"] == "ped" and item.get("simulation_task") == "wander")
        self.assertEqual(npc["owner_id"], first.player_id)
        self.assertEqual(npc["ownership"], "offered")
        self.input(first, npc); self.error(first, "simulation_not_ready")
        active = self.ready(first, npc)
        self.input(second, active); self.error(second, "stale_owner")
        first.send({"type": "simulation_result", "world_epoch": first.world_epoch, "entity_id": npc["entity_id"],
            "owner_epoch": active["owner_epoch"], "input_seq": 1, "kind": "entity_health", "health": 150})
        _, damaged = self.delta(first, npc["entity_id"], lambda item: item["components"]["combat"]["health"] == 150)
        self.assertEqual(self.entity(npc["entity_id"])["components"]["combat"]["health"], 150)
        first.send({"type": "simulation_result", "world_epoch": first.world_epoch, "entity_id": npc["entity_id"],
            "owner_epoch": active["owner_epoch"], "input_seq": 2, "kind": "entity_health", "health": 200})
        self.error(first, "health_increase_denied")
        self.assertEqual(damaged["entity_id"], npc["entity_id"])

    def test_population_owner_disconnect_migrates_same_entity_through_ready(self):
        first = self.client("原区域模拟者")
        second = self.client("接手区域模拟者")
        npc = next(item for item in first.initial_snapshot["entities"] if item.get("simulation_task") == "wander")
        active = self.ready(first, npc)
        position = active["components"]["transform"]["position"]
        destination = [position[0] + .4, position[1], position[2]]
        self.input(first, active, position=destination)
        self.delta(first, npc["entity_id"], lambda item: item["last_input_seq"] == 1)
        first.close()
        _, offer = self.delta(second, npc["entity_id"], lambda item: item["owner_id"] == second.player_id and item["ownership"] == "offered")
        self.assertGreater(offer["owner_epoch"], active["owner_epoch"])
        self.assertEqual(offer["generation"], active["generation"])
        self.assertEqual(offer["components"]["transform"]["position"], destination)
        self.input(second, offer, sequence=2); self.error(second, "simulation_not_ready")
        migrated = self.ready(second, offer)
        self.input(second, migrated, sequence=2, owner_epoch=active["owner_epoch"]); self.error(second, "stale_owner")
        self.input(second, migrated, sequence=1)
        _, accepted = self.delta(second, npc["entity_id"], lambda item: item["last_input_seq"] == 1 and item["owner_epoch"] == migrated["owner_epoch"])
        self.assertEqual(accepted["components"]["transform"]["position"], destination)

    def traffic_owner(self, ready_driver):
        player = self.client("交通租约模拟者")
        car = next(item for item in player.initial_snapshot["entities"] if item.get("population_cell")
            and item["kind"] == "vehicle" and item["components"]["vehicle"]["seats"]["driver"] is not None)
        driver = self.entity(car["components"]["vehicle"]["seats"]["driver"])
        car = self.ready(player, car)
        if ready_driver:
            driver = self.ready(player, driver)
        return player, car, driver

    def keep_car_active(self, player, car, duration=5.6):
        started = time.monotonic(); sequence = 0
        while time.monotonic() - started < duration:
            sequence += 1
            # Population ownership also requires the simulator's player lease to stay active.
            self.state(player, sequence)
            current = self.entity(car["entity_id"])
            self.input(player, current, sequence=sequence)
            self.delta(player, car["entity_id"], lambda item: item["last_input_seq"] == sequence)
            time.sleep(.15)
        return self.world()

    def test_active_traffic_driver_lease_renews_with_vehicle_without_epoch_reset(self):
        player, car, driver = self.traffic_owner(True)
        after = self.keep_car_active(player, car)
        driver_after = self.entity(driver["entity_id"], after)
        self.assertEqual(driver_after["owner_epoch"], driver["owner_epoch"])
        self.assertEqual(driver_after["owner_id"], player.player_id)
        self.assertEqual(driver_after["ownership"], "active")
        self.assertGreater(driver_after["lease_until_tick"], after["world_tick"])
        self.assertEqual(self.entity(car["entity_id"], after)["owner_epoch"], car["owner_epoch"])

    def test_unready_traffic_driver_is_not_kept_alive_by_ready_vehicle(self):
        player, car, driver = self.traffic_owner(False)
        self.assertEqual(driver["ownership"], "offered")
        after = self.keep_car_active(player, car)
        driver_after = self.entity(driver["entity_id"], after)
        self.assertGreater(driver_after["owner_epoch"], driver["owner_epoch"], "未ready司机必须超时撤销/重新邀请")
        self.assertEqual(driver_after["ownership"], "offered")
        self.assertEqual(self.entity(car["entity_id"], after)["owner_epoch"], car["owner_epoch"])

    def car(self):
        return next(item for item in self.world()["entities"] if item["kind"] == "vehicle"
                    and item["components"]["vehicle"]["seats"]["driver"] is None)

    def input(self, client, car, sequence=1, *, position=None, owner_epoch=None, based_revision=None,
              world_epoch=None, view=None, **extra):
        transform = copy.deepcopy(car["components"]["transform"])
        if position is not None:
            transform["position"] = position
        message = {"type": "entity_input", "world_epoch": world_epoch or client.world_epoch,
            "entity_id": car["entity_id"], "owner_epoch": car["owner_epoch"] if owner_epoch is None else owner_epoch,
            "input_seq": sequence, "based_on_revision": car["revision"] if based_revision is None else based_revision,
            "transform": transform, **extra}
        if view is not None:
            message["view"] = view
        client.send(message)
        return message

    def ready(self, client, car):
        client.send({"type": "entity_ready", "world_epoch": client.world_epoch,
            "entity_id": car["entity_id"], "owner_epoch": car["owner_epoch"]})
        _, active = self.delta(client, car["entity_id"], lambda item: item["ownership"] == "active")
        return active

    def drive(self, name="驾驶员"):
        driver = self.client(name); self.state(driver)
        car = self.car()
        self.accepted_interaction(driver, "enter_vehicle", car["entity_id"], seat="driver")
        _, offered = self.delta(driver, car["entity_id"], lambda item: item["owner_id"] == driver.player_id and item["ownership"] == "offered")
        return driver, self.ready(driver, offered)

    def test_driver_control_requires_ready_and_owner_epoch_then_increasing_input(self):
        driver = self.client(); self.state(driver)
        car = self.car()
        self.input(driver, car); self.error(driver, "stale_owner")
        self.accepted_interaction(driver, "enter_vehicle", car["entity_id"], seat="driver")
        _, offered = self.delta(driver, car["entity_id"], lambda item: item["ownership"] == "offered")
        self.assertEqual(offered["components"]["vehicle"]["seats"]["driver"], driver.entity_id)
        self.input(driver, offered); self.error(driver, "simulation_not_ready")
        driver.send({"type": "entity_ready", "world_epoch": driver.world_epoch,
            "entity_id": offered["entity_id"], "owner_epoch": offered["owner_epoch"] - 1})
        self.error(driver, "stale_owner")
        active = self.ready(driver, offered)
        target = [active["components"]["transform"]["position"][0] + .5, -1088.1, 22.4]
        self.input(driver, active, position=target, view={"engine_on": True, "lights_on": True})
        _, moved = self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 1)
        self.assertEqual(moved["components"]["transform"]["position"], target)
        self.assertTrue(moved["components"]["vehicle"]["engine_on"])
        self.input(driver, moved, sequence=1); self.error(driver, "stale_input")
        self.input(driver, moved, sequence=2, owner_epoch=moved["owner_epoch"] - 1); self.error(driver, "stale_owner")
        self.input(driver, moved, sequence=2, world_epoch="old-epoch"); self.error(driver, "wrong_world")
        self.assertEqual(self.entity(car["entity_id"])["last_input_seq"], 1)

    def test_seat_race_commits_one_driver_and_cannot_forge_occupants(self):
        first, second = self.client("座位一"), self.client("座位二")
        self.state(first); self.state(second)
        car = self.car(); revision = car["revision"]
        left = self.interaction(first, "enter_vehicle", car["entity_id"], seat="driver", revision=revision)
        right = self.interaction(second, "enter_vehicle", car["entity_id"], seat="driver", revision=revision)
        left_result = first.expect("interaction_result", lambda event: event.get("request_id") == left["request_id"])
        right_result = second.expect("interaction_result", lambda event: event.get("request_id") == right["request_id"])
        self.assertEqual(sum(bool(item["accepted"]) for item in (left_result, right_result)), 1)
        final = self.entity(car["entity_id"])
        winner, loser = (first, second) if left_result["accepted"] else (second, first)
        self.assertEqual(final["components"]["vehicle"]["seats"]["driver"], winner.entity_id)
        self.assertEqual(final["owner_id"], winner.player_id)
        self.assertNotIn("attachment", self.entity(loser.entity_id)["components"])
        self.interaction(loser, "enter_vehicle", car["entity_id"], seat="passenger:0", occupants={"driver": loser.entity_id})
        self.error(loser, "invalid_message")
        self.assertEqual(self.entity(car["entity_id"])["components"]["vehicle"]["seats"]["driver"], winner.entity_id)

    def test_enter_and_leave_request_replays_never_reapply_seat_transactions(self):
        driver = self.client("幂等入座"); self.state(driver)
        car = self.car()
        request = self.interaction(driver, "enter_vehicle", car["entity_id"], seat="driver", request_id="seat-enter-once")
        result = driver.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertTrue(result["accepted"])
        before = self.world(); driver.send(request)
        replay = driver.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertEqual(replay, result)
        self.assertEqual(self.world()["cut_revision"], before["cut_revision"])
        self.assertEqual(self.entity(car["entity_id"])["components"]["vehicle"]["seats"]["driver"], driver.entity_id)
        driver.send({**request, "seat": "passenger:0"}); self.error(driver, "invalid_request")
        self.assertEqual(self.world()["cut_revision"], before["cut_revision"])
        request = self.interaction(driver, "leave_vehicle", car["entity_id"], request_id="seat-leave-once")
        result = driver.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertTrue(result["accepted"])
        before = self.world(); driver.send(request)
        replay = driver.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertEqual(replay, result)
        self.assertEqual(self.world()["entities"], before["entities"])
        self.assertEqual(self.world()["cut_revision"], before["cut_revision"])
        self.assertNotIn("attachment", self.entity(driver.entity_id)["components"])

    def test_two_players_racing_npc_driver_eviction_have_one_atomic_winner(self):
        first, car, npc = self.traffic_owner(True)
        second = self.client("抢车竞争者")
        position = car["components"]["transform"]["position"]
        # 每个玩家首次有效位置可在固定测试出生区40米内确认，之后按正常移动预算。
        self.state(first, position=position)
        self.state(second, position=[position[0] + 1, position[1], position[2]])
        before = self.world(); car = self.entity(car["entity_id"], before); npc = self.entity(npc["entity_id"], before)
        left = self.interaction(first, "enter_vehicle", car["entity_id"], seat="driver", revision=car["revision"], request_id="npc-car-left")
        right = self.interaction(second, "enter_vehicle", car["entity_id"], seat="driver", revision=car["revision"], request_id="npc-car-right")
        results = [first.expect("interaction_result", lambda event: event.get("request_id") == left["request_id"]),
                   second.expect("interaction_result", lambda event: event.get("request_id") == right["request_id"])]
        self.assertEqual(sum(bool(result["accepted"]) for result in results), 1)
        winner = first if results[0]["accepted"] else second
        request = left if winner is first else right
        event, offered = self.delta(winner, car["entity_id"], lambda item: item["owner_id"] == winner.player_id and item["ownership"] == "offered")
        after = self.world()
        # The atomic seat transaction is followed by the server's new walking AI task.
        self.assertGreaterEqual(after["cut_revision"], before["cut_revision"] + 1)
        self.assertEqual(event["world_revision"], after["cut_revision"])
        changed = {car["entity_id"], npc["entity_id"], winner.entity_id}
        self.assertTrue(changed.issubset({item["entity_id"] for item in event["entities"]}))
        for entity_id in changed - {npc["entity_id"]}:
            self.assertEqual(self.entity(entity_id, after)["revision"], self.entity(entity_id, before)["revision"] + 1)
        evicted = self.entity(npc["entity_id"], after)
        self.assertGreaterEqual(evicted["revision"], npc["revision"] + 1)
        self.assertEqual(evicted["ai_task"]["action"], "wander")
        self.assertNotIn("attachment", evicted["components"])
        self.assertEqual(evicted["components"]["combat"], npc["components"]["combat"])
        self.assertEqual(evicted["generation"], npc["generation"])
        self.assertEqual(evicted["components"]["transform"]["position"], [position[0] + 1, position[1] + 1, position[2]])
        self.assertEqual(offered["components"]["vehicle"]["seats"]["driver"], winner.entity_id)
        self.assertGreater(offered["owner_epoch"], car["owner_epoch"])
        winner.send(request)
        replay = winner.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
        self.assertTrue(replay["accepted"])
        self.assertEqual(self.world()["cut_revision"], after["cut_revision"])
        active = self.ready(winner, offered)
        self.input(first, active, owner_epoch=car["owner_epoch"]); self.error(first, "stale_owner")
        self.assertEqual(self.entity(npc["entity_id"])["components"]["combat"]["health"], npc["components"]["combat"]["health"])

    def test_only_driver_moves_vehicle_and_all_attached_players_share_position(self):
        driver, car = self.drive()
        passenger = self.client("乘客"); self.state(passenger)
        self.accepted_interaction(passenger, "enter_vehicle", car["entity_id"], seat="passenger:0")
        car = self.entity(car["entity_id"])
        self.input(passenger, car); self.error(passenger, "stale_owner")
        destination = [car["components"]["transform"]["position"][0] + 1, -1088.1, 22.4]
        self.input(driver, car, position=destination)
        _, moved = self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 1)
        snapshot = self.world()
        for client in (driver, passenger):
            entity = self.entity(client.entity_id, snapshot)
            self.assertEqual(entity["components"]["transform"]["position"], destination)
            self.assertEqual(entity["components"]["attachment"]["entity_id"], car["entity_id"])
        joined = self.client("后来玩家")
        for client in (driver, passenger):
            entity = self.entity(client.entity_id, joined.initial_snapshot)
            self.assertEqual(entity["components"]["transform"]["position"], destination)
        self.assertEqual(moved["owner_id"], driver.player_id)

    def test_three_passengers_join_with_old_basis_during_driver_updates(self):
        driver, car = self.drive()
        basis, owner_epoch = car["revision"], car["owner_epoch"]
        passengers = [self.client("共享乘客" + str(index)) for index in range(3)]
        for passenger in passengers:
            self.state(passenger)
        for index, passenger in enumerate(passengers):
            current = self.entity(car["entity_id"])
            self.input(driver, current, sequence=index + 1)
            self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == index + 1)
            self.accepted_interaction(passenger, "enter_vehicle", car["entity_id"],
                seat="passenger:" + str(index), revision=basis, target_generation=car["generation"])
        current = self.entity(car["entity_id"])
        self.assertGreater(current["revision"], basis)
        self.assertEqual(current["owner_id"], driver.player_id)
        self.assertEqual(current["owner_epoch"], owner_epoch)
        self.assertEqual(current["ownership"], "active")
        self.assertEqual(current["components"]["vehicle"]["seats"],
            {"driver": driver.entity_id, **{"passenger:" + str(index): passenger.entity_id
                for index, passenger in enumerate(passengers)}})
        destination = [current["components"]["transform"]["position"][0] + .5, -1088.1, 22.4]
        self.input(driver, current, sequence=4, position=destination)
        self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 4)
        snapshot = self.world()
        for player in [driver, *passengers]:
            self.assertEqual(self.entity(player.entity_id, snapshot)["components"]["transform"]["position"], destination)

    def test_passenger_seat_race_uses_current_occupancy_and_rejects_invalid_baselines(self):
        driver, car = self.drive()
        first, second = self.client("竞争乘客一"), self.client("竞争乘客二")
        self.state(first); self.state(second)
        basis = car["revision"]
        self.input(driver, car)
        self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 1)
        left = self.interaction(first, "enter_vehicle", car["entity_id"], seat="passenger:0", revision=basis)
        right = self.interaction(second, "enter_vehicle", car["entity_id"], seat="passenger:0", revision=basis)
        left_result = first.expect("interaction_result", lambda event: event.get("request_id") == left["request_id"])
        right_result = second.expect("interaction_result", lambda event: event.get("request_id") == right["request_id"])
        self.assertEqual(sum(bool(result["accepted"]) for result in (left_result, right_result)), 1)
        winner, loser = (first, second) if left_result["accepted"] else (second, first)
        failure = right_result if left_result["accepted"] else left_result
        self.assertEqual(failure["reason"], "seat_unavailable")
        self.error(loser, "seat_unavailable")
        current = self.entity(car["entity_id"])
        self.assertEqual(current["components"]["vehicle"]["seats"]["passenger:0"], winner.entity_id)
        self.assertEqual(current["owner_id"], driver.player_id)
        self.assertEqual(current["owner_epoch"], car["owner_epoch"])
        self.assertNotIn("attachment", self.entity(loser.entity_id)["components"])
        for fields, reason in (({"revision": current["revision"] + 1000}, "invalid_revision"),
                               ({"target_generation": current["generation"] + 1}, "stale_generation")):
            request = self.interaction(loser, "enter_vehicle", car["entity_id"], seat="passenger:1", **fields)
            result = loser.expect("interaction_result", lambda event: event.get("request_id") == request["request_id"])
            self.assertFalse(result["accepted"])
            self.assertEqual(result["reason"], reason)
            self.error(loser, reason)
        self.assertIsNone(self.entity(car["entity_id"])["components"]["vehicle"]["seats"]["passenger:1"])

    def test_passenger_leave_preserves_drivers_pending_ready_offer(self):
        driver = self.client("尚在加载的驾驶员"); self.state(driver)
        car = self.car()
        self.accepted_interaction(driver, "enter_vehicle", car["entity_id"], seat="driver")
        _, offered = self.delta(driver, car["entity_id"], lambda item: item["ownership"] == "offered")
        passenger = self.client("离车乘客"); self.state(passenger)
        self.accepted_interaction(passenger, "enter_vehicle", car["entity_id"], seat="passenger:0")
        self.accepted_interaction(passenger, "leave_vehicle", car["entity_id"])
        current = self.entity(car["entity_id"])
        self.assertEqual(current["components"]["vehicle"]["seats"]["driver"], driver.entity_id)
        self.assertIsNone(current["components"]["vehicle"]["seats"]["passenger:0"])
        self.assertEqual(current["owner_id"], driver.player_id)
        self.assertEqual(current["owner_epoch"], offered["owner_epoch"])
        self.assertEqual(current["ownership"], "offered", "乘客离车不能取消驾驶员的资源ready邀请")
        self.input(driver, current); self.error(driver, "simulation_not_ready")
        active = self.ready(driver, offered)
        self.input(driver, active)
        self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 1)

    def test_attached_player_v1_input_cannot_override_confirmed_vehicle_pose(self):
        driver, car = self.drive()
        passenger = self.client("座位位置保护"); self.state(passenger)
        self.accepted_interaction(passenger, "enter_vehicle", car["entity_id"], seat="passenger:0")
        car = self.entity(car["entity_id"])
        position = car["components"]["transform"]["position"]
        # 合法格式的陈旧车载样本可能超过步行预算；必须忽略坐标并接受表现，不回滚高速车辆。
        self.state(passenger, 2, position=[position[0] - 10, position[1], position[2]])
        attached = self.entity(passenger.entity_id)
        self.assertEqual(attached["components"]["transform"]["position"], position)
        self.assertEqual(attached["components"]["attachment"], {"entity_id": car["entity_id"], "seat": "passenger:0"})

    def test_driver_disconnect_freezes_last_position_and_requires_new_ready(self):
        driver, car = self.drive()
        passenger = self.client("接管乘客"); self.state(passenger)
        self.accepted_interaction(passenger, "enter_vehicle", car["entity_id"], seat="passenger:0")
        car = self.entity(car["entity_id"])
        destination = [car["components"]["transform"]["position"][0] + 1, -1088.1, 22.4]
        self.input(driver, car, position=destination)
        self.delta(driver, car["entity_id"], lambda item: item["last_input_seq"] == 1)
        old_epoch = car["owner_epoch"]
        driver.close()
        deadline = time.monotonic() + 3
        while True:
            current = self.entity(car["entity_id"])
            if current["owner_id"] != driver.player_id:
                break
            self.assertLess(time.monotonic(), deadline); time.sleep(.03)
        self.assertGreater(current["owner_epoch"], old_epoch)
        self.assertEqual(current["components"]["transform"]["position"], destination)
        self.assertIsNone(current["components"]["vehicle"]["seats"]["driver"])
        self.assertEqual(current["components"]["vehicle"]["seats"]["passenger:0"], passenger.entity_id)
        self.assertEqual(self.entity(passenger.entity_id)["components"]["transform"]["position"], destination)
        if current["owner_id"] is not None:
            self.assertEqual(current["ownership"], "offered", "接管不得跳过资源 ready 门槛")
        self.input(passenger, current, sequence=2, owner_epoch=old_epoch)
        self.error(passenger)
        self.assertEqual(self.entity(car["entity_id"])["components"]["transform"]["position"], destination)
        observer = self.client("断线后观察者")
        self.assertEqual(self.entity(car["entity_id"], observer.initial_snapshot)["components"]["transform"]["position"], destination)

    def test_vehicle_damage_is_owner_candidate_and_cannot_heal_or_write_seats(self):
        driver, car = self.drive()
        stranger = self.client("未授权损伤"); self.state(stranger)
        base = {"type": "simulation_result", "world_epoch": driver.world_epoch, "entity_id": car["entity_id"],
            "owner_epoch": car["owner_epoch"], "input_seq": 1, "kind": "vehicle_damage", "engine_health": 900, "body_health": 950}
        stranger.send(base); self.error(stranger, "stale_owner")
        driver.send({**base, "seats": {"driver": stranger.entity_id}}); self.error(driver, "invalid_message")
        driver.send(base)
        _, damaged = self.delta(driver, car["entity_id"], lambda item: item["components"]["vehicle"]["engine_health"] == 900)
        driver.send({**base, "input_seq": 2, "engine_health": 1000}); self.error(driver, "health_increase_denied")
        driver.send(base); self.error(driver, "stale_input")
        self.assertEqual(self.entity(car["entity_id"])["components"]["vehicle"]["body_health"], 950)
        self.assertEqual(damaged["components"]["vehicle"]["seats"]["driver"], driver.entity_id)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=world_tests.protocol.JAR_PATH)
    parser.add_argument("--java", default=world_tests.protocol.JAVA_COMMAND)
    arguments, remainder = parser.parse_known_args()
    world_tests.protocol.JAR_PATH = arguments.jar.expanduser().resolve()
    world_tests.protocol.JAVA_COMMAND = arguments.java
    unittest.main(argv=[sys.argv[0], *remainder])
