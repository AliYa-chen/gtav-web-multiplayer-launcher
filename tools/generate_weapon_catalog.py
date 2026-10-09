#!/usr/bin/env python3
"""Freeze the local weapons.meta schema into the resource-free Java server.

Asset fields are evidence, not a complete implementation of GTA damage: melee,
blast radii/damage and compatibility values below are explicit server policies.
The binary explosion.ymt is deliberately not guessed or parsed as text.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from readonly_game_outputs import atomic_write_text, validate_output
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "gta5data/data/common/data/ai/weapons.meta"
OUTPUT = ROOT / "server/src/main/java/offline/multiplayer/WeaponCatalog.java"


def joaat(value):
    result = 0
    for byte in value.lower().encode():
        result = (result + byte) & 0xffffffff
        result = (result + (result << 10)) & 0xffffffff
        result ^= result >> 6
    result = (result + (result << 3)) & 0xffffffff
    result ^= result >> 11
    return (result + (result << 15)) & 0xffffffff


# Preserve already published damage and trigger cadence during this migration.
COMPATIBILITY = {}
for damage, cooldown, names in (
    (25, 200, "PISTOL COMBATPISTOL APPISTOL PISTOL50 SNSPISTOL"),
    (35, 100, "CARBINERIFLE ASSAULTRIFLE ADVANCEDRIFLE COMPACTRIFLE SMG MICROSMG ASSAULTSMG MG COMBATMG"),
    (50, 800, "PUMPSHOTGUN SAWNOFFSHOTGUN BULLPUPSHOTGUN ASSAULTSHOTGUN"),
    (100, 1000, "SNIPERRIFLE HEAVYSNIPER MARKSMANRIFLE"),
    (25, 20, "MINIGUN"),
):
    for name in names.split():
        COMPATIBILITY["WEAPON_" + name] = damage, cooldown


def generate():
    data = SOURCE.read_bytes()
    root = ET.fromstring(data)
    ammo = {x.findtext("Name"): x for x in root.iter("Item")
            if x.attrib.get("type", "").startswith("CAmmo")}
    weapons = {x.findtext("Name"): x for x in root.iter("Item") if x.attrib.get("type") == "CWeaponInfo"}
    rows = []
    for name, node in weapons.items():
        def value(key, default=0):
            element = node.find(key)
            return float(element.attrib.get("value", default)) if element is not None else default
        fire, kind = node.findtext("FireType"), node.findtext("DamageType")
        mode = {"MELEE": "melee", "INSTANT_HIT": "hitscan", "DELAYED_HIT": "hitscan",
                "PROJECTILE": "projectile", "VOLUMETRIC_PARTICLE": "utility", "NONE": "environment"}[fire]
        if fire == "NONE" and node.findtext("HumanNameHash") != "WT_INVALID":
            mode = "utility"
        pellets = int(value("BulletsInBatch", 1))
        if mode == "hitscan" and pellets > 1:
            mode = "shotgun"
        raw_damage = value("Damage")
        damage, cooldown = COMPATIBILITY.get(name, (round(raw_damage * pellets), max(50, round(value("TimeBetweenShots") * 1000))))
        if mode in ("utility", "environment", "melee"):
            damage = 0
        if mode == "melee":
            cooldown = 700
        radius, duration, interval = 0, 0, 0
        bullet = ammo.get(node.find("AmmoInfo").attrib.get("ref"))
        def ammo_value(key, default=0):
            element = bullet.find(key) if bullet is not None else None
            return float(element.attrib.get("value", default)) if element is not None else default
        speed = ammo_value("LaunchSpeed")
        gravity = ammo_value("GravityFactor")
        life = int(max(0, ammo_value("LifeTime")) * 1000)
        fuse = int(max(0, ammo_value("ExplosionTime")) * 1000)
        detonation = "impact"
        if mode == "projectile":
            cooldown = max(500, cooldown)
            life = min(30000, life or 15000)
            damage = max(damage, round(ammo_value("Damage")))
            if kind == "EXPLOSIVE":
                damage, radius = 150, 6
            if name == "WEAPON_STICKYBOMB":
                detonation, life = "remote", 120000
            elif name == "WEAPON_GRENADE":
                detonation, fuse = "timed", life
            elif kind == "SMOKE":
                detonation, fuse = "timed", fuse or life
                damage, radius, duration, interval = (10, 5, 8000, 1000) if name == "WEAPON_BZGAS" else (0, 0, 8000, 1000)
            elif kind == "FIRE":
                damage, radius, duration, interval = 20, 4, 8000, 1000
            if name == "WEAPON_BIRD_CRAP":
                damage, radius = 0, 0
        reach = min(1500, value("WeaponRange"))
        melee_damage = 20 if name == "WEAPON_UNARMED" else (45 if name == "WEAPON_KNIFE" else 35)
        if mode == "environment":
            melee_damage = 0
        melee_range = 2.0
        rows.append(f'        add(rules, 0x{joaat(name):08x}L, "{name}", "{mode}", {damage}, {cooldown}, {reach}, {pellets}, {value("BatchSpread")}, {speed}, {gravity}, {fuse}, {life}, "{detonation}", {radius}, {duration}, {interval}, {melee_damage}, {melee_range}, {raw_damage}, "{fire}", "{kind}");')
    for name, (damage, cooldown) in COMPATIBILITY.items():
        if name in weapons:
            continue
        rows.append(f'        add(rules, 0x{joaat(name):08x}L, "{name}", "hitscan", {damage}, {cooldown}, 120, 1, 0, 0, 0, 0, 0, "impact", 0, 0, 0, 35, 2, -1, "COMPATIBILITY", "BULLET");')
    template = '''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generated by tools/generate_weapon_catalog.py; do not edit the data rows.
 * weapons.meta SHA-256: @SHA@
 * Blast, melee and legacy damage values are published server gameplay policy.
 * No claim is made to reproduce the binary explosion.ymt or native collision.
 */
public final class WeaponCatalog {
    private WeaponCatalog() {}
    public static final String SOURCE_SHA256 = "@SHA@";
    public record Rule(long hash, String name, String mode, int damage, long cooldownMillis,
        double range, int pellets, double spread, double speed, double gravity,
        long fuseMillis, long lifetimeMillis, String detonation, double blastRadius,
        long effectDurationMillis, long effectIntervalMillis, int meleeDamage, double meleeRange,
        double assetDamage, String assetFireType, String damageType) {
        public boolean shootable() { return !"melee".equals(mode) && !"environment".equals(mode); }
        public boolean projectile() { return "projectile".equals(mode); }
        public Map<String,Object> publicRule() {
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("weapon",hash); value.put("name",name); value.put("mode",mode);
            value.put("damage",damage); value.put("cooldown_ms",cooldownMillis); value.put("range",range);
            value.put("pellets",pellets); value.put("spread",spread); value.put("speed",speed);
            value.put("gravity",gravity); value.put("fuse_ms",fuseMillis); value.put("lifetime_ms",lifetimeMillis);
            value.put("detonation",detonation); value.put("blast_radius",blastRadius);
            value.put("effect_duration_ms",effectDurationMillis); value.put("effect_interval_ms",effectIntervalMillis);
            value.put("melee_damage",meleeDamage); value.put("melee_range",meleeRange);
            value.put("asset_damage",assetDamage); value.put("asset_fire_type",assetFireType); value.put("damage_type",damageType);
            value.put("collision_model","server_trajectories_world_queries");
            return Collections.unmodifiableMap(value);
        }
    }
    private static final Map<Long,Rule> RULES = create();
    public static Rule rule(long hash) { return RULES.get(hash); }
    public static Map<Long,Rule> rules() { return RULES; }
    public static List<Map<String,Object>> publicRules() { return RULES.values().stream().map(Rule::publicRule).toList(); }
    private static void add(Map<Long,Rule> rules,long hash,String name,String mode,int damage,long cooldown,
        double range,int pellets,double spread,double speed,double gravity,long fuse,long lifetime,
        String detonation,double radius,long duration,long interval,int melee,double meleeRange,
        double assetDamage,String fire,String kind) {
        if(rules.put(hash,new Rule(hash,name,mode,damage,cooldown,range,pellets,spread,speed,gravity,fuse,
            lifetime,detonation,radius,duration,interval,melee,meleeRange,assetDamage,fire,kind))!=null)
            throw new IllegalStateException("Duplicate weapon hash");
    }
    private static Map<Long,Rule> create() {
        Map<Long,Rule> rules = new LinkedHashMap<>();
@ROWS@
        // The legacy bridge uses zero while an unarmed ped finishes loading.
        Rule unarmed = rules.get(0xa2719263L);
        rules.put(0L,new Rule(0L,"UNARMED_LOADING_ALIAS","melee",0,700,2,1,0,0,0,0,0,
            "impact",0,0,0,unarmed.meleeDamage(),unarmed.meleeRange(),0,"MELEE","MELEE"));
        return Collections.unmodifiableMap(rules);
    }
}
'''
    return template.replace("@SHA@", hashlib.sha256(data).hexdigest()).replace("@ROWS@", "\n".join(rows))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.check:
        validate_output(OUTPUT, sources=(SOURCE,))
    output = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != output:
            parser.exit(1, "WeaponCatalog.java differs from weapons.meta; regenerate it.\n")
    else:
        atomic_write_text(OUTPUT, output, sources=(SOURCE,))
    print(f"Weapon catalog verified: {len(ET.parse(SOURCE).findall('.//Item[@type=\"CWeaponInfo\"]'))} local asset definitions")


if __name__ == "__main__":
    main()
