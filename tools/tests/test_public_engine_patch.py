#!/usr/bin/env python3
"""校验公共战局补丁隔离范围；不启动游戏或覆盖运行中的引擎。"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import struct
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
    FRONTEND_FUNCTION, FRONTEND_TAIL, FRONTEND_MAGIC,
)
from inspect_native_bridge import Reader, WasmAudit


class PublicEnginePatchTests(unittest.TestCase):
    def test_public_radar_exports_preserve_abis_and_original_bodies(self):
        expected = {
            'mpDisplayHud': (51542, ['i32'], []),
            'mpDisplayRadar': (51610, ['i32'], []),
            'mpIsRadarHidden': (51614, [], ['i32']),
            'mpIsMinimapRendering': (51615, [], ['i32']),
            'mpHudPreference': (51539, [], ['i32']),
            'mpRadarPreference': (51540, [], ['i32']),
            'mpMinimapHideFog': (51755, ['i32'], []),
            'mpMinimapPrologue': (51761, ['i32'], []),
            'mpUnlockMinimapAngle': (51765, [], []),
            'mpUnlockMinimapPosition': (51767, [], []),
            'mpMinimapBackgroundInfo': (52350, ['i64'], []),
        }
        for name, (index, parameters, results) in expected.items():
            self.assertIn(name, self.audits['public'].exports[index])
            self.assertEqual(self.original.descriptor(index)['signature'], {'parameters': parameters, 'results': results})
            self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))
        instructions = self.original.instructions(52350)['instructions']
        self.assertEqual([op['operation'] for op in instructions],
                         ['i64.const', 'local.get', 'i64.load', 'i32.load', 'i32.const', 'i32.ne', 'i32.store8', 'end'])
        self.assertEqual(instructions[0]['value'], 19508521)
        self.assertEqual(instructions[2]['memory']['offset'], 16)
        self.assertEqual(instructions[3]['memory']['offset'], 0)
        fog = self.original.instructions(51755)['instructions']
        self.assertEqual(fog[0]['value'], 19520605)

    def test_collision_query_exports_use_original_script_command_abis(self):
        expected = {
            'mpStartShapeTestLOS': (59400, ['i64', 'i64', 'i32', 'i32', 'i32'], ['i32']),
            'mpStartShapeTestSweptSphere': (59407, ['i64', 'i64', 'f32', 'i32', 'i32', 'i32'], ['i32']),
            'mpShapeTestResultMaterial': (59410, ['i32', 'i64', 'i64', 'i64', 'i64', 'i64'], ['i32']),
            'mpCollisionLoadedAroundEntity': (50141, ['i32'], ['i32']),
            'mpWaitingForWorldCollision': (50087, ['i32'], ['i32']),
            'mpModelDimensions': (52892, ['i32', 'i64', 'i64'], []),
        }
        for name, (index, params, results) in expected.items():
            self.assertIn(name, self.audits['public'].exports[index])
            self.assertEqual(self.original.descriptor(index)['signature'], {'parameters': params, 'results': results})
            self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))

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

    def test_vehicle_seat_config_flags_use_checked_native_abis_and_unchanged_bodies(self):
        expected = {
            'mpSetPedConfigFlag': (57558, 'ped_commands::CommandSetPedConfigFlag(int, int, bool)',
                                   ['i32', 'i32', 'i32'], []),
            'mpGetPedConfigFlag': (57560, 'ped_commands::CommandGetPedConfigFlag(int, int, bool)',
                                   ['i32', 'i32', 'i32'], ['i32']),
        }
        for name, specification in expected.items():
            with self.subTest(export=name):
                self.assertEqual(export_map(True)[name], specification)
                index, native_name, parameters, results = specification
                self.assertEqual(self.original.descriptor(index)['name'], native_name)
                self.assertEqual(self.original.descriptor(index)['signature'],
                                 {'parameters': parameters, 'results': results})
                self.assertIn(name, self.audits['public'].exports[index])
                self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))
                self.assertNotIn(name, export_map(False))

        getter = self.original.instructions(57560)
        setter = self.original.instructions(57558)
        motion = self.original.instructions(76396)
        self.assertTrue(getter['decode_complete'] and setter['decode_complete'] and motion['decode_complete'])
        # 184 在原 flag 位图中是 CPed+5307 的最低位；getter 输出规范化为 0/1。
        getter_ops = {op['instruction_offset']: op for op in getter['instructions']}
        self.assertEqual(getter_ops[90]['memory']['offset'], 5284)
        self.assertEqual(getter_ops[100]['operation'], 'local.tee')
        self.assertEqual(getter_ops[104]['operation'], 'i32.ne')
        # SET 的 switch 中 184 跳过 readonly 标记分支，随后进入原生位图写入。
        setter_table = next(op for op in setter['instructions'] if op['operation'] == 'br_table')
        self.assertEqual(setter_table['labels'][184 - 2], 1)
        # 原 motion task 在这个 flag 为 true 时跳过自动换到驾驶位的逻辑。
        motion_ops = {op['instruction_offset']: op for op in motion['instructions']}
        self.assertEqual(motion_ops[2841]['memory']['offset'], 5307)
        self.assertEqual(motion_ops[2845]['value'], 1)
        self.assertEqual(motion_ops[2847]['operation'], 'i32.and')
        self.assertEqual(motion_ops[2848]['operation'], 'br_if')

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
        self.assertNotEqual(self.body(self.audits["replica"], HOOK_FUNCTION),
                            self.body(self.audits["public"], HOOK_FUNCTION))
        from build_native_probe import SCRIPT_GATE_MAGIC, signed_leb, unsigned_leb, CALLBACK_IMPORT
        gate = b'\x20\x00\x41' + signed_leb(SCRIPT_GATE_MAGIC) + b'\x10' + unsigned_leb(CALLBACK_IMPORT) + b'\x0d\x00'
        public_body = self.body(self.audits['public'], HOOK_FUNCTION)
        self.assertEqual(public_body.count(gate), 1)
        offset = self.reports['public']['hook']['original_file_offset'] - self.original.bodies[HOOK_FUNCTION][0]
        original_body = self.body(self.original, HOOK_FUNCTION)
        injected = bytes.fromhex(self.reports['public']['hook']['inserted_bytes_hex'])
        self.assertEqual(public_body, original_body[:offset] + injected + original_body[offset:])
        self.assertEqual(self.reports['public']['script_gate']['resume_instruction_offset'], 32869)
        self.assertTrue(self.audits['public'].instructions(HOOK_FUNCTION)['decode_complete'])
        self.assertEqual(self.body(self.audits["replica"], PUBLIC_MODEL_WRAPPER), EXPECTED_MODEL_WRAPPER)
        self.assertEqual(self.source_digest, ORIGINAL_SHA256)

    def test_server_rules_native_interfaces_preserve_verified_abis_and_bodies(self):
        from build_native_probe import export_map
        names = ['mpSetProofs', 'mpPlayerWeaponDamage', 'mpPlayerMeleeDamage', 'mpDriveToCoord',
                 'mpVisualExplosion', 'mpDrawSphere', 'mpGetAmmo', 'mpControlJustPressed']
        for name in names:
            index, function_name, parameters, results = export_map(True)[name]
            with self.subTest(name=name):
                self.assertEqual(self.original.descriptor(index)['name'], function_name)
                self.assertEqual(self.original.descriptor(index)['signature'], {'parameters': parameters, 'results': results})
                self.assertEqual(self.body(self.original, index), self.body(self.audits['public'], index))

    def test_only_expected_function_bodies_change(self):
        for name, expected in (("probe", {HOOK_FUNCTION}), ("replica", {HOOK_FUNCTION}),
                               ("public", {HOOK_FUNCTION, PUBLIC_MODEL_WRAPPER, FRONTEND_FUNCTION})):
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

    def test_public_frontend_callback_runs_only_at_verified_normal_tail(self):
        from build_native_probe import signed_leb, CALLBACK_IMPORT
        callback = b'\x42\x00\x41' + signed_leb(FRONTEND_MAGIC) + b'\x10' + bytes([CALLBACK_IMPORT]) + b'\x1a'
        original = self.body(self.original, FRONTEND_FUNCTION)
        result = self.body(self.audits['public'], FRONTEND_FUNCTION)
        self.assertEqual(result, original[:-len(FRONTEND_TAIL)] + callback + FRONTEND_TAIL)
        self.assertEqual(self.body(self.audits['probe'], FRONTEND_FUNCTION), original)
        self.assertEqual(self.body(self.audits['replica'], FRONTEND_FUNCTION), original)
        self.assertEqual(self.reports['public']['frontend_hook']['function_index'], FRONTEND_FUNCTION)
        self.assertTrue(self.audits['public'].instructions(FRONTEND_FUNCTION)['decode_complete'])

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

    def test_blip_recovery_exports_validate_real_handles_and_preserve_original_bodies(self):
        expected = {
            "mpDoesBlipExist": (51693, "hud_commands::CommandDoesBlipExist(int)", ["i32"], ["i32"]),
            "mpSetBlipDisplay": (51661, "hud_commands::CommandChangeBlipDisplay(int, int)", ["i32", "i32"], []),
            "mpSetBlipAlpha": (51625, "hud_commands::ChangeBlipAlpha(int, int)", ["i32", "i32"], []),
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

        # DOES_BLIP_EXIST 先拒绝零句柄，再用原生管理器核对槽位与代次。
        exists = self.original.instructions(51693)
        self.assertTrue(exists["decode_complete"])
        self.assertEqual([item["operation"] for item in exists["instructions"]],
                         ["local.get", "i32.eqz", "if", "i32.const", "return", "end",
                          "local.get", "call", "end"])
        self.assertEqual(exists["instructions"][3]["value"], 0)
        self.assertEqual(exists["instructions"][7]["target"]["function_index"], 35323)
        lookup = self.original.instructions(35323)
        self.assertTrue(lookup["decode_complete"])
        self.assertTrue(any(item["operation"] == "i32.load16_u" and item["memory"]["offset"] == 8
                            for item in lookup["instructions"]))
        self.assertTrue(any(item["operation"] == "i32.const" and item["value"] == 16
                            for item in lookup["instructions"]))

        # Display 是句柄与枚举值，不能把引擎内部 CMiniMapBlip* 当作参数。
        display = self.original.instructions(51661)
        self.assertTrue(display["decode_complete"])
        self.assertEqual([item["operation"] for item in display["instructions"]],
                         ["local.get", "if", "i32.const", "local.get", "local.get", "call", "end", "end"])
        self.assertEqual(display["instructions"][2]["value"], 1)
        self.assertEqual(display["instructions"][5]["target"]["function_index"], 35317)
        alpha = self.original.instructions(51625)
        self.assertTrue(alpha["decode_complete"])
        calls = [item["target"]["function_index"] for item in alpha["instructions"] if item["operation"] == "call"]
        self.assertIn(35317, calls)

    def test_visual_shot_muzzle_exports_preserve_original_abis_and_resource_guards(self):
        expected = {
            "mpCurrentWeaponEntity": (62919, "weapon_commands::CommandGetCurrentPedWeaponEntityIndex(int, bool)", ["i32", "i32"], ["i32"]),
            "mpEntityBoneCount": (50191, "entity_commands::CommandGetEntityBoneCount(int)", ["i32"], ["i32"]),
            "mpEntityBoneIndexByName": (50098, "entity_commands::CommandGetEntityBoneIndexByName(int, char const*)", ["i32", "i64"], ["i32"]),
            "mpWorldPositionOfEntityBone": (50053, "entity_commands::CommandGetWorldPositionOfEntityBone(int, int)", ["i64", "i32", "i32"], []),
            "mpPedBoneCoords": (57514, "ped_commands::CommandGetPedBoneCoords(int, int, rage::scrVector const&)", ["i64", "i32", "i32", "i64"], []),
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

        # 武器查询验证角色、manager 和真实武器后才创建脚本 GUID；未就绪返回 0。
        weapon = self.original.instructions(62919)
        self.assertTrue(weapon["decode_complete"])
        calls = [item["target"]["function_index"] for item in weapon["instructions"] if item["operation"] == "call"]
        self.assertEqual(calls, [8693, 8689])
        self.assertGreaterEqual(sum(item["operation"] == "i64.eqz" for item in weapon["instructions"]), 2)
        self.assertTrue(any(item["operation"] == "i32.const" and item["value"] == 0
                            for item in weapon["instructions"]))

        # BoneCount 自身逐层判空；名字查询可能在无 skeleton 分支解引用，调用方必须先确认 >0。
        count = self.original.instructions(50191)
        self.assertTrue(count["decode_complete"])
        self.assertEqual([item["target"]["function_index"] for item in count["instructions"] if item["operation"] == "call"], [8693])
        self.assertGreaterEqual(sum(item["operation"] == "i64.eqz" for item in count["instructions"]), 5)
        self.assertTrue(any(item["operation"] == "i32.load" and item["memory"]["offset"] == 32
                            for item in count["instructions"]))
        bone_index = self.original.instructions(50098)
        self.assertTrue(bone_index["decode_complete"])
        calls = [item["target"]["function_index"] for item in bone_index["instructions"] if item["operation"] == "call"]
        self.assertEqual(calls, [650, 8693, 9209])
        self.assertTrue(any(item["operation"] == "i32.const" and item["value"] == -1
                            for item in bone_index["instructions"]))

        # 世界骨骼查询检查负索引与 skeleton 骨骼数，再写入带 8 字节间隔的 scrVector。
        position = self.original.instructions(50053)
        self.assertTrue(position["decode_complete"])
        self.assertIn("i32.lt_s", [item["operation"] for item in position["instructions"]])
        self.assertIn("i32.ge_u", [item["operation"] for item in position["instructions"]])
        self.assertEqual([item["memory"]["offset"] for item in position["instructions"] if item["operation"] == "f32.store"], [16, 8, 0])
        self.assertIn(9233, [item["target"]["function_index"] for item in position["instructions"] if item["operation"] == "call"])
        # 右手 tag 的 fallback 由原生 GetBoneMatrix 处理；输入偏移同样按 0/8/16 读取。
        ped_bone = self.original.instructions(57514)
        self.assertTrue(ped_bone["decode_complete"])
        self.assertIn(45840, [item["target"]["function_index"] for item in ped_bone["instructions"] if item["operation"] == "call"])
        self.assertEqual([item["memory"]["offset"] for item in ped_bone["instructions"] if item["operation"] == "f32.load"][:3], [16, 8, 0])

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

    def test_pause_header_presentation_exports_preserve_abis_and_original_bodies(self):
        expected = {
            "mpPauseMenuActive": (51840, "hud_commands::CommandIsPauseMenuActive()", [], ["i32"]),
            "mpFrontendReady": (51856, "hud_commands::CommandIsFrontendReadyForControl()", [], ["i32"]),
            "mpBeginPauseHeader": (50805, "graphics_commands::CommandBeginScaleformMovieMethodOnFrontendHeader(char const*)", ["i64"], ["i32"]),
            "mpGetPausePanel": (36266, "CPauseMenu::GetCurrentActivePanel()", ["i64"], []),
            "mpPausePanelName": (35600, "MenuScreenId::GetParserName() const", ["i64"], ["i64"]),
            "mpBeginPauseContent": (50804, "graphics_commands::CommandBeginScaleformMovieMethodOnFrontend(char const*)", ["i64"], ["i32"]),
            "mpScaleformString": (50818, "graphics_commands::CommandScaleformMovieMethodAddParamLiteralString(char const*)", ["i64"], []),
            "mpScaleformBool": (50814, "graphics_commands::CommandScaleformMovieMethodAddParamBool(bool)", ["i32"], []),
            "mpScaleformInt": (50812, "graphics_commands::CommandScaleformMovieMethodAddParamInt(int)", ["i32"], []),
            "mpEndScaleform": (50806, "graphics_commands::CommandEndScaleformMovieMethod()", [], []),
        }
        for name, (index, native_name, parameters, results) in expected.items():
            self.assertEqual(export_map(True)[name], (index, native_name, parameters, results))
            self.assertEqual(self.original.descriptor(index)["signature"], {"parameters": parameters, "results": results})
            self.assertNotIn(name, self.audits["probe"].exports.get(index, []))
            for result in (self.audits["replica"], self.audits["public"]):
                self.assertIn(name, result.exports[index])
                self.assertEqual(self.body(self.original, index), self.body(result, index), name)
        # 表现层不能用真假在线返回值替换原引擎会话，保留 C++ 与脚本包装器原体。
        for index in (54706, 54707, 54708, 54711, 55538, 55539, 55540, 55545, 82912, 83019, 36288):
            self.assertEqual(self.body(self.original, index), self.body(self.audits["public"], index))

    def test_pause_header_begin_checks_active_and_valid_movie_before_call(self):
        decoded = self.original.instructions(50805)
        self.assertTrue(decoded["decode_complete"])
        items = decoded["instructions"]
        active = next(index for index, item in enumerate(items) if item["operation"] == "call"
                      and item["target"]["function_index"] == 36254)
        begin = next(index for index, item in enumerate(items) if item["operation"] == "call"
                     and item["target"]["function_index"] == 37248)
        self.assertLess(active, begin)
        self.assertEqual([item["operation"] for item in items[active + 1:active + 3]], ["i32.eqz", "br_if"])
        movie_check = [item for item in items[active + 3:begin] if item["instruction_offset"] <= 36]
        self.assertEqual([item["operation"] for item in movie_check[-3:]], ["i32.const", "i32.lt_s", "br_if"])
        self.assertEqual(movie_check[-3]["value"], 0)
        self.assertTrue(any(item["operation"] == "i64.const" and item["value"] == 19566964 for item in items))
        ready = self.original.instructions(51856)
        self.assertTrue(ready["decode_complete"])
        self.assertEqual([item["target"]["function_index"] for item in ready["instructions"] if item["operation"] == "call"],
                         [36254, 36038])

    def test_scaleform_literal_strings_do_not_require_gxt_labels(self):
        literal = self.original.instructions(50818)
        self.assertTrue(literal["decode_complete"])
        items = literal["instructions"]
        add = next(index for index, item in enumerate(items) if item["operation"] == "call"
                   and item["target"]["function_index"] == 36056)
        self.assertEqual(items[add - 1]["operation"], "i32.const")
        self.assertEqual(items[add - 1]["value"], 1, "literal API 以文字转换模式传入原字串")
        string = self.original.instructions(36056)
        self.assertTrue(string["decode_complete"])
        targets = {item["target"]["function_index"] for item in string["instructions"] if item["operation"] == "call"}
        self.assertIn(77557, targets, "字符串先 TextToHtml 再给 GFx")
        self.assertFalse(targets & {77479, 77480, 77481}, "literal-string 不能偷偷把公共文案当 GXT label")
        for index, target in ((50812, 36053), (50814, 36051), (50806, 36050)):
            decoded = self.original.instructions(index)
            self.assertTrue(decoded["decode_complete"])
            self.assertEqual([item["target"]["function_index"] for item in decoded["instructions"] if item["operation"] == "call"], [target])

    def test_online_body_uses_actual_multiplayer_script_pane_and_four_byte_menu_id(self):
        path = ROOT / "gta5data/data/common/data/ui/pausemenu.XML"
        tree = ET.parse(path)
        online = next(item for item in tree.iter("Item")
                      if item.findtext("MenuScreen") == "MENU_UNIQUE_ID_MISSION_CREATOR")
        self.assertEqual(online.findtext("cGfxFilename"), "PAUSE_MENU_PAGES_MISSIONCREATOR")
        self.assertEqual(online.findtext("runtime/type"), "SCRIPT")
        self.assertEqual(online.findtext("runtime/params/data"), "PauseMenu_Multiplayer")
        panel = self.original.instructions(36266)
        self.assertTrue(panel["decode_complete"])
        items = panel["instructions"]
        # C++ 结构体返回通过 i64 指向调用者自己的四字节 MenuScreenId；不是 this 指针。
        stores = [item for item in items if item["operation"].endswith("store")]
        self.assertEqual(len(stores), 2)
        self.assertTrue(all(item["operation"] == "i32.store" and item["memory"]["offset"] == 0 for item in stores))
        self.assertFalse(any(item["operation"] == "call" for item in items))
        self.assertEqual(items[0]["operation"], "i64.const")
        self.assertEqual(items[0]["value"], 19567504)
        parser = self.original.instructions(35600)
        self.assertTrue(parser["decode_complete"])
        parser_calls = [item["target"]["name"] for item in parser["instructions"] if item["operation"] == "call"]
        self.assertIn("rage::parEnumData::NameFromValueUnsafe(int) const", parser_calls)
        self.assertFalse(any("Network" in name or "SocialClub" in name for name in parser_calls))

    def test_pause_content_begin_checks_original_movie_and_warning_parameter_order(self):
        content = self.original.instructions(50804)
        self.assertTrue(content["decode_complete"])
        items = content["instructions"]
        active = next(index for index, item in enumerate(items) if item["operation"] == "call"
                      and item["target"]["function_index"] == 36254)
        begin = next(index for index, item in enumerate(items) if item["operation"] == "call"
                     and item["target"]["function_index"] == 37248)
        self.assertLess(active, begin)
        self.assertEqual([item["operation"] for item in items[active + 1:active + 3]], ["i32.eqz", "br_if"])
        self.assertTrue(any(item["operation"] == "i64.const" and item["value"] == 19567060 for item in items))
        self.assertTrue(any(item["operation"] == "i32.lt_s" for item in items[active:begin]))
        warning = self.original.instructions(36341)
        self.assertTrue(warning["decode_complete"])
        args = warning["instructions"]
        adds = [index for index, item in enumerate(args) if item["operation"] == "call"
                and item["target"]["function_index"] == 36162]
        self.assertEqual(len(adds), 11, "warning API 首参是可见性，之后是原十个 native 参数")
        # 原序列：true, column, layout, title, body, width, image, texture, alignment, image caption, bool。
        starts = [0] + [index + 1 for index in adds[:-1]]
        for argument, (start, end) in enumerate(zip(starts, adds)):
            part = args[start:end]
            if argument == 0:
                self.assertTrue(any(item["operation"] == "i32.const" and item["value"] == 1 for item in part))
            else:
                expected_local = argument - 1
                self.assertTrue(any(item["operation"] == "local.get" and item["index"] == expected_local for item in part),
                                f"warning 参数 {argument} 应从 native local {expected_local} 读取")

    def test_pause_game_label_static_position_is_not_assumed_to_be_online_content(self):
        path = ROOT / "gta5data/data/common/data/ui/pausemenu.XML"
        tree = ET.parse(path)
        header = next(item for item in tree.iter("Item") if item.findtext("MenuScreen") == "MENU_UNIQUE_ID_HEADER")
        tabs = list(header.find("MenuItems"))
        game = next(index for index, item in enumerate(tabs) if item.findtext("cTextId") == "PM_SCR_GAM")
        self.assertEqual(game, 4, "XML 原始顺序里游戏页在第5个，但运行 context 可能过滤其他页")
        game_page = next(item for item in tree.iter("Item") if item.findtext("MenuScreen") == "MENU_UNIQUE_ID_GAME")
        self.assertEqual(game_page.findtext("runtime/params/data"), "PauseMenu_SP_Repeat")
        self.assertTrue(any(item.findtext("cTextId") == "PM_PANE_NEW" for item in game_page.find("MenuItems")))
        setup = self.original.instructions(36277)
        self.assertTrue(setup["decode_complete"])
        self.assertTrue(any(item["operation"] == "call" and item["target"]["function_index"] == 36205 for item in setup["instructions"]),
                        "原 header 按 UIContextList 过滤，不能把原 XML 索引直接当可见索引")

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


class WorldPolicyNativeStaticTests(unittest.TestCase):
    """只读 ABI/指令审计；单独运行本类不会生成或编译任何 WASM。"""

    @classmethod
    def setUpClass(cls):
        cls.original = checked_audit(DEFAULT_WASM, True, True)

    def calls(self, index):
        decoded = self.original.instructions(index)
        self.assertTrue(decoded["decode_complete"], self.original.names[index])
        return [item["target"]["function_index"] for item in decoded["instructions"]
                if item["operation"] == "call"]

    def test_environment_and_law_interfaces_match_real_native_abis(self):
        expected = {
            "mpSetClockTime": (49437, "clock_commands::CommandSetClockTime(int, int, int)", ["i32", "i32", "i32"], []),
            "mpPauseClock": (49443, "clock_commands::CommandPauseClock(bool)", ["i32"], []),
            "mpWeatherPersist": (52794, "misc_commands::CommandSetWeatherTypeNowPersist(char const*)", ["i64"], []),
            "mpWeatherOvertime": (52796, "misc_commands::CommandSetWeatherTypeOvertimePersist(char const*, float)", ["i64", "f32"], []),
            "mpClearOverrideWeather": (52803, "misc_commands::CommandClearOverrideWeather()", [], []),
            "mpRain": (52824, "misc_commands::CommandSetRain(float)", ["f32"], []),
            "mpWind": (52820, "misc_commands::CommandSetWindSpeed(float)", ["f32"], []),
            "mpDispatchService": (52957, "misc_commands::CommandEnableDispatchService(int, bool)", ["i32", "i32"], []),
            "mpRandomCops": (57371, "ped_commands::CommandSetCreateRandomCops(bool)", ["i32"], []),
            "mpRandomCopsNotScenarios": (57372, "ped_commands::CommandSetCreateRandomCopsNotOnScenarios(bool)", ["i32"], []),
            "mpRandomCopsScenarios": (57373, "ped_commands::CommandSetCreateRandomCopsOnScenarios(bool)", ["i32"], []),
            "mpWantedLevel": (58655, "player_commands::CommandGetPlayerWantedLevel(int)", ["i32"], ["i32"]),
            "mpSetWantedLevel": (58638, "player_commands::CommandAlterWantedLevel(int, int, bool)", ["i32", "i32", "i32"], []),
            "mpSetWantedNow": (58640, "player_commands::CommandApplyWantedLevelChangeNow(int, bool)", ["i32", "i32"], []),
            "mpClearWanted": (58646, "player_commands::CommandClearWantedLevel(int)", ["i32"], []),
            "mpSuppressWitnesses": (58680, "player_commands::CommandSuppressWitnessesCallingPoliceThisFrame(int)", ["i32"], []),
            "mpTaskCombatPed": (60593, "task_commands::CommandTaskCombat(int, int, int, int)", ["i32", "i32", "i32", "i32"], []),
            "mpSetPedAsCop": (57350, "ped_commands::CommandSetPedAsCop(int, bool)", ["i32", "i32"], []),
            "mpAIWeaponDamage": (57226, "ped_commands::SetAiWeaponDamageModifier(float)", ["f32"], []),
            "mpAIMeleeDamage": (57228, "ped_commands::SetAiMeleeWeaponDamageModifier(float)", ["f32"], []),
        }
        for name, specification in expected.items():
            with self.subTest(export=name):
                self.assertEqual(export_map(True)[name], specification)
                index, native_name, parameters, results = specification
                descriptor = self.original.descriptor(index)
                self.assertEqual(descriptor["name"], native_name)
                self.assertEqual(descriptor["signature"], {"parameters": parameters, "results": results})
                self.assertNotIn(name, export_map(False), "只读探针不能获得世界写接口")

    def test_clock_and_weather_use_ordinary_commands_without_network_spoof(self):
        self.assertIn(37676, self.calls(49437), "时钟通过 CClock::SetTime 应用")
        self.assertNotIn(82905, self.calls(49437), "不能借用真实网络 ClockOverrideData")
        pause = self.original.instructions(49443)["instructions"]
        self.assertTrue(any(item["operation"] == "i64.const" and item["value"] == 19617753 for item in pause))
        self.assertTrue(any(item["operation"] == "i32.store8" for item in pause))
        self.assertEqual(self.calls(52794), [37934, 37945])
        weather = self.original.instructions(52794)["instructions"]
        self.assertTrue(any(item["operation"] == "i32.lt_s" for item in weather), "无效天气名称应先拒绝")
        self.assertTrue(any(item["operation"] == "i32.ge_s" for item in weather), "枚举超出已加载天气列表应先拒绝")
        self.assertIn(37944, self.calls(52803))
        self.assertIn(37934, self.calls(52796), "过渡先查找真实天气类型")
        self.assertEqual(self.calls(52796)[-1], 37947)
        transition = self.original.instructions(52796)["instructions"]
        self.assertTrue(any(item["operation"] == "i32.lt_s" for item in transition))
        self.assertTrue(any(item["operation"] == "i32.ge_s" for item in transition))
        transition_engine = self.original.instructions(37947)["instructions"]
        self.assertTrue(any(item["operation"] == "f32.const" and item["value"] == 1000 for item in transition_engine),
                        "原生 float 秒数转换为引擎毫秒，调用方不能直接传 transition_ms")
        for index in (49437, 49443, 52794, 52796, 52803, 52820, 52824):
            self.assertNotIn(59322, self.calls(index), "世界覆盖不得终止活动脚本")

    def test_dispatch_controls_route_to_population_and_manager_without_private_pointers(self):
        self.assertEqual(self.calls(52957), [38191])
        self.assertEqual(self.calls(57371), [41474, 41475])
        self.assertEqual(self.calls(57372), [41474])
        self.assertEqual(self.calls(57373), [41475])
        dispatch = self.original.instructions(52957)["instructions"]
        self.assertEqual([item["operation"] for item in dispatch[:4]], ["local.get", "i32.const", "i32.le_u", "if"])
        self.assertEqual(dispatch[1]["value"], 16, "原生命令仍保留 dispatch 类型边界判断")

    def test_law_task_uses_real_guids_and_scripted_task_owner(self):
        task_calls = self.calls(60593)
        self.assertEqual(task_calls.count(8693), 2, "NPC 与目标均解析真实 guid，而非伪造对象地址")
        self.assertIn(66157, task_calls, "沿用原引擎 ThreatResponse 任务")
        self.assertEqual(task_calls[-1], 63902, "任务仍经 GivePedScriptedTask 绑定有效 handler")
        self.assertIn(8693, self.calls(57350))
        self.assertIn(45844, self.calls(57350))
        self.assertEqual(self.calls(58655), [63816])
        lookup = self.original.instructions(63816)["instructions"]
        self.assertTrue(any(item["operation"] == "i64.const" and item["value"] == 28501281 for item in lookup),
                        "本地/真实网络玩家解析沿用原 flag，不改写会话状态")
        self.assertTrue(any(item["operation"] == "i64.const" and item["value"] == 20159720 for item in lookup),
                        "未建立原网络会话时仍有真实本地 player 0 回退")
        names = [item[1] for item in export_map(True).values()]
        self.assertFalse(any("Terminate" in name and "Script" in name for name in names),
                         "不得 blanket 结束单机脚本而清理共享实体与客户端生命周期")

    def test_zero_ai_weapon_damage_is_accepted_without_affecting_player_modifier(self):
        for native, address in ((57226, 19453620), (57228, 19453616)):
            instructions = self.original.instructions(native)["instructions"]
            self.assertEqual([item["operation"] for item in instructions], ["i64.const", "local.get", "f32.store", "end"])
            self.assertEqual(instructions[0]["value"], address)
            self.assertEqual(instructions[1]["index"], 0, "常量 0 直接写入 AI damage modifier，无正数下界")
        damage = self.original.instructions(82063)
        self.assertTrue(damage["decode_complete"])
        instructions = damage["instructions"]
        player_modifier = next(index for index, item in enumerate(instructions)
                               if item["operation"] == "call" and item["target"]["function_index"] == 41726)
        ai_modifier = next(index for index, item in enumerate(instructions)
                           if item["operation"] == "i64.const" and item["value"] == 19453616)
        self.assertLess(player_modifier, ai_modifier)
        self.assertTrue(any(item["operation"] == "br" and item["index"] == 2
                            for item in instructions[player_modifier + 1:ai_modifier]),
                        "玩家 melee modifier 分支跳过全局 AI modifier，不替换玩家伤害规则")
        self.assertEqual([item["operation"] for item in instructions[ai_modifier:ai_modifier + 7]],
                         ["i64.const", "i64.const", "local.get", "select", "f32.load", "f32.mul", "local.set"])

    def test_native_wind_speed_normalizer_is_twelve(self):
        instructions = self.original.instructions(52820)["instructions"]
        self.assertEqual([item["operation"] for item in instructions[:6]],
                         ["i64.const", "local.get", "i64.const", "f32.load", "f32.div", "local.tee"])
        address = instructions[2]["value"]
        self.assertEqual(address, 5160336)
        start, end = self.original.sections[11]
        reader = Reader(self.original.data, start, end)
        segments = []
        for _ in range(reader.leb()):
            self.assertEqual(reader.leb(), 1, "本版本使用被动数据段，由 init_memory 写入")
            segments.append(reader.take(reader.leb()))
        initialization = self.original.instructions(88)
        self.assertTrue(initialization["decode_complete"])
        operations = initialization["instructions"]
        found = []
        for index, item in enumerate(operations):
            if item["operation"] != "opcode_fc" or item.get("sub_opcode") != 8:
                continue
            destination, source, length = [previous["value"] for previous in operations[index - 3:index]]
            if destination <= address < destination + length:
                segment = segments[item["indices"][0]]
                found.append(struct.unpack_from("<f", segment, source + address - destination)[0])
        self.assertEqual(found, [12.0], "服务器归一化风量 0..1 应乘 12 转换为原生 speed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
