#!/usr/bin/env python3
"""只读审计当前 WASM 的线上世界系统，不实例化引擎或修改游戏资源。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from inspect_native_bridge import DEFAULT_WASM, ROOT, WasmAudit

GROUPS = {
    "原生传输": r"rage::netSocket::|rage::netTcp::|rage::netConnectionManager",
    "会话与身份": r"rage::rlSession::|rage::rlRos::|CNetworkSession::",
    "网络实体与归属": r"rage::netObject::|rage::netObjectMgrBase::|CNetworkObjectMgr::|CNetObj(?:Ped|Player|Vehicle|Object)::",
    "同步树与节点": r"rage::netSyncTree::|rage::netSyncDataNode::|C(?:Ped|Player|Vehicle|Object).*DataNode::",
    "任务与克隆任务": r"rage::aiTaskTree::|CTaskInfo::|CPedIntelligence::CreateClone|CCloned.*Task",
    "实体池与脚本引用": r"CPoolHelpers::|CTheScripts::RegisterEntity|CommandGetAllVehicles|CEntity::GetScript|CPools::",
    "人群交通与警察": r"CPopulation::|CPopulationManager::|CVehiclePopulation::|CDispatch|CWanted::|CArrest",
    "死亡与重启": r"CGameLogic::.*(?:Death|Arrest|Restart|State)|Command.*(?:DeathArrest|Resurrect|PlayerBeingArrested)",
}

# 精确索引仅用于已审计构建；名称、ABI 和函数体一起报告，不能当成可直接执行的 API。
ANCHORS = (181, 185, 186, 13571, 13829, 8099, 8102, 8155, 8318, 8319, 8324,
           16953, 82999, 86746, 54900, 61266, 61943, 57110, 58711, 54881)


def describe(audit: WasmAudit, index: int, decode: bool = False):
    record = audit.descriptor(index)
    if index not in audit.bodies:
        return record
    start, end = audit.bodies[index]
    body = audit.data[start:end]
    record.update(body_offset=start, body_bytes=len(body), body_sha256=hashlib.sha256(body).hexdigest())
    # 空函数或单个常量返回可直接确认；不把更长函数体一概标记为可用。
    record["simple_body_hex"] = body.hex() if len(body) <= 16 else None
    if decode:
        instructions = audit.instructions(index)
        record["decode_complete"] = instructions["decode_complete"]
        direct = sorted({item["target"]["function_index"] for item in instructions["instructions"]
                         if item["operation"] in ("call", "return_call")})
        record["direct_calls"] = [{"index": target, "name": audit.names.get(target, "")}
                                  for target in direct]
        record["indirect_calls"] = sum(item["operation"] in ("call_indirect", "return_call_indirect")
                                       for item in instructions["instructions"])
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/snapshot/online-world-audit.json")
    args = parser.parse_args()
    audit = WasmAudit(args.wasm)
    systems = {}
    for label, pattern in GROUPS.items():
        matching = [index for index, name in audit.names.items() if re.search(pattern, name)]
        systems[label] = {"function_count": len(matching),
                          "samples": [describe(audit, index) for index in matching[:16]]}
    report = {
        "source": {"path": str(args.wasm.resolve()), "bytes": len(audit.data),
                   "sha256": hashlib.sha256(audit.data).hexdigest()},
        "execution": "只读二进制解析；未实例化 WASM，未调用游戏函数，未修改资源。",
        "function_names": len(audit.names), "function_exports": sum(len(names) for names in audit.exports.values()),
        "systems": systems, "anchors": [describe(audit, index, True) for index in ANCHORS],
        "interpretation": [
            "符号、函数体与序列化节点存在，不等于网络管理器、会话和对象可独立初始化。",
            "函数编号不是脚本 native 哈希或间接表位置；对象指针不能跨客户端传输。",
            "实体池枚举、同步树读写与世界模拟需分别证明线程、对象布局与生命周期。",
            "没有 GTA 物理与 AI 模拟的 Java 服务不能凭坐标和 JSON 独立复现整个游戏世界。",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"报告": str(args.output), "原始SHA256": report["source"]["sha256"],
                      "系统函数数量": {key: value["function_count"] for key, value in systems.items()},
                      "未执行游戏": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
