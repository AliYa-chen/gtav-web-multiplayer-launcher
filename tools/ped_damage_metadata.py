#!/usr/bin/env python3
"""Read the supported original character armour coefficients without changing game inputs.

PSO file offsets are checked against the on-file schema, separately from the
runtime C++ layout. Native PersonalityData has ArmourEfficiency at offset 76;
the PSO field with the same verified name/hash is at offset 108.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

sys.dont_write_bytecode = True
from explosion_metadata import _sections, _mapping, _read_cstring, _read_pointer_word, _u16, _u32
from export_world_collision import initial_memory
from generate_weapon_catalog import joaat
from inspect_native_bridge import WasmAudit
from readonly_game_outputs import atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
GAME = ROOT / "gta5data"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/PedDamageCatalog.java"
HASHES = {
    "b/8b0b5899ed/game.wasm": "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0",
    "data/x64/data/peds.ymt": "abec57fa062f8a5e43bc7844281ae6cabc3e77175954e7c538738f7cb78d5ffe",
    "data/x64/data/metadata/pedpersonality.ymt": "cd69d45312dcea7f6f43d410201b0f23b0e77cbcdab1ba123ed6c1b0060ca2d0",
}


def schema(data: bytes, wanted: int, size: int, fields: dict[int, tuple[int, int]]) -> None:
    section = _sections(data)[b"PSCH"]
    for index in range(_u32(section, 8)):
        identity, offset = struct.unpack_from(">II", section, 12 + index * 8)
        if identity != wanted:
            continue
        packed, actual_size = struct.unpack_from(">II", section, offset)
        if packed >> 24 or actual_size != size:
            raise ValueError("Unsupported character PSO record")
        found = {}
        for field in range(packed & 65535):
            cursor = offset + 12 + field * 12
            found[_u32(section, cursor)] = (section[cursor + 4], _u16(section, cursor + 6))
        if any(found.get(key) != value for key, value in fields.items()):
            raise ValueError("Character PSO field identity/type/offset mismatch")
        return
    raise ValueError("Required character PSO schema missing")


def rows(data: bytes, root_hash: int, array_offset: int, record_hash: int, size: int):
    sections = _sections(data)
    root_id, mapping = _mapping(sections[b"PMAP"])
    root = mapping[root_id - 1]
    if root["hash"] != root_hash or root["length"] < array_offset + 12:
        raise ValueError("Unexpected character root")
    start = root["offset"] + array_offset
    block_id, offset = _read_pointer_word(data[start:start + 8])
    count, capacity = struct.unpack_from(">HH", data, start + 8)
    if count != capacity or not 1 <= block_id <= len(mapping):
        raise ValueError("Invalid character array")
    block = mapping[block_id - 1]
    if block["hash"] != record_hash or offset + count * size > block["length"]:
        raise ValueError("Character array exceeds its typed block")
    return mapping, [data[block["offset"] + offset + i * size:block["offset"] + offset + (i + 1) * size]
                     for i in range(count)]


def load(game: Path = GAME):
    inputs = {}
    for suffix, expected in HASHES.items():
        data = (game / suffix).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Unsupported original character damage input: {suffix}")
        inputs[suffix] = data
    audit = WasmAudit(game / "b/8b0b5899ed/game.wasm")
    if audit.names.get(30815) != "CPedDamageCalculator::ApplyDamageAndComputeResponse(CPed*, CPedDamageResponse&, rage::fwFlags<int> const&, unsigned int, float)":
        raise ValueError("Character damage native identity mismatch")
    memory = initial_memory(audit)
    def field(index, offsets, attributes, names):
        offset = struct.unpack_from("<I", memory, offsets + index * 4)[0]
        attribute = struct.unpack_from("<Q", memory, attributes + index * 8)[0]
        name = struct.unpack_from("<Q", memory, names + index * 8)[0]
        return offset, struct.unpack_from("<I", memory, attribute)[0], bytes(memory[name:memory.index(0, name)]).decode("ascii")
    if field(25, 5173984, 5174176, 5174560) != (76, 0xC67CC98F, "ArmourEfficiency"):
        raise ValueError("Native armour parser mapping differs")
    if field(43, 5171008, 5171296, 5171872) != (176, 0x24F58FE0, "Personality"):
        raise ValueError("Native model personality mapping differs")
    personalities = inputs["data/x64/data/metadata/pedpersonality.ymt"]
    schema(personalities, 0xF977FFB7, 184, {0xFAB435A8: (11, 8), 0xC67CC98F: (7, 108)})
    _, entries = rows(personalities, 0x90BA59AF, 40, 0xF977FFB7, 184)
    efficiencies = {}
    for entry in entries:
        identity = _u32(entry, 8)
        value = struct.unpack_from(">f", entry, 108)[0]
        # The supported source repeats one personality name, with identical armour efficiency.
        # Conflicting duplicates would be ambiguous and must fail instead of choosing an order.
        if (identity in efficiencies and efficiencies[identity] != value) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid or conflicting original armour efficiency")
        efficiencies[identity] = value
    peds = inputs["data/x64/data/peds.ymt"]
    schema(peds, 0xEB66D086, 296, {0xACEC22BE: (11, 8), 0x24F58FE0: (11, 188)})
    mapping, entries = rows(peds, 0xDD77771E, 40, 0xEB66D086, 296)
    output = {}
    for entry in entries:
        name = _read_cstring(peds, mapping, entry[8:16])
        personality = _u32(entry, 188)
        if personality not in efficiencies or joaat(name) in output:
            raise ValueError("Unresolved character personality or duplicate model")
        output[joaat(name)] = (name, personality, efficiencies[personality])
    if len(efficiencies) != 94 or len(output) != 683:
        raise ValueError("Original character damage coverage differs")
    return output


def generate(game: Path = GAME):
    values = load(game)
    entries = "\n".join(f"        rules.put({model}L, new Rule({json.dumps(name)}, {personality}L, {efficiency!r}));"
                        for model, (name, personality, efficiency) in values.items())
    return f'''package offline.multiplayer;

import java.util.Map;
import java.util.LinkedHashMap;
import java.util.Collections;

/** Generated from supported original model/personality PSO metadata; contains no geometry. */
public final class PedDamageCatalog {{
    private PedDamageCatalog() {{}}
    public static final String PED_SOURCE_SHA256 = "{HASHES['data/x64/data/peds.ymt']}";
    public static final String PERSONALITY_SOURCE_SHA256 = "{HASHES['data/x64/data/metadata/pedpersonality.ymt']}";
    public record Rule(String modelName, long personality, double armourEfficiency) {{}}
    private static final Map<Long, Rule> RULES = create();
    private static Map<Long, Rule> create() {{
        Map<Long, Rule> rules = new LinkedHashMap<>();
{entries}
        return Collections.unmodifiableMap(rules);
    }}
    public static Rule byModel(long model) {{ return RULES.get(model); }}
}}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-root", type=Path, default=GAME)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    boundary = {"sources": tuple(args.game_root / suffix for suffix in HASHES), "protected_roots": (args.game_root,)}
    validate_outputs((args.output,), **boundary)
    result = generate(args.game_root)
    if args.check:
        if args.output.read_text() != result:
            parser.error("PedDamageCatalog.java differs from verified original metadata")
    else:
        atomic_write_text(args.output, result, **boundary)
    print("Verified 683 model mappings and 94 personality armour coefficients")


if __name__ == "__main__":
    main()
