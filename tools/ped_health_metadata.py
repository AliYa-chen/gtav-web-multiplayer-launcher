#!/usr/bin/env python3
"""Generate supported model health scalars from pinned, read-only game metadata.

CPed::InitHealth selects the personality's HealthConfigHash, then copies the
configuration's DefaultHealth to current/max health and DyingHealthThreshold to
the fatal-injury threshold. Native death checks use health < dying threshold.
The server's integer effective health therefore includes the threshold unit:
initial - threshold + 1. Positive native health is threshold - 1 + effective.
No model geometry is read or emitted.
"""
from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
from export_ped_collision import MODELS
from export_world_collision import initial_memory
from explosion_metadata import _read_cstring, _u32
from generate_weapon_catalog import joaat
from inspect_native_bridge import WasmAudit
from ped_damage_metadata import rows, schema
from readonly_game_outputs import atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
GAME = ROOT / "gta5data"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/PedHealthCatalog.java"
HASHES = {
    "b/8b0b5899ed/game.wasm": "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0",
    "data/x64/data/peds.ymt": "abec57fa062f8a5e43bc7844281ae6cabc3e77175954e7c538738f7cb78d5ffe",
    "data/x64/data/metadata/pedpersonality.ymt": "cd69d45312dcea7f6f43d410201b0f23b0e77cbcdab1ba123ed6c1b0060ca2d0",
    "data/common/data/pedhealth.meta": "e263508d7c5f20a27eae4e395bd35300f5536b2aa95c6b237c6a7b2a2769cd76",
}
NATIVES = {
    21351: "CPed::ShouldBeDead() const",
    30815: "CPedDamageCalculator::ApplyDamageAndComputeResponse(CPed*, CPedDamageResponse&, rage::fwFlags<int> const&, unsigned int, float)",
    30819: "CPed::IsInjured() const",
    45788: "CPed::GetPedHealthInfo() const",
    45836: "CPed::InitHealth()",
    54887: "CPed::IsFatallyInjured() const",
}


def load(game: Path = GAME):
    inputs = {}
    for suffix, expected in HASHES.items():
        data = (game / suffix).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Unsupported original character health input: {suffix}")
        inputs[suffix] = data
    audit = WasmAudit(game / "b/8b0b5899ed/game.wasm")
    if (hashlib.sha256(audit.data).hexdigest() != HASHES["b/8b0b5899ed/game.wasm"]
            or any(audit.names.get(index) != name for index, name in NATIVES.items())):
        raise ValueError("Original character health native identity mismatch")
    memory = initial_memory(audit)

    def field(index, offsets, attributes, names):
        offset = struct.unpack_from("<I", memory, offsets + index * 4)[0]
        attribute = struct.unpack_from("<Q", memory, attributes + index * 8)[0]
        name = struct.unpack_from("<Q", memory, names + index * 8)[0]
        return offset, struct.unpack_from("<I", memory, attribute)[0], bytes(memory[name:memory.index(0, name)]).decode("ascii")

    if field(43, 5171008, 5171296, 5171872) != (176, 0x24F58FE0, "Personality"):
        raise ValueError("Native model personality mapping differs")
    if field(6, 5173984, 5174176, 5174560) != (24, 0x163A3415, "HealthConfigHash"):
        raise ValueError("Native personality health mapping differs")
    for index, expected in {
        0: (0, 0xACEC22BE, "Name"),
        1: (4, 0x61BCA11C, "DefaultHealth"),
        2: (8, 0x3B47223F, "DefaultArmour"),
        5: (20, 0x4F6FA035, "InjuredHealthThreshold"),
        6: (24, 0x481B9243, "DyingHealthThreshold"),
    }.items():
        if field(index, 5236016, 5236080, 5236192) != expected:
            raise ValueError("Native health configuration field identity/offset differs")

    tree = ET.fromstring(inputs["data/common/data/pedhealth.meta"])
    if tree.tag != "CHealthConfigInfoManager" or tree.find("DefaultSet").get("ref") != "Average":
        raise ValueError("Unsupported original health configuration root/default")
    profiles = {}
    for entry in tree.findall("./aHealthConfig/Item"):
        name = entry.findtext("Name")
        identity = joaat(name)
        health, threshold, armour = (
            float(entry.find(key).get("value"))
            for key in ("DefaultHealth", "DyingHealthThreshold", "DefaultArmour")
        )
        if (identity in profiles or not all(math.isfinite(value) for value in (health, threshold, armour))
                or not health.is_integer() or not threshold.is_integer()
                or not 1 <= threshold <= health <= 1000 or armour < 0):
            raise ValueError("Invalid or duplicate original health configuration")
        profiles[identity] = (int(health), int(threshold), armour)
    if len(profiles) != 10:
        raise ValueError("Original health configuration coverage differs")

    personalities = inputs["data/x64/data/metadata/pedpersonality.ymt"]
    schema(personalities, 0xF977FFB7, 184, {0xFAB435A8: (11, 8), 0x163A3415: (11, 32)})
    _, entries = rows(personalities, 0x90BA59AF, 40, 0xF977FFB7, 184)
    personality_health = {}
    for entry in entries:
        identity, health = _u32(entry, 8), _u32(entry, 32)
        if health not in profiles or identity in personality_health and personality_health[identity] != health:
            raise ValueError("Unresolved or conflicting personality health configuration")
        personality_health[identity] = health
    if len(personality_health) != 94:
        raise ValueError("Original personality health coverage differs")

    peds = inputs["data/x64/data/peds.ymt"]
    schema(peds, 0xEB66D086, 296, {0xACEC22BE: (11, 8), 0x24F58FE0: (11, 188)})
    mapping, entries = rows(peds, 0xDD77771E, 40, 0xEB66D086, 296)
    models = {}
    for entry in entries:
        name = _read_cstring(peds, mapping, entry[8:16]).lower()
        identity, personality = joaat(name), _u32(entry, 188)
        if identity in models or personality not in personality_health:
            raise ValueError("Duplicate model or unresolved model personality")
        models[identity] = (name, *profiles[personality_health[personality]])
    if len(models) != 683 or len(MODELS) != 10:
        raise ValueError("Original or supported character health coverage differs")
    supported = {}
    for name in sorted(MODELS):
        identity = joaat(name)
        if identity not in models or models[identity][0] != name:
            raise ValueError(f"Unresolved supported character health: {name}")
        supported[identity] = models[identity]
    return supported


def generate(game: Path = GAME):
    entries = "\n".join(
        f"        rules.put({model}L, new Rule({health}, {threshold}, {armour!r})); // {name}"
        for model, (name, health, threshold, armour) in load(game).items()
    )
    return f'''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Generated from supported original health/personality metadata; contains no geometry. */
public final class PedHealthCatalog {{
    private PedHealthCatalog() {{}}
    public static final String ENGINE_SOURCE_SHA256 = "{HASHES['b/8b0b5899ed/game.wasm']}";
    public static final String PED_SOURCE_SHA256 = "{HASHES['data/x64/data/peds.ymt']}";
    public static final String PERSONALITY_SOURCE_SHA256 = "{HASHES['data/x64/data/metadata/pedpersonality.ymt']}";
    public static final String HEALTH_SOURCE_SHA256 = "{HASHES['data/common/data/pedhealth.meta']}";
    public record Rule(int initialHealth, int dyingThreshold, double armour) {{
        /** Native fatal injury is strictly below the threshold, so equality remains one live unit. */
        public int effectiveHealth() {{ return initialHealth - dyingThreshold + 1; }}
    }}
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
            parser.error("PedHealthCatalog.java differs from verified original metadata")
    else:
        atomic_write_text(args.output, result, **boundary)
    print("Verified original health rules for 10 supported character models")


if __name__ == "__main__":
    main()
