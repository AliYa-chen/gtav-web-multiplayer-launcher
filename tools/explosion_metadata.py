#!/usr/bin/env python3
"""Decode the PSO explosion metadata used by the local GTA resource.

The input is opened read-only.  This parser intentionally consumes the PSCH
schema from the file itself instead of assuming a newer CodeWalker schema:
the shipped file has a 120-byte explosion record and does not contain the
newer ``midRadius``/``damageAtMid`` fields.

Public API:
    load_explosions(source) -> dict[str, dict[str, object]]

The returned values keep IEEE-754 single precision values as Python floats;
no damage or radius values are rounded or invented.  A generator may use the
same values to create a resource-free server catalog.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path
from typing import Any

try:  # works both as ``python tools/explosion_metadata.py`` and as a module
    from readonly_game_outputs import atomic_write_text, validate_outputs
except ModuleNotFoundError:  # pragma: no cover - import-path convenience
    from tools.readonly_game_outputs import atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "gta5data/data/x64/data/metadata/explosion.ymt"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/ExplosionCatalog.java"

PSIN = b"PSIN"
PMAP = b"PMAP"
PSCH = b"PSCH"

ROOT_HASH = 0x0F271702  # CExplosionInfoManager
ITEM_HASH = 0x977D9A7F  # the on-file 120-byte explosion item
ARRAYINFO_HASH = 0x00000100

_FLOAT_FIELDS = {
    "damageAtCentre": 24,
    "damageAtEdge": 28,
    "networkPlayerModifier": 32,
    "networkPedModifier": 36,
    "endRadius": 40,
    "initSpeed": 44,
    "decayFactor": 48,
    "forceFactor": 52,
    "fRagdollForceModifier": 56,
    "fSelfForceModifier": 60,
    "directedWidth": 64,
    "directedLifeTime": 68,
    "camShake": 76,
    "camShakeRollOffScaling": 80,
    "shockingEventVisualRangeOverride": 84,
    "shockingEventAudioRangeOverride": 88,
    "fragDamage": 100,
}
_BOOL_FIELDS = {
    "minorExplosion": 92,
    "bAppliesContinuousDamage": 104,
    "bPostProcessCollisionsWithNoForce": 105,
    "bDamageVehicles": 106,
    "bDamageObjects": 107,
    "bOnlyAffectsLivePeds": 108,
    "bIgnoreExplodingEntity": 109,
    "bNoOcclusion": 110,
    "explodeAttachEntityWhenFinished": 111,
    "bCanSetPedOnFire": 112,
    "bSuppressCrime": 113,
    "bUseDistanceDamageCalc": 114,
    "bPreventWaterExplosionVFX": 115,
}

# These hashes/offsets are read from this file's PSCH section.  Keeping the
# check here prevents silently interpreting a same-looking PSO with a shifted
# schema as if it were this supported resource version.
_EXPECTED_ROOT_ENTRIES = (
    (ARRAYINFO_HASH, 0x0C, 0, 0, ITEM_HASH),
    (0x82ECA25B, 0x0D, 0, 8, 0),  # aExplosionTagData
)
_EXPECTED_ITEM_ENTRIES = {
    0xE6E17F14: (0x0B, 3, 8),  # name
    0x2554A5B0: (0x07, 0, 24),  # damageAtCentre
    0x56CFC098: (0x07, 0, 28),  # damageAtEdge
    0xD54B2ED3: (0x07, 0, 32),  # networkPlayerModifier
    0xA85AC189: (0x07, 0, 36),  # networkPedModifier
    0x12422BA6: (0x07, 0, 40),  # endRadius
    0xD8FCaf5A: (0x07, 0, 44),  # initSpeed
    0x8260FBF6: (0x07, 0, 48),  # decayFactor
    0xE02F914F: (0x07, 0, 52),  # forceFactor
    0x568014DF: (0x07, 0, 56),  # fRagdollForceModifier
    0xC2C1D670: (0x07, 0, 60),  # fSelfForceModifier
    0x37981288: (0x07, 0, 64),  # directedWidth
    0x7BB3C0F7: (0x07, 0, 68),  # directedLifeTime
    0xBC1C2609: (0x0B, 7, 72),  # camShakeName
    0xA7A6E14F: (0x07, 0, 76),  # camShake
    0x3F12544C: (0x07, 0, 80),  # camShakeRollOffScaling
    0x8455E617: (0x07, 0, 84),  # shockingEventVisualRangeOverride
    0x149887BF: (0x07, 0, 88),  # shockingEventAudioRangeOverride
    0xB83415EC: (0x00, 0, 92),  # minorExplosion
    0x73EE4024: (0x0B, 7, 96),  # vfxTagHashName
    0x9F8575E5: (0x07, 0, 100),  # fragDamage
    0x76DE865E: (0x00, 0, 104),  # bAppliesContinuousDamage
    0x4110CF8B: (0x00, 0, 105),  # bPostProcessCollisionsWithNoForce
    0x187E1174: (0x00, 0, 106),  # bDamageVehicles
    0xB803CBB2: (0x00, 0, 107),  # bDamageObjects
    0x9797005D: (0x00, 0, 108),  # bOnlyAffectsLivePeds
    0x2149CB9F: (0x00, 0, 109),  # bIgnoreExplodingEntity
    0x5CA5CEB8: (0x00, 0, 110),  # bNoOcclusion
    0xA1B39EFC: (0x00, 0, 111),  # explodeAttachEntityWhenFinished
    0x75B84570: (0x00, 0, 112),  # bCanSetPedOnFire
    0x3F359AB0: (0x00, 0, 113),  # bSuppressCrime
    0x7302D15D: (0x00, 0, 114),  # bUseDistanceDamageCalc
    0xDA6F603A: (0x00, 0, 115),  # bPreventWaterExplosionVFX
}


class ExplosionParseError(ValueError):
    """The input is not the supported, schema-validated explosion PSO."""


def _u32(buf: bytes, off: int) -> int:
    return struct.unpack_from(">I", buf, off)[0]


def _u16(buf: bytes, off: int) -> int:
    return struct.unpack_from(">H", buf, off)[0]


def _f32(buf: bytes, off: int) -> float:
    return struct.unpack_from(">f", buf, off)[0]


def _sections(data: bytes) -> dict[bytes, bytes]:
    sections: dict[bytes, bytes] = {}
    pos = 0
    while pos < len(data):
        if pos + 8 > len(data):
            raise ExplosionParseError("truncated PSO section header")
        ident = data[pos:pos + 4]
        length = _u32(data, pos + 4)
        if length < 8 or pos + length > len(data):
            raise ExplosionParseError(f"invalid {ident!r} section length {length}")
        if ident in sections:
            raise ExplosionParseError(f"duplicate PSO section {ident!r}")
        sections[ident] = data[pos:pos + length]
        pos += length
    if pos != len(data):
        raise ExplosionParseError("PSO sections do not consume the input")
    for ident in (PSIN, PMAP, PSCH):
        if ident not in sections:
            raise ExplosionParseError(f"missing {ident.decode()} section")
    return sections


def _mapping(section: bytes) -> tuple[int, list[dict[str, int]]]:
    if section[:4] != PMAP:
        raise ExplosionParseError("invalid PMAP header")
    length = _u32(section, 4)
    if length != len(section):
        raise ExplosionParseError("PMAP length mismatch")
    root_id = _u32(section, 8)
    count = _u16(section, 12)
    if count <= 0 or 16 + count * 16 > len(section):
        raise ExplosionParseError("invalid PMAP entry count")
    entries = []
    for i in range(count):
        off = 16 + i * 16
        entries.append({
            "hash": _u32(section, off),
            "offset": _u32(section, off + 4),
            "unknown": _u32(section, off + 8),
            "length": _u32(section, off + 12),
        })
    if not 1 <= root_id <= len(entries):
        raise ExplosionParseError(f"invalid PMAP root id {root_id}")
    return root_id, entries


def _schema(section: bytes) -> tuple[dict[int, dict[str, Any]], dict[int, list[dict[str, int]]]]:
    if section[:4] != PSCH:
        raise ExplosionParseError("invalid PSCH header")
    if _u32(section, 4) != len(section):
        raise ExplosionParseError("PSCH length mismatch")
    count = _u32(section, 8)
    if count == 0 or 12 + count * 8 > len(section):
        raise ExplosionParseError("invalid PSCH type count")
    index: list[tuple[int, int]] = []
    for i in range(count):
        off = 12 + i * 8
        index.append((_u32(section, off), _u32(section, off + 4)))
    structures: dict[int, dict[str, Any]] = {}
    entries_by_hash: dict[int, list[dict[str, int]]] = {}
    for type_hash, off in index:
        if off + 12 > len(section):
            raise ExplosionParseError("PSCH type offset outside section")
        packed = _u32(section, off)
        type_id = packed >> 24
        entry_count = packed & 0xFFFF
        struct_len = _u32(section, off + 4)
        if type_id != 0:
            raise ExplosionParseError(f"unsupported PSCH type {type_id} for {type_hash:#x}")
        end = off + 12 + entry_count * 12
        if end > len(section):
            raise ExplosionParseError("truncated PSCH structure entries")
        entries = []
        for i in range(entry_count):
            eoff = off + 12 + i * 12
            entries.append({
                "hash": _u32(section, eoff),
                "type": section[eoff + 4],
                "unknown": section[eoff + 5],
                "offset": _u16(section, eoff + 6),
                "ref": _u32(section, eoff + 8),
            })
        structures[type_hash] = {"length": struct_len, "entries": entries}
        entries_by_hash[type_hash] = entries
    return structures, entries_by_hash


def _read_pointer_word(field: bytes) -> tuple[int, int]:
    """Read a PSO pointer's custom-endian first word as (block id, offset)."""
    if len(field) < 4:
        raise ExplosionParseError("truncated PSO pointer")
    encoded = int.from_bytes(field[:4], "big")
    return encoded & 0xFFF, encoded >> 12


def _read_cstring(data: bytes, mapping: list[dict[str, int]], field: bytes) -> str:
    block_id, offset = _read_pointer_word(field)
    if block_id == 0 or block_id > len(mapping):
        raise ExplosionParseError(f"string pointer block id {block_id} is invalid")
    block = mapping[block_id - 1]
    start = block["offset"] + offset
    end = data.find(b"\0", start, block["offset"] + block["length"])
    if end < 0:
        raise ExplosionParseError("unterminated explosion tag string")
    try:
        return data[start:end].decode("ascii")
    except UnicodeDecodeError as error:
        raise ExplosionParseError("non-ASCII explosion tag string") from error


def _resource_root(source: Path | str) -> Path:
    """Protect the entire selected resource, not only explosion.ymt itself."""
    source = Path(source).expanduser().resolve()
    suffix = ("data", "x64", "data", "metadata", "explosion.ymt")
    if tuple(part.lower() for part in source.parts[-5:]) != suffix:
        raise ExplosionParseError("source must be RESOURCE_ROOT/data/x64/data/metadata/explosion.ymt")
    return source.parents[4]


def load_explosions(source: Path | str = SOURCE) -> dict[str, dict[str, object]]:
    """Return the schema-validated explosion records keyed by EXP_TAG name."""
    path = Path(source).expanduser()
    if not path.is_file():
        raise ExplosionParseError(f"explosion metadata is not a regular file: {path}")
    data = path.read_bytes()  # deliberate read-only access
    if hashlib.sha256(data).hexdigest() != "15d3d6d5f0327d6e50db763957827f1095265244eee20c76bf66513520b4c41e":
        raise ExplosionParseError("unsupported explosion.ymt SHA-256; refusing to guess its schema")
    sections = _sections(data)
    if _u32(sections[PSIN], 4) != len(sections[PSIN]):
        raise ExplosionParseError("PSIN length mismatch")
    root_id, mapping = _mapping(sections[PMAP])
    structures, _ = _schema(sections[PSCH])
    root_schema = structures.get(ROOT_HASH)
    if root_schema is None or root_schema["length"] != 24:
        raise ExplosionParseError("unsupported CExplosionInfoManager schema")
    root_actual = tuple(
        (e["hash"], e["type"], e["unknown"], e["offset"], e["ref"])
        for e in root_schema["entries"]
    )
    if root_actual != _EXPECTED_ROOT_ENTRIES:
        raise ExplosionParseError("CExplosionInfoManager PSCH entries differ from the supported schema")
    root_entry = mapping[root_id - 1]
    if root_entry["hash"] != ROOT_HASH:
        raise ExplosionParseError(f"unexpected PSO root hash {root_entry['hash']:#x}")
    root = data[root_entry["offset"]:root_entry["offset"] + root_entry["length"]]
    if len(root) != 24:
        raise ExplosionParseError("unexpected CExplosionInfoManager size")
    array_block, array_offset = _read_pointer_word(root[8:16])
    count = _u16(root, 16)
    count2 = _u16(root, 18)
    if count != count2 or array_block == 0 or array_block > len(mapping):
        raise ExplosionParseError("invalid explosion array pointer/count")
    item_block = mapping[array_block - 1]
    item_schema = structures.get(ITEM_HASH)
    if item_schema is None or item_schema["length"] != 120 or len(item_schema["entries"]) != 33:
        raise ExplosionParseError("unsupported explosion item schema")
    item_actual = {
        e["hash"]: (e["type"], e["unknown"], e["offset"])
        for e in item_schema["entries"]
    }
    if item_actual != _EXPECTED_ITEM_ENTRIES:
        raise ExplosionParseError("explosion item PSCH entries differ from the supported schema")
    if item_block["hash"] != ITEM_HASH or array_offset + count * 120 > item_block["length"]:
        raise ExplosionParseError("explosion array does not fit its PMAP block")
    output: dict[str, dict[str, object]] = {}
    for index in range(count):
        start = item_block["offset"] + array_offset + index * 120
        record = data[start:start + 120]
        name = _read_cstring(data, mapping, record[8:16])
        if not name.startswith("EXP_TAG_"):
            raise ExplosionParseError(f"unexpected explosion tag {name!r}")
        values: dict[str, object] = {"tag": name, "name": name}
        for field, off in _FLOAT_FIELDS.items():
            values[field] = _f32(record, off)
        for field, off in _BOOL_FIELDS.items():
            values[field] = bool(record[off])
        if name in output:
            raise ExplosionParseError(f"duplicate explosion tag {name}")
        output[name] = values
    return output


def _java_double(value: float) -> str:
    # repr is the shortest round-trippable representation of the source f32.
    text = repr(value)
    if text == "-0.0":
        return "-0.0d"
    if text in {"nan", "inf", "-inf"}:
        raise ExplosionParseError("non-finite explosion metadata")
    return text + ("d" if "." not in text and "e" not in text.lower() else "")


def generate_java(source: Path | str = SOURCE) -> str:
    rows = load_explosions(source)
    data = Path(source).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    lines = []
    for tag, row in rows.items():
        vals = [_java_double(float(row[name])) for name in _FLOAT_FIELDS]
        vals += ["true" if row[name] else "false" for name in _BOOL_FIELDS]
        lines.append("        add(rules, \"%s\", %s);" % (tag, ", ".join(vals)))
    body = "\n".join(lines)
    return f'''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Generated by tools/explosion_metadata.py from the read-only game resource. */
public final class ExplosionCatalog {{
    private ExplosionCatalog() {{}}
    public static final String SOURCE_SHA256 = "{sha}";
    public static final int SOURCE_SCHEMA_ITEM_BYTES = 120;
    public record Rule(String tag, double damageAtCentre, double damageAtEdge,
        double networkPlayerModifier, double networkPedModifier, double endRadius,
        double initSpeed, double decayFactor, double forceFactor,
        double fRagdollForceModifier, double fSelfForceModifier, double directedWidth,
        double directedLifeTime, double camShake, double camShakeRollOffScaling,
        double shockingEventVisualRangeOverride, double shockingEventAudioRangeOverride,
        double fragDamage, boolean minorExplosion, boolean bAppliesContinuousDamage,
        boolean bPostProcessCollisionsWithNoForce, boolean bDamageVehicles,
        boolean bDamageObjects, boolean bOnlyAffectsLivePeds, boolean bIgnoreExplodingEntity,
        boolean bNoOcclusion, boolean explodeAttachEntityWhenFinished,
        boolean bCanSetPedOnFire, boolean bSuppressCrime, boolean bUseDistanceDamageCalc,
        boolean bPreventWaterExplosionVFX) {{
        public boolean continuous() {{ return bAppliesContinuousDamage; }}
        public Map<String,Object> publicRule() {{
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("tag", tag); value.put("damage_at_centre", damageAtCentre);
            value.put("damage_at_edge", damageAtEdge); value.put("end_radius", endRadius);
            value.put("frag_damage", fragDamage); value.put("network_player_modifier", networkPlayerModifier);
            value.put("network_ped_modifier", networkPedModifier); value.put("continuous", continuous());
            value.put("damage_vehicles", bDamageVehicles); value.put("damage_objects", bDamageObjects);
            value.put("distance_damage_calc", bUseDistanceDamageCalc);
            return Collections.unmodifiableMap(value);
        }}
    }}
    private static void add(Map<String,Rule> rules, String tag, double damageAtCentre,
        double damageAtEdge, double networkPlayerModifier, double networkPedModifier,
        double endRadius, double initSpeed, double decayFactor, double forceFactor,
        double fRagdollForceModifier, double fSelfForceModifier, double directedWidth,
        double directedLifeTime, double camShake, double camShakeRollOffScaling,
        double shockingEventVisualRangeOverride, double shockingEventAudioRangeOverride,
        double fragDamage, boolean minorExplosion, boolean bAppliesContinuousDamage,
        boolean bPostProcessCollisionsWithNoForce, boolean bDamageVehicles, boolean bDamageObjects,
        boolean bOnlyAffectsLivePeds, boolean bIgnoreExplodingEntity, boolean bNoOcclusion,
        boolean explodeAttachEntityWhenFinished, boolean bCanSetPedOnFire, boolean bSuppressCrime,
        boolean bUseDistanceDamageCalc, boolean bPreventWaterExplosionVFX) {{
        if (rules.put(tag, new Rule(tag, damageAtCentre, damageAtEdge, networkPlayerModifier,
            networkPedModifier, endRadius, initSpeed, decayFactor, forceFactor,
            fRagdollForceModifier, fSelfForceModifier, directedWidth, directedLifeTime,
            camShake, camShakeRollOffScaling, shockingEventVisualRangeOverride,
            shockingEventAudioRangeOverride, fragDamage, minorExplosion, bAppliesContinuousDamage,
            bPostProcessCollisionsWithNoForce, bDamageVehicles, bDamageObjects,
            bOnlyAffectsLivePeds, bIgnoreExplodingEntity, bNoOcclusion,
            explodeAttachEntityWhenFinished, bCanSetPedOnFire, bSuppressCrime,
            bUseDistanceDamageCalc, bPreventWaterExplosionVFX)) != null)
            throw new IllegalStateException("Duplicate explosion tag");
    }}
    private static final Map<String,Rule> RULES = create();
    private static Map<String,Rule> create() {{
        Map<String,Rule> rules = new LinkedHashMap<>();
{body}
        return Collections.unmodifiableMap(rules);
    }}
    public static Rule byName(String tag) {{
        if (tag == null) return null;
        String key = tag.toUpperCase(Locale.ROOT);
        if (!key.startsWith("EXP_TAG_")) key = "EXP_TAG_" + key;
        return RULES.get(key);
    }}
    public static Map<String,Rule> all() {{ return RULES; }}
}}
'''


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source_root = _resource_root(args.source)
    if not args.check:
        outputs = (OUTPUT, args.json) if args.json else (OUTPUT,)
        validate_outputs(outputs, sources=(args.source,), protected_roots=(source_root,))
    rows = load_explosions(args.source)
    if args.json:
        text = json.dumps(rows, indent=2, sort_keys=True) + "\n"
        if args.check:
            if not args.json.exists() or args.json.read_text() != text:
                parser.exit(1, "explosion JSON differs from the source; regenerate it.\n")
        else:
            atomic_write_text(args.json, text, sources=(args.source,), protected_roots=(source_root,))
    java = generate_java(args.source)
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != java:
            parser.exit(1, "ExplosionCatalog.java differs from explosion.ymt; regenerate it.\n")
    else:
        atomic_write_text(OUTPUT, java, sources=(args.source,), protected_roots=(source_root,))
    print(f"Explosion catalog verified: {len(rows)} PSO records")


if __name__ == "__main__":
    main()
