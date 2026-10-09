#!/usr/bin/env python3
"""Export explicit local weapons.meta collision parameters without inventing defaults.

This catalog records source data; impact, penetration and material policy remain
server decisions. Missing numeric fields and infinite lifetime use -1; callers
can distinguish those cases through explicitFields.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from readonly_game_outputs import atomic_write_text, validate_output
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'gta5data/data/common/data/ai/weapons.meta'
OUTPUT = ROOT / 'server/src/main/java/offline/multiplayer/WeaponPhysics.java'


def joaat(text):
    value = 0
    for byte in text.lower().encode():
        value = (value + byte) & 0xffffffff
        value = (value + (value << 10)) & 0xffffffff
        value ^= value >> 6
    value = (value + (value << 3)) & 0xffffffff
    value ^= value >> 11
    return (value + (value << 15)) & 0xffffffff


def generate():
    raw = SOURCE.read_bytes()
    root = ET.fromstring(raw)
    ammo = {node.findtext('Name'): node for node in root.iter('Item')
            if node.get('type', '').startswith('CAmmo')}
    rows = []
    for weapon in root.iter('Item'):
        if weapon.get('type') != 'CWeaponInfo':
            continue
        name = weapon.findtext('Name')
        reference = weapon.find('AmmoInfo')
        ammo_name = reference.get('ref', '') if reference is not None else ''
        bullet = ammo.get(ammo_name)
        def text(node, key):
            return ' '.join((node.findtext(key) or '').split()) if node is not None else ''
        def number(node, key):
            child = node.find(key) if node is not None else None
            return float(child.get('value')) if child is not None and 'value' in child.attrib else -1.0
        def ms(node, key):
            value = number(node, key)
            return -1 if value < 0 else round(value * 1000)
        weapon_flags, projectile_flags = text(weapon, 'WeaponFlags'), text(bullet, 'ProjectileFlags')
        numeric_ammo = ['LaunchSpeed', 'GravityFactor', 'Damping', 'RicochetTolerance', 'PedRicochetTolerance',
                        'VehicleRicochetTolerance', 'FrictionMultiplier']
        numeric_weapon = ['Penetration', 'DamageTime', 'DamageTimeInVehicle', 'DamageTimeInVehicleHeadShot']
        lifetime_fields = ['LifeTime', 'LifeTimeAfterImpact', 'ExplosionTime']
        values = [json.dumps(name), json.dumps(ammo_name), json.dumps(bullet.get('type', '') if bullet is not None else '')]
        values += [str(number(bullet, field)) for field in numeric_ammo]
        values += [str(number(weapon, field)) for field in numeric_weapon]
        values += [str(ms(bullet, field)) + 'L' for field in lifetime_fields]
        values += [str('Sticky' in projectile_flags.split()).lower(), str('DestroyOnImpact' in projectile_flags.split()).lower(),
                   str('NonLethal' in weapon_flags.split()).lower()]
        values += [json.dumps(text(bullet, 'Explosion/Default')), json.dumps(text(bullet, 'AmmoFlags')),
                   json.dumps(projectile_flags), json.dumps(weapon_flags)]
        present = [field for field in numeric_ammo + lifetime_fields if bullet is not None and bullet.find(field) is not None]
        present += [field for field in numeric_weapon if weapon.find(field) is not None]
        values.append('Set.of(' + ', '.join(json.dumps(field) for field in present) + ')')
        rows.append('        rules.put(%dL, new Physics(%s));' % (joaat(name), ', '.join(values)))
    return '''package offline.multiplayer;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Explicit XML parameters only; missing numbers are -1, never guessed engine defaults. */
public final class WeaponPhysics {
    public static final String SOURCE_SHA256 = "%s";
    public record Physics(String name, String ammoName, String ammoType,
            double speed, double gravity, double damping, double ricochet, double pedRicochet,
            double vehicleRicochet, double friction, double penetration, double damageTime,
            double damageTimeInVehicle, double damageTimeInVehicleHeadShot,
            long lifetimeMs, long impactDelayMs, long explosionTimeMs,
            boolean sticky, boolean destroyOnImpact, boolean nonLethal,
            String explosion, String ammoFlags, String projectileFlags, String weaponFlags,
            Set<String> explicitFields) {}
    private static final Map<Long, Physics> RULES;
    static {
        var rules = new LinkedHashMap<Long, Physics>();
%s
        RULES = Map.copyOf(rules);
    }
    public static Physics byHash(long hash) { return RULES.get(hash & 0xffffffffL); }
    public static Map<Long, Physics> all() { return RULES; }
    private WeaponPhysics() {}
}
''' % (hashlib.sha256(raw).hexdigest(), '\n'.join(rows))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.check:
        validate_output(OUTPUT, sources=(SOURCE,))
    expected = generate()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text() != expected:
            parser.error('WeaponPhysics.java is stale; run tools/generate_weapon_physics.py')
    else:
        atomic_write_text(OUTPUT, expected, sources=(SOURCE,))
    print('WeaponPhysics.java: explicit source parameters verified')


if __name__ == '__main__':
    main()
