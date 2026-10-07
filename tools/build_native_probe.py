#!/usr/bin/env python3
"""制作非生产的 native 探针 WASM 副本，不覆盖游戏引擎。

默认增加只读玩家/坐标/脚本上下文与分配器导出；--entity-probe 增加隔离实体实验导出。
在脚本线程安装活动上下文后插入回调。
此工具不会运行 WASM；生成文件仍需浏览器实际验证，不能据此声明多人同步可用。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from inspect_native_bridge import DEFAULT_WASM, ROOT, Reader, WasmAudit

ORIGINAL_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0"
HOOK_FUNCTION = 16953
HOOK_INSTRUCTION_START = 9966559
HOOK_INSTRUCTION_OFFSET = 108
MAGIC = 0x4D505442
CALLBACK_IMPORT = 11
EXPECTED_RUN_PREFIX = bytes.fromhex(
    "031a7e0c7f067d230042f00b7d220521082005240042b0d6ac07200042ac037c2214370300"
    "2000280220221d417e714102470440200042c0017c210642a0d6ac07290300211a42a0d6ac07"
    "2000370300230122024298187c221b41013a000020024290187c2218290300211920182000370300"
)
ADDITIONAL_EXPORTS = {
    "mpGetPlayerPed": (58627, "player_commands::CommandGetPlayerPed(int)", ["i32"], ["i32"]),
    "mpGetEntityCoords": (50028, "entity_commands::CommandGetEntityCoords(int, bool)", ["i64", "i32", "i32"], []),
    "mpGetActiveThread": (16949, "rage::scrThread::GetActiveThread()", [], ["i64"]),
    "mpGetCurrentHandler": (63772, "CTheScripts::GetCurrentGtaScriptHandler()", [], ["i64"]),
    "mpAlloc": (91000, "emscripten_builtin_malloc", ["i64"], ["i64"]),
    "mpFree": (91002, "emscripten_builtin_free", ["i64"], []),
}
ENTITY_EXPORTS = {
    "mpGetModel": (50040, "entity_commands::CommandGetEntityModel(int)", ["i32"], ["i32"]),
    "mpHeading": (50032, "entity_commands::CommandGetEntityHeading(int)", ["i32"], ["f32"]),
    "mpCreatePed": (57110, "ped_commands::CommandCreatePed(int, int, rage::scrVector const&, float, bool, bool)", ["i32", "i32", "i64", "f32", "i32", "i32"], ["i32"]),
    "mpSetCoords": (50131, "entity_commands::CommandSetEntityCoords(int, rage::scrVector const&, bool, bool, bool, bool)", ["i32", "i64", "i32", "i32", "i32", "i32"], []),
    "mpSetHeading": (50135, "entity_commands::CommandSetEntityHeading(int, float)", ["i32", "f32"], []),
    "mpSetCollision": (50128, "entity_commands::CommandSetEntityCollision(int, bool, bool)", ["i32", "i32", "i32"], []),
    "mpSetInvincible": (50137, "entity_commands::CommandSetEntityInvincible(int, bool)", ["i32", "i32"], []),
    "mpBlockEvents": (57447, "ped_commands::CommandSetBlockingOfNonTemporaryEvents(int, bool)", ["i32", "i32"], []),
    "mpDeleteEntity": (50100, "entity_commands::CommandDeleteEntity(int&)", ["i64"], []),
    "mpDeletePed": (57115, "ped_commands::CommandDeletePed(int&)", ["i64"], []),
    "mpExists": (50006, "entity_commands::CommandDoesEntityExist(int)", ["i32"], ["i32"]),
    "mpSetCoordsNoOffset": (50133, "entity_commands::CommandSetEntityCoordsNoOffset(int, rage::scrVector const&, bool, bool, bool)", ["i32", "i64", "i32", "i32", "i32"], []),
    "mpFreeze": (50102, "entity_commands::CommandFreezeEntityPosition(int, bool)", ["i32", "i32"], []),
    "mpGetHealth": (50034, "entity_commands::CommandGetEntityHealth(int)", ["i32"], ["i32"]),
    "mpSetHealth": (50136, "entity_commands::CommandSetEntityHealth(int, int, int)", ["i32", "i32", "i32"], []),
    "mpIsDead": (50068, "entity_commands::CommandIsEntityDead(int, bool)", ["i32", "i32"], ["i32"]),
    "mpIsShooting": (57158, "ped_commands::CommandIsPedShooting(int)", ["i32"], ["i32"]),
    "mpSelectedWeapon": (62955, "weapon_commands::CommandGetSelectedPedWeapon(int)", ["i32"], ["i32"]),
    "mpGiveWeapon": (62910, "weapon_commands::CommandGiveWeaponToPed(int, int, int, bool, bool)", ["i32", "i32", "i32", "i32", "i32"], []),
    "mpSetCurrentWeapon": (62917, "weapon_commands::CommandSetCurrentPedWeapon(int, int, bool)", ["i32", "i32", "i32"], []),
    "mpTaskShootAtCoord": (60656, "task_commands::CommandTaskShootAtCoord(int, rage::scrVector const&, int, int)", ["i32", "i64", "i32", "i32"], []),
    "mpCamCoords": (49040, "camera_commands::CommandGetGameplayCamCoord()", ["i64"], []),
    "mpCamRot": (49041, "camera_commands::CommandGetGameplayCamRot(int)", ["i64", "i32"], []),
    "mpRequestModel": (60322, "streaming_commands::CommandRequestModel(int)", ["i32"], []),
    "mpHasModel": (60324, "streaming_commands::HasModelLoaded(int)", ["i32"], ["i32"]),
    "mpAddBlipForEntity": (51603, "hud_commands::AddBlipForEntity(int)", ["i32"], ["i32"]),
    "mpSetBlipColour": (51623, "hud_commands::ChangeBlipColour(int, int)", ["i32", "i32"], []),
    "mpSetBlipSprite": (51664, "hud_commands::CommandSetBlipSprite(int, int)", ["i32", "i32"], []),
    "mpSetBlipScale": (51659, "hud_commands::CommandChangeBlipScale(int, float)", ["i32", "f32"], []),
    "mpSetBlipAsShortRange": (51652, "hud_commands::CommandSetBlipAsShortRange(int, bool)", ["i32", "i32"], []),
    "mpRemoveBlip": (51667, "hud_commands::CommandRemoveBlip(int&)", ["i64"], []),
    "mpBeginSetBlipName": (51491, "hud_commands::CommandBeginTextCommandSetBlipName(char const*)", ["i64"], []),
    "mpAddTextPlayerSubstring": (51504, "hud_commands::CommandAddTextComponentSubStringPlayerName(char const*)", ["i64"], []),
    "mpEndSetBlipName": (51492, "hud_commands::CommandEndTextCommandSetBlipName(int)", ["i32"], []),
    "mpSetPlayerModel": (58625, "player_commands::CommandChangePlayerModel(int, int)", ["i32", "i32"], []),
    "mpPlayerId": (58714, "player_commands::CommandPlayerId()", [], ["i32"]),
    "mpDefaultVariation": (57395, "ped_commands::CommandSetPedDefaultComponentVariation(int)", ["i32"], []),
}


def export_map(entity_probe: bool = False):
    return {**ADDITIONAL_EXPORTS, **(ENTITY_EXPORTS if entity_probe else {})}


def unsigned_leb(value: int) -> bytes:
    if value < 0:
        raise ValueError("无符号 LEB 不能编码负数")
    result = bytearray()
    while True:
        byte, value = value & 127, value >> 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def signed_leb(value: int) -> bytes:
    result = bytearray()
    while True:
        byte, value = value & 127, value >> 7
        done = (value == 0 and not byte & 64) or (value == -1 and bool(byte & 64))
        result.append(byte if done else byte | 128)
        if done:
            return bytes(result)


def encoded_name(value: str) -> bytes:
    value_bytes = value.encode("utf-8")
    return unsigned_leb(len(value_bytes)) + value_bytes


def checked_audit(path: Path, entity_probe: bool = False) -> WasmAudit:
    audit = WasmAudit(path)
    digest = hashlib.sha256(audit.data).hexdigest()
    if digest != ORIGINAL_SHA256:
        raise ValueError(f"原引擎 SHA256 不匹配，拒绝修改：{digest}")
    for export, (index, expected_name, parameters, results) in export_map(entity_probe).items():
        descriptor = audit.descriptor(index)
        if descriptor["name"] != expected_name or descriptor["signature"] != {"parameters": parameters, "results": results}:
            raise ValueError(f"导出 {export} 对应函数或 ABI 不匹配")
    callback = audit.descriptor(CALLBACK_IMPORT)
    if callback["name"] != "wasm_module_int_js" or callback["signature"] != {"parameters": ["i64", "i32"], "results": ["i32"]}:
        raise ValueError("现有 JavaScript 回调导入不匹配")
    if audit.names.get(HOOK_FUNCTION) != "rage::scrThread::Run(int)":
        raise ValueError("目标脚本运行函数名称不匹配")
    decoded = audit.instructions(HOOK_FUNCTION)
    if not decoded["decode_complete"] or decoded["instruction_start"] != HOOK_INSTRUCTION_START:
        raise ValueError("目标函数未完整解码，或指令起点不同")
    hook_position = HOOK_INSTRUCTION_START + HOOK_INSTRUCTION_OFFSET
    body_start, _ = audit.bodies[HOOK_FUNCTION]
    if audit.data[body_start:hook_position] != EXPECTED_RUN_PREFIX:
        raise ValueError("脚本线程前置字节不同；无法确认已安装活动线程，拒绝插入回调")
    before = next((instruction for instruction in decoded["instructions"] if instruction["instruction_offset"] == 105), None)
    after = next((instruction for instruction in decoded["instructions"] if instruction["instruction_offset"] == 108), None)
    if not before or before["operation"] != "i64.store" or before.get("memory", {}).get("offset") != 0 or not after or after["operation"] != "block":
        raise ValueError("hook 前后的 TLS 写入和指令边界不匹配")
    return audit


def build(audit: WasmAudit, entity_probe: bool = False):
    data = audit.data
    exports = export_map(entity_probe)
    hook_position = HOOK_INSTRUCTION_START + HOOK_INSTRUCTION_OFFSET
    # local.get 0；i32.const MAGIC；call 11；drop。沿用已有导入，不移动函数索引。
    hook_bytes = b"\x20\x00\x41" + signed_leb(MAGIC) + b"\x10" + unsigned_leb(CALLBACK_IMPORT) + b"\x1a"
    source = Reader(data, 8)
    output = bytearray(data[:8])
    export_section_seen, code_section_seen, patched_bodies = False, False, 0
    unchanged_sections = []
    while source.pos < source.end:
        section_start = source.pos
        kind, size = source.byte(), source.leb()
        payload_start, payload_end = source.pos, source.pos + size
        payload = data[payload_start:payload_end]
        if kind == 7:
            export_section_seen = True
            reader = Reader(payload)
            count = reader.leb()
            entries = payload[reader.pos:]
            existing_names = []
            for _ in range(count):
                existing_names.append(reader.string())
                reader.byte()
                reader.leb()
            if reader.pos != reader.end or set(existing_names).intersection(exports):
                raise ValueError("原导出节有冲突或尾部数据")
            additions = b"".join(encoded_name(name) + b"\x00" + unsigned_leb(value[0]) for name, value in exports.items())
            payload = unsigned_leb(count + len(exports)) + entries + additions
        elif kind == 10:
            code_section_seen = True
            reader = Reader(data, payload_start, payload_end)
            count = reader.leb()
            result = bytearray(data[payload_start:reader.pos])
            for index in range(audit.import_count, audit.import_count + count):
                entry_start = reader.pos
                body_size = reader.leb()
                body_start, body_end = reader.pos, reader.pos + body_size
                if index == HOOK_FUNCTION:
                    if not body_start < hook_position < body_end:
                        raise ValueError("hook 没有落在预期函数体内")
                    body = data[body_start:hook_position] + hook_bytes + data[hook_position:body_end]
                    result.extend(unsigned_leb(len(body)) + body)
                    patched_bodies += 1
                else:
                    result.extend(data[entry_start:body_end])
                reader.take(body_size)
            if reader.pos != reader.end:
                raise ValueError("代码节有未解析尾部数据")
            payload = bytes(result)
        else:
            unchanged_sections.append({"section_id": kind, "payload_bytes": size, "sha256": hashlib.sha256(payload).hexdigest()})
        if kind in (7, 10):
            output.extend(bytes((kind,)) + unsigned_leb(len(payload)) + payload)
        else:
            output.extend(data[section_start:payload_end])
        source.take(size)
    if not export_section_seen or not code_section_seen or patched_bodies != 1:
        raise ValueError("预期导出节/代码节/单个目标函数体未全部匹配")
    evidence = {
        "purpose": ("非生产实体复制实验：增加本地角色创建/属性/坐标/销毁接口，尚未证明实际游戏操作成功。" if entity_probe else "非生产只读探针：读取本地玩家、坐标和活动脚本上下文；未加入创建角色或写入实体的接口。"),
        "entity_probe": entity_probe,
        "original": {"path": str(audit.path.resolve()), "sha256": ORIGINAL_SHA256, "bytes": len(data)},
        "prototype": {"sha256": hashlib.sha256(output).hexdigest(), "bytes": len(output)},
        "hook": {"function_index": HOOK_FUNCTION, "function_name": audit.names[HOOK_FUNCTION],
                 "original_instruction_start": HOOK_INSTRUCTION_START, "instruction_offset": HOOK_INSTRUCTION_OFFSET,
                 "original_file_offset": hook_position, "verified_prefix_sha256": hashlib.sha256(EXPECTED_RUN_PREFIX).hexdigest(),
                 "verified_prefix_bytes": len(EXPECTED_RUN_PREFIX), "callback_import": audit.descriptor(CALLBACK_IMPORT),
                 "magic_hex": hex(MAGIC), "magic_i32": MAGIC, "inserted_bytes_hex": hook_bytes.hex(),
                 "meaning": "活动线程 this 已写入 TLS；JS 必须识别 magic 后再使用指针，不能当作字符串读取。"},
        "additional_exports": [{"export_name": name, **audit.descriptor(value[0])} for name, value in exports.items()],
        "entity_probe_constraints": (["仅在活动脚本线程和有效 handler 上测试；不得当作已完成的同步功能。", "坐标向量为三个 f32，分别位于 scratch 指针的 0/8/16 字节偏移。", "模型需要在当前有效脚本上下文请求并确认 mpHasModel 已完成；同本地角色模型可直接复用。", "创建本地测试角色时 pedType=4、network=false、scriptHost=false。", "mpDeleteEntity/mpDeletePed 的参数为 i64 指向 int32 句柄，而不是句柄本身。", "测试角色归属于当前脚本上下文；清理/重生/掉线时必须先检查 mpExists。", "mpSetCoords 含角色高度补偿；直接同步世界坐标应验证并使用 mpSetCoordsNoOffset。", "mpCamCoords/mpCamRot 是结构体返回，首 i64 为结果缓冲区；不是返回 JS 坐标数组。"] if entity_probe else []),
        "unchanged_sections": unchanged_sections,
        "invariants": {"function_indices_unchanged": True, "imports_unchanged": True, "types_unchanged": True,
                       "data_and_elements_unchanged": True, "patched_function_bodies": patched_bodies},
        "runtime_status": "尚未在实际游戏中验证；编译成功也不代表脚本上下文、生命周期或多人同步可用。",
    }
    return bytes(output), evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM, help="必须匹配已审计 SHA256 的原始引擎")
    parser.add_argument("--output", type=Path, help="非生产输出路径；默认只读 native-probe.wasm，实体实验 native-replica.wasm")
    parser.add_argument("--entity-probe", action="store_true", help="增加隔离实体复制实验导出；不改变默认只读探针")
    arguments = parser.parse_args()
    default_output = ROOT / "archive/cache" / ("native-replica.wasm" if arguments.entity_probe else "native-probe.wasm")
    original, output = arguments.wasm.resolve(), (arguments.output or default_output).resolve()
    production_root = (ROOT / "gta5data").resolve()
    if output == original or output == DEFAULT_WASM.resolve() or production_root in output.parents:
        parser.error("不能将探针写入原引擎或生产镜像目录；请选择 archive/cache 或独立实验目录")
    if output.suffix != ".wasm":
        parser.error("探针输出必须是独立的 .wasm 文件")
    audit = checked_audit(original, arguments.entity_probe)
    prototype, evidence = build(audit, arguments.entity_probe)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_bytes(prototype)
    os.replace(temporary, output)
    evidence["prototype"]["path"] = str(output)
    evidence_path = output.with_suffix(".json")
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"探针": str(output), "证据": str(evidence_path), "新增导出": len(export_map(arguments.entity_probe)),
                      "hook": evidence["hook"]["original_file_offset"], "生产引擎未改动": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
