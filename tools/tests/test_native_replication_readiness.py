#!/usr/bin/env python3
"""核对只读复制就绪工具，不运行 WASM，不把静态 ABI 当作运行态联机。"""

from __future__ import annotations

import copy
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import audit_native_replication_readiness as readiness
from inspect_native_bridge import WasmAudit


class ReadinessGateTests(unittest.TestCase):
    def test_no_runtime_samples_does_not_infer_missing_trees_or_success(self):
        result = readiness.proof_gates([])
        self.assertEqual(result["runtime"]["status"], "unverified")
        self.assertFalse(result["can_attempt_clone"])
        codes = {item["code"] for item in result["blockers"]}
        self.assertIn("runtime_observation_missing", codes)
        self.assertNotIn("trees_not_initialized", codes, "无记录不能推断树实际不存在")
        self.assertFalse(result["runtime"]["clone_roundtrip_verified"])

    def test_each_init_state_still_requires_real_target_and_roundtrip(self):
        for tree, context in ((False, False), (False, True), (True, False), (True, True)):
            value = {"ped_tree_initialized": tree, "player_tree_initialized": tree,
                     "network_script_context": context, "session_active": None, "session_started": None}
            result = readiness.proof_gates([value])
            codes = {item["code"] for item in result["blockers"]}
            self.assertEqual("trees_not_initialized" in codes, not tree)
            self.assertEqual("network_handler_missing" in codes, not context)
            self.assertIn("legal_target_unverified", codes)
            self.assertIn("session_observation_missing", codes)
            self.assertFalse(result["can_attempt_clone"])
            self.assertFalse(result["runtime"]["current_page_verified"])

    def test_log_parser_accepts_only_typed_readonly_samples_and_latest_per_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "browser.log"
            first = {"phase": "world_readiness", "mode": "read_only", "ped_tree_initialized": False,
                     "player_tree_initialized": False, "network_script_context": False}
            last = {**first, "type": "world_readiness", "ped_tree_initialized": True}
            invalid = [{**last, "ped_tree_initialized": "true"}, {**last, "mode": "native_write"},
                       {**last, "type": "unrelated"}, {"type": "world_readiness", "mode": "read_only"}]
            path.write_text("[public-client] " + json.dumps(first) + "\n"
                            + "malformed world_readiness {" + "\n"
                            + "[public-client] " + json.dumps(last) + "\n"
                            + "\n".join(json.dumps(value) for value in invalid), encoding="utf-8")
            observations, errors = readiness.read_observations([path])
            self.assertFalse(errors)
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0]["line"], 3)
            self.assertTrue(observations[0]["ped_tree_initialized"])
            self.assertIsNone(observations[0]["session_active"])
            self.assertEqual(path.read_text().count("malformed"), 1)

    def test_missing_log_is_reported_without_creating_runtime_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            observations, errors = readiness.read_observations([Path(directory) / "missing.log"])
            self.assertEqual(observations, [])
            self.assertEqual(len(errors), 1)

    def test_known_false_session_is_distinct_from_missing_session_observation(self):
        result = readiness.proof_gates([{"ped_tree_initialized": True, "player_tree_initialized": True,
            "network_script_context": True, "session_active": False, "session_started": False}])
        codes = {item["code"] for item in result["blockers"]}
        self.assertIn("session_not_established", codes)
        self.assertNotIn("session_observation_missing", codes)
        self.assertFalse(result["can_attempt_clone"])

    def test_output_cannot_overwrite_wasm_or_log_and_is_checked_before_parse(self):
        for args in (("--wasm", "/tmp/source.wasm", "--output", "/tmp/source.wasm"),
                     ("--runtime-log", "/tmp/source.log", "--report", "/tmp/source.log"),
                     ("--output", "/tmp/result.json", "--report", "/tmp/result.json")):
            with self.subTest(args=args), patch.object(readiness, "audit_readiness") as audit, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    readiness.main(args)
                self.assertEqual(error.exception.code, 1)
                audit.assert_not_called()


@unittest.skipUnless(readiness.DEFAULT_WASM.exists(), "源码仓库未包含原游戏 WASM，仍可运行纯 gate 测试")
class StaticReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.audit = WasmAudit(readiness.DEFAULT_WASM)
        cls.before = hashlib.sha256(cls.audit.data).hexdigest()
        cls.result = readiness.audit_static(cls.audit)

    @classmethod
    def tearDownClass(cls):
        if hashlib.sha256(readiness.DEFAULT_WASM.read_bytes()).hexdigest() != cls.before:
            raise AssertionError("只读审计修改了原 WASM")

    def test_getter_abi_and_null_guard_contracts_are_complete(self):
        result = self.result
        self.assertEqual(set(result["getters"]), set(readiness.READINESS_SPECS))
        for key in ("ped_tree", "player_tree"):
            value = result["getters"][key]
            self.assertEqual(value["global_pointer_address"], readiness.TREE_ADDRESSES[key])
            self.assertEqual([item["operation"] for item in value["instructions"]], ["i64.const", "i64.load", "end"])
        handler = result["getters"]["network_handler"]
        self.assertEqual(handler["function_index"], 63797)
        for key, (target, comparison, state) in readiness.SESSION_IMPLEMENTATIONS.items():
            value = result["getters"][key]["implementation"]
            self.assertEqual(value["function_index"], target)
            self.assertEqual(value["instructions"][-3]["value"], state)
            self.assertEqual(value["instructions"][-2]["operation"], comparison)

    def test_peer_transport_fixed_stubs_cannot_be_declared_working(self):
        transport = self.result["peer_transport"]
        self.assertFalse(transport["implemented"])
        self.assertEqual(set(transport["functions"]), {str(index) for index in readiness.TRANSPORT_INDICES})
        self.assertTrue(all(value["stub_confirmed"] for value in transport["functions"].values()))
        self.assertEqual(transport["functions"]["181"]["body_hex"], "0041010b")

    def test_mismatched_input_hash_refuses_known_layout(self):
        original = self.audit.data
        try:
            self.audit.data = original[:8] + bytes([original[8] ^ 1]) + original[9:]
            with self.assertRaisesRegex(ValueError, "SHA256"):
                readiness.audit_static(self.audit)
        finally:
            self.audit.data = original

    def test_getter_signature_drift_is_not_silently_accepted(self):
        original = self.audit.descriptor

        def incorrect(index):
            value = copy.deepcopy(original(index))
            if index == 88346:
                value["signature"] = {"parameters": ["i32"], "results": ["i64"]}
            return value

        with patch.object(self.audit, "descriptor", incorrect):
            with self.assertRaisesRegex(ValueError, "ABI"):
                readiness.audit_static(self.audit)

    def test_report_explicitly_marks_unverified_runtime(self):
        result = {**self.result, **readiness.proof_gates([]), "log_read_errors": []}
        report = readiness.render_report(result)
        self.assertIn("未完成；没有有效 world_readiness 日志", report)
        self.assertIn("没有创建网络对象", report)
        self.assertIn("尚未满足执行条件", report)
        self.assertNotIn("双客户端同步已成功", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
