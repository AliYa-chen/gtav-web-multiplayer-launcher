#!/usr/bin/env python3
"""Read pinned original human ragdoll primitives and model bone bindings.

Derived geometry stays outside the game directory and is not source code.
The supported engine selects its shared ragdoll from YFT byte 193, not the
model's movement capsule or gender. All input files are strictly read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

sys.dont_write_bytecode = True
from export_world_collision import BoundReader, EXPECTED_ENGINE_SHA256, Zstd, archive_entries, local_archive_key
from inspect_native_bridge import DEFAULT_WASM, ROOT, WasmAudit
from generate_weapon_catalog import joaat
from readonly_game_outputs import atomic_write_text, validate_outputs

INPUTS = {
    'x64/models/z_z_fred.yft': '88b90e3104464c947439c70764df617f9356ef4f048a3501368c4ab8a494f1b6',
    'x64/models/z_z_wilma.yft': 'f34630d7ae7a2b486dab37041070bca7a01b5c1b81dcea5b5c28604e46e9883a',
    'x64/models/cdimages/componentpeds_s_m_y.rpf': '9005f7177aefeee0d08bf44aebc4d7935de7c6458fa0900ff4202bc8623c6a52',
    'x64/models/cdimages/componentpeds_a_f_y.rpf': 'db7f8959efc15a91faf3c7ff1c6d230737a58b4c7c78e22435d6f9cdd98f1cf6',
    'x64/models/cdimages/componentpeds_a_m_y.rpf': 'f7a137a2863367ba093a485833b4ffb75f078aafab14ef0e69884f64128f008c',
    'x64/models/cdimages/streamedpeds_mp.rpf': '0d9b6f1200e684b4dbd6cac4f144e3c4686f8f7cacc9c727d91dc4e9fb5af34a',
    'x64/levels/gta5/paths.rpf': '0151931b69fe8b1d5f530086339fdeb7854c53dc9d8ced5377124fb88e7e3250',
}
MODELS = {
    's_m_y_cop_01': 'b453bde0058aebdb09c0bbe25a1323f6ceddea8435bcdbcfaf768d1bf1526c51',
    'a_f_y_beach_01': 'f9fc08dba652bf5d8f8e5af284f89ebe57cc5d1f874e013dfc1d7a89ae30873b',
    'a_f_y_business_01': '670369158a35c6925c8222d4075856591473b0388024d64f8c19e939854cc9b2',
    'a_f_y_topless_01': 'cece71858a44981f026fee292590cb57e1c36c7d2600fed04a75ed67bd022563',
    'a_f_y_hipster_01': '89f3fac4091bd836e2e2431b8ddbcbd0d75bad667af17f26507675c0f25220be',
    'a_m_y_beach_01': '4348bf0e7f2a6dd7ee3cae823ad9eaca565d6aaf8b53bed17b10e63a2bc4a649',
    'a_m_y_business_01': '6bb841ebb35472d869137cb3fbbffbf63c8285f62935cd4c113865a5a899f20b',
    'a_m_y_hipster_01': 'd7a37a7419f0592c4f27a814e37997747081fd3643439f47b3f4598243d1c131',
    'mp_f_freemode_01': '87efcf07125c3320adc1e8c071ca1d8346534331d229a19f5c48513e1e8a862a',
    'mp_m_freemode_01': '3ccaaa737c427e102c0e1e43b6ba067bf94699442b6c5864b190b0ac6c72f2c2',
}
NATIVE = {
    1907: 'rage::fiPackfile::GetEntryName(unsigned int) const',
    11964: 'rage::fragType::GetSkeletonData() const',
    16444: 'rage::phBoundCapsule::GetEndPointA() const',
    16445: 'rage::phBoundCapsule::GetEndPointB() const',
    16118: 'rage::phShapeProbe::TestBoundPrimitive(rage::phShapeProbe::LocalizedData const&, rage::phBound const&, unsigned int, unsigned int, rage::phShapeBase::PartialIntersection const&)',
    43145: 'fragInstNMGta::PoseBoundsFromSkeleton(bool, bool, bool, signed char, signed char const*)',
    45998: 'CPed::GetBoneIndexFromRagdollComponent(int) const',
    57514: 'ped_commands::CommandGetPedBoneCoords(int, int, rage::scrVector const&)',
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def numbers(values, limit=100):
    if any(not math.isfinite(x) or abs(x) > limit for x in values):
        raise ValueError('Invalid original character geometry')
    return list(values)


def matrix(reader, offset):
    # SIMD fourth lanes are padding, containing the original NaN sentinels.
    values = reader.unpack('<16f', offset)
    return numbers(tuple(values[i] for i in (0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14)))


def skeleton(reader):
    source = reader.pointer(reader.pointer(48) + 24)
    bones = reader.pointer(source + 32)
    count, = reader.unpack('<H', source + 94)
    if not 1 <= count <= 1024:
        raise ValueError('Unsupported character skeleton count')
    result = []
    for index in range(count):
        at = bones + index * 80
        parent, = reader.unpack('<h', at + 50)
        if not -1 <= parent < index:
            raise ValueError('Invalid character skeleton hierarchy')
        name_at = reader.pointer(at + 56)
        end = reader.data.find(b'\0', name_at, name_at + 128)
        if end < 0:
            raise ValueError('Invalid bone name')
        result.append({'tag': reader.unpack('<H', at + 68)[0], 'parent': parent,
                       'name': reader.data[name_at:end].decode('ascii'),
                       'translation': numbers(reader.unpack('<3f', at + 16))})
    if len({b['tag'] for b in result}) != count:
        raise ValueError('Duplicate original bone tag')
    return result


def ragdoll(reader, label):
    lod = reader.pointer(reader.pointer(240) + 16)
    root = reader.pointer(reader.pointer(lod + 216) + 32)
    if reader.unpack('<B', root + 16)[0] != 10:
        raise ValueError('Expected ragdoll composite')
    count, capacity = reader.unpack('<HH', root + 160)
    if count != 21 or capacity != count or reader.unpack('<B', lod + 286)[0] != count:
        raise ValueError('Ragdoll component coverage differs')
    bounds, fragments = reader.pointer(root + 112), reader.pointer(lod + 208)
    known = {b['tag']: b['name'] for b in skeleton(reader)}
    shapes = []
    for index in range(count):
        bound, child = reader.pointer(bounds + index * 8), reader.pointer(fragments + index * 8)
        tag, = reader.unpack('<H', child + 18)
        if tag not in known or reader.unpack('<H', child + 16)[0] != index:
            raise ValueError('Unresolved original ragdoll component bone')
        kind = reader.unpack('<B', bound + 16)[0]
        shape = {'component': index, 'tag': tag, 'bone_name': known[tag], 'kind': kind,
                 'local': matrix(reader, reader.pointer(child + 160) + 176),
                 'center': numbers(reader.unpack('<3f', bound + 64))}
        if kind == 1:
            radius, = reader.unpack('<f', bound + 44)
            half_length = reader.unpack('<f', bound + 20)[0] - radius
            if not 0 < radius < 1 or not 0 <= half_length < 1:
                raise ValueError('Invalid original ragdoll capsule')
            shape.update(radius=radius, half_length=half_length)
        elif kind == 3:
            box = reader.bounds(bound)
            shape['half_extents'] = numbers(tuple((box[i + 3] - box[i]) / 2 for i in range(3)))
            if any(x <= 0 for x in shape['half_extents']):
                raise ValueError('Invalid original ragdoll box')
        else:
            raise ValueError('Unsupported original ragdoll primitive')
        shapes.append(shape)
    if len({s['tag'] for s in shapes}) != count:
        raise ValueError('Duplicate component bone')
    return {'name': label, 'shapes': shapes}


def export(args):
    data, wasm = Path(args.data), Path(args.wasm)
    output = Path(args.output)
    report = Path(args.evidence_output) if args.evidence_output else output.with_suffix('.meta.json')
    sources = [wasm] + [data / name for name in INPUTS]
    roots = [data, data.resolve()]
    for root in tuple(roots):
        if root.name == 'data':
            roots.append(root.parent)
    boundary = {'sources': sources, 'protected_roots': roots}
    validate_outputs((output, report), **boundary)
    before = {str(path): sha(path) for path in sources}
    if before[str(wasm)] != EXPECTED_ENGINE_SHA256:
        raise ValueError('Unsupported original engine')
    for name, digest in INPUTS.items():
        if before[str(data / name)] != digest:
            raise ValueError('Unsupported original character source: ' + name)
    audit = WasmAudit(wasm)
    for index, name in NATIVE.items():
        if audit.names.get(index) != name:
            raise ValueError('Original character native ABI mismatch')
    shared = []
    for name in ('z_z_fred', 'z_z_wilma'):
        encoded = (data / ('x64/models/' + name + '.yft')).read_bytes()
        if encoded[:4] != b'RSC7':
            raise ValueError('Invalid original shared ragdoll resource')
        decoded = zlib.decompress(encoded[16:], -15)
        shared.append(ragdoll(BoundReader(decoded), name))
    key, codec = local_archive_key(audit, data / 'x64/levels/gta5/paths.rpf'), Zstd()
    records, seen = [], set()
    for archive_name in INPUTS:
        if '/cdimages/' not in archive_name:
            continue
        archive = data / archive_name
        for entry in archive_entries(archive, key):
            name = entry['name'].removesuffix('.yft')
            if name not in MODELS or not entry['name'].endswith('.yft'):
                continue
            if name in seen or not entry['resource']:
                raise ValueError('Ambiguous original character model')
            seen.add(name)
            with archive.open('rb') as stream:
                stream.seek(entry['offset'])
                encoded = stream.read(entry['size'])
            decoded = codec.decompress(encoded[16:])
            if hashlib.sha256(decoded).hexdigest() != MODELS[name]:
                raise ValueError('Unsupported original character model: ' + name)
            reader = BoundReader(decoded)
            # CPedModelInfo::InitMasterFragData uses signed byte 193 to select
            # the shared PhysicsLODGroup at global table base + index*24.
            group, = reader.unpack('<b', 193)
            if group not in (0, 1) or reader.pointer(240, False) is not None:
                raise ValueError('Unsupported character ragdoll binding')
            bones = skeleton(reader)
            required = {s['tag'] for s in shared[group]['shapes']}
            if not required.issubset({b['tag'] for b in bones}):
                raise ValueError('Missing original character component bone')
            edges = []
            for bone in bones:
                if bone['tag'] not in required:
                    continue
                distance, cursor = 0.0, bone
                while cursor['parent'] >= 0:
                    distance += math.dist((0, 0, 0), cursor['translation'])
                    cursor = bones[cursor['parent']]
                    if cursor['tag'] in required:
                        edges.append({'from': cursor['tag'], 'to': bone['tag'], 'length': distance})
                        break
            records.append({'model': joaat(name), 'name': name, 'source_sha256': MODELS[name],
                            'ragdoll': group, 'bone_count': len(bones), 'edges': edges})
    if seen != set(MODELS):
        raise ValueError('Incomplete supported character model coverage')
    value = {'version': 1, 'engine_sha256': EXPECTED_ENGINE_SHA256, 'sources': INPUTS,
             'ragdolls': shared, 'models': sorted(records, key=lambda r: r['model'])}
    result = json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n'
    evidence = {'version': 1, 'output_sha256': hashlib.sha256(result.encode()).hexdigest(),
                'engine_sha256': EXPECTED_ENGINE_SHA256, 'input_hashes': INPUTS,
                'native_abi': [{'index': i, 'name': n} for i, n in NATIVE.items()],
                'models': [{k: v for k, v in r.items() if k != 'edges'} for r in value['models']],
                'limitations': ['Animated world bone transforms are separately validated native observations.',
                                'No visual mesh, guessed hit zones or movement capsule dimensions are exported.',
                                'Derived geometry must not be committed or written into player resources.']}
    for path in sources:
        if sha(path) != before[str(path)]:
            raise ValueError('Original input changed during read')
    atomic_write_text(output, result, **boundary)
    atomic_write_text(report, json.dumps(evidence, indent=2) + '\n', **boundary)
    print(json.dumps({'models': len(records), 'ragdolls': len(shared), 'primitives': sum(len(r['shapes']) for r in shared),
                      'output_sha256': evidence['output_sha256']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', default=str(ROOT / 'gta5data/data'))
    parser.add_argument('--wasm', default=str(DEFAULT_WASM))
    parser.add_argument('--output', required=True)
    parser.add_argument('--evidence-output')
    export(parser.parse_args())


if __name__ == '__main__':
    main()
