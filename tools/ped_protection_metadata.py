#!/usr/bin/env python3
"""Read pinned original head-prop protection flags; never write player resources.

The native content comparator orders these compatibility packs by setup.order.
CExtraMetaDataFileMounter appends their variation indices; InitPedData retains
that order and GetGlobalPropData sums earlier anchor counts. This is therefore
the supported engine's global drawable numbering, not a name-based guess.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zlib

sys.dont_write_bytecode = True
from export_ped_collision import INPUTS as PED_INPUTS, MODELS
from export_world_collision import EXPECTED_ENGINE_SHA256, Zstd, archive_entries, decrypt_blocks, initial_memory, local_archive_key
from generate_weapon_catalog import joaat
from inspect_native_bridge import ROOT, WasmAudit
from readonly_game_outputs import atomic_write_text, validate_outputs

GAME = ROOT / 'gta5data'
OUTPUT = ROOT / 'server/src/main/java/offline/multiplayer/PedProtectionCatalog.java'
INPUTS = {k: v for k, v in PED_INPUTS.items() if '/cdimages/' in k or k.endswith('/paths.rpf')}
INPUTS.update({
    'x64/dlcPacks/mpBeach/dlc.rpf': 'd6118a60ca82d0e50ae71dd90e4b00c943a61138f5abd43380af2c24ba71acfe',
    'x64/dlcPacks/mpChristmas/dlc.rpf': 'ce27c6e374bd5416d1d12bda051a0116a205b013256e298e80550865ef38853b',
    'x64/dlcPacks/mpValentines/dlc.rpf': '3068b6871575f15d817c8009c7e002ab6d1b1e17017626a400cfb725dad501f9',
    'x64/dlcPacks/mpBusiness/dlc.rpf': '8a2fc0de772bc30b8a47c6c86dbd3e2046e4c953d594ad691077110e2f75456c',
    'x64/dlcPacks/mpBusiness2/dlc.rpf': '375c16a0bf97389f8d9b02266010a058bfa15e55406a520448d6c9dec9c3cf89',
    'x64/dlcPacks/mpHipster/dlc.rpf': 'a3764068ddef5c048595bc9f8521bacda1b69143fd248959132b7da07a544c0b',
    'x64/dlcPacks/mpIndependence/dlc.rpf': '065147ed38fe8fc9811720a3d83335ce46ccddeb90239dad1efbc2b2900c98a7',
    'x64/dlcPacks/mpPilot/dlc.rpf': 'fc7d0e48ad1864e123edc80d60aff929f57f4f5f3fbaf87447753eb359c4688b',
    'x64/dlcPacks/mpLTS/dlc.rpf': 'c55788768a1d582beb3c8b2b4742eeb4dad781523f154b7ff9e394c6770b8207',
})
NATIVES = {
    30815: 'CPedDamageCalculator::ApplyDamageAndComputeResponse(CPed*, CPedDamageResponse&, rage::fwFlags<int> const&, unsigned int, float)',
    42628: 'CPedPropsMgr::GetGlobalPropData(CPed const*, eAnchorPoints, unsigned int, int)',
    46671: 'CExtraContentManager::LoadContent(bool, bool)',
    48180: 'CExtraMetaDataFileMounter::LoadDataFile(CDataFileMgr::DataFile const&)',
}


class Variation:
    def __init__(self, data):
        self.data = data
        if data[16:20] != b'0DRP':
            raise ValueError('Unsupported variation resource')
        self.blocks = []
        for i in range(self.u16(76)):
            at = self.ptr(48) + 16 * i
            self.blocks.append((self.u32(at), self.u32(at + 4), self.ptr(at + 8)))
        self.root = self.blocks[self.u32(28) - 1]
        if self.root[:2] != (0x16760659, 112):
            raise ValueError('Unsupported variation root')
        schemas = {}
        for i in range(self.u16(72)):
            at = self.ptr(32) + 32 * i
            fields = {}
            for j in range(self.u16(at + 30)):
                row = self.ptr(at + 16) + j * 16
                fields[self.u32(row)] = (self.u32(row + 4), data[row + 8])
            schemas[self.u32(at)] = (self.u32(at + 24), fields)
        expected = {
            0x16760659: (112, {2996560424: (4, 80), 3796409423: (16, 82), 592652859: (48, 82), 2337697442: (104, 74)}),
            0x6f419fc9: (48, {1741842546: (28, 21), 1613922652: (40, 100), 2114993291: (42, 19), 3509540765: (44, 17), 4196345791: (45, 17)}),
            0x5a2b494: (56, {1066841901: (44, 21), 1741842546: (48, 19), 2731224028: (50, 17), 3817142252: (51, 17)}),
        }
        for identity, (size, fields) in expected.items():
            found = schemas.get(identity)
            # Resources with no props or components can omit the unused schema.
            if found is not None and (found[0] != size or any(found[1].get(k) != v for k, v in fields.items())):
                raise ValueError('Variation schema field/type/offset mismatch')
        self.schemas = schemas

    def u16(self, at): return struct.unpack_from('<H', self.data, at)[0]
    def u32(self, at): return struct.unpack_from('<I', self.data, at)[0]
    def u64(self, at): return struct.unpack_from('<Q', self.data, at)[0]
    def ptr(self, at):
        value = self.u64(at)
        if value >> 28 != 5 or value & 0xfffffff >= len(self.data):
            raise ValueError('Invalid variation pointer')
        return value & 0xfffffff

    def array(self, at, identity, size):
        value, count = self.u64(at), self.u16(at + 8)
        if count != self.u16(at + 10):
            raise ValueError('Variation array capacity mismatch')
        if not count: return []
        if identity not in self.schemas or self.schemas[identity][0] != size:
            raise ValueError('Missing variation array schema')
        index, offset = (value & 4095) - 1, value >> 12
        if not 0 <= index < len(self.blocks):
            raise ValueError('Invalid variation typed block')
        kind, length, start = self.blocks[index]
        if kind != identity or offset + count * size > length or start + length > len(self.data):
            raise ValueError('Variation array exceeds typed block')
        return [start + offset + i * size for i in range(count)]

    def parse(self):
        root = self.root[2]
        # No supported source contains light-armour components or bulletproof
        # face components. Do not silently ignore a newly introduced rule.
        for at in self.array(root + 48, 0x6f419fc9, 48):
            flags = self.u32(at + 28) or self.u16(at + 42)
            if flags & 1024 or self.data[at + 44] == 1 and flags & 512:
                raise ValueError('New component protection requires native support')
        props = {}
        for at in self.array(root + 72, 0x5a2b494, 56):
            anchor, index = self.data[at + 50], self.data[at + 51]
            if anchor == 0:
                if index in props: raise ValueError('Duplicate head prop')
                props[index] = self.u32(at + 44) or self.u16(at + 48)
        count = max(props, default=-1) + 1
        if set(props) != set(range(count)): raise ValueError('Sparse head prop numbering')
        return self.u32(root + 104), count, props


def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def nested_entries(path, parent, key):
    with path.open('rb') as stream:
        stream.seek(parent['offset'])
        magic, count, names_size, encryption = struct.unpack('<4I', stream.read(16))
        shift, names_size = names_size >> 28 & 7, names_size & 0xfffffff
        if magic != 0x52504637 or count > 100000 or names_size > 16 * 1024 * 1024:
            raise ValueError('Unsupported nested archive')
        entries, names = stream.read(count * 16), stream.read(names_size)
    if encryption == 0xffffff9:
        entries, names = decrypt_blocks(entries, key), decrypt_blocks(names, key)
    elif encryption != 0x4e45504f:
        raise ValueError('Unsupported nested archive encryption')
    for i in range(count):
        record = entries[i * 16:i * 16 + 16]
        if struct.unpack_from('<I', record, 4)[0] == 0x7fffff00: continue
        name_at = struct.unpack_from('<H', record)[0] << shift
        name = names[name_at:names.index(0, name_at)].decode('ascii')
        offset = int.from_bytes(record[5:8], 'little')
        yield {'name': name, 'offset': parent['offset'] + (offset & 0x7fffff) * 512,
               'size': int.from_bytes(record[2:5], 'little'), 'resource': bool(offset & 0x800000)}


def load(game):
    engine, data = game / 'b/8b0b5899ed/game.wasm', game / 'data'
    before = {engine: digest(engine), **{data / k: digest(data / k) for k in INPUTS}}
    if before[engine] != EXPECTED_ENGINE_SHA256 or any(before[data / k] != v for k, v in INPUTS.items()):
        raise ValueError('Unsupported original protection inputs')
    audit = WasmAudit(engine)
    if any(audit.names.get(i) != name for i, name in NATIVES.items()):
        raise ValueError('Original protection native identity mismatch')
    memory = initial_memory(audit)
    # SSetupData order runtime+100, nested in CMountableContent at+56.
    # Native comparator sorts compatibility packs using that +156 field.
    if struct.unpack_from('<I', memory, 5335072 + 9 * 4)[0] != 100:
        raise ValueError('Native setup order field changed')
    if struct.unpack_from('<f', memory, 6955144)[0] != 2:
        raise ValueError('Native bulletproof hit threshold changed')
    key, codec = local_archive_key(audit, data / 'x64/levels/gta5/paths.rpf'), Zstd()
    models, packs = {}, []
    def read(path, entry):
        with path.open('rb') as stream:
            stream.seek(entry['offset']); return stream.read(entry['size'])
    def variation(path, entry):
        if not entry['resource']: raise ValueError('Variation is not a resource')
        return Variation(codec.decompress(read(path, entry)[16:])).parse()
    for suffix in INPUTS:
        path = data / suffix
        if '/cdimages/' in suffix:
            for entry in archive_entries(path, key):
                name = entry['name'].removesuffix('.ymt')
                if name in MODELS and entry['name'].endswith('.ymt'):
                    if name in models: raise ValueError('Duplicate base variation')
                    identity, count, flags = variation(path, entry)
                    if identity: raise ValueError('Base variation has DLC name')
                    models[name] = [count, flags]
        elif '/dlcPacks/' in suffix:
            entries = list(archive_entries(path, key))
            setup = next(e for e in entries if e['name'] == 'setup2.xml')
            encoded = read(path, setup)
            if setup['graphics_flags']: encoded = decrypt_blocks(encoded, key)
            tree = ET.fromstring(zlib.decompress(encoded, -15))
            if tree.findtext('type') != 'EXTRACONTENT_COMPAT_PACK':
                raise ValueError('Unexpected DLC type')
            order = int(tree.find('order').get('value'))
            nested_name = 'mpxmas.rpf' if path.parent.name == 'mpChristmas' else path.parent.name.lower() + '.rpf'
            nested = next(e for e in entries if e['name'] == nested_name)
            records = {}
            for entry in nested_entries(path, nested, key):
                for model in ('mp_m_freemode_01', 'mp_f_freemode_01'):
                    if entry['name'].startswith(model + '_') and entry['name'].endswith('.ymt'):
                        if model in records: raise ValueError('Ambiguous DLC variation')
                        records[model] = variation(path, entry)
            if len(records) != 2: raise ValueError('Missing DLC variation')
            packs.append((order, records))
    if set(models) != set(MODELS) or sorted(order for order, _ in packs) != list(range(9)):
        raise ValueError('Incomplete supported protection coverage')
    for _, records in sorted(packs):
        for model, (identity, count, flags) in records.items():
            if not identity: raise ValueError('DLC variation has no collection name')
            offset = models[model][0]
            models[model][1].update({offset + i: f for i, f in flags.items()})
            models[model][0] += count
    if any(digest(path) != value for path, value in before.items()):
        raise ValueError('Original input changed during read')
    return models


def generate(game):
    models = load(game)
    lines = []
    for name, (count, props) in sorted(models.items()):
        values = ', '.join(f'{index}, {flags}' for index, flags in props.items() if flags & 0x7200)
        lines.append(f'        rules.put({joaat(name)}L, Map.of({values})); // {name}: {count} original head props')
    return '''package offline.multiplayer;

import java.util.Map;
import java.util.LinkedHashMap;

/** Generated original flags; no meshes, textures or animation data. Supported
 * base/DLC sources have no lightly-armoured or bulletproof face components. */
final class PedProtectionCatalog {
    private PedProtectionCatalog() {}
    static final int BULLETPROOF_HITS = 2;
    private static final Map<Long,Map<Integer,Integer>> RULES = create();
    private static Map<Long,Map<Integer,Integer>> create() {
        Map<Long,Map<Integer,Integer>> rules = new LinkedHashMap<>();
''' + '\n'.join(lines) + '''
        return Map.copyOf(rules);
    }
    static int headFlags(long model,int drawable) {
        return RULES.getOrDefault(model,Map.of()).getOrDefault(drawable,0);
    }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-root', type=Path, default=GAME)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    boundary = {'sources': (args.game_root / 'b/8b0b5899ed/game.wasm', *(args.game_root / 'data' / p for p in INPUTS)),
                'protected_roots': (args.game_root,)}
    validate_outputs((args.output,), **boundary)
    result = generate(args.game_root)
    if args.check:
        if args.output.read_text() != result: parser.error('Protection catalog differs from original metadata')
    else: atomic_write_text(args.output, result, **boundary)
    print('Verified 10 base and 18 DLC variations, native order, flags and hit threshold')


if __name__ == '__main__': main()
