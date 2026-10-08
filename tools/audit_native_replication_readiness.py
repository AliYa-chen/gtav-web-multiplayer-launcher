#!/usr/bin/env python3
"""只读核对原生复制前置条件；不运行 WASM、不创建对象、不修改引擎。

可选读取 engine bridge 的 world_readiness 日志。日志没有证明当前页已刷新，
且同步树指针存在不能证明 target object 合法或双客户端复制成功。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from inspect_native_bridge import DEFAULT_WASM, WasmAudit

ORIGINAL_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0"
READINESS_SPECS = {
    "ped_tree": (88346, "CNetObjPed::GetSyncTree()", ["i64"], ["i64"]),
    "player_tree": (88355, "CNetObjPlayer::GetSyncTree()", ["i64"], ["i64"]),
    "network_handler": (63797, "CTheScripts::GetCurrentGtaScriptHandlerNetwork()", [], ["i64"]),
    "session_active": (54707, "network_commands::CommandNetworkIsSessionActive()", [], ["i32"]),
    "session_started": (54708, "network_commands::CommandNetworkIsSessionStarted()", [], ["i32"]),
}
TREE_ADDRESSES = {"ped_tree": 29559952, "player_tree": 29561200}
SESSION_IMPLEMENTATIONS = {"session_active": (82912, "i32.ne", 0), "session_started": (83019, "i32.eq", 5)}
TRANSPORT_INDICES = (181, 185, 186, 187, 13571, 13829)
OBSERVATION_FIELDS = ("ped_tree_initialized", "player_tree_initialized", "network_script_context")


def checked_function(audit: WasmAudit, index: int, expected_name: str | None = None,
                     parameters: list[str] | None = None, results: list[str] | None = None):
    descriptor = audit.descriptor(index)
    if expected_name is not None and descriptor["name"] != expected_name:
        raise ValueError(f"函数 {index} 的名称与已审计版本不同")
    if parameters is not None and descriptor["signature"] != {"parameters": parameters, "results": results}:
        raise ValueError(f"函数 {index} 的 WASM ABI 与已审计版本不同")
    decoded = audit.instructions(index)
    if not decoded["decode_complete"]:
        raise ValueError(f"函数 {index} 无法完整解码，不继续推断调用或内存布局")
    start, end = audit.bodies[index]
    return {**descriptor, "body_offset": start, "body_bytes": end - start,
            "body_sha256": hashlib.sha256(audit.data[start:end]).hexdigest(),
            "instructions": decoded["instructions"]}


def audit_static(audit: WasmAudit):
    digest = hashlib.sha256(audit.data).hexdigest()
    if digest != ORIGINAL_SHA256:
        raise ValueError("原引擎 SHA256 不匹配；不能把已知函数索引或布局套用到其它构建")
    getters = {}
    for key, (index, name, parameters, results) in READINESS_SPECS.items():
        value = checked_function(audit, index, name, parameters, results)
        items = value["instructions"]
        if key in TREE_ADDRESSES:
            if ([item["operation"] for item in items] != ["i64.const", "i64.load", "end"]
                    or items[0]["value"] != TREE_ADDRESSES[key] or items[1]["memory"]["offset"] != 0):
                raise ValueError(f"{key} getter 已不能证明仅读取初始化指针")
            value["global_pointer_address"] = TREE_ADDRESSES[key]
            value["contract"] = "只读全局指针；实际未解引用传入 this，不创建树或 target object。"
        elif key == "network_handler":
            if not (sum(item["operation"] == "i64.eqz" for item in items) >= 2
                    and any(item["operation"] == "i64.load" and item["memory"]["offset"] == 560 for item in items)
                    and any(item["operation"] == "call_indirect" and item["type_index"] == 4 for item in items)):
                raise ValueError("network handler 的活动线程/handler 空值检查未匹配")
            value["contract"] = "检查活动线程和 handler，利用原虚接口确认网络 handler；只能在真实脚本上下文观察。"
        else:
            target, comparison, state = SESSION_IMPLEMENTATIONS[key]
            if ([item["operation"] for item in items] != ["call", "end"]
                    or items[0]["target"]["function_index"] != target):
                raise ValueError(f"{key} 的只读查询调用路径不同")
            implementation = checked_function(audit, target)
            inner = implementation["instructions"]
            if not (any(item["operation"] == "i64.eqz" for item in inner)
                    and any(item["operation"] == "return" for item in inner)
                    and any(item["operation"] == "i32.load" and item["memory"]["offset"] == 99916 for item in inner)
                    and inner[-3]["operation"] == "i32.const" and inner[-3]["value"] == state
                    and inner[-2]["operation"] == comparison):
                raise ValueError(f"{key} 的 session 空值保护/状态查询未匹配")
            value["implementation"] = implementation
            value["contract"] = "空 session 返回 false；只查询原状态，不建立会话或认证。"
        getters[key] = value

    transport = {}
    for index in TRANSPORT_INDICES:
        value = checked_function(audit, index)
        items = value["instructions"]
        if index in (181, 186, 187):
            expected = {181: "0041010b", 186: "002001410036020041000b",
                        187: "00200041003b0100200141003b01000b"}[index]
            start, end = audit.bodies[index]
            if audit.data[start:end].hex() != expected:
                raise ValueError(f"socket 空实现 {index} 的完整字节不同")
            value["body_hex"] = expected
        elif index == 185:
            if not (items[-2]["operation"] == "i32.const" and items[-2]["value"] == 0
                    and any(item["operation"] == "i64.store" and item["memory"]["offset"] == 8
                            and pos > 0 and items[pos - 1]["operation"] == "i64.const" and items[pos - 1]["value"] == -1
                            for pos, item in enumerate(items))):
                raise ValueError("NativeBind 未确认写入无效句柄 -1 并返回 0")
        elif index == 13571:
            forbidden = [item for item in items if item["operation"] in ("call", "return_call")
                         and (item["target"]["function_index"] < audit.import_count
                              or any(term in (item["target"]["name"] or "").lower()
                                     for term in ("sendto", "syscall", "emscripten", "wasm_net")))]
            if forbidden or any(item["operation"] in ("call_indirect", "return_call_indirect") for item in items):
                raise ValueError("原 Send 直接 I/O 空实现与已知调用列表不同")
        elif index == 13829:
            fixed = next((pos for pos, item in enumerate(items) if item["file_offset"] == 7840045), None)
            if fixed is None or items[fixed]["operation"] != "i32.const" or items[fixed]["value"] != -1:
                raise ValueError("Receive 固定无数据结果的准确偏移不同")
            branch = next((pos for pos, item in enumerate(items) if item["file_offset"] == 7840049), None)
            if branch is None or items[branch]["operation"] != "i32.const" or items[branch]["value"] != 1 or items[branch + 1]["operation"] != "br_if":
                raise ValueError("Receive 跳过原生接收的恒真分支不同")
        value["stub_confirmed"] = True
        transport[str(index)] = value
    return {"input": {"path": str(audit.path.resolve()), "bytes": len(audit.data), "sha256": digest},
            "scope": "静态只读核对；没有实例化或调用任何 WASM 函数。",
            "getters": getters, "peer_transport": {"implemented": False, "functions": transport}}


def read_observations(paths: list[Path]):
    observations, errors = [], []
    for path in paths:
        latest = None
        try:
            with path.open(encoding="utf-8", errors="replace") as stream:
                for number, line in enumerate(stream, 1):
                    if "world_readiness" not in line or len(line) > 65536:
                        continue
                    start = line.find("{")
                    if start < 0:
                        continue
                    try:
                        value, _ = json.JSONDecoder().raw_decode(line[start:])
                    except ValueError:
                        continue
                    if (not isinstance(value, dict) or value.get("mode") != "read_only"
                            or value.get("type", value.get("phase")) != "world_readiness"
                            or not all(type(value.get(field)) is bool for field in OBSERVATION_FIELDS)):
                        continue
                    latest = {field: value[field] for field in OBSERVATION_FIELDS}
                    for field in ("session_active", "session_started"):
                        latest[field] = value.get(field) if type(value.get(field)) is bool else None
                    latest.update(source=str(path.resolve()), line=number)
            if latest:
                observations.append(latest)
        except OSError as error:
            errors.append({"source": str(path.resolve()), "error": str(error)})
    return observations, errors


def proof_gates(observations: list[dict]):
    runtime = {"status": "logged_observations" if observations else "unverified",
               "current_page_verified": False, "clone_roundtrip_verified": False,
               "observations": observations,
               "note": "日志只能证明记录时的只读观测，不能确认用户当前页面已刷新、对象合法或树复制成功。"}
    blockers = [{"code": "peer_transport_stub", "message": "原 peer socket 存在空实现，需要通用传输适配。"},
                {"code": "legal_target_unverified", "message": "尚未证明真实 netPlayer/netObject/target accessor、对象池和执行阶段有效；禁止伪造指针调用树。"},
                {"code": "codec_roundtrip_unverified", "message": "未完成原节点编码、解码、应用及双客户端创建/更新/删除验证。"}]
    if not observations:
        blockers.append({"code": "runtime_observation_missing", "message": "没有 world_readiness 运行日志；运行态验证未完成。"})
        next_step = "刷新隔离客户端并取得只读 world_readiness，再按真实状态决定初始化诊断；当前只通过静态接口核对。"
    else:
        incomplete = [item for item in observations if not item["ped_tree_initialized"] or not item["player_tree_initialized"]]
        no_context = [item for item in observations if not item["network_script_context"]]
        if incomplete:
            blockers.append({"code": "trees_not_initialized", "message": "至少一个已记录客户端的原 ped/player 同步树未初始化。"})
        if no_context:
            blockers.append({"code": "network_handler_missing", "message": "至少一个已记录客户端的当前脚本没有 network handler。"})
        if any(item["session_active"] is None or item["session_started"] is None for item in observations):
            blockers.append({"code": "session_observation_missing", "message": "现有观测没有原 session active/started 值；静态入口存在不代表当前 session 成功。"})
        if any(item["session_active"] is False or item["session_started"] is False for item in observations):
            blockers.append({"code": "session_not_established", "message": "至少一个已记录客户端的原 session 未启动或未建立。"})
        if incomplete:
            next_step = "追查原网络初始化阶段、管理器和对象池；未证明合法树/target 前停止 clone read/apply。"
        elif no_context:
            next_step = "先只读核对实体 netObject/accessor；仅隔离专用实验脚本可研究 TRY 网络 handler 初始化，不能接管正常游戏脚本。"
        else:
            next_step = "继续核对原 session、合法 netPlayer/netObject/target、锁和调用阶段；全部成立后才能进行一个原节点的有界编码实验。"
    return {"runtime": runtime, "can_attempt_clone": False, "blockers": blockers, "next_step": next_step,
            "route_decision": "原生优先以合法目标和三个节点往返为门槛；若必须恢复完整官方匹配或无法建立有效上下文，再转统一对象/组件适配。"}


def audit_readiness(wasm: Path, logs: list[Path] | None = None):
    static = audit_static(WasmAudit(wasm))
    observations, errors = read_observations(logs or [])
    return {**static, **proof_gates(observations), "log_read_errors": errors}


def render_report(result: dict):
    lines = ["# 原生复制就绪检查", "", "此检查读取原 WASM 和可选浏览器日志，没有运行或修改引擎，没有创建网络对象，也没有调用未知指针。", "",
             "原引擎 SHA256：`" + result["input"]["sha256"] + "`。", "",
             "## 当前结果", "", "静态 ABI、树 getter、network handler/session 查询和 peer socket 空实现均匹配已审计构建。",
             "运行态验证：" + ("只有日志观测，未确认当前刷新。" if result["runtime"]["observations"] else "**未完成；没有有效 world_readiness 日志。**"),
             "原生复制实验：**尚未满足执行条件，不能据此声称原生联机可用。**", "", "## 只读接口", "",
             "| 查询 | 函数索引 | 文件体偏移 | ABI |", "| --- | ---: | ---: | --- |"]
    for key, value in result["getters"].items():
        signature = value["signature"]
        lines.append(f"| {key} | {value['function_index']} | {value['body_offset']} | ({','.join(signature['parameters'])}) → {','.join(signature['results']) or 'void'} |")
    lines += ["", "树 getter 只读取全局初始化指针；network handler 依赖真实活动脚本。session 查询空对象返回 false。任何查询都不会创建合法 netObject/target。", "",
              "## 运行记录", ""]
    if not result["runtime"]["observations"]:
        lines.append("没有可用样本。现有 engine bridge 的 world_readiness 保持只读，等待实际客户端记录。")
    else:
        for item in result["runtime"]["observations"]:
            fields = ", ".join(f"{key}={item[key] if item[key] is not None else '未记录'}" for key in (*OBSERVATION_FIELDS, "session_active", "session_started"))
            lines.append(f"- `{item['source']}:{item['line']}`：{fields}。")
    lines += ["", "## 阻断条件", ""]
    lines.extend("- " + item["message"] for item in result["blockers"])
    lines += ["", "下一步：" + result["next_step"], "", result["route_decision"], "",
              "只读脚本与当前 Java 战局互不替代：房间连接成功不会补齐原网络初始化和 peer I/O。", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM)
    parser.add_argument("--runtime-log", type=Path, action="append", default=[], help="可重复指定只读 world_readiness 日志")
    parser.add_argument("--output", type=Path, help="JSON 证据输出路径，默认打印到标准输出")
    parser.add_argument("--report", type=Path, help="中文 Markdown 报告输出路径")
    args = parser.parse_args(argv)
    inputs = {path.resolve() for path in [args.wasm, *args.runtime_log]}
    outputs = [path.resolve() for path in (args.output, args.report) if path]
    if any(path in inputs for path in outputs) or len(set(outputs)) != len(outputs):
        parser.exit(1, "输出路径不得覆盖 WASM、输入日志或另一个输出文件。\n")
    try:
        result = audit_readiness(args.wasm, args.runtime_log)
    except (OSError, ValueError) as error:
        parser.exit(1, "就绪检查未完成：" + str(error) + "\n")
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    for path, content in ((args.output, encoded), (args.report, render_report(result))):
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    if args.output:
        print(json.dumps({"静态核对": "通过", "运行态验证": result["runtime"]["status"],
                          "可执行clone": result["can_attempt_clone"], "JSON": str(args.output.resolve()),
                          "报告": str(args.report.resolve()) if args.report else None}, ensure_ascii=False))
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
