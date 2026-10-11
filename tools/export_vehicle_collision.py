#!/usr/bin/env python3
"""Read supported pristine YFT collision surfaces into server-owned data.

The game package and engine stay read-only. Unimplemented bound primitives
remain conservative blockers; their boxes never become damageable surfaces.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import sys

sys.dont_write_bytecode = True

from export_world_collision import (
    BoundReader, EXPECTED_ENGINE_SHA256, IDENTITY, Zstd, archive_entries,
    local_archive_key, points_bounds, transform,
)
from inspect_native_bridge import DEFAULT_WASM, ROOT, WasmAudit
from readonly_game_outputs import atomic_write_text, validate_outputs

ARCHIVE_SHA256 = "bb634dc7767b922e8cd9d340e22e567f2b164b4d5625aaea651c596c32366450"
MODELS = {
    "asea": (2485144969, "76251d1c9ce124740a6e3299b3c3dcb10121eb5de8b52503c5f63155cf94307d"),
    "blista": (3950024287, "6dc4ea9b4a0f589d00ef4a681b99229ba412b18a282edd59ef4747be64e14d7a"),
    "police": (2046537925, "5bc384776ac869c34eeb9b0f688f302dff8ee44901c05b5631260fc926bb0ce8"),
}
NATIVE_NAMES = {
    38627: "CBaseModelInfo::InitMasterFragData(unsigned int)",
    12021: "rage::fragPhysicsLODGroup::GetLODByIndex(int)",
    4622: "rage::fwArchetype::UpdateBoundingVolumes(rage::phBound const&)",
    67028: "rage::phBoundPolyhedron::GetVertex(int) const",
    16547: "rage::phBoundGeometry::GetPolygonMaterialIndex(int) const",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class VehicleBoundReader(BoundReader):
    def __init__(self, data: bytes):
        super().__init__(data)
        self.unknown_bounds = []
        self.matrix_count = 0

    def unpack(self, fmt, offset):
        values = super().unpack(fmt, offset)
        if fmt == "<16f":
            # Native Mat34V uses four 16-byte columns. The fourth lane is
            # padding/tag storage, including NaN sentinels in this snapshot.
            # transform()/compose() consume only the three XYZ lanes.
            values = list(values)
            for lane in (3, 7, 11, 15):
                values[lane] = 0.0
            self.matrix_count += 1
            return tuple(values)
        return values

    def triangles(self, offset=0, matrix=IDENTITY, active=None):
        kind, = self.unpack("<B", offset + 16)
        if kind not in (4, 8, 10):
            bounds = self.bounds(offset)
            corners = [transform(matrix, point) for point in itertools.product(
                *[(bounds[axis], bounds[axis + 3]) for axis in range(3)])]
            enclosing = points_bounds(corners)
            if any(not math.isfinite(v) or abs(v) > 100 for v in enclosing):
                raise ValueError("Vehicle primitive exceeds model-local limits")
            self.unknown_bounds.append({"kind": kind, "bounds": list(enclosing)})
        yield from super().triangles(offset, matrix, active)


def export(args):
    data, wasm, output = Path(args.data), Path(args.wasm), Path(args.output)
    report = Path(args.evidence_output) if args.evidence_output else output.with_suffix(".meta.json")
    archive = data / "x64/levels/gta5/vehicles.rpf"
    sample = data / "x64/levels/gta5/paths.rpf"
    protected = [data, data.resolve()]
    for candidate in tuple(protected):
        if candidate.name == "data":
            protected.append(candidate.parent)
    boundary = {"sources": (wasm, archive, sample), "protected_roots": protected}
    # Validate the complete output set before inspecting or publishing input.
    validate_outputs((output, report), **boundary)
    audit = WasmAudit(wasm)
    if hashlib.sha256(audit.data).hexdigest() != EXPECTED_ENGINE_SHA256:
        raise ValueError("Unsupported engine version for vehicle collision export")
    if sha256(archive) != ARCHIVE_SHA256:
        raise ValueError("Unsupported vehicle archive version")
    native = []
    for index, name in NATIVE_NAMES.items():
        if audit.names.get(index) != name:
            raise ValueError("Vehicle collision ABI symbol does not match supported engine")
        evidence = audit.body_evidence(index, False)
        if not evidence["decode_complete"]:
            raise ValueError("Incomplete vehicle collision ABI decoding")
        start, end = audit.bodies[index]
        native.append({"function_index": index, "name": name,
                       "signature": evidence["signature"],
                       "body_sha256": hashlib.sha256(audit.data[start:end]).hexdigest()})
    key, codec = local_archive_key(audit, sample), Zstd()
    entries = {item["name"]: item for item in archive_entries(archive, key)
               if item["name"] in {name + ".yft" for name in MODELS}}
    if set(entries) != {name + ".yft" for name in MODELS}:
        raise ValueError("Required supported vehicle resources are missing")
    models, sources = [], []
    for name, (model, expected) in MODELS.items():
        entry = entries[name + ".yft"]
        if not entry["resource"]:
            raise ValueError("Expected vehicle system resource")
        with archive.open("rb") as stream:
            stream.seek(entry["offset"])
            compressed = stream.read(entry["size"])
        decoded = codec.decompress(compressed[16:])
        digest = hashlib.sha256(decoded).hexdigest()
        if digest != expected:
            raise ValueError("Unsupported vehicle model version: " + name)
        reader = VehicleBoundReader(decoded)
        # Native InitMasterFragData: frag +240 physics group -> LOD 0 at
        # group +16 -> pristine archetype at LOD +216 -> bound at +32.
        group = reader.pointer(240)
        lod = reader.pointer(group + 16)
        archetype = reader.pointer(lod + 216)
        bound = reader.pointer(archetype + 32)
        triangles, degenerate = [], 0
        for vertices, material in reader.triangles(bound):
            flat = [value for point in vertices for value in point]
            if any(not math.isfinite(value) or abs(value) > 100 for value in flat):
                raise ValueError("Invalid vehicle triangle")
            a, b, c = vertices
            ab, ac = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            cross = [ab[1]*ac[2] - ab[2]*ac[1], ab[2]*ac[0] - ab[0]*ac[2],
                     ab[0]*ac[1] - ab[1]*ac[0]]
            if sum(value*value for value in cross) <= 1e-18:
                degenerate += 1
                continue
            triangles.append({"vertices": flat, "material": material})
        if not triangles or len(triangles) > 200_000:
            raise ValueError("Vehicle triangle count outside supported limits")
        record = {"model": model, "name": name, "source_sha256": digest,
                  "coverage_complete": not reader.unsupported,
                  "triangles": triangles, "unknown_bounds": reader.unknown_bounds}
        models.append(record)
        sources.append({"name": name, "resource": entry["name"], "model": model,
                        "archive_offset": entry["offset"], "compressed_bytes": entry["size"],
                        "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                        "source_sha256": digest, "decoded_bytes": len(decoded),
                        "bound_offset": bound, "model_bounds": reader.bounds(bound),
                        "triangle_count": len(triangles), "degenerate_triangles_omitted": degenerate,
                        "bound_types": dict(reader.types), "unsupported": dict(reader.unsupported),
                        "unknown_bound_count": len(reader.unknown_bounds),
                        "matrix_count": reader.matrix_count,
                        "coverage_complete": record["coverage_complete"]})
    value = {"version": 1, "engine_sha256": EXPECTED_ENGINE_SHA256,
             "source_sha256": ARCHIVE_SHA256, "models": models}
    binary_text = json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n"
    metadata = {"version": 1, "engine_sha256": EXPECTED_ENGINE_SHA256,
                "source_sha256": ARCHIVE_SHA256,
                "output_sha256": hashlib.sha256(binary_text.encode()).hexdigest(),
                "native_abi": native, "sources": sources,
                "limitations": [
                    "Pristine LOD-0 collision triangle surfaces only; no deformation, breakage or animation.",
                    "Native disc and box bounds are conservative uncertainty blockers, never damage surfaces.",
                    "No collision margin expansion or native material/include/type filtering is reconstructed.",
                    "A triangle contact is surface evidence; omitted or uncertain geometry is not clear-path evidence.",
                    "Derived geometry belongs to the server world-data directory and must not be committed.",
                ]}
    atomic_write_text(output, binary_text, **boundary)
    atomic_write_text(report, json.dumps(metadata, indent=2, allow_nan=False) + "\n", **boundary)
    print(json.dumps({"models": len(models), "triangles": sum(len(m["triangles"]) for m in models),
                      "unknown_bounds": sum(len(m["unknown_bounds"]) for m in models)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default=str(ROOT / "gta5data/data"))
    parser.add_argument("--wasm", default=str(DEFAULT_WASM))
    parser.add_argument("--output", required=True)
    parser.add_argument("--evidence-output")
    export(parser.parse_args())


if __name__ == "__main__":
    main()
