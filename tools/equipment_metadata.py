#!/usr/bin/env python3
"""Read original ammo, clip, pickup rewards and default reload animation lengths.

Only numeric metadata is published. Original RPF members remain in memory.
The supported WASM supplies its own archive key; keys and animation bytes are
never emitted. Reload lengths describe complete default third-person clips,
not the exact native animation-event frame that inserts a magazine.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

from export_world_collision import archive_entries, local_archive_key, Zstd, EXPECTED_ENGINE_SHA256
from inspect_native_bridge import WasmAudit, DEFAULT_WASM
from readonly_game_outputs import atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'gta5data/data'
OUTPUT = ROOT / 'server/src/main/java/offline/multiplayer/EquipmentCatalog.java'
PATHS = ('common/data/ai/weapons.meta', 'common/data/ai/weaponcomponents.meta',
         'common/data/ai/weaponanimations.meta', 'common/data/pickups.meta',
         'x64/anim/ingame/clip_weapons@.rpf', 'x64/levels/gta5/paths.rpf')
EXPECTED = dict(zip(PATHS, (
    'dac0a631e6ad69f52dc0a8f9e4966e51be6b76ebab5bc2262b2be1c3155ccd1b',
    '5ea6e48e570a6c2cdcc35b58803bf20a0e8694023adb28661513e98ec28fdedc',
    '918855304a06ecb039a3eb5e9188c8968b53c1f4216be757805e42cb3138fc8a',
    'e9f78878974b61dd4d947fcaa9277abd0c4f949ea1d4ca7c62adc0992b918d9a',
    '2fbdac345f4e9c7cd4aa10ecd7a367fe9d149f6904ad092369071ae9bdc70533',
    '0151931b69fe8b1d5f530086339fdeb7854c53dc9d8ced5377124fb88e7e3250')))


def joaat(text):
    value = 0
    for byte in text.lower().encode():
        value = (value + byte) & 0xffffffff
        value = (value + (value << 10)) & 0xffffffff
        value ^= value >> 6
    value = (value + (value << 3)) & 0xffffffff
    value ^= value >> 11
    return (value + (value << 15)) & 0xffffffff


def number(node, key, default=-1):
    child = node.find(key) if node is not None else None
    if child is None:
        return default
    value = float(child.get('value'))
    if not math.isfinite(value):
        raise ValueError('Invalid original number: ' + key)
    return int(value) if value == int(value) else value


def reference(node, key):
    child = node.find(key) if node is not None else None
    return child.get('ref', '') if child is not None else ''


def clip_lengths(data):
    """Bounded RAGE 64-bit YCD clip map reader; validates every traversed pointer."""
    def get(fmt, off):
        size = struct.calcsize(fmt)
        if not 0 <= off <= len(data) - size:
            raise ValueError('YCD field outside resource')
        return struct.unpack_from(fmt, data, off)[0]
    def ptr(off, nullable=False):
        raw = get('<Q', off)
        if raw == 0 and nullable:
            return None
        if not 0x50000000 <= raw < 0x50000000 + len(data):
            raise ValueError('Unsupported YCD system pointer')
        return raw - 0x50000000
    capacity, count = get('<H', 48), get('<H', 50)
    if not 0 < capacity <= 8192 or count > 8192:
        raise ValueError('Invalid YCD clip map')
    table = ptr(40)
    visited, result = set(), {}
    for index in range(capacity):
        entry = ptr(table + 8 * index, True)
        while entry is not None:
            if entry in visited:
                raise ValueError('YCD clip map cycle or duplicate')
            visited.add(entry)
            clip = ptr(entry + 8)
            name_at = ptr(clip + 24)
            length = get('<H', clip + 32)
            if not 0 < length < 1024 or name_at + length >= len(data) or data[name_at+length] != 0:
                raise ValueError('Invalid YCD clip name')
            name = data[name_at:name_at+length].decode('utf-8').replace('\\', '/').split('/')[-1].split('.')[0].lower()
            if joaat(name) != get('<I', entry):
                raise ValueError('YCD clip name/hash mismatch: ' + name)
            kind = get('<I', clip + 16)
            if kind == 1:
                start, end, rate = (get('<f', clip + off) for off in (88, 92, 96))
                duration = (end - start) / rate if rate > 0 else -1
            elif kind == 2:
                duration = get('<f', clip + 96)
            else:
                raise ValueError('Unsupported YCD clip kind')
            if not math.isfinite(duration) or not 0 < duration <= 300:
                raise ValueError('Invalid YCD duration')
            result[name] = duration
            entry = ptr(entry + 16, True)
    if len(visited) != count:
        raise ValueError('YCD clip count mismatch')
    return result


def load(data_root=DATA, wasm=DEFAULT_WASM):
    sources = [data_root / p for p in PATHS] + [wasm]
    before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    if before[str(wasm)] != EXPECTED_ENGINE_SHA256:
        raise ValueError('Unsupported original engine version')
    for name,digest in EXPECTED.items():
        if before[str(data_root/name)] != digest:
            raise ValueError('Unsupported original equipment metadata: '+name)
    wroot, components, animations, pickups = (ET.parse(data_root / p).getroot() for p in PATHS[:4])
    weapons = {n.findtext('Name'): n for n in wroot.iter('Item') if n.get('type') == 'CWeaponInfo'}
    ammo_nodes = {n.findtext('Name'): n for n in wroot.iter('Item') if n.get('type', '').startswith('CAmmo')}
    parts = {n.findtext('Name'): n for n in components.iter('Item') if n.find('Name') is not None}
    sets = animations.find('./WeaponAnimationsSets/Item[@key="Default"]/WeaponAnimations')
    anims = {n.get('key'): n for n in sets}
    archive = data_root / PATHS[4]
    key = local_archive_key(WasmAudit(wasm), data_root / PATHS[5])
    entries = {e['name']: e for e in archive_entries(archive, key)}
    codec, cache = Zstd(), {}
    def clips(name):
        name = name.lower() + '.ycd'
        if name not in cache:
            e = entries.get(name)
            if e is None:
                cache[name] = {}
            else:
                with archive.open('rb') as stream:
                    stream.seek(e['offset'])
                    compressed = stream.read(e['size'])
                cache[name] = clip_lengths(codec.decompress(compressed[16:]))
        return cache[name]
    ammo = {name: {'name': name, 'hash': joaat(name), 'max_mp': number(n, 'AmmoMaxMP'),
                   'max50_mp': number(n, 'AmmoMax50MP'), 'max100_mp': number(n, 'AmmoMax100MP'),
                   'flags': (n.findtext('AmmoFlags') or '').split()}
            for name, n in ammo_nodes.items()}
    rows = []
    for name, w in weapons.items():
        flags = (w.findtext('WeaponFlags') or '').split()
        group = w.findtext('Group') or ''
        # Public-session loadout policy: real on-foot human weapons only.
        anim = anims.get(name)
        melee_set = (anim.findtext('MeleeClipSetHash') or '') if anim is not None else ''
        hand = ('UsableOnFoot' in flags and 'CarriedInHand' in flags and 'Vehicle' not in flags and anim is not None
                and not melee_set.startswith('creatures@') and w.findtext('HumanNameHash') != 'WT_INVALID'
                and group in ('GROUP_UNARMED','GROUP_MELEE','GROUP_PISTOL','GROUP_SMG','GROUP_RIFLE',
                              'GROUP_MG','GROUP_SHOTGUN','GROUP_SNIPER','GROUP_HEAVY','GROUP_THROWN','GROUP_PETROLCAN','GROUP_STUNGUN','GROUP_FIREEXTINGUISHER'))
        a = reference(w, 'AmmoInfo')
        clip_size = number(w, 'ClipSize')
        default_part = None
        for p in w.findall('AttachPoints/Item/Components/Item'):
            d = p.find('Default')
            part = parts.get(p.findtext('Name'))
            if d is not None and d.get('value') == 'true' and part is not None and part.get('type') == 'CWeaponComponentClipInfo':
                default_part = part
                break
        if default_part is not None and number(default_part,'ClipSize') >= 0:
            clip_size = number(default_part,'ClipSize')
        reload_data = parts.get(reference(default_part, 'ReloadData'))
        candidates = [] if anim is None else [anim.findtext(k) for k in ('WeaponClipSetStreamedHash','WeaponClipSetHash') if anim.findtext(k)]
        reload_clips = {}
        for empty, field in ((False,'PedIdleReloadClipId'),(True,'PedIdleReloadEmptyClipId')):
            clip_name = (reload_data.findtext(field) if reload_data is not None else 'RELOAD_AIM') or ''
            for candidate in candidates:
                duration = clips(candidate).get(clip_name.lower())
                if duration is None and reload_data is not None:
                    weapon_clip = reload_data.findtext(field.replace('Ped','Weapon')) or ''
                    duration = clips(candidate).get(weapon_clip.lower())
                    if duration is not None: clip_name = weapon_clip
                if duration is not None:
                    reload_clips['empty' if empty else 'normal'] = {'clipset': candidate.lower(), 'clip': clip_name.lower(),
                        'seconds': duration, 'ms': math.ceil(duration * 1000 / number(w,'AnimReloadRate'))}
                    break
        rows.append({'hash': joaat(name), 'name': name, 'ammo': a if a in ammo else '', 'clip_size': clip_size,
                     'on_foot': hand, 'thrown': 'Thrown' in flags, 'recharge': 'DisplayRechargeTimeHUD' in flags,
                     'animated_reload': 'AnimReload' in flags, 'reload_ms': reload_clips.get('normal',{}).get('ms',-1),
                     'reload_empty_ms': reload_clips.get('empty',{}).get('ms',-1),
                     'reload_source': reload_clips, 'reload_time_mp': number(w,'ReloadTimeMP'),
                     'bullets_per_loop': number(w,'BulletsPerAnimLoop'), 'flags': flags})
    rewards = {n.findtext('Name'): n for n in pickups.find('rewardData')}
    pickup_rows = []
    for n in pickups.find('pickupData'):
        grants, amounts, unsupported, armour = [], {}, [], 0
        for r in n.findall('Rewards/Item'):
            reward = rewards.get(r.text)
            if reward is None:
                unsupported.append(r.text)
            elif reward.get('type') == 'CPickupRewardWeapon' and reward.findtext('WeaponRef') in weapons:
                grants.append(joaat(reward.findtext('WeaponRef')))
            elif reward.get('type') == 'CPickupRewardAmmo' and reward.findtext('AmmoRef') in ammo:
                amount = number(reward,'Amount')
                if amount < 0: unsupported.append(r.text)
                else: amounts[reward.findtext('AmmoRef')] = amounts.get(reward.findtext('AmmoRef'),0)+amount
            elif reward.get('type') == 'CPickupRewardArmour':
                armour += number(reward,'Armour')
            elif reward.get('type') not in ('CPickupRewardStat',):
                unsupported.append(r.text)
        flags = (n.findtext('PickupFlags') or '').split()
        if (grants or amounts or armour>0) and not unsupported and 'CollectableOnFoot' in flags:
            pickup_rows.append({'hash':joaat(n.findtext('Name')), 'name':n.findtext('Name'), 'model':n.findtext('Model') or '',
                                'radius':number(n,'CollectionRadius'), 'regeneration_ms':math.ceil(number(n,'RegenerationTime')*1000),
                                'weapons':grants,'ammo':amounts,'armour':armour})
    for p in sources:
        if hashlib.sha256(p.read_bytes()).hexdigest() != before[str(p)]:
            raise ValueError('Original input changed while reading: '+str(p))
    return {'weapons':rows, 'ammo':list(ammo.values()), 'pickups':pickup_rows,
            'hashes':{p:before[str(data_root/p)] for p in PATHS}, 'engine_sha256':before[str(wasm)]}, sources


def generate(metadata):
    def quote(s): return json.dumps(s, ensure_ascii=True)
    weapon_rows = []
    for r in metadata['weapons']:
        weapon_rows.append('        weapons.put(%dL, new Weapon(%dL, %s, %s, %d, %s, %s, %s, %s, %dL, %dL, %d));' %
            (r['hash'],r['hash'],quote(r['name']),quote(r['ammo']),r['clip_size'],str(r['on_foot']).lower(),str(r['thrown']).lower(),
             str(r['recharge']).lower(),str(r['animated_reload']).lower(),r['reload_ms'],r['reload_empty_ms'],r['bullets_per_loop']))
    ammo_rows = ['        ammo.put(%s, new Ammo(%s, %dL, %d, %d, %d, %s));' % (quote(r['name']),quote(r['name']),r['hash'],r['max_mp'],r['max50_mp'],r['max100_mp'],str('InfiniteAmmo' in r['flags']).lower()) for r in metadata['ammo']]
    pickup_rows = []
    for r in metadata['pickups']:
        ws = 'List.of('+','.join(str(h)+'L' for h in r['weapons'])+')'
        am = 'Map.ofEntries('+','.join('Map.entry(%s,%d)'%(quote(k),v) for k,v in r['ammo'].items())+')'
        pickup_rows.append('        pickups.put(%dL, new Pickup(%dL, %s, %s, %s, %dL, %s, %s, %d));' %
                           (r['hash'],r['hash'],quote(r['name']),quote(r['model']),r['radius'],r['regeneration_ms'],ws,am,r['armour']))
    return '''package offline.multiplayer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Generated by tools/equipment_metadata.py. Numeric original metadata only.
 * Reload gates use complete default third-person animation clips, not native insertion events.
 * Public-session policy uses base AmmoMaxMP without unverified character-stat upgrades. */
public final class EquipmentCatalog {
    public static final String ENGINE_SHA256 = %s;
    public static final Map<String,String> SOURCE_HASHES = Map.ofEntries(%s);
    public record Ammo(String name,long hash,int maximum,int maximum50,int maximum100,boolean infinite) {}
    public record Weapon(long hash,String name,String ammo,int clipSize,boolean onFoot,boolean thrown,
            boolean recharge,boolean animatedReload,long reloadMillis,long emptyReloadMillis,int bulletsPerLoop) {}
    public record Pickup(long hash,String name,String model,double radius,long regenerationMillis,
            List<Long> weapons,Map<String,Integer> ammo,int armour) {}
    private static final Map<Long,Weapon> WEAPONS;
    private static final Map<String,Ammo> AMMO;
    private static final Map<Long,Pickup> PICKUPS;
    static {
        var weapons=new LinkedHashMap<Long,Weapon>();
%s
        var ammo=new LinkedHashMap<String,Ammo>();
%s
        var pickups=new LinkedHashMap<Long,Pickup>();
%s
        WEAPONS=Collections.unmodifiableMap(weapons); AMMO=Collections.unmodifiableMap(ammo); PICKUPS=Collections.unmodifiableMap(pickups);
    }
    public static Weapon weapon(long hash) { return WEAPONS.get(hash==0 ? 0xa2719263L : hash); }
    public static Ammo ammo(String name) { return AMMO.get(name); }
    public static Pickup pickup(long hash) { return PICKUPS.get(hash); }
    public static Map<Long,Weapon> weapons() { return WEAPONS; }
    public static Map<String,Ammo> ammunition() { return AMMO; }
    public static Map<Long,Pickup> pickups() { return PICKUPS; }
    private EquipmentCatalog() {}
}
''' % (quote(metadata['engine_sha256']),','.join('Map.entry(%s,%s)'%(quote(k),quote(v)) for k,v in metadata['hashes'].items()),
       '\n'.join(weapon_rows),'\n'.join(ammo_rows),'\n'.join(pickup_rows))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root',type=Path,default=DATA)
    parser.add_argument('--wasm',type=Path,default=DEFAULT_WASM)
    parser.add_argument('--output',type=Path,default=OUTPUT)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    sources=[args.data_root/p for p in PATHS]+[args.wasm]
    protected=(args.data_root,args.wasm.parent)
    outputs=([args.output] if not args.check else [])+([args.report] if args.report else [])
    validate_outputs(outputs,sources=sources,protected_roots=protected)
    metadata,sources=load(args.data_root,args.wasm)
    result=generate(metadata)
    if args.check:
        if args.output.read_text()!=result: parser.error('EquipmentCatalog.java is stale')
    else: atomic_write_text(args.output,result,sources=sources,protected_roots=protected)
    if args.report: atomic_write_text(args.report,json.dumps(metadata,indent=2)+'\n',sources=sources,protected_roots=protected)
    print('EquipmentCatalog: %d weapons, %d ammo pools, %d pickup definitions; original inputs unchanged' %
          (len(metadata['weapons']),len(metadata['ammo']),len(metadata['pickups'])))


if __name__=='__main__': main()
