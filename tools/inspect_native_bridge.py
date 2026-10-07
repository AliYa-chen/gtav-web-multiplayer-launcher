#!/usr/bin/env python3
"""只读解析引擎 WASM 的接口与函数体，输出可复核的 JSON 证据。

本工具不实例化 WASM，不修改其导入、导出、数据或代码。
例如：python3 -B tools/inspect_native_bridge.py --output docs/snapshot/native-bridge-evidence.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WASM = ROOT / "gta5data/b/8b0b5899ed/game.wasm"
VALUE_TYPES = {0x7F: "i32", 0x7E: "i64", 0x7D: "f32", 0x7C: "f64", 0x7B: "v128", 0x70: "funcref", 0x6F: "externref"}
DEFAULT_NAMES = (
    "Main_OneLoopIteration()",
    "ped_commands::CommandCreatePed(int, int, rage::scrVector const&, float, bool, bool)",
    "vehicle_commands::CommandCreateVehicle(int, rage::scrVector const&, float, bool, bool, bool)",
    "player_commands::CommandGetPlayerPed(int)",
    "entity_commands::CommandGetEntityCoords(int, bool)",
    "entity_commands::CommandSetEntityCoords(int, rage::scrVector const&, bool, bool, bool, bool)",
    "entity_commands::CommandSetEntityCoordsExt(int, rage::scrVector const&, bool, bool, bool, bool, bool)",
    "entity_commands::CommandGetEntityHealth(int)",
    "entity_commands::CommandSetEntityHealth(int, int, int)",
    "streaming_commands::CommandRequestModel(int)",
    "streaming_commands::HasModelLoaded(int)",
    "rage::scrThread::Run(int)",
    "rage::scrThread::Update(int)",
    "rage::scrThread::GetActiveThread()",
    "CTheScripts::RegisterEntity(CPhysical*, bool, bool, bool)",
    "CTheScripts::GetCurrentGtaScriptHandler()",
    "CTheScripts::GetCurrentGtaScriptHandlerNetwork()",
    "CScriptPeds::SetPedCoordinates(CPed*, float, float, float, int, bool, bool)",
)
OP_NAMES = {
    0x00: "unreachable", 0x01: "nop", 0x02: "block", 0x03: "loop", 0x04: "if", 0x05: "else",
    0x06: "try", 0x07: "catch", 0x08: "throw", 0x09: "rethrow", 0x0A: "throw_ref",
    0x0B: "end", 0x0C: "br", 0x0D: "br_if", 0x0E: "br_table", 0x0F: "return",
    0x10: "call", 0x11: "call_indirect", 0x12: "return_call", 0x13: "return_call_indirect",
    0x14: "call_ref", 0x15: "return_call_ref", 0x18: "delegate", 0x19: "catch_all",
    0x1A: "drop", 0x1B: "select", 0x1C: "select_typed", 0x1F: "try_table",
    0x20: "local.get", 0x21: "local.set", 0x22: "local.tee", 0x23: "global.get", 0x24: "global.set",
    0x25: "table.get", 0x26: "table.set", 0x28: "i32.load", 0x29: "i64.load", 0x2A: "f32.load",
    0x2B: "f64.load", 0x2C: "i32.load8_s", 0x2D: "i32.load8_u", 0x2E: "i32.load16_s",
    0x2F: "i32.load16_u", 0x30: "i64.load8_s", 0x31: "i64.load8_u", 0x32: "i64.load16_s",
    0x33: "i64.load16_u", 0x34: "i64.load32_s", 0x35: "i64.load32_u", 0x36: "i32.store",
    0x37: "i64.store", 0x38: "f32.store", 0x39: "f64.store", 0x3A: "i32.store8",
    0x3B: "i32.store16", 0x3C: "i64.store8", 0x3D: "i64.store16", 0x3E: "i64.store32",
    0x3F: "memory.size", 0x40: "memory.grow", 0x41: "i32.const", 0x42: "i64.const",
    0x43: "f32.const", 0x44: "f64.const", 0x45: "i32.eqz", 0x46: "i32.eq", 0x47: "i32.ne",
    0x48: "i32.lt_s", 0x49: "i32.lt_u", 0x4A: "i32.gt_s", 0x4B: "i32.gt_u", 0x4C: "i32.le_s",
    0x4D: "i32.le_u", 0x4E: "i32.ge_s", 0x4F: "i32.ge_u", 0x50: "i64.eqz", 0x51: "i64.eq",
    0x52: "i64.ne", 0x53: "i64.lt_s", 0x54: "i64.lt_u", 0x55: "i64.gt_s", 0x56: "i64.gt_u",
    0x57: "i64.le_s", 0x58: "i64.le_u", 0x59: "i64.ge_s", 0x5A: "i64.ge_u",
    0x6A: "i32.add", 0x6B: "i32.sub", 0x6C: "i32.mul", 0x71: "i32.and", 0x72: "i32.or",
    0x73: "i32.xor", 0x74: "i32.shl", 0x75: "i32.shr_s", 0x76: "i32.shr_u",
    0x7C: "i64.add", 0x7D: "i64.sub", 0x7E: "i64.mul", 0x83: "i64.and", 0x84: "i64.or",
    0x85: "i64.xor", 0x86: "i64.shl", 0x87: "i64.shr_s", 0x88: "i64.shr_u",
    0x92: "f32.add", 0x93: "f32.sub", 0x94: "f32.mul", 0x95: "f32.div",
    0xA0: "f64.add", 0xA1: "f64.sub", 0xA2: "f64.mul", 0xA3: "f64.div",
    0xA7: "i32.wrap_i64", 0xAC: "i64.extend_i32_s", 0xAD: "i64.extend_i32_u",
    0xD0: "ref.null", 0xD1: "ref.is_null", 0xD2: "ref.func", 0xD3: "ref.eq",
    0xD4: "ref.as_non_null", 0xD5: "br_on_null", 0xD6: "br_on_non_null",
}


class Reader:
    def __init__(self, data: bytes, start: int = 0, end: int | None = None):
        self.data, self.pos, self.end = data, start, len(data) if end is None else end

    def take(self, length: int) -> bytes:
        if length < 0 or self.pos + length > self.end:
            raise ValueError(f"读取超过区域边界：0x{self.pos:x}")
        result = self.data[self.pos:self.pos + length]
        self.pos += length
        return result

    def byte(self) -> int:
        return self.take(1)[0]

    def leb(self, signed: bool = False, bits: int = 64) -> int:
        value, shift = 0, 0
        while shift < bits + 7:
            byte = self.byte()
            value |= (byte & 127) << shift
            shift += 7
            if not byte & 128:
                if signed and byte & 64:
                    value -= 1 << shift
                return value
        raise ValueError("LEB 编码超过支持范围")

    def string(self) -> str:
        return self.take(self.leb()).decode("utf-8", "strict")

    def limits(self):
        flags = self.leb()
        minimum = self.leb()
        maximum = self.leb() if flags & 1 else None
        return {"flags": flags, "minimum": minimum, "maximum": maximum}

    def memarg(self):
        align = self.leb()
        memory = self.leb() if align & 0x40 else 0
        return {"alignment_exponent": align & 0x3F, "memory_index": memory, "offset": self.leb()}


class WasmAudit:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if self.data[:8] != b"\0asm\x01\0\0\0":
            raise ValueError("不是受支持的 WASM 二进制")
        self.sections, self.custom = {}, []
        reader = Reader(self.data, 8)
        while reader.pos < reader.end:
            kind = reader.byte()
            size = reader.leb()
            start, end = reader.pos, reader.pos + size
            payload = Reader(self.data, start, end)
            if kind == 0:
                name = payload.string()
                self.custom.append((name, payload.pos, end))
            else:
                self.sections[kind] = (start, end)
            reader.take(size)
        self.types, self.imports, self.function_types, self.exports, self.names, self.bodies = [], [], [], {}, {}, {}
        self._parse_tables()

    def section(self, kind: int) -> Reader:
        return Reader(self.data, *self.sections[kind])

    def _parse_tables(self):
        reader = self.section(1)
        for _ in range(reader.leb()):
            if reader.byte() != 0x60:
                raise ValueError("当前审计工具仅支持普通函数类型")
            parameters = [VALUE_TYPES.get(value, hex(value)) for value in reader.take(reader.leb())]
            results = [VALUE_TYPES.get(value, hex(value)) for value in reader.take(reader.leb())]
            self.types.append({"parameters": parameters, "results": results})
        reader = self.section(2)
        for _ in range(reader.leb()):
            module, name, kind = reader.string(), reader.string(), reader.byte()
            detail = {"module": module, "name": name, "kind": kind}
            if kind == 0:
                detail["function_index"] = len(self.function_types)
                detail["type_index"] = reader.leb()
                self.function_types.append(detail["type_index"])
            elif kind == 1:
                detail["element_type"] = reader.byte()
                detail["limits"] = reader.limits()
            elif kind == 2:
                detail["limits"] = reader.limits()
            elif kind == 3:
                detail["value_type"], detail["mutable"] = reader.byte(), reader.byte()
            elif kind == 4:
                detail["attribute"], detail["type_index"] = reader.leb(), reader.leb()
            else:
                raise ValueError(f"未知导入类型：{kind}")
            self.imports.append(detail)
        self.import_count = len(self.function_types)
        reader = self.section(3)
        self.function_types.extend(reader.leb() for _ in range(reader.leb()))
        reader = self.section(7)
        for _ in range(reader.leb()):
            name, kind, index = reader.string(), reader.byte(), reader.leb()
            if kind == 0:
                self.exports.setdefault(index, []).append(name)
        for name, start, end in self.custom:
            if name != "name":
                continue
            reader = Reader(self.data, start, end)
            while reader.pos < reader.end:
                kind, size = reader.byte(), reader.leb()
                child = Reader(self.data, reader.pos, reader.pos + size)
                if kind == 1:
                    for _ in range(child.leb()):
                        index, name = child.leb(), child.string()
                        self.names[index] = name
                reader.take(size)
        reader = self.section(10)
        for index in range(self.import_count, self.import_count + reader.leb()):
            size = reader.leb()
            self.bodies[index] = (reader.pos, reader.pos + size)
            reader.take(size)

    def descriptor(self, index: int):
        return {"function_index": index, "name": self.names.get(index), "type_index": self.function_types[index],
                "signature": self.types[self.function_types[index]], "exports": self.exports.get(index, [])}

    def instructions(self, index: int):
        reader = Reader(self.data, *self.bodies[index])
        locals_ = []
        for _ in range(reader.leb()):
            count, value = reader.leb(), reader.byte()
            locals_.append({"count": count, "type": VALUE_TYPES.get(value, hex(value))})
        instruction_start = reader.pos
        instructions, error = [], None
        while reader.pos < reader.end:
            offset = reader.pos
            opcode = reader.byte()
            item = {"file_offset": offset, "instruction_offset": offset - instruction_start,
                    "opcode": f"0x{opcode:02x}", "operation": OP_NAMES.get(opcode, f"opcode_{opcode:02x}")}
            try:
                if opcode in (0x02, 0x03, 0x04, 0x06):
                    item["block_type"] = reader.leb(True)
                elif opcode in (0x07, 0x08, 0x09, 0x0C, 0x0D, 0x18, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3F, 0x40, 0xD5, 0xD6):
                    item["index"] = reader.leb()
                elif opcode == 0x0E:
                    item["labels"] = [reader.leb() for _ in range(reader.leb())]
                    item["default_label"] = reader.leb()
                elif opcode in (0x10, 0x12, 0xD2):
                    item["target"] = self.descriptor(reader.leb())
                elif opcode in (0x11, 0x13):
                    item["type_index"], item["table_index"] = reader.leb(), reader.leb()
                elif opcode in (0x14, 0x15):
                    item["type_index"] = reader.leb()
                elif opcode == 0x1C:
                    item["types"] = list(reader.take(reader.leb()))
                elif opcode == 0x1F:
                    item["block_type"] = reader.leb(True)
                    handlers = []
                    for _ in range(reader.leb()):
                        kind = reader.byte()
                        if kind not in (0, 1, 2, 3):
                            raise ValueError("未知 try_table 处理器")
                        handlers.append({"kind": kind, "tag": reader.leb() if kind < 2 else None, "label": reader.leb()})
                    item["handlers"] = handlers
                elif 0x28 <= opcode <= 0x3E:
                    item["memory"] = reader.memarg()
                elif opcode in (0x41, 0x42):
                    item["value"] = reader.leb(True, 32 if opcode == 0x41 else 64)
                elif opcode in (0x43, 0x44):
                    item["value"] = struct.unpack("<f" if opcode == 0x43 else "<d", reader.take(4 if opcode == 0x43 else 8))[0]
                elif opcode == 0xD0:
                    item["heap_type"] = reader.leb(True)
                elif opcode == 0xFC:
                    sub = reader.leb()
                    item["sub_opcode"] = sub
                    counts = {8: 2, 9: 1, 10: 2, 11: 1, 12: 2, 13: 1, 14: 2, 15: 1, 16: 1, 17: 1, 18: 1}
                    if sub < 8:
                        pass
                    elif sub in counts:
                        item["indices"] = [reader.leb() for _ in range(counts[sub])]
                    else:
                        raise ValueError(f"未支持的 0xfc 扩展 {sub}")
                elif opcode == 0xFD:
                    sub = reader.leb()
                    item["sub_opcode"] = sub
                    if 0 <= sub <= 11 or sub in (92, 93):
                        item["memory"] = reader.memarg()
                    elif sub in (12, 13):
                        item["constant_bytes"] = reader.take(16).hex()
                    elif 21 <= sub <= 34:
                        item["lane"] = reader.byte()
                    elif 84 <= sub <= 91:
                        item["memory"] = reader.memarg()
                        item["lane"] = reader.byte()
                    elif not (14 <= sub <= 20 or 35 <= sub <= 83 or 94 <= sub <= 255 or 256 <= sub <= 275):
                        raise ValueError(f"未支持的 SIMD 扩展 {sub}")
                elif opcode == 0xFE:
                    sub = reader.leb()
                    item["sub_opcode"] = sub
                    if sub == 3:
                        item["reserved"] = reader.byte()
                    elif sub in (0, 1, 2) or 0x10 <= sub <= 0x4E:
                        item["memory"] = reader.memarg()
                    else:
                        raise ValueError(f"未支持的原子扩展 {sub}")
                elif opcode in (0x00, 0x01, 0x05, 0x0A, 0x0B, 0x0F, 0x19, 0x1A, 0x1B, 0xD1, 0xD3, 0xD4) or 0x45 <= opcode <= 0xC4:
                    pass
                else:
                    raise ValueError(f"未知或未支持的 opcode 0x{opcode:02x}")
                item["encoded_bytes"] = reader.pos - offset
                instructions.append(item)
            except ValueError as exception:
                error = {"file_offset": offset, "message": str(exception)}
                break
        return {"locals": locals_, "instruction_start": instruction_start, "decode_complete": error is None,
                "decode_error": error, "instructions": instructions}

    def body_evidence(self, index: int, include_instructions: bool = True):
        result = self.descriptor(index)
        result["body_offset"], end = self.bodies[index]
        result["body_bytes"] = end - result["body_offset"]
        decoded = self.instructions(index)
        result.update({key: value for key, value in decoded.items() if key != "instructions"})
        result["direct_calls"] = [item for item in decoded["instructions"] if item["operation"] in ("call", "return_call")]
        result["indirect_calls"] = [item for item in decoded["instructions"] if item["operation"] in ("call_indirect", "return_call_indirect", "call_ref", "return_call_ref")]
        result["memory_operations"] = [item for item in decoded["instructions"] if "memory" in item]
        if include_instructions and result["body_bytes"] <= 8192:
            result["instructions"] = decoded["instructions"]
        elif include_instructions:
            result["instructions_omitted"] = "函数体超过 8 KiB；仍保留准确的调用与内存操作摘要。"
        return result

    def audit(self, extra_pattern: str | None):
        selected = [index for index, name in self.names.items() if name in DEFAULT_NAMES or (extra_pattern and re.search(extra_pattern, name))]
        functions = [self.body_evidence(index) for index in selected if index in self.bodies]
        callee_indices = {item["target"]["function_index"] for function in functions for item in function["direct_calls"]}
        callees = [self.body_evidence(index, False) for index in sorted(callee_indices) if index in self.bodies and index not in selected]
        return {
            "input": {"path": str(self.path.resolve()), "bytes": len(self.data), "sha256": hashlib.sha256(self.data).hexdigest()},
            "scope": "只读静态解析，没有实例化、调用或修改 WASM；调用列表仅包含已准确解码部分。",
            "function_count": len(self.function_types), "imported_functions": self.import_count,
            "exports": [self.descriptor(index) for index in self.exports],
            "imports": self.imports,
            "selected_functions": functions, "first_level_callees": callees,
            "limitations": ["函数索引不是间接调用表索引。", "WASM 参数类型不足以推导 C++ 对象和脚本上下文内存布局。",
                            "直接调用依赖不包含间接调用和全局内存的全部影响。", "未完成解码的函数不能据此排除后续依赖。",
                            "主循环插入回调仍需验证运行线程、实体生命周期和 reentrancy；本工具不验证运行期安全性。"],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM, help="只读分析的 WASM 路径")
    parser.add_argument("--output", type=Path, help="JSON 输出路径；不设置则写入标准输出")
    parser.add_argument("--match", help="额外选择函数名称的正则表达式")
    arguments = parser.parse_args()
    result = WasmAudit(arguments.wasm).audit(arguments.match)
    output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(output, encoding="utf-8")
        functions = result["selected_functions"]
        print(json.dumps({"输出": str(arguments.output.resolve()), "函数数": len(functions),
                          "完整解码函数数": sum(function["decode_complete"] for function in functions)}, ensure_ascii=False))
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
