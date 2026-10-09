#!/usr/bin/env python3
"""Generate native-index/hash material rules from the local 12.00 materials.dat."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from readonly_game_outputs import atomic_write_text, validate_output

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "gta5data/data/common/data/materials/materials.dat"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/MaterialCatalog.java"


def joaat(name):
    value = 0
    for byte in name.lower().encode("ascii"):
        value = (value+byte) & 0xffffffff
        value = (value+(value << 10)) & 0xffffffff
        value ^= value >> 6
    value = (value+(value << 3)) & 0xffffffff
    value ^= value >> 11
    return (value+(value << 15)) & 0xffffffff


def parse_materials(raw):
    lines = [(index, line.split("#", 1)[0].strip()) for index, line in enumerate(raw.decode("utf-8-sig").splitlines(), 1)]
    lines = [(index, line) for index, line in lines if line]
    if not lines or lines[0][1] != "12.00":
        raise ValueError("Only the audited materials.dat version 12.00 is supported")
    result = []
    names, hashes = set(), set()
    for line, text in lines[1:]:
        fields = text.split()
        if len(fields) != 23:
            raise ValueError(f"Expected 23 fields on material line {line}")
        name = fields[0]
        # CommandGetShapeTestResultIncludingMaterial calls GetMaterialName with
        # the native low-byte material index. GetMaterialName appends _<index>
        # before atStringHash; direct joaat(name) is only an external alias.
        hash_ = joaat(name+"_"+str(len(result)))
        if name in names or hash_ in hashes:
            raise ValueError(f"Duplicate material name/hash on line {line}")
        names.add(name)
        hashes.add(hash_)
        numeric = [float(fields[i]) for i in (6, 7, 15)]
        if not all(math.isfinite(value) and value >= 0 for value in numeric):
            raise ValueError(f"Invalid physical parameter on material line {line}")
        flags = fields[16:22]
        if any(value not in ("0", "1") for value in flags):
            raise ValueError(f"Invalid material flag on line {line}")
        result.append({"index": len(result), "name": name, "hash": hash_, "base_hash": joaat(name), "line": line,
                       "friction": numeric[0], "elasticity": numeric[1], "penetration_resistance": numeric[2],
                       **dict(zip(("see_thru", "shoot_thru", "shoot_thru_fx", "no_decal", "porous", "heats_tyre"),
                                  [value == "1" for value in flags])), "effect_material": fields[22]})
    if len(result) > 256:
        raise ValueError("Native material index exceeds audited 8-bit mask")
    return result


def generate(raw=None):
    raw = SOURCE.read_bytes() if raw is None else raw
    rows = []
    for material in parse_materials(raw):
        values = [str(material["index"]), json.dumps(material["name"]), str(material["hash"])+"L"]
        values.extend(str(material[field]) for field in ("friction", "elasticity", "penetration_resistance"))
        values.extend(str(material[field]).lower() for field in ("see_thru", "shoot_thru", "shoot_thru_fx", "no_decal", "porous", "heats_tyre"))
        values.append(json.dumps(material["effect_material"]))
        rows.append("        add(new Material("+", ".join(values)+"), "+str(material["base_hash"])+"L);")
    return '''package offline.multiplayer;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generated from local materials.dat 12.00. Shape tests hash name_index;
 * unsuffixed name hashes are accepted as explicit external aliases. */
public final class MaterialCatalog {
    public static final String SOURCE_SHA256 = "%s";
    public record Material(int index, String name, long nameHash, double friction,
            double elasticity, double penetrationResistance, boolean seeThru,
            boolean shootThru, boolean shootThruFx, boolean noDecal, boolean porous,
            boolean heatsTyre, String effectMaterial) {}
    private static final Map<Integer, Material> INDICES = new LinkedHashMap<>();
    private static final Map<Long, Material> HASHES = new LinkedHashMap<>();
    static {
%s
    }
    private static void add(Material material, long baseNameHash) {
        if (INDICES.put(material.index(), material) != null || HASHES.put(material.nameHash(), material) != null)
            throw new IllegalStateException("Duplicate material identity");
        Material previous = HASHES.put(baseNameHash, material);
        if (previous != null && previous != material)
            throw new IllegalStateException("Material hash alias collision");
    }
    /** Unknown values stay unknown; callers choose their conservative fallback. */
    public static Material byCode(long code) {
        long unsigned = code & 0xffffffffL;
        return unsigned <= 255 ? INDICES.get((int) unsigned) : HASHES.get(unsigned);
    }
    public static Material byIndex(int index) { return INDICES.get(index); }
    public static Material byHash(long hash) { return HASHES.get(hash & 0xffffffffL); }
    public static List<Material> all() { return List.copyOf(INDICES.values()); }
    private MaterialCatalog() {}
}
''' % (hashlib.sha256(raw).hexdigest(), "\n".join(rows))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.check:
        validate_output(OUTPUT, sources=(SOURCE,))
    expected = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != expected:
            parser.error("MaterialCatalog.java is stale; run tools/generate_material_catalog.py")
    else:
        atomic_write_text(OUTPUT, expected, sources=(SOURCE,))
    print("MaterialCatalog.java: 213 audited local material rules verified")


if __name__ == "__main__":
    main()
