#!/usr/bin/env python3
"""Freeze original vehicle damage inputs into a resource-free Java catalog.

The source records are descriptive only.  ``fWeaponDamageMult`` is the source
vehicle weapon multiplier, ``fDeformationDamageMult`` and
``fEngineDamageMult`` are handling fields, and ``fPetrolTankVolume`` is a tank
capacity.  The shipped metadata has no universal blast or petrol-tank damage
formula, so this exporter deliberately writes unknown values as ``-1`` and
never derives a threshold from a health field.  A model whose handlingId is
absent remains in the catalog with ``handlingResolved=false``; it is never
silently assigned another model's handling.

The original game files are read-only.  Publication uses the same guarded,
atomic output boundary as the weapon generators.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
GAME_DATA = ROOT / "gta5data/data"
VEHICLES = GAME_DATA / "common/data/levels/gta5/vehicles.meta"
HANDLING = GAME_DATA / "common/data/handling.meta"
WEAPONS = GAME_DATA / "common/data/ai/weapons.meta"
ORIGINAL_WASM = ROOT / "gta5data/b/8b0b5899ed/game.wasm"
ENGINE_SPEC = ROOT / "desktop/src-tauri/assets/engine-spec.json"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/VehicleDamageCatalog.java"
SOURCES = (VEHICLES, HANDLING, WEAPONS, ORIGINAL_WASM, ENGINE_SPEC)
EXPECTED_WASM_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0"

# Publicly documented native health domains are command/state bounds.  They do
# not establish when a vehicle explodes, becomes undrivable, or catches fire.
# Keep these separate from generated per-model metadata so callers cannot
# mistake them for weapon thresholds.
HEALTH_DOMAINS = {
    "engine": (-4000.0, 1000.0, "health_state_bounds", "destruction semantics unverified"),
    "body": (0.0, 1000.0, "health_state_bounds", "zero does not universally imply explosion"),
    "petrol_tank": (-999.90002441406, 1000.0, "health_state_bounds", "damage and fire semantics unverified"),
}


def _value(node: ET.Element | None, field: str, default: str | None = None) -> str | None:
    if node is None:
        return default
    child = node.find(field)
    if child is None:
        return default
    value = child.get("value")
    if value is not None:
        return value.strip()
    text = "" if child.text is None else child.text.strip()
    return text or default


def _number(node: ET.Element | None, field: str, default: float = -1.0) -> float:
    raw = _value(node, field)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError(f"{field} is not numeric: {raw!r}") from error
    if not math.isfinite(value):
        raise ValueError(f"{field} is not finite: {raw!r}")
    return value


def _int(node: ET.Element | None, field: str, default: int = -1) -> int:
    value = _number(node, field, float(default))
    if value != int(value):
        raise ValueError(f"{field} is not integral: {value}")
    return int(value)


def _text(value: str | None) -> str:
    return "" if value is None else " ".join(value.split())


def joaat(value: str) -> int:
    result = 0
    for byte in value.lower().encode("utf-8"):
        result = (result + byte) & 0xFFFFFFFF
        result = (result + (result << 10)) & 0xFFFFFFFF
        result ^= result >> 6
    result = (result + (result << 3)) & 0xFFFFFFFF
    result ^= result >> 11
    return (result + (result << 15)) & 0xFFFFFFFF


def jstr(value: str) -> str:
    # JSON string escaping is valid Java string escaping for the characters in
    # these metadata names (and avoids hand-written quote/backslash bugs).
    return json.dumps(value, ensure_ascii=False)


def jnum(value: float | int) -> str:
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError(f"non-finite generated number: {value}")
    # repr preserves the source decimal without inventing precision.  Java
    # accepts the same exponent notation; force a decimal for integral floats.
    text = repr(float(value))
    return text if any(ch in text for ch in ".eE") else text + ".0"


def load_xml(path: Path) -> ET.Element:
    # read_bytes() is intentional: this code never opens a player resource for
    # writing and hashes exactly the bytes parsed below.
    return ET.fromstring(path.read_bytes())


def _find_items(root: ET.Element, field: str) -> list[ET.Element]:
    return [item for item in root.iter("Item") if _value(item, field) is not None]


def _explicit(node: ET.Element | None, fields: tuple[str, ...]) -> list[str]:
    if node is None:
        return []
    return [field for field in fields if node.find(field) is not None]


def parse_vehicle_sources() -> tuple[list[dict], list[dict], dict[str, str]]:
    vehicles_root = load_xml(VEHICLES)
    handling_root = load_xml(HANDLING)
    weapons_root = load_xml(WEAPONS)
    vehicles = {str(_value(item, "modelName")): item for item in _find_items(vehicles_root, "modelName")}
    handling = {str(_value(item, "handlingName")): item for item in _find_items(handling_root, "handlingName")}
    if len(vehicles) != 298:
        raise ValueError(f"expected 298 vehicle records, found {len(vehicles)}")
    if len(handling) != 248:
        raise ValueError(f"expected 248 handling records, found {len(handling)}")

    handling_fields = (
        "fMass", "fPercentSubmerged", "fCollisionDamageMult", "fWeaponDamageMult",
        "fDeformationDamageMult", "fEngineDamageMult", "fPetrolTankVolume", "fOilVolume",
        "strDamageFlags", "fWeaponDamageScaledToVehHealthMult",
    )
    vehicle_fields = (
        "handlingId", "type", "vehicleClass", "layout", "explosionInfo", "coverBoundOffsets",
        "defaultBodyHealth", "damageMapScale", "damageOffsetScale", "weaponForceMult",
        "buoyancySphereOffset", "buoyancySphereSizeScale",
    )
    rows: list[dict] = []
    for model_name, node in vehicles.items():
        handling_name = str(_value(node, "handlingId", ""))
        hnode = handling.get(handling_name)
        rows.append({
            "hash": joaat(model_name), "model": model_name, "handling": handling_name,
            "type": str(_value(node, "type", "")), "vehicleClass": str(_value(node, "vehicleClass", "")),
            "layout": str(_value(node, "layout", "")), "explosionInfo": str(_value(node, "explosionInfo", "")),
            "coverBoundOffsets": str(_value(node, "coverBoundOffsets", "")),
            "defaultBodyHealth": _number(node, "defaultBodyHealth"),
            "damageMapScale": _number(node, "damageMapScale"), "damageOffsetScale": _number(node, "damageOffsetScale"),
            "weaponForceMult": _number(node, "weaponForceMult"),
            "mass": _number(hnode, "fMass"), "percentSubmerged": _number(hnode, "fPercentSubmerged"),
            "collisionDamageMult": _number(hnode, "fCollisionDamageMult"),
            "weaponDamageMult": _number(hnode, "fWeaponDamageMult"),
            "deformationDamageMult": _number(hnode, "fDeformationDamageMult"),
            "engineDamageMult": _number(hnode, "fEngineDamageMult"),
            "petrolTankVolume": _number(hnode, "fPetrolTankVolume"), "oilVolume": _number(hnode, "fOilVolume"),
            "damageFlags": _int(hnode, "strDamageFlags"),
            "weaponDamageScaledToVehHealthMult": _number(hnode, "fWeaponDamageScaledToVehHealthMult"),
            "handlingResolved": hnode is not None,
            "explicit": _explicit(node, vehicle_fields) + _explicit(hnode, handling_fields),
        })

    ammo = {}
    for item in weapons_root.iter("Item"):
        name = _value(item, "Name")
        if name and str(item.get("type", "")).startswith("CAmmo"):
            ammo[str(name)] = item
    weapon_rows: list[dict] = []
    for item in weapons_root.iter("Item"):
        if item.get("type") != "CWeaponInfo":
            continue
        name = str(_value(item, "Name", ""))
        reference = item.find("AmmoInfo")
        ammo_name = reference.get("ref", "") if reference is not None else ""
        ammo_node = ammo.get(ammo_name)
        weapon_rows.append({
            "hash": joaat(name), "name": name, "fireType": str(_value(item, "FireType", "")),
            "damageType": str(_value(item, "DamageType", "")), "baseDamage": _number(item, "Damage"),
            "damageTimeInVehicle": _number(item, "DamageTimeInVehicle"),
            "damageTimeInVehicleHeadShot": _number(item, "DamageTimeInVehicleHeadShot"),
            "forceHitVehicle": _number(item, "ForceHitVehicle"),
            "ammoName": ammo_name, "ammoDamage": _number(ammo_node, "Damage"),
            "ammoExplosion": _text(_value(ammo_node, "Explosion/Default")),
            "weaponExplosion": _text(_value(item, "Explosion")),
            "explicit": _explicit(item, ("Damage", "DamageTimeInVehicle", "DamageTimeInVehicleHeadShot", "ForceHitVehicle", "FireType", "DamageType"))
                + _explicit(ammo_node, ("Damage", "Explosion/Default", "LaunchSpeed", "GravityFactor")),
        })
    if len(weapon_rows) != 91:
        raise ValueError(f"expected 91 CWeaponInfo records, found {len(weapon_rows)}")
    hashes = {
        "common/data/levels/gta5/vehicles.meta": hashlib.sha256(VEHICLES.read_bytes()).hexdigest(),
        "common/data/handling.meta": hashlib.sha256(HANDLING.read_bytes()).hexdigest(),
        "common/data/ai/weapons.meta": hashlib.sha256(WEAPONS.read_bytes()).hexdigest(),
        "b/8b0b5899ed/game.wasm": hashlib.sha256(ORIGINAL_WASM.read_bytes()).hexdigest(),
        "desktop/src-tauri/assets/engine-spec.json": hashlib.sha256(ENGINE_SPEC.read_bytes()).hexdigest(),
    }
    if hashes["b/8b0b5899ed/game.wasm"] != EXPECTED_WASM_SHA256:
        raise ValueError("unsupported original game.wasm SHA-256")
    return rows, weapon_rows, hashes


def parse_native_bindings() -> dict[str, dict]:
    spec = json.loads(ENGINE_SPEC.read_text(encoding="utf-8"))
    # The engine spec is generated from the read-only WASM adapter contract and
    # gives the exact ABI exported to the browser bridge.  Refuse a missing or
    # changed health ABI rather than silently claiming a writer exists.
    wanted = {
        "mpEngineHealth": (61599, ["i32"], ["f32"]),
        "mpBodyHealth": (61604, ["i32"], ["f32"]),
        "mpSetEngineHealth": (61600, ["i32", "f32"], []),
        "mpSetBodyHealth": (61605, ["i32", "f32"], []),
    }
    found = {item.get("name"): item for item in spec.get("exports", []) if isinstance(item, dict)}
    # engine-spec.json stores the descriptors under native_exports in newer
    # builds; accept both forms while requiring exact signatures.
    if not found:
        found = {item.get("name"): item for item in spec.get("native_exports", []) if isinstance(item, dict)}
    result = {}
    for name, (index, parameters, results) in wanted.items():
        item = found.get(name)
        if item is None:
            raise ValueError(f"missing verified engine ABI descriptor: {name}")
        if item.get("function_index") != index or item.get("parameters") != parameters or item.get("results") != results:
            raise ValueError(f"engine ABI descriptor changed: {name}")
        result[name] = {"index": index, "parameters": parameters, "results": results}
    return result


def generate() -> str:
    rows, weapons, hashes = parse_vehicle_sources()
    native = parse_native_bindings()
    vehicle_lines = []
    for row in rows:
        explicit = ", ".join(jstr(value) for value in sorted(set(row["explicit"])))
        vehicle_lines.append(
            "        add(vehicles, 0x%08xL, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, Set.of(%s));" % (
                row["hash"], jstr(row["model"]), jstr(row["handling"]), jstr(row["type"]), jstr(row["vehicleClass"]),
                jstr(row["layout"]), jstr(row["explosionInfo"]), jstr(row["coverBoundOffsets"]),
                jnum(row["defaultBodyHealth"]), jnum(row["damageMapScale"]), jnum(row["damageOffsetScale"]),
                jnum(row["weaponForceMult"]), jnum(row["mass"]), jnum(row["percentSubmerged"]),
                jnum(row["collisionDamageMult"]), jnum(row["weaponDamageMult"]), jnum(row["deformationDamageMult"]),
                jnum(row["engineDamageMult"]), jnum(row["petrolTankVolume"]), jnum(row["oilVolume"]),
                str(row["damageFlags"]), jnum(row["weaponDamageScaledToVehHealthMult"]), str(row["handlingResolved"]).lower(), explicit))
    weapon_lines = []
    for row in weapons:
        explicit = ", ".join(jstr(value) for value in sorted(set(row["explicit"])))
        weapon_lines.append(
            "        addWeapon(weapons, 0x%08xL, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, Set.of(%s));" % (
                row["hash"], jstr(row["name"]), jstr(row["fireType"]), jstr(row["damageType"]), jnum(row["baseDamage"]),
                jnum(row["damageTimeInVehicle"]), jnum(row["damageTimeInVehicleHeadShot"]), jnum(row["forceHitVehicle"]),
                jstr(row["ammoName"]), jnum(row["ammoDamage"]), jstr(row["ammoExplosion"]), jstr(row["weaponExplosion"]), explicit))
    native_lines = []
    names = {"mpEngineHealth": "mpEngineHealth", "mpBodyHealth": "mpBodyHealth", "mpSetEngineHealth": "mpSetEngineHealth", "mpSetBodyHealth": "mpSetBodyHealth"}
    for name in names:
        item = native[name]
        native_lines.append("        bindings.put(%s, new NativeBinding(%s, %d, List.of(%s), List.of(%s)));" % (
            jstr(name), jstr(name), item["index"], ", ".join(jstr(v) for v in item["parameters"]), ", ".join(jstr(v) for v in item["results"])))
    hash_lines = ",\n        ".join("Map.entry(%s, %s)" % (jstr(k), jstr(v)) for k, v in hashes.items())
    return f'''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Generated from the supported read-only GTA metadata. Missing source values
 * remain -1 and unresolved handling IDs remain explicit. This catalog contains
 * no inferred blast/tank formula and no explosion threshold.
 */
public final class VehicleDamageCatalog {{
    private VehicleDamageCatalog() {{}}
    public static final String ORIGINAL_WASM_SHA256 = {jstr(EXPECTED_WASM_SHA256)};
    public static final Map<String,String> SOURCE_HASHES = Map.ofEntries(
        {hash_lines});
    public record Rule(long hash, String model, String handling, String vehicleType, String vehicleClass,
        String layout, String explosionInfo, String coverBoundOffsets, double defaultBodyHealth,
        double damageMapScale, double damageOffsetScale, double weaponForceMult, double mass,
        double percentSubmerged, double collisionDamageMult, double weaponDamageMult,
        double deformationDamageMult, double engineDamageMult, double petrolTankVolume, double oilVolume,
        int damageFlags, double weaponDamageScaledToVehHealthMult, boolean handlingResolved,
        Set<String> explicitFields) {{
        public boolean hasBulletScale() {{ return handlingResolved && weaponDamageMult >= 0; }}
        public boolean hasBodyScale() {{ return handlingResolved && deformationDamageMult >= 0; }}
        public boolean hasEngineScale() {{ return handlingResolved && engineDamageMult >= 0; }}
        // The original records do not contain a universal blast/tank damage multiplier.
        public double blastDamageScale() {{ return -1.0; }}
        public double petrolTankDamageScale() {{ return -1.0; }}
        public boolean explosionThresholdKnown() {{ return false; }}
        public Map<String,Object> values() {{
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("model_hash", hash); value.put("model", model); value.put("handling", handling);
            value.put("vehicle_type", vehicleType); value.put("vehicle_class", vehicleClass);
            value.put("layout", layout); value.put("explosion_info", explosionInfo);
            value.put("default_body_health", defaultBodyHealth); value.put("damage_map_scale", damageMapScale);
            value.put("damage_offset_scale", damageOffsetScale); value.put("weapon_force_mult", weaponForceMult);
            value.put("mass", mass); value.put("collision_damage_mult", collisionDamageMult);
            value.put("weapon_damage_mult", weaponDamageMult); value.put("deformation_damage_mult", deformationDamageMult);
            value.put("engine_damage_mult", engineDamageMult); value.put("petrol_tank_volume", petrolTankVolume);
            value.put("oil_volume", oilVolume); value.put("damage_flags", damageFlags);
            value.put("handling_resolved", handlingResolved); value.put("blast_damage_scale", -1.0);
            value.put("petrol_tank_damage_scale", -1.0); value.put("explosion_threshold_known", false);
            value.put("source_fields", explicitFields); return Collections.unmodifiableMap(value);
        }}
    }}
    public record WeaponImpact(long hash, String name, String fireType, String damageType, double baseDamage,
        double damageTimeInVehicle, double damageTimeInVehicleHeadShot, double forceHitVehicle,
        String ammoName, double ammoDamage, String ammoExplosion, String weaponExplosion,
        Set<String> explicitFields) {{
        // ForceHitVehicle is an impulse field, not a health-damage amount.
        public boolean hasVehicleHealthDamage() {{ return false; }}
    }}
    public record HealthDomain(double min, double max, String evidence, String semantics) {{}}
    public record NativeBinding(String exportName, int functionIndex, List<String> parameters, List<String> results) {{}}
    private static final Map<Long,Rule> VEHICLES = createVehicles();
    private static final Map<Long,WeaponImpact> WEAPONS = createWeapons();
    private static final Map<String,HealthDomain> HEALTH = Map.of(
        "engine", new HealthDomain(-4000.0, 1000.0, "health_state_bounds", "destruction semantics unverified"),
        "body", new HealthDomain(0.0, 1000.0, "health_state_bounds", "zero does not universally imply explosion"),
        "petrol_tank", new HealthDomain(-999.90002441406, 1000.0, "health_state_bounds", "damage and fire semantics unverified"));
    private static final Map<String,NativeBinding> NATIVE = createNative();
    private static Map<Long,Rule> createVehicles() {{
        Map<Long,Rule> vehicles = new LinkedHashMap<>();
{chr(10).join(vehicle_lines)}
        return Collections.unmodifiableMap(vehicles);
    }}
    private static void add(Map<Long,Rule> values, long hash, String model, String handling, String type, String vehicleClass,
        String layout, String explosionInfo, String coverBoundOffsets, double defaultBodyHealth, double damageMapScale,
        double damageOffsetScale, double weaponForceMult, double mass, double percentSubmerged, double collisionDamageMult,
        double weaponDamageMult, double deformationDamageMult, double engineDamageMult, double petrolTankVolume,
        double oilVolume, int damageFlags, double weaponDamageScaledToVehHealthMult, boolean handlingResolved,
        Set<String> explicitFields) {{
        if (values.put(hash, new Rule(hash, model, handling, type, vehicleClass, layout, explosionInfo, coverBoundOffsets,
            defaultBodyHealth, damageMapScale, damageOffsetScale, weaponForceMult, mass, percentSubmerged,
            collisionDamageMult, weaponDamageMult, deformationDamageMult, engineDamageMult, petrolTankVolume, oilVolume,
            damageFlags, weaponDamageScaledToVehHealthMult, handlingResolved, explicitFields)) != null)
            throw new IllegalStateException("duplicate vehicle model hash");
    }}
    private static Map<Long,WeaponImpact> createWeapons() {{
        Map<Long,WeaponImpact> weapons = new LinkedHashMap<>();
{chr(10).join(weapon_lines)}
        return Collections.unmodifiableMap(weapons);
    }}
    private static void addWeapon(Map<Long,WeaponImpact> values, long hash, String name, String fireType, String damageType,
        double baseDamage, double damageTimeInVehicle, double damageTimeInVehicleHeadShot, double forceHitVehicle,
        String ammoName, double ammoDamage, String ammoExplosion, String weaponExplosion, Set<String> explicitFields) {{
        if (values.put(hash, new WeaponImpact(hash, name, fireType, damageType, baseDamage, damageTimeInVehicle,
            damageTimeInVehicleHeadShot, forceHitVehicle, ammoName, ammoDamage, ammoExplosion, weaponExplosion,
            explicitFields)) != null) throw new IllegalStateException("duplicate weapon hash");
    }}
    private static Map<String,NativeBinding> createNative() {{
        Map<String,NativeBinding> bindings = new LinkedHashMap<>();
{chr(10).join(native_lines)}
        return Collections.unmodifiableMap(bindings);
    }}
    public static Rule byModel(long hash) {{ return VEHICLES.get(hash & 0xffffffffL); }}
    public static Rule byModel(String model) {{ return VEHICLES.values().stream().filter(value -> value.model().equals(model)).findFirst().orElse(null); }}
    public static Map<Long,Rule> vehicles() {{ return VEHICLES; }}
    public static WeaponImpact weapon(long hash) {{ return WEAPONS.get(hash & 0xffffffffL); }}
    public static Map<Long,WeaponImpact> weapons() {{ return WEAPONS; }}
    public static Map<String,HealthDomain> healthDomains() {{ return HEALTH; }}
    public static Map<String,NativeBinding> nativeBindings() {{ return NATIVE; }}
    public static boolean hasVehicleDamageNative() {{ return false; }}
    public static boolean hasVehicleExplosionNative() {{ return false; }}
}}
'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify generated Java is current")
    args = parser.parse_args()
    from readonly_game_outputs import atomic_write_text, validate_output
    if not args.check:
        validate_output(OUTPUT, sources=SOURCES)
    expected = generate()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != expected:
            parser.error("VehicleDamageCatalog.java is stale; run tools/vehicle_damage_metadata.py")
    else:
        atomic_write_text(OUTPUT, expected, sources=SOURCES)
    rows, weapons, _ = parse_vehicle_sources()
    print(f"Vehicle damage catalog verified: {len(rows)} vehicle models, {len(weapons)} weapon definitions")


if __name__ == "__main__":
    main()
