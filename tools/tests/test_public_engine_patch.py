#!/usr/bin/env python3
"""校验公共战局补丁隔离范围；不启动游戏或覆盖运行中的引擎。"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from build_native_probe import (
    DEFAULT_WASM, EXPECTED_MODEL_WRAPPER, HOOK_FUNCTION, ORIGINAL_SHA256,
    PUBLIC_MODEL_WRAPPER, build, checked_audit, export_map,
)
from inspect_native_bridge import WasmAudit


class PublicEnginePatchTests(unittest.TestCase):
    def test_cached_melee_inputs_use_two_byte_outputs_and_preserve_original_body(self):
        index = 41719
        self.assertIn('mpCachedMeleeInputs', self.audits['public'].exports[index])
        self.assertEqual(self.original.descriptor(index)['signature'], {'parameters': ['i64', 'i64'], 'results': []})
        operations = self.original.instructions(index)['instructions']
        self.assertEqual(sum(item['operation'] == 'i32.store8' for item in operations), 2)
        self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))

    def test_world_component_native_abis_and_original_function_bodies(self):
        expected = {
            'mpCreateVehicle': (61266, ['i32', 'i64', 'f32', 'i32', 'i32', 'i32'], ['i32']),
            'mpDeleteVehicle': (61267, ['i64'], []),
            'mpGetQuaternion': (50044, ['i32', 'i64', 'i64', 'i64', 'i64'], []),
            'mpSetQuaternion': (50147, ['i32', 'f32', 'f32', 'f32', 'f32'], []),
            'mpGetVelocity': (50052, ['i64', 'i32'], []),
            'mpSetVelocity': (50154, ['i32', 'i64'], []),
            'mpGetAngularVelocity': (50047, ['i64', 'i32'], []),
            'mpSetAngularVelocity': (50155, ['i32', 'i64'], []),
            'mpSetPedIntoVehicle': (57201, ['i32', 'i32', 'i32'], []),
            'mpIsArrested': (58711, ['i32', 'i32'], ['i32']),
            'mpMeleeAction': (57608, ['i32'], ['i32']),
            'mpTaskWander': (60591, ['i32', 'f32', 'i32'], []),
            'mpDriveWander': (60576, ['i32', 'i32', 'f32', 'i32'], []),
            'mpPedDensity': (57186, ['f32'], []),
            'mpScenarioDensity': (57187, ['f32', 'f32'], []),
            'mpVehicleDensity': (61298, ['f32'], []),
            'mpRandomVehicleDensity': (61299, ['f32'], []),
            'mpParkedVehicleDensity': (61300, ['f32'], []),
            'mpAllVehicles': (61943, ['i64'], ['i32']),
            'mpNearbyPeds': (57673, ['i32', 'i64', 'i32'], ['i32']),
            'mpPopulationType': (50055, ['i32'], ['i32']),
            'mpEngineHealth': (61599, ['i32'], ['f32']),
            'mpBodyHealth': (61604, ['i32'], ['f32']),
        }
        for name, (index, parameters, results) in expected.items():
            self.assertIn(name, self.audits['public'].exports[index])
            self.assertEqual(self.original.descriptor(index)['signature'], {'parameters': parameters, 'results': results})
            self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))

    def test_world_readiness_getters_only_read_initialized_pointers(self):
        for name, index, address in (("mpPedSyncTree", 88346, 29559952),
                                     ("mpPlayerSyncTree", 88355, 29561200)):
            self.assertIn(name, self.audits["public"].exports[index])
            self.assertEqual(self.original.descriptor(index)["signature"],
                             {"parameters": ["i64"], "results": ["i64"]})
            instructions = self.original.instructions(index)["instructions"]
            self.assertEqual([item["operation"] for item in instructions], ["i64.const", "i64.load", "end"])
            self.assertEqual(instructions[0]["value"], address)
            self.assertEqual(self.body(self.original, index), self.body(self.audits["public"], index))
        index = 63797
        self.assertIn("mpNetworkScriptHandler", self.audits["public"].exports[index])
        self.assertEqual(self.body(self.original, index), self.body(self.audits["public"], index))

    @classmethod
    def setUpClass(cls):
        cls.source_digest = hashlib.sha256(DEFAULT_WASM.read_bytes()).hexdigest()
        cls.original = checked_audit(DEFAULT_WASM, True, True)
        cls.temporary = tempfile.TemporaryDirectory(prefix="gta-public-patch-")
        cls.outputs, cls.reports, cls.audits = {}, {}, {}
        for name, entities, public in (("probe", False, False), ("replica", True, False), ("public", True, True)):
            output, report = build(cls.original, entities, public)
            path = Path(cls.temporary.name) / f"{name}.wasm"
            path.write_bytes(output)
            cls.outputs[name], cls.reports[name], cls.audits[name] = path, report, WasmAudit(path)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()
        if hashlib.sha256(DEFAULT_WASM.read_bytes()).hexdigest() != cls.source_digest:
            raise AssertionError("原始单机引擎被修改")

    def body(self, audit, index):
        start, end = audit.bodies[index]
        return audit.data[start:end]

    def test_readonly_probe_unchanged_and_public_patch_is_isolated(self):
        # 外观导出仅扩展实体探针；公共开关仍不能改变只读探针产物。
        self.assertEqual(self.reports["probe"]["prototype"]["sha256"],
                         "bbf19a89c8327eb580eb3c7a1530dbd1988ac3f4624897aba3f348cf98393dd8")
        self.assertEqual(len(self.reports["probe"]["additional_exports"]), len(export_map(False)))
        self.assertEqual(self.body(self.audits["replica"], HOOK_FUNCTION),
                         self.body(self.audits["public"], HOOK_FUNCTION))
        self.assertEqual(self.body(self.audits["replica"], PUBLIC_MODEL_WRAPPER), EXPECTED_MODEL_WRAPPER)
        self.assertEqual(self.source_digest, ORIGINAL_SHA256)

    def test_only_expected_function_bodies_change(self):
        for name, expected in (("probe", {HOOK_FUNCTION}), ("replica", {HOOK_FUNCTION}),
                               ("public", {HOOK_FUNCTION, PUBLIC_MODEL_WRAPPER})):
            result = self.audits[name]
            changed = {index for index in self.original.bodies
                       if self.body(self.original, index) != self.body(result, index)}
            self.assertEqual(changed, expected, name)
            self.assertEqual(self.reports[name]["invariants"]["patched_function_bodies"], len(expected))
        self.assertEqual(self.body(self.original, PUBLIC_MODEL_WRAPPER), EXPECTED_MODEL_WRAPPER)
        replacement = self.body(self.audits["public"], PUBLIC_MODEL_WRAPPER)
        self.assertEqual(len(replacement), len(EXPECTED_MODEL_WRAPPER))
        decoded = self.audits["public"].instructions(PUBLIC_MODEL_WRAPPER)
        self.assertTrue(decoded["decode_complete"])
        self.assertEqual(decoded["locals"], [])
        self.assertEqual({item["operation"] for item in decoded["instructions"]}, {"nop", "end"})
        # 直接桥设置模型和另一种玩家切换路径均保留原始函数体。
        for index in (58625, 58869, 47995, 45486):
            self.assertEqual(self.body(self.original, index), self.body(self.audits["public"], index))

    def test_all_other_sections_and_export_abis_are_preserved(self):
        result = self.audits["public"]
        self.assertEqual(result.types, self.original.types)
        self.assertEqual(result.imports, self.original.imports)
        self.assertEqual(result.function_types, self.original.function_types)
        self.assertEqual(result.names, self.original.names)
        for kind, (start, end) in self.original.sections.items():
            if kind in (7, 10):
                continue
            new_start, new_end = result.sections[kind]
            self.assertEqual(self.original.data[start:end], result.data[new_start:new_end], f"section {kind}")
        self.assertEqual([(name, self.original.data[start:end]) for name, start, end in self.original.custom],
                         [(name, result.data[start:end]) for name, start, end in result.custom])
        for index, names in self.original.exports.items():
            self.assertTrue(set(names).issubset(result.exports[index]))
        self.assertEqual(len(self.reports["public"]["additional_exports"]), len(export_map(True)))
        for name, (index, _, parameters, results) in export_map(True).items():
            self.assertIn(name, result.exports[index])
            self.assertEqual(result.descriptor(index)["signature"], {"parameters": parameters, "results": results})
        self.assertEqual(result.exports, self.audits["replica"].exports)

    def test_appearance_export_functions_retain_original_bodies(self):
        appearance_exports = ("mpGetDrawable", "mpGetTexture", "mpGetPalette", "mpSetComponent",
                              "mpRandomComponents", "mpRandomProps", "mpSetHeadOverlay", "mpSetOverlayTint",
                              "mpSetHairTint", "mpGetPropIndex", "mpGetPropTextureIndex", "mpSetProp", "mpClearProp",
                              "mpHeadOverlayCount", "mpDrawableCount", "mpTextureCount")
        for name in appearance_exports:
            index, expected_name, parameters, results = export_map(True)[name]
            descriptor = self.original.descriptor(index)
            self.assertEqual(descriptor["name"], expected_name, name)
            self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results}, name)
            self.assertIn(name, self.audits["public"].exports[index])
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)

    def test_combat_export_abis_and_standard_bullet_defaults(self):
        for name in ("mpShootBullet", "mpRevive", "mpResurrect", "mpClearTasksImmediately",
                     "mpRequestWeaponAsset", "mpHasWeaponAsset"):
            index, expected_name, parameters, results = export_map(True)[name]
            descriptor = self.original.descriptor(index)
            self.assertEqual(descriptor["name"], expected_name, name)
            self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results}, name)
            self.assertIn(name, self.audits["public"].exports[index])
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            self.assertEqual(self.body(self.original, index), self.body(self.audits["public"], index), name)
        # 标准九参 C++ 子弹接口与 SHOOT_SINGLE_BULLET_BETWEEN_COORDS 包装器
        # 共同调用同一实现，尾部八个默认值也完全相同，避免自行猜测新接口的十七个参数。
        for index in (52891, 53207):
            decoded = self.original.instructions(index)
            self.assertTrue(decoded["decode_complete"])
            calls = [item for item in decoded["instructions"] if item["operation"] == "call"]
            self.assertEqual([item["target"]["function_index"] for item in calls], [52889])
            defaults = decoded["instructions"][-10:-2]
            self.assertEqual([item["operation"] for item in defaults], ["i32.const"] * 8)
            self.assertEqual([item["value"] for item in defaults], [0, 0, 0, 0, 1, 0, 0, 0])

    def test_native_notification_exports_abis_and_isolation(self):
        expected = {
            "mpBeginTheFeedPost": (51457, "hud_commands::CommandBeginTheFeedPost(char const*)", ["i64"], []),
            "mpAddTextPlayerSubstring": (51504, "hud_commands::CommandAddTextComponentSubStringPlayerName(char const*)", ["i64"], []),
            "mpEndTheFeedPostTicker": (51464, "hud_commands::CommandEndTheFeedPostTicker(bool, bool)", ["i32", "i32"], ["i32"]),
        }
        for name, (index, expected_name, parameters, results) in expected.items():
            self.assertEqual(export_map(True)[name], (index, expected_name, parameters, results))
            descriptor = self.original.descriptor(index)
            self.assertEqual(descriptor["name"], expected_name, name)
            self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results}, name)
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertIn(name, result.exports[index])
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)
        # Begin 与正文添加器直接转发 i64 指针；Ticker 包装器补第三个默认布尔值 0。
        for index, target in ((51457, 64096), (51504, 64131)):
            decoded = self.original.instructions(index)
            self.assertTrue(decoded["decode_complete"])
            self.assertEqual([item["operation"] for item in decoded["instructions"]], ["local.get", "call", "end"])
            self.assertEqual(decoded["instructions"][0]["index"], 0)
            self.assertEqual(decoded["instructions"][1]["target"]["function_index"], target)
        decoded = self.original.instructions(51464)
        self.assertTrue(decoded["decode_complete"])
        self.assertEqual([item["operation"] for item in decoded["instructions"]],
                         ["local.get", "local.get", "i32.const", "call", "end"])
        self.assertEqual([item["index"] for item in decoded["instructions"][:2]], [0, 1])
        self.assertEqual(decoded["instructions"][2]["value"], 0)
        self.assertEqual(decoded["instructions"][3]["target"]["function_index"], 64099)
        self.assertEqual(decoded["instructions"][3]["target"]["signature"],
                         {"parameters": ["i32", "i32", "i32"], "results": ["i32"]})

    def test_native_notification_construction_retains_memory_contract(self):
        # Begin 保存文字标签指针供 End 读取，因此调用方的 UTF-8 缓冲至少应活到 End 返回。
        begin = self.original.instructions(64096)
        self.assertTrue(begin["decode_complete"])
        pointer_store = [item["operation"] for item in begin["instructions"]]
        self.assertIn("i64.store", pointer_store)
        self.assertEqual(begin["instructions"][-4]["operation"], "local.get")
        self.assertEqual(begin["instructions"][-4]["index"], 0)
        self.assertEqual(begin["instructions"][-3]["operation"], "i64.store")
        # End 先拼接文字再交给 feed；feed 内部把文字复制到自有字符串，而非保存 JS 缓冲。
        end = self.original.instructions(64099)
        self.assertTrue(end["decode_complete"])
        calls = [item["target"]["function_index"] for item in end["instructions"] if item["operation"] == "call"]
        self.assertEqual(calls, [77479, 77488, 37511])
        feed = self.original.instructions(37511)
        self.assertTrue(feed["decode_complete"])
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 651
                            for item in feed["instructions"]))
        constraints = "\n".join(self.reports["public"]["entity_probe_constraints"])
        self.assertIn("NUL 结尾 UTF-8", constraints)
        self.assertIn("End 返回前不可释放或覆写", constraints)

    def test_weapon_sampling_and_action_exports_abis_and_isolation(self):
        expected = {
            "mpGetCurrentPedWeapon": (62918, "weapon_commands::CommandGetCurrentPedWeapon(int, int&, bool)", ["i32", "i64", "i32"], ["i32"]),
            "mpGetAmmoInClip": (62942, "weapon_commands::CommandGetAmmoInClip(int, int, int&)", ["i32", "i32", "i64"], ["i32"]),
            "mpLastWeaponImpact": (62953, "weapon_commands::CommandGetPedLastWeaponImpactCoord(int, rage::Vector3&)", ["i32", "i64"], ["i32"]),
            "mpIsAiming": (58689, "player_commands::CommandIsPlayerFreeAiming(int)", ["i32"], ["i32"]),
            "mpIsReloading": (57122, "ped_commands::CommandIsPedReloading(int)", ["i32"], ["i32"]),
            "mpIsJumping": (57240, "ped_commands::CommandIsPedJumping(int)", ["i32"], ["i32"]),
            "mpIsDucking": (57259, "ped_commands::CommandIsPedDucking(int)", ["i32"], ["i32"]),
            "mpSetDucking": (57258, "ped_commands::CommandSetPedDucking(int, bool)", ["i32", "i32"], []),
            "mpIsSprinting": (60839, "task_commands::CommandPedIsSprinting(int)", ["i32"], ["i32"]),
            "mpTaskAimGunAtCoord": (60655, "task_commands::CommandTaskAimGunAtCoord(int, rage::scrVector const&, int, bool, bool)", ["i32", "i64", "i32", "i32", "i32"], []),
            "mpTaskReloadWeapon": (60785, "task_commands::CommandTaskReloadWeapon(int, bool)", ["i32", "i32"], []),
            "mpTaskJump": (60565, "task_commands::CommandTaskJump(int, bool, bool, bool)", ["i32", "i32", "i32", "i32"], []),
        }
        for name, (index, expected_name, parameters, results) in expected.items():
            self.assertEqual(export_map(True)[name], (index, expected_name, parameters, results))
            descriptor = self.original.descriptor(index)
            self.assertEqual(descriptor["name"], expected_name, name)
            self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results}, name)
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertIn(name, result.exports[index])
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)

    def test_weapon_sampling_output_memory_layouts_and_current_frame_impact(self):
        for index, pointer_parameter, store_offset in ((62918, 1, 110), (62942, 2, 135)):
            decoded = self.original.instructions(index)
            self.assertTrue(decoded["decode_complete"])
            store = next(item for item in decoded["instructions"] if item["instruction_offset"] == store_offset)
            self.assertEqual(store["operation"], "i32.store")
            self.assertEqual(store["memory"]["offset"], 0, "武器与弹夹输出均为指针起始处的 int32")
            previous = decoded["instructions"].index(store)
            if index == 62918:
                self.assertEqual(decoded["instructions"][previous - 2]["operation"], "local.get")
                self.assertEqual(decoded["instructions"][previous - 2]["index"], pointer_parameter)
            else:
                self.assertTrue(any(item["operation"] == "local.get" and item["index"] == pointer_parameter
                                    for item in decoded["instructions"][previous - 6:previous]))
        impact = self.original.instructions(62953)
        self.assertTrue(impact["decode_complete"])
        items = impact["instructions"]
        # 输出低八字节直接拷贝 x/y，接着 f32 写 z 在 +8；+12 为额外原始 padding。
        copied_xy = next(index for index, item in enumerate(items) if item["instruction_offset"] == 120)
        self.assertEqual(items[copied_xy - 2]["operation"], "local.get")
        self.assertEqual(items[copied_xy - 2]["index"], 1)
        self.assertEqual(items[copied_xy]["operation"], "i64.store")
        self.assertEqual(items[copied_xy]["memory"]["offset"], 0)
        z_store = next(item for item in items if item["instruction_offset"] == 113)
        self.assertEqual(z_store["operation"], "f32.store")
        self.assertEqual(z_store["memory"]["offset"], 8)
        self.assertFalse(any(item["operation"] == "f32.store" and item["memory"]["offset"] == 16 for item in items))
        # 只有 weapon manager 的 impact frame 与全局 frame 相同才写出结果；不能当作持久 last-hit 锁存。
        guard = [item for item in items if 80 <= item["instruction_offset"] <= 95]
        self.assertEqual([item["operation"] for item in guard], ["i64.const", "i32.load", "local.get", "i32.load", "i32.ne", "br_if"])
        self.assertEqual(guard[0]["value"], 12321256)
        self.assertEqual(guard[3]["memory"]["offset"], 448)

    def test_action_tasks_vector_layout_and_jump_bool_flags(self):
        aiming = self.original.instructions(60655)
        self.assertTrue(aiming["decode_complete"])
        inputs = [item for item in aiming["instructions"] if item["operation"] == "f32.load"
                  and item["instruction_offset"] < 40]
        self.assertEqual([item["memory"]["offset"] for item in inputs], [0, 8, 16],
                         "瞄准任务输入必须为 24-byte scrVector，不能使用紧凑 Vector3")
        jump = self.original.instructions(60565)
        self.assertTrue(jump["decode_complete"])
        task = next(index for index, item in enumerate(jump["instructions"])
                    if item["operation"] == "call" and item["target"]["function_index"] == 69993)
        args = jump["instructions"][task - 12:task]
        self.assertEqual([item["operation"] for item in args], ["local.get", "local.get", "i32.const", "i32.const", "local.get",
                         "select", "local.tee", "i32.const", "i32.or", "local.get", "local.get", "select"])
        self.assertEqual([item["value"] for item in args if item["operation"] == "i32.const"], [163842, 2, 262144])
        self.assertEqual([item["index"] for item in args if item["operation"] == "local.get"], [0, 5, 2, 2, 3])
        self.assertFalse(any(item["operation"] == "local.get" and item["index"] == 1
                             for item in jump["instructions"]), "原始 ABI 第二个 bool 在此构建未使用")
        # 查询使用真实玩家/角色 handle；jump/ducking 是游戏状态观察，不是可靠一次性事件。
        for index, target in ((58689, 63816), (57240, 41388), (57259, 45903)):
            decoded = self.original.instructions(index)
            self.assertTrue(decoded["decode_complete"])
            self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == target
                                for item in decoded["instructions"]))

    def test_ducking_setter_preserves_native_persistent_request_defaults(self):
        setter = self.original.instructions(57258)
        self.assertTrue(setter["decode_complete"])
        index = next(index for index, item in enumerate(setter["instructions"])
                     if item["operation"] == "call" and item["target"]["function_index"] == 45904)
        args = setter["instructions"][index - 5:index]
        self.assertEqual([item["operation"] for item in args],
                         ["local.get", "local.get", "i32.const", "i32.const", "i32.const"])
        self.assertEqual([item["index"] for item in args[:2]], [3, 1])
        self.assertEqual([item["value"] for item in args[2:]], [-1, 1, 0])
        self.assertEqual(setter["instructions"][index]["target"]["signature"],
                         {"parameters": ["i64", "i32", "i32", "i32", "i32"], "results": []})
        # native 保存请求持续时间(-1)和布尔值；调用方必须在状态解除或复活后重置/重应用。
        implementation = self.original.instructions(45904)
        self.assertTrue(implementation["decode_complete"])
        stores = [item for item in implementation["instructions"] if item["operation"] == "i32.store"]
        self.assertEqual([item["memory"]["offset"] for item in stores[-2:]], [1536, 1532])
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 45905
                            for item in implementation["instructions"]), "站起仍遵守原生 CanPedStandUp 判断")

    def test_replica_ragdoll_exports_abis_and_original_bodies(self):
        expected = {
            "mpSetCanRagdoll": (57471, "ped_commands::CommandSetPedCanRagdoll(int, bool)", ["i32", "i32"], []),
            "mpIsRagdoll": (57464, "ped_commands::CommandIsPedRagdoll(int)", ["i32"], ["i32"]),
        }
        for name, (index, expected_name, parameters, results) in expected.items():
            self.assertEqual(export_map(True)[name], (index, expected_name, parameters, results))
            descriptor = self.original.descriptor(index)
            self.assertEqual(descriptor["name"], expected_name, name)
            self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results}, name)
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertIn(name, result.exports[index])
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)

    def test_script_animation_exports_abis_and_original_bodies(self):
        expected = {
            "mpAnimDictExists": (60331, "streaming_commands::DoesAnimDictExist(char const*)", ["i64"], ["i32"]),
            "mpRequestAnimDict": (60332, "streaming_commands::RequestAnimDict(char const*)", ["i64"], []),
            "mpHasAnimDictLoaded": (60333, "streaming_commands::HasAnimDictLoaded(char const*)", ["i64"], ["i32"]),
            "mpTaskPlayAnim": (60617, "task_commands::CommandTaskPlayAnim(int, char const*, char const*, float, float, int, int, float, bool, int, bool)", ["i32", "i64", "i64", "f32", "f32", "i32", "i32", "f32", "i32", "i32", "i32"], []),
            "mpIsPlayingAnim": (50077, "entity_commands::CommandIsEntityPlayingAnim(int, char const*, char const*, int)", ["i32", "i64", "i64", "i32"], ["i32"]),
            "mpAnimTime": (50024, "entity_commands::CommandGetEntityAnimCurrentTime(int, char const*, char const*)", ["i32", "i64", "i64"], ["f32"]),
        }
        for name, (index, native_name, parameters, results) in expected.items():
            self.assertEqual(export_map(True)[name], (index, native_name, parameters, results))
            self.assertEqual(self.original.descriptor(index)["signature"], {"parameters": parameters, "results": results})
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertIn(name, result.exports[index])
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)

    def test_script_animation_wrapper_preserves_string_order_and_secondary_flags(self):
        wrapper = self.original.instructions(60617)
        self.assertTrue(wrapper["decode_complete"])
        items = wrapper["instructions"]
        call = next(index for index, item in enumerate(items)
                    if item["operation"] == "call" and item["target"]["function_index"] == 60616)
        args = items[call - 15:call]
        self.assertEqual([item["operation"] for item in args], ["local.get"] * 8
                         + ["i32.const", "i64.const", "i64.const", "local.get", "i32.const", "local.get", "local.get"])
        self.assertEqual([item["index"] for item in args[:8]], [0, 2, 1, 3, 4, 5, 6, 9],
                         "公开 native 顺序为字典、剪辑；内部优化参数顺序不可套作公开接口")
        self.assertEqual(args[8]["value"], 0)
        self.assertEqual(args[9]["value"], args[10]["value"])
        self.assertEqual(args[11]["index"], 7)
        self.assertEqual(args[12]["value"], 2)
        self.assertEqual([item["index"] for item in args[-2:]], [8, 10])
        helper = self.original.instructions(60616)
        self.assertTrue(helper["decode_complete"])
        calls = {item["target"]["function_index"] for item in helper["instructions"] if item["operation"] == "call"}
        self.assertIn(65950, calls, "普通脚本动画创建 CTaskScriptedAnimation")
        self.assertIn(65951, calls)
        self.assertIn(29870, calls, "secondary 分支存在独立次级任务插入")
        self.assertFalse(calls & {66224, 89361, 52889, 60656}, "视觉剪辑入口不调用近战结果、伤害事件或真实射击任务")
        constants = {item["value"] for item in helper["instructions"] if item["operation"] == "i32.const"}
        self.assertIn(16, constants)
        self.assertIn(32, constants)
        request = self.original.instructions(60332)
        self.assertTrue(request["decode_complete"])
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 63772
                            for item in request["instructions"]), "动画请求归当前有效脚本 handler 的流式资源")

    def test_melee_queries_are_task_presence_and_target_not_attack_counters(self):
        presence = self.original.instructions(57608)
        target = self.original.instructions(57612)
        self.assertTrue(presence["decode_complete"])
        self.assertTrue(target["decode_complete"])
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 41387
                            for item in presence["instructions"]))
        find = self.original.instructions(41387)
        task = next(index for index, item in enumerate(find["instructions"])
                    if item["operation"] == "call" and item["target"]["function_index"] == 5949)
        self.assertEqual(find["instructions"][task - 1]["value"], 131)
        self.assertTrue(any(item["operation"] == "i64.load" and item["memory"]["offset"] == 368
                            for item in target["instructions"]))
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 8689
                            for item in target["instructions"]), "返回值是本地 GUID，必须映射到统一实体")
        self.assertFalse(any(item["operation"] == "i32.load" and item["memory"]["offset"] == 408
                             for item in target["instructions"]), "该查询没有直接读取 invincible 标记")

    def test_unarmed_punch_clip_names_are_referenced_by_current_project_resources(self):
        result_path = ROOT / "gta5data/data/common/data/action/results.meta"
        metadata_path = ROOT / "gta5data/data/common/non_final/anim/clip_dictionary_metadata/clip_melee@.xml"
        weapons_path = ROOT / "gta5data/data/common/data/ai/weaponanimations.meta"
        dictionary = "melee@unarmed@streamed_core"
        results = ET.parse(result_path)
        entries = {item.findtext("Name"): item for item in results.iter("Item")
                   if item.findtext("ClipSet") == dictionary}
        for name, clip in (("AR_heavy_1a", "heavy_punch_a"), ("AR_heavy_2a", "heavy_punch_b"), ("AR_heavy_3a", "heavy_punch_c")):
            self.assertEqual(entries[name].findtext("Anim"), clip)
            self.assertIn("RA_IS_STANDARD_ATTACK", entries[name].findtext("ResultAttrs"))
            self.assertFalse(clip.startswith("victim_"), "攻击视觉不能误选受害者/倒地动画")
        metadata = ET.parse(metadata_path)
        resource = next(item for item in metadata.iter("Item") if item.get("key") == dictionary + ".icd.zip")
        self.assertGreater(int(resource.find("sizeAfter").get("value")), 0)
        weapons = ET.parse(weapons_path)
        self.assertTrue(any(item.get("key") == "WEAPON_UNARMED" and item.findtext("MeleeClipSetHash") == dictionary
                            for item in weapons.iter("Item")))

    def test_disabling_ragdoll_restores_animation_using_original_defaults(self):
        decoded = self.original.instructions(57471)
        self.assertTrue(decoded["decode_complete"])
        items = decoded["instructions"]
        animation = next(index for index, item in enumerate(items)
                         if item["operation"] == "call" and item["target"]["function_index"] == 45834)
        arguments = items[animation - 8:animation]
        self.assertEqual(arguments[0]["operation"], "local.get")
        self.assertEqual(arguments[0]["index"], 2, "动画恢复使用实际 ped 指针")
        self.assertEqual([item["operation"] for item in arguments[1:]], ["i32.const"] * 7)
        self.assertEqual([item["value"] for item in arguments[1:]], [1, 1, 1, 0, 1, 1, 0])
        self.assertEqual(items[animation]["target"]["signature"],
                         {"parameters": ["i64", "i32", "i32", "i32", "i32", "i32", "i32", "i32"], "results": []})
        state_calls = [(index, item) for index, item in enumerate(items)
                       if item["operation"] == "call" and item["target"]["function_index"] == 45881]
        self.assertEqual([items[index - 1]["value"] for index, _ in state_calls], [2, 0],
                         "允许和禁止 ragdoll 分别使用原生状态 2 和 0")
        self.assertEqual(state_calls[-1][0] > animation, True)
        query = self.original.instructions(57464)
        self.assertTrue(query["decode_complete"])
        masks = [item["value"] for item in query["instructions"] if item["operation"] == "i64.const"]
        self.assertIn(2061584302080, masks)
        self.assertIn(687194767360, masks, "查询沿用 ped ragdoll 状态位判断，不等同于死亡查询")

    def test_public_patch_requires_entity_interfaces(self):
        with self.assertRaisesRegex(ValueError, "必须同时"):
            build(self.original, False, True)
        with self.assertRaisesRegex(ValueError, "必须同时"):
            checked_audit(DEFAULT_WASM, False, True)
        result = subprocess.run([sys.executable, "-B", str(ROOT / "tools/build_native_probe.py"), "--public-client"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("必须与 --entity-probe", result.stderr)

    def test_rejects_unexpected_wrapper_bytes(self):
        original_bytes = self.original.data
        start, end = self.original.bodies[PUBLIC_MODEL_WRAPPER]
        try:
            self.original.data = original_bytes[:start] + b"\x01" + original_bytes[start + 1:]
            with self.assertRaisesRegex(ValueError, "原始函数体不匹配"):
                build(self.original, True, True)
        finally:
            self.original.data = original_bytes

    def test_full_public_module_compiles_without_running_game(self):
        node = os.environ.get("NODE") or shutil.which("node")
        if not node:
            self.skipTest("没有可用的 Node.js，结构检查仍会执行")
        script = "const fs=require('node:fs'); WebAssembly.compile(fs.readFileSync(process.argv[1])).then(()=>console.log('compiled')).catch(e=>{console.error(e);process.exitCode=1});"
        # 只延迟机器码编译，未启用延迟校验；完整模块仍需通过 V8 验证。
        result = subprocess.run([node, "--wasm-lazy-compilation", "-e", script, str(self.outputs["public"])],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "compiled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
