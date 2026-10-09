#!/usr/bin/env python3
"""Read local YNV polygons into a server-only pedestrian navigation mesh.

No game file is changed. Compressed vertices, split arrays and ordinary edge
adjacency follow the matching engine's CNavMesh functions. Special traversal
edges (jump/climb/drop), transformed dynamic meshes and unknown formats fail
closed rather than being replaced with road centrelines or straight paths.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
import struct

from export_world_collision import (EXPECTED_ENGINE_SHA256, Zstd, archive_entries,
                                    intersects, local_archive_key, points_bounds)
from inspect_native_bridge import DEFAULT_WASM, ROOT, WasmAudit
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

MAGIC = b"GTAPNAV1"
RECORD = struct.Struct(">iii9f3i")


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def triangulate(vertices):
    """Ear clipping keeps every emitted segment within a simple YNV polygon."""
    if len(vertices) < 3:
        raise ValueError("Nav polygon has fewer than three vertices")
    signed = sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(vertices, vertices[1:]+vertices[:1]))
    if abs(signed) < 1e-6:
        raise ValueError("Nav polygon has zero projected area")
    orientation = 1 if signed > 0 else -1
    remaining = list(range(len(vertices)))
    result = []
    while len(remaining) > 3:
        found = False
        for at, current in enumerate(remaining):
            before, after = remaining[at-1], remaining[(at+1) % len(remaining)]
            a, b, c = (vertices[i] for i in (before, current, after))
            if cross(a, b, c)*orientation <= 1e-7:
                continue
            # A nonadjacent vertex on the candidate diagonal also blocks the
            # ear: accepting it can cut directly across a concave wall corner.
            if any(all(cross(x, y, vertices[i])*orientation >= -1e-7
                       for x, y in ((a, b), (b, c), (c, a)))
                   for i in remaining if i not in (before, current, after)):
                continue
            result.append((before, current, after)); remaining.remove(current)
            found = True
            break
        if not found:
            raise ValueError("Nav polygon is not safely triangulable")
    if abs(cross(*(vertices[i] for i in remaining))) > 1e-7:
        result.append(tuple(remaining))
    if not result:
        raise ValueError("Nav polygon has no walkable triangles")
    triangle_area = sum(abs(cross(*(vertices[i] for i in triangle))) for triangle in result)
    if abs(triangle_area-abs(signed)) > max(1e-5, abs(signed)*1e-6):
        raise ValueError("Triangulation crosses the native polygon boundary")
    return result


@dataclass
class Polygon:
    area: int
    index: int
    flags: int
    vertices: list
    neighbors: list


class NavReader:
    """ABI audited against GetVertex, GetPolyCentroid and ObtainAdjacentPolys."""
    def __init__(self, data):
        self.data = data
        self.flags, = self.unpack("<I", 16)
        if not self.flags & 1 or self.flags & 4:
            raise ValueError("Only static compressed YNV meshes are supported")
        tree = self.pointer(288)
        self.minimum = self.unpack("<3f", tree)
        self.maximum = self.unpack("<3f", tree+16)
        self.bounds = self.minimum+self.maximum
        self.scale = self.unpack("<3f", 96)
        if not all(math.isfinite(v) and abs(v) <= 100000 for v in self.bounds+self.scale):
            raise ValueError("Invalid YNV bounds")
        if any(self.minimum[i] >= self.maximum[i]
               or abs(self.maximum[i]-self.minimum[i]-self.scale[i]) > .02 for i in range(3)):
            raise ValueError("YNV scale does not match sector bounds")
        self.area, = self.unpack("<I", 320)
        if not 0 <= self.area < 10000:
            raise ValueError("Dynamic or unsupported YNV area")

    def unpack(self, fmt, offset):
        if offset < 0 or offset+struct.calcsize(fmt) > len(self.data):
            raise ValueError("YNV field exceeds resource")
        return struct.unpack_from(fmt, self.data, offset)

    def pointer(self, offset):
        value, = self.unpack("<Q", offset)
        if value >> 28 != 5:
            raise ValueError("YNV pointer outside system resource")
        result = value & 0x0fffffff
        if result >= len(self.data):
            raise ValueError("YNV pointer exceeds resource")
        return result

    def split(self, field, expected, capacity, size):
        header = self.pointer(field)
        total, = self.unpack("<I", header+8)
        parts, = self.unpack("<I", header+32)
        if total != expected or total > 100000 or not 0 < parts <= 256:
            raise ValueError("Invalid YNV split-array count")
        entries = self.pointer(header+16)
        result = []
        for part in range(parts):
            start = self.pointer(entries+part*16)
            count, = self.unpack("<I", entries+part*16+8)
            if not 0 < count <= capacity or (part+1 < parts and count != capacity):
                raise ValueError("Invalid YNV split-array part")
            for index in range(count):
                offset = start+index*size
                self.unpack(f"<{size}s", offset)
                result.append(self.data[offset:offset+size])
        if len(result) != total:
            raise ValueError("YNV split-array total mismatch")
        return result

    def polygons(self):
        vertices_count, polygons_count = self.unpack("<II", 312)
        index_count, area_count = self.unpack("<II", 144)
        if not 0 < vertices_count <= 65535 or not 0 < polygons_count <= 32767 or not 0 < area_count <= 32:
            raise ValueError("Invalid YNV mesh counts")
        areas = self.unpack(f"<{area_count}I", 152)
        vertices = [tuple(self.minimum[i]+v*self.scale[i]/65536 for i, v in enumerate(struct.unpack("<3H", row)))
                    for row in self.split(112, vertices_count, 2730, 6)]
        indices = [struct.unpack("<H", row)[0] for row in self.split(128, index_count, 8192, 2)]
        edges = [struct.unpack("<II", row) for row in self.split(136, index_count, 2048, 8)]
        for index, raw in enumerate(self.split(280, polygons_count, 341, 48)):
            flags, start, area = struct.unpack_from("<IHH", raw)
            count = (flags >> 21) & 15
            if (area & 16383) != self.area or not 3 <= count <= 15 or start+count > len(indices):
                raise ValueError("Invalid YNV polygon references")
            if any(i >= len(vertices) for i in indices[start:start+count]):
                raise ValueError("Invalid YNV vertex index")
            points = [vertices[i] for i in indices[start:start+count]]
            limits = struct.unpack_from("<6h", raw, 24)
            # Native polygon bounds are quantized in quarter-metres. This
            # independently validates the recovered world origin and scale.
            for axis in range(3):
                if abs(min(p[axis] for p in points)-limits[axis*2]/4) > .26 or abs(max(p[axis] for p in points)-limits[axis*2+1]/4) > .26:
                    raise ValueError("Recovered YNV vertices disagree with polygon world bounds")
            neighbors = []
            for edge, _ in edges[start:start+count]:
                area_index = edge & 31
                if area_index >= len(areas):
                    raise ValueError("YNV edge references an absent area")
                # The native ordinary-adjacency path rejects these two bits.
                neighbors.append(None if edge & 0x300000 or areas[area_index] == 16383 else
                                 (areas[area_index], (edge >> 5) & 32767))
            yield Polygon(self.area, index, flags & 0x1fffff, points, neighbors)


def edge_key(a, b):
    return tuple(sorted((a, b)))


def build_mesh(polygons):
    triangles, lookup, omitted = [], defaultdict(list), Counter()
    for poly in polygons:
        try:
            pieces = triangulate(poly.vertices)
        except ValueError:
            omitted["unsafe_polygon"] += 1
            continue
        for indices in pieces:
            vertices = [poly.vertices[i] for i in indices]
            a, b, c = vertices
            normal = ((b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),
                      (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]), cross(a, b, c))
            if abs(normal[2]) < math.hypot(normal[0], normal[1]):
                omitted["slope_over_45_degrees"] += 1
                continue
            triangle = {"area": poly.area, "polygon": poly.index, "flags": poly.flags,
                        "vertices": vertices, "neighbors": [-1, -1, -1], "indices": indices, "source": poly}
            lookup[(poly.area, poly.index)].append(len(triangles)); triangles.append(triangle)
    # A polygon's own triangulation shares exact vertex records. Keep every
    # external edge tied to its native neighbor reference, not spatial proximity.
    internal = defaultdict(list)
    boundary = {}
    for at, triangle in enumerate(triangles):
        poly, indices = triangle["source"], triangle["indices"]
        for side in range(3):
            first, last = indices[side], indices[(side+1) % 3]
            key = edge_key(first, last)
            internal[(poly.area, poly.index, key)].append((at, side))
            for source_side in range(len(poly.vertices)):
                if key == edge_key(source_side, (source_side+1) % len(poly.vertices)):
                    boundary[(poly.area, poly.index, source_side)] = (at, side)
    for items in internal.values():
        if len(items) == 2:
            (a, sa), (b, sb) = items
            triangles[a]["neighbors"][sa] = b; triangles[b]["neighbors"][sb] = a
        elif len(items) > 2:
            raise ValueError("Nonmanifold internal navmesh edge")
    for poly in polygons:
        for source_side, target in enumerate(poly.neighbors):
            source = boundary.get((poly.area, poly.index, source_side))
            if source is None or target is None:
                continue
            a, sa = source
            start = triangles[a]["vertices"][sa]; end = triangles[a]["vertices"][(sa+1) % 3]
            candidates = []
            for b in lookup.get(target, ()):
                for sb in range(3):
                    v = triangles[b]["vertices"][sb]; w = triangles[b]["vertices"][(sb+1) % 3]
                    if min(max(math.dist(start,v), math.dist(end,w)), max(math.dist(start,w), math.dist(end,v))) <= .04:
                        candidates.append(b)
            if len(set(candidates)) == 1:
                triangles[a]["neighbors"][sa] = candidates[0]
            else:
                omitted["unresolved_or_nonmatching_portal"] += 1
    return triangles, omitted


def export(args):
    data, wasm, output = Path(args.data), Path(args.wasm), Path(args.output)
    metadata_path = output.with_suffix(".meta.json")
    archives = sorted(data.glob("x64/levels/gta5/navmeshes*.rpf"))
    sample = data / "x64/levels/gta5/paths.rpf"
    protected = [data, data.resolve()]
    if data.name == "data":
        protected.append(data.parent)
    # The matching engine may be selected from another supported installation.
    # Protect its full game root too, including a symlinked lexical input path.
    for candidate in (wasm.absolute(), wasm.resolve()):
        if candidate.name == "game.wasm" and candidate.parent.parent.name == "b":
            protected.append(candidate.parents[2])
        else:
            protected.append(candidate.parent)
    boundary = {"sources": (wasm, sample, *archives), "protected_roots": protected}
    validate_outputs((output, metadata_path), **boundary)
    bounds = tuple(args.bounds)
    if not all(math.isfinite(v) for v in bounds) or any(bounds[i] >= bounds[i+3] for i in range(3)):
        raise ValueError("Invalid navigation bounds")
    audit = WasmAudit(wasm); key = local_archive_key(audit, sample); codec = Zstd()
    polygons, sources, errors, seen = [], [], [], set()
    matched = 0
    for path in archives:
        for entry in archive_entries(path, key):
            match = re.fullmatch(r"navmesh\[(\d+)\]\[(\d+)\]\.ynv", entry["name"])
            if not match:
                continue
            matched += 1
            # Name grid is only a read optimisation; decoded world bounds and
            # every polygon's native bounds are checked independently below.
            x, y = (int(value)*50-6000 for value in match.groups())
            if x+150 < bounds[0] or x > bounds[3] or y+150 < bounds[1] or y > bounds[4]:
                continue
            try:
                with path.open("rb") as stream:
                    stream.seek(entry["offset"]); compressed = stream.read(entry["size"])
                decoded = codec.decompress(compressed[16:]); reader = NavReader(decoded)
                if not intersects(reader.bounds, bounds):
                    continue
                selected = []
                for polygon in reader.polygons():
                    if (polygon.area, polygon.index) in seen:
                        raise ValueError("Duplicate YNV area/poly identity")
                    if intersects(points_bounds(polygon.vertices), bounds):
                        seen.add((polygon.area, polygon.index)); selected.append(polygon)
                polygons.extend(selected)
                sources.append({"archive": path.relative_to(data).as_posix(), "resource": entry["name"],
                                "area": reader.area, "bounds": reader.bounds, "polygons": len(selected),
                                "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                                "decoded_sha256": hashlib.sha256(decoded).hexdigest()})
            except (ValueError, struct.error) as error:
                errors.append({"archive": path.relative_to(data).as_posix(), "resource": entry["name"], "error": str(error)})
    polygons.sort(key=lambda p: (p.area, p.index))
    triangles, omitted = build_mesh(polygons)
    if not triangles:
        raise ValueError("No verified pedestrian navigation polygons within bounds")
    records = [MAGIC, struct.pack(">6dI", *bounds, len(triangles))]
    for triangle in triangles:
        records.append(RECORD.pack(triangle["area"], triangle["polygon"], triangle["flags"],
                                  *(v for point in triangle["vertices"] for v in point), *triangle["neighbors"]))
    binary = b"".join(records)
    metadata = {"schema": MAGIC.decode(), "engine_sha256": EXPECTED_ENGINE_SHA256,
                "requested_bounds": bounds, "source_polygons": len(polygons), "navigation_triangles": len(triangles),
                "directed_links": sum(n >= 0 for triangle in triangles for n in triangle["neighbors"]),
                "source_count": len(sources), "indexed_static_meshes": matched, "sources": sources,
                "omitted": dict(omitted), "errors": errors, "sha256": hashlib.sha256(binary).hexdigest(),
                "native_abi_functions": [5964, 5969, 39991, 40027, 40033], "coverage_complete": False,
                "limitations": ["Static YNV ordinary adjacency only; dynamic area switches and moving-object meshes are not simulated.",
                                "Special jump, climb, drop, door and nonmatching boundary links are excluded.",
                                "Triangles steeper than 45 degrees are excluded; unknown surface flags are retained for audit.",
                                "Runtime temporary obstacles and traffic still require collision/avoidance handling.",
                                "Clipped export boundaries are not traversable; no road or direct-line fallback."]}
    atomic_write_bytes(output, binary, **boundary)
    atomic_write_text(metadata_path, json.dumps(metadata, indent=2, ensure_ascii=False)+"\n", **boundary)
    print(json.dumps({k: metadata[k] for k in ("source_count", "source_polygons", "navigation_triangles", "directed_links", "omitted", "errors", "sha256")}, ensure_ascii=False))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "gta5data/data")
    parser.add_argument("--wasm", type=Path, default=DEFAULT_WASM)
    parser.add_argument("--output", type=Path, default=ROOT / "server/world-data/ped-navigation.bin")
    parser.add_argument("--bounds", type=float, nargs=6, default=[411, -1388, -100, 1011, -788, 300])
    args = parser.parse_args()
    try:
        export(args)
    except (ValueError, ImportError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
