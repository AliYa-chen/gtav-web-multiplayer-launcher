#!/usr/bin/env python3
"""Freeze the local weapons.meta schema into the resource-free Java server.

Direct damage and ordinary melee come from the original metadata. No legacy
weapon values or definitions absent from these resources are synthesized.
Explosion parameters are resolved by their original metadata tags. Runtime
bone, armour, stats and action-graph handling remain separate from this catalog.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from readonly_game_outputs import atomic_write_text, validate_output
from weapon_damage_metadata import SOURCES as DAMAGE_SOURCES, WEAPONS, exact_int, load, number as source_number
from explosion_metadata import SOURCE as EXPLOSION_SOURCE, load_explosions

ROOT = Path(__file__).resolve().parents[1]
SOURCE = WEAPONS
SOURCES = (*DAMAGE_SOURCES, EXPLOSION_SOURCE)
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


def generate():
    metadata = load()
    ammo, weapons = metadata.ammo, metadata.weapons
    explosions = load_explosions()
    rows = []
    for name, node in weapons.items():
        def value(key, default=0):
            return source_number(node, key, default)
        fire, kind = node.findtext("FireType"), node.findtext("DamageType")
        mode = {"MELEE": "melee", "INSTANT_HIT": "hitscan", "DELAYED_HIT": "hitscan",
                "PROJECTILE": "projectile", "VOLUMETRIC_PARTICLE": "utility", "NONE": "environment"}[fire]
        if fire == "NONE" and node.findtext("HumanNameHash") != "WT_INVALID":
            mode = "utility"
        pellets = exact_int(value("BulletsInBatch", -1), name + " pellets")
        if pellets < 1:
            raise ValueError(f"Invalid original pellet count for {name}")
        if mode == "hitscan" and pellets > 1:
            mode = "shotgun"
        raw_damage = value("Damage", -1)
        if raw_damage < 0:
            raise ValueError(f"Missing original damage for {name}")
        damage = exact_int(raw_damage * pellets, name) if mode in ("hitscan", "shotgun") else 0
        # Positive source cadence is preserved, including the 20ms minigun.
        # Zero denotes an animation-driven attack; these scheduling bounds do
        # not substitute for the original damage metadata.
        interval_ms = round(value("TimeBetweenShots") * 1000)
        cooldown = max(1, interval_ms) if interval_ms > 0 else 50
        if mode in ("utility", "environment", "melee"):
            damage = 0
        if mode == "melee":
            cooldown = 700
        radius, duration, interval = 0, 0, 0
        bullet = ammo.get(node.find("AmmoInfo").attrib.get("ref"))
        def ammo_value(key, default=0):
            return source_number(bullet, key, default)
        speed = ammo_value("LaunchSpeed")
        gravity = ammo_value("GravityFactor")
        life = int(max(0, ammo_value("LifeTime")) * 1000)
        fuse = int(max(0, ammo_value("ExplosionTime")) * 1000)
        detonation = "impact"
        if mode == "projectile":
            cooldown = max(500, cooldown)
            life = min(30000, life or 15000)
            # This supported resource defines direct projectile impact damage
            # on the ammo record; weapon Damage is zero for those projectiles.
            ammo_damage = ammo_value("Damage", -1)
            if raw_damage and ammo_damage != raw_damage:
                raise ValueError(f"Ambiguous original projectile damage for {name}")
            damage = exact_int(ammo_damage, name + " ammo")
            explosion_tag = bullet.findtext("Explosion/Default") if bullet is not None else None
            if explosion_tag and explosion_tag != "DONTCARE":
                explosion_key = explosion_tag if explosion_tag.startswith("EXP_TAG_") else "EXP_TAG_" + explosion_tag
                if explosion_key not in explosions:
                    raise ValueError(f"Missing original explosion type {explosion_tag} for {name}")
                explosion = explosions[explosion_key]
                radius = explosion["endRadius"]
                # phInstBehaviorExplosionGta::Reset reads directedLifeTime
                # even for spherical smoke. SMOKE/BZ store 25 seconds here;
                # continuous damage uses elapsed time, no invented tick size.
                duration = round(explosion["directedLifeTime"] * 1000)
                # A continuous coefficient is not a discrete blast amount.
                # Preserve it in ExplosionCatalog for elapsed exposure.
                if not explosion["bAppliesContinuousDamage"]:
                    damage = exact_int(explosion["damageAtCentre"], name + " explosion")
            if name == "WEAPON_STICKYBOMB":
                detonation, life = "remote", 120000
            elif name == "WEAPON_GRENADE":
                detonation, fuse = "timed", life
            elif kind == "SMOKE":
                detonation, fuse = "timed", fuse or life
        reach = min(1500, value("WeaponRange"))
        melee = metadata.melee.get(name)
        # 0 means no supported ordinary melee action, not zero native damage
        # for finishers, counters or other unrepresented action-graph phases.
        melee_damage = melee.damage if melee is not None else 0
        melee_range = 2.0
        rows.append(f'        add(rules, 0x{joaat(name):08x}L, "{name}", "{mode}", {damage}, {cooldown}, {reach}, {pellets}, {value("BatchSpread")}, {speed}, {gravity}, {fuse}, {life}, "{detonation}", {radius}, {duration}, {interval}, {melee_damage}, {melee_range}, {raw_damage}, "{fire}", "{kind}");')
    template = '''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generated by tools/generate_weapon_catalog.py; do not edit the data rows.
 * weapons.meta SHA-256: @SHA@
 * Hitscan damage is source damage per pellet multiplied by the pellet count.
 * Ordinary melee resolves weapon animations and action damage reactions.
 * No weapon absent from these original resources receives a guessed fallback.
 * Bone, armour, stats and unrepresented action phases are separate concerns.
 */
public final class WeaponCatalog {
    private WeaponCatalog() {}
    public static final String SOURCE_SHA256 = "@SHA@";
    public static final Map<String,String> SOURCE_HASHES = Map.ofEntries(
        @HASHES@);
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
        rules.put(0L,new Rule(0L,"UNARMED_LOADING_ALIAS",unarmed.mode(),unarmed.damage(),unarmed.cooldownMillis(),
            unarmed.range(),unarmed.pellets(),unarmed.spread(),unarmed.speed(),unarmed.gravity(),unarmed.fuseMillis(),
            unarmed.lifetimeMillis(),unarmed.detonation(),unarmed.blastRadius(),unarmed.effectDurationMillis(),
            unarmed.effectIntervalMillis(),unarmed.meleeDamage(),unarmed.meleeRange(),unarmed.assetDamage(),
            unarmed.assetFireType(),unarmed.damageType()));
        return Collections.unmodifiableMap(rules);
    }
}
'''
    source_hashes = dict(metadata.hashes)
    source_hashes["x64/data/metadata/explosion.ymt"] = hashlib.sha256(EXPLOSION_SOURCE.read_bytes()).hexdigest()
    hashes = ",\n        ".join("Map.entry(%s, %s)" % (json.dumps(name), json.dumps(digest))
                                  for name, digest in source_hashes.items())
    return (template.replace("@SHA@", metadata.hashes["common/data/ai/weapons.meta"])
            .replace("@HASHES@", hashes).replace("@ROWS@", "\n".join(rows)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.check:
        validate_output(OUTPUT, sources=SOURCES)
    output = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != output:
            parser.exit(1, "WeaponCatalog.java differs from weapons.meta; regenerate it.\n")
    else:
        atomic_write_text(OUTPUT, output, sources=SOURCES)
    print(f"Weapon catalog verified: {len(load().weapons)} original asset definitions")


if __name__ == "__main__":
    main()
