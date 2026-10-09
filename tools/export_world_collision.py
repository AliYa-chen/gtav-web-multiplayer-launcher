#!/usr/bin/env python3
"""Read this snapshot's RPF/YBN resources into server-owned static triangles.

The AES material is located in the user's matching local engine, never copied
into source or output. Requires the already installed PyCryptodome and libzstd
or zstd executable. No download, game execution or game-resource mutation.
"""
from __future__ import annotations

import argparse
from collections import Counter
import ctypes
import ctypes.util
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess

from inspect_native_bridge import DEFAULT_WASM, ROOT, WasmAudit
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

EXPECTED_ENGINE_SHA256 = "11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0"
IDENTITY = (1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0.)
MAGIC = b"GTACOL1\n"


def initial_memory(audit: WasmAudit) -> bytearray:
    """Reconstruct passive data placements, without instantiating the module."""
    reader = audit.section(11)
    segments = []
    for _ in range(reader.leb()):
        if reader.leb() != 1:
            raise ValueError("Expected snapshot passive data segments")
        segments.append(reader.take(reader.leb()))
    index = next(i for i, name in audit.names.items() if name == "__wasm_init_memory")
    decoded = audit.instructions(index)
    if not decoded["decode_complete"]:
        raise ValueError("Incomplete memory initializer decoding")
    instructions = decoded["instructions"]
    placements = []
    for i, instruction in enumerate(instructions):
        if instruction.get("sub_opcode") == 8 and instruction["operation"] == "opcode_fc":
            operands = instructions[i-3:i]
            if len(operands) != 3 or any(item["operation"] not in ("i32.const", "i64.const") for item in operands):
                raise ValueError("Nonconstant passive data placement")
            destination, source, size = (item["value"] for item in operands)
            segment, memory = instruction["indices"]
            if memory or min(destination, source, size) < 0 or destination + size > 64*1024*1024:
                raise ValueError("Invalid passive data placement")
            if source + size > len(segments[segment]):
                raise ValueError("Passive placement exceeds data segment")
            placements.append((destination, segments[segment][source:source+size]))
    result = bytearray(max(destination + len(data) for destination, data in placements))
    for destination, data in placements:
        result[destination:destination+len(data)] = data
    return result


def decrypt_blocks(data: bytes, key: bytes) -> bytes:
    from Crypto.Cipher import AES
    end = len(data) // 16 * 16
    return AES.new(key, AES.MODE_ECB).decrypt(data[:end]) + data[end:]


def rpf_header(path: Path) -> tuple[int, int, int]:
    with path.open("rb") as stream:
        header = stream.read(16)
    if len(header) != 16:
        raise ValueError(f"Truncated archive header: {path}")
    magic, count, names, encryption = struct.unpack("<4I", header)
    # This snapshot uses the high nibble of names length for archive flags.
    names &= 0x0fffffff
    if magic != 0x52504637 or not 0 < count <= 100_000 or not 0 < names <= 32*1024*1024:
        raise ValueError(f"Unsupported archive header: {path}")
    if 16 + count*16 + names > path.stat().st_size:
        raise ValueError(f"Archive directory exceeds file: {path}")
    return count, names, encryption


def local_archive_key(audit: WasmAudit, sample: Path) -> bytes:
    """Find only key constants referenced by the audited local AES constructor."""
    if hashlib.sha256(audit.data).hexdigest() != EXPECTED_ENGINE_SHA256:
        raise ValueError("Unsupported engine build; audit offsets before exporting")
    memory = initial_memory(audit)
    index = next(i for i, name in audit.names.items() if name == "rage::AES::AES(unsigned int)")
    count, names_size, encryption = rpf_header(sample)
    if encryption != 0x0ffffff9:
        raise ValueError("Expected AES snapshot archive")
    with sample.open("rb") as stream:
        stream.seek(16)
        encrypted_entries = stream.read(count*16)
        encrypted_names = stream.read(names_size)
    candidates = {instruction["value"] for instruction in audit.instructions(index)["instructions"]
                  if instruction["operation"] == "i64.const" and 0 <= instruction["value"] <= len(memory)-32}
    for address in sorted(candidates):
        key = bytes(memory[address:address+32])
        entries = decrypt_blocks(encrypted_entries, key)
        # Real RPF directory record, validated independently of printable names.
        if entries[:8] != b"\0\0\0\0\0\xff\xff\x7f":
            continue
        names = decrypt_blocks(encrypted_names, key)
        printable = sum(byte == 0 or 32 <= byte < 127 for byte in names) / len(names)
        if names[:1] == b"\0" and b".ynd\0" in names and printable > .97:
            return key
    raise ValueError("Could not validate archive key from local engine")


def archive_entries(path: Path, key: bytes):
    count, names_size, encryption = rpf_header(path)
    with path.open("rb") as stream:
        stream.seek(16)
        entries, names = stream.read(count*16), stream.read(names_size)
    if encryption == 0x0ffffff9:
        entries, names = decrypt_blocks(entries, key), decrypt_blocks(names, key)
    elif encryption not in (0, 0x4e45504f):
        raise ValueError(f"Unsupported archive encryption: {path}")
    for index in range(count):
        record = entries[index*16:index*16+16]
        if struct.unpack_from("<I", record, 4)[0] == 0x7fffff00:
            continue
        name_offset = struct.unpack_from("<H", record)[0]
        name_end = names.find(b"\0", name_offset)
        if not 0 <= name_offset <= name_end < len(names):
            raise ValueError(f"Invalid archive filename: {path} entry {index}")
        name = names[name_offset:name_end].decode("utf-8", "strict")
        packed_offset = int.from_bytes(record[5:8], "little")
        size = int.from_bytes(record[2:5], "little")
        offset = (packed_offset & 0x7fffff)*512
        if offset + size > path.stat().st_size:
            raise ValueError(f"Archive entry exceeds file: {path} {name}")
        yield {"name": name, "offset": offset, "size": size,
               "resource": bool(packed_offset & 0x800000),
               "system_flags": struct.unpack_from("<I", record, 8)[0],
               "graphics_flags": struct.unpack_from("<I", record, 12)[0]}


class Zstd:
    def __init__(self):
        self.library = None
        self.executable = shutil.which("zstd")
        candidates = [ctypes.util.find_library("zstd")]
        if self.executable:
            candidates += [str(Path(self.executable).resolve().parents[1] / "lib/libzstd.dylib")]
        for path in candidates:
            if not path:
                continue
            try:
                library = ctypes.CDLL(path)
                library.ZSTD_getFrameContentSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
                library.ZSTD_getFrameContentSize.restype = ctypes.c_ulonglong
                library.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
                library.ZSTD_decompress.restype = ctypes.c_size_t
                library.ZSTD_isError.argtypes = [ctypes.c_size_t]
                library.ZSTD_isError.restype = ctypes.c_uint
                self.library = library
                break
            except OSError:
                continue
        if self.library is None and self.executable is None:
            raise ValueError("Install libzstd or zstd to read local snapshot resources")

    def decompress(self, compressed: bytes) -> bytes:
        if compressed[:4] != b"\x28\xb5\x2f\xfd":
            raise ValueError("Expected snapshot Zstandard resource frame")
        if self.library:
            source = ctypes.create_string_buffer(compressed)
            size = self.library.ZSTD_getFrameContentSize(source, len(compressed))
            if not 0 < size <= 128*1024*1024:
                raise ValueError("Unsupported or excessive decompressed resource size")
            target = ctypes.create_string_buffer(size)
            actual = self.library.ZSTD_decompress(target, size, source, len(compressed))
            if self.library.ZSTD_isError(actual) or actual != size:
                raise ValueError("Corrupt Zstandard resource")
            return target.raw
        result = subprocess.run([self.executable, "-d", "-c", "--quiet"], input=compressed,
                                capture_output=True, check=True)
        if len(result.stdout) > 128*1024*1024:
            raise ValueError("Excessive decompressed resource size")
        return result.stdout


def transform(matrix, point):
    return tuple(sum(matrix[col*4+row]*point[col] for col in range(3))+matrix[12+row] for row in range(3))


def compose(parent, child):
    result = [0.]*16
    for column in range(3):
        for row in range(3):
            result[column*4+row] = sum(parent[k*4+row]*child[column*4+k] for k in range(3))
    result[12:15] = transform(parent, child[12:15])
    return tuple(result)


def intersects(a, b):
    return all(a[i] <= b[i+3] and b[i] <= a[i+3] for i in range(3))


def points_bounds(points):
    return tuple(min(point[i] for point in points) for i in range(3)) + tuple(max(point[i] for point in points) for i in range(3))


class BoundReader:
    """Snapshot ABI confirmed by GetVertex/GetPolygonMaterialIndex in WASM."""
    def __init__(self, data: bytes):
        self.data = data
        self.unsupported = Counter()
        self.types = Counter()

    def unpack(self, fmt, offset):
        size = struct.calcsize(fmt)
        if offset < 0 or offset+size > len(self.data):
            raise ValueError("YBN field exceeds resource")
        return struct.unpack_from(fmt, self.data, offset)

    def pointer(self, offset, required=True):
        value, = self.unpack("<Q", offset)
        if value == 0 and not required:
            return None
        if value >> 28 != 5 or value & 0xffffffff00000000:
            raise ValueError("YBN pointer outside system resource")
        position = value & 0x0fffffff
        if position >= len(self.data):
            raise ValueError("YBN pointer exceeds resource")
        return position

    def bounds(self, offset=0):
        minimum, maximum = self.unpack("<3f", offset+48), self.unpack("<3f", offset+32)
        if any(not math.isfinite(value) or abs(value) > 100000 for value in minimum+maximum):
            raise ValueError("Nonfinite or excessive YBN bounds")
        if any(minimum[i] > maximum[i] for i in range(3)):
            raise ValueError("Inverted YBN bounds")
        return minimum+maximum

    def triangles(self, offset=0, matrix=IDENTITY, active=None):
        active = set() if active is None else active
        if offset in active or len(active) > 32:
            raise ValueError("YBN composite cycle or excessive depth")
        active.add(offset)
        kind, = self.unpack("<B", offset+16)
        self.types[kind] += 1
        if kind == 10:
            children, matrices = self.pointer(offset+112), self.pointer(offset+120)
            count, capacity = self.unpack("<HH", offset+160)
            if not 0 <= count <= capacity <= 65535:
                raise ValueError("Invalid composite child count")
            for index in range(count):
                child = self.pointer(children+index*8, required=False)
                if child is None:
                    continue
                local = self.unpack("<16f", matrices+index*64)
                if not all(math.isfinite(v) and abs(v) <= 100000 for v in local):
                    raise ValueError("Invalid composite transformation")
                yield from self.triangles(child, compose(matrix, local), active)
        elif kind in (4, 8):
            vertices_count, polygons_count = self.unpack("<II", offset+208)
            if vertices_count > 32768 or polygons_count > 1_000_000:
                raise ValueError("Unsupported geometry element counts")
            vertices, polygons = self.pointer(offset+176), self.pointer(offset+136)
            quantum, center = self.unpack("<3f", offset+144), self.unpack("<3f", offset+160)
            if not all(math.isfinite(v) for v in quantum+center) or any(v <= 0 for v in quantum):
                raise ValueError("Invalid geometry quantization")
            # Checked before iteration, including regions skipped by polygon type.
            self.unpack(f"<{vertices_count*3}h", vertices)
            self.unpack(f"<{polygons_count*16}s", polygons)
            material_pointer = self.pointer(offset+240)
            material_indices = self.pointer(offset+280)
            material_count, = self.unpack("<B", offset+288)
            if not material_count:
                raise ValueError("Geometry has no material table")
            self.unpack(f"<{material_count}Q", material_pointer)
            self.unpack(f"<{polygons_count}s", material_indices)
            for index in range(polygons_count):
                polygon = polygons+index*16
                polygon_type = self.data[polygon] & 7
                if polygon_type != 0:
                    self.unsupported[f"polygon_type_{polygon_type}"] += 1
                    continue
                indices = self.unpack("<3H", polygon+4)
                indices = tuple(vertex & 0x7fff for vertex in indices)
                if any(vertex >= vertices_count for vertex in indices):
                    raise ValueError("Triangle vertex exceeds geometry")
                triangle = []
                for vertex in indices:
                    packed = self.unpack("<3h", vertices+vertex*6)
                    point = tuple(packed[i]*quantum[i]+center[i] for i in range(3))
                    triangle.append(transform(matrix, point))
                mat_index = self.data[material_indices+index]
                if mat_index >= material_count:
                    raise ValueError("Polygon material exceeds table")
                packed_material, = self.unpack("<Q", material_pointer+mat_index*8)
                # The packed material ID stores native material index in low byte;
                # remaining bits include flags and must not be used as name hashes.
                yield tuple(triangle), packed_material & 0xff
        else:
            self.unsupported[f"bound_type_{kind}"] += 1
        active.remove(offset)


def export(args):
    data, wasm, output = Path(args.data), Path(args.wasm), Path(args.output)
    metadata_path = output.with_suffix(".meta.json")
    evidence_output = Path(args.evidence_output) if args.evidence_output else None
    # Check every output before inspecting the engine or publishing any part of
    # the export. A custom data directory is just as read-only as bundled data.
    archives = sorted(data.rglob("*.rpf"))
    protected_roots = [data]
    for root in (data, data.resolve()):
        if root.name == "data":
            protected_roots.append(root.parent)
    boundary = {"sources": (wasm, *archives), "protected_roots": protected_roots}
    validate_outputs((output, metadata_path, *((evidence_output,) if evidence_output else ())), **boundary)
    audit = WasmAudit(args.wasm)
    sample = data / "x64/levels/gta5/paths.rpf"
    key = local_archive_key(audit, sample)
    codec = Zstd()
    requested = tuple(args.bounds)
    if len(requested) != 6 or any(not math.isfinite(v) for v in requested) or any(requested[i] >= requested[i+3] for i in range(3)):
        raise ValueError("--bounds requires finite increasing min/max x,y,z")
    catalog_counts, type_counts, unsupported = Counter(), Counter(), Counter()
    sources, errors = [], []
    triangles = []
    seen = set()
    archive_count = 0
    for path in archives:
        relative = path.relative_to(data).as_posix()
        archive_count += 1
        entries = list(archive_entries(path, key))
        catalog_counts.update(Path(item["name"]).suffix.lower() for item in entries)
        if not relative.startswith(args.path_prefix):
            continue
        for item in entries:
            if not item["name"].endswith(".ybn") or not item["resource"]:
                continue
            with path.open("rb") as stream:
                stream.seek(item["offset"])
                compressed = stream.read(item["size"])
            try:
                decoded = codec.decompress(compressed[16:])
                reader = BoundReader(decoded)
                bounds = reader.bounds()
                if not intersects(bounds, requested):
                    continue
                count = 0
                source_triangles = []
                # Do not retain a partly decoded resource on parse failure.
                for triangle, material in reader.triangles():
                    if not intersects(points_bounds(triangle), requested):
                        continue
                    if any(not math.isfinite(v) or abs(v) > 100000 for point in triangle for v in point):
                        raise ValueError("Invalid world triangle")
                    packed = struct.pack(">9fi", *(v for point in triangle for v in point), material)
                    source_triangles.append(packed)
                for packed in source_triangles:
                    if packed not in seen:
                        seen.add(packed)
                        triangles.append(packed)
                        count += 1
                type_counts.update(reader.types)
                unsupported.update(reader.unsupported)
                sources.append({"archive": relative, "resource": item["name"], "offset": item["offset"],
                                "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                                "decoded_sha256": hashlib.sha256(decoded).hexdigest(), "decoded_bytes": len(decoded),
                                "world_bounds": bounds, "unique_triangles": count,
                                "unsupported": dict(reader.unsupported)})
            except (ValueError, struct.error, subprocess.CalledProcessError) as error:
                errors.append({"archive": relative, "resource": item["name"], "error": str(error)})
    binary = MAGIC + struct.pack(">6di", *requested, len(triangles)) + b"".join(triangles)
    metadata = {"schema": "GTACOL1", "engine_sha256": EXPECTED_ENGINE_SHA256,
                "archives_indexed": archive_count, "catalog_counts": dict(sorted(catalog_counts.items())),
                "path_prefix": args.path_prefix, "requested_bounds": requested,
                "coverage_complete": False, "completeness": "static_ybn_triangles_only",
                "material_encoding": "native packed material low-byte index, not a name hash",
                "triangle_count": len(triangles), "bound_types": dict(type_counts),
                "unsupported": dict(unsupported), "source_count": len(sources), "sources": sources,
                "errors": errors, "collision_sha256": hashlib.sha256(binary).hexdigest(),
                "limitations": ["No YDR/YFT embedded bounds or YMAP entity placement export.",
                                "No dynamic vehicles, doors, breakables or moving-object state.",
                                "Nontriangle primitives are reported and omitted, never replaced with AABBs.",
                                "All overlapping YBN variants are retained; streaming activation/LOD selection is not reproduced.",
                                "A triangle hit is static geometry evidence; a miss is not proof of clear line of sight.",
                                "Native material flags and composite include/type filters are not exported."]}
    if evidence_output:
        descriptors = []
        for index in (88, 1190, 16489, 16545, 16546, 16547, 43185, 67028):
            body = audit.body_evidence(index, False)
            descriptors.append({key: body[key] for key in ("function_index", "name", "signature", "body_bytes", "decode_complete")})
        evidence = {key: metadata[key] for key in ("schema", "engine_sha256", "archives_indexed", "catalog_counts",
                    "path_prefix", "requested_bounds", "coverage_complete", "completeness", "material_encoding",
                    "triangle_count", "bound_types", "unsupported", "source_count", "collision_sha256", "limitations")}
        evidence.update({"binary_bytes": len(binary), "resource_errors": len(errors),
                         "resource_error_counts": dict(Counter(item["error"] for item in errors)),
                         "native_abi": descriptors,
                         "source_sample": sources[:6], "source_manifest": str(metadata_path.relative_to(ROOT)) if metadata_path.is_relative_to(ROOT) else str(metadata_path),
                         "archive_name_length_mask": "0x0fffffff",
                         "dependency_provenance": "Existing local PyCryptodome plus existing system libzstd/zstd; nothing downloaded."})
    atomic_write_bytes(output, binary, **boundary)
    atomic_write_text(metadata_path, json.dumps(metadata, ensure_ascii=False, indent=2)+"\n", **boundary)
    if evidence_output:
        atomic_write_text(evidence_output, json.dumps(evidence, ensure_ascii=False, indent=2)+"\n", **boundary)
    print(json.dumps({key: metadata[key] for key in ("archives_indexed", "catalog_counts", "triangle_count", "source_count", "unsupported")}, ensure_ascii=False))
    print(json.dumps({"output": str(args.output), "metadata": str(metadata_path), "errors": len(errors), "coverage_complete": False}))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "gta5data/data")
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM)
    parser.add_argument("--output", type=Path, default=ROOT / "server/world-data/collision.bin")
    parser.add_argument("--bounds", type=float, nargs=6, default=[411, -1388, -100, 1011, -788, 300])
    parser.add_argument("--path-prefix", default="x64/levels/gta5/", help="Only decode YBN under this archive prefix; all directories are indexed")
    parser.add_argument("--evidence-output", type=Path, help="Write a compact, non-geometric audit report")
    args = parser.parse_args()
    try:
        export(args)
    except (ValueError, ImportError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
