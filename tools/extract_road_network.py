#!/usr/bin/env python3
"""Export the installed game's road graph, without bundling game data in Git.

The generated IPL is the effective source: unlike the authoring XML it includes
generated nodes and resolved defaults. XML is streamed for a separate audit.
This is a vehicle centreline graph, not collision geometry or a ped navmesh.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import itertools
import json
import math
from pathlib import Path
import struct
import xml.etree.ElementTree as ET

from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"GTAROAD1"
NODE = struct.Struct(">fffIBBBBI")
LINK = struct.Struct(">iifHHI")
FLAGS = {
    "Disabled": (3, 1), "Water": (4, 2), "Highway": (10, 4),
    "NoGps": (11, 8), "Tunnel": (12, 16), "Off Road": (16, 32),
    "Cannot Go Left": (14, 64), "Left Turns Only": (15, 128),
    "Cannot Go Right": (17, 256), "No Big Vehicles": (18, 512),
    "Indicate Keep Left": (19, 1024), "Indicate Keep Right": (20, 2048),
    "Slip Lane": (21, 4096),
}
LINK_FLAGS = {"Narrowroad": 1, "GpsBothWays": 2, "Block If No Lanes": 4,
              "Shortcut": 8, "Dont Use For Navigation": 16}


def sha256(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.digest()


def load_ipl(path: Path):
    nodes, links = [], []
    section = None
    with path.open(encoding="latin-1") as stream:
        for number, raw in enumerate(stream, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line == "end":
                section = None
            elif section is None:
                section = line
            elif section == "vnod":
                fields = [float(value) for value in line.split(",")]
                if len(fields) != 22 or not all(math.isfinite(v) for v in fields):
                    raise ValueError(f"{path}:{number}: expected 22 finite vnod fields")
                if any(fields[index] != int(fields[index]) or fields[index] not in (0, 1)
                       for index, _ in FLAGS.values()):
                    raise ValueError(f"{path}:{number}: invalid node flags")
                if not (0 <= fields[6] <= 255 and 0 <= fields[7] <= 255
                        and fields[6] == int(fields[6]) and fields[7] == int(fields[7])
                        and 0 <= fields[8] <= 1 and 0 <= fields[9] <= 0xFFFFFFFF):
                    raise ValueError(f"{path}:{number}: invalid node attributes")
                nodes.append(fields)
            elif section == "link":
                fields = [int(value) for value in line.split(",")]
                if len(fields) != 6 or any(not 0 <= fields[i] <= 65535 for i in (3, 4)):
                    raise ValueError(f"{path}:{number}: invalid link fields")
                if not 0 <= fields[5] <= 31:
                    raise ValueError(f"{path}:{number}: unknown link flag bits")
                links.append(fields)
    if not nodes or not links:
        raise ValueError("empty road network")
    if any(not 0 <= endpoint < len(nodes) for link in links for endpoint in link[:2]):
        raise ValueError("road link references a missing node")
    return nodes, links


def audit_xml(path: Path, nodes, links):
    # IPL decimal formatting can move a point across a cell boundary. Search
    # adjacent cells, retaining only unambiguous matches within five mm.
    scale = 50
    cells = defaultdict(list)
    for index, node in enumerate(nodes):
        cells[tuple(math.floor(v * scale) for v in node[:3])].append(index)
    guid_map, xml_links = {}, []
    counts, mismatches = Counter(), Counter()
    link_map = defaultdict(list)
    for link in links:
        link_map[tuple(link[:2])].append(link)
    objects = None
    for event, element in ET.iterparse(path, events=("start", "end")):
        if event == "start":
            if element.tag == "objects":
                objects = element
            continue
        if element.tag != "object" or "guid" not in element.attrib:
            continue
        kind = element.get("class")
        counts[kind] += 1
        attrs = {a.get("name"): a.get("value") for a in element.findall("./attributes/attribute")}
        if kind == "vehiclenode":
            position = element.find("./transform/object/position")
            xyz = [float(position.get(axis)) for axis in "xyz"]
            cell = [math.floor(v * scale) for v in xyz]
            candidates = []
            for delta in itertools.product((-1, 0, 1), repeat=3):
                for index in cells.get(tuple(v + d for v, d in zip(cell, delta)), ()):
                    if max(abs(a - b) for a, b in zip(xyz, nodes[index])) <= .005:
                        candidates.append(index)
            if len(candidates) == 1:
                index = candidates[0]
                guid_map[element.get("guid")] = index
                counts["nodes_matched_to_ipl"] += 1
                for name, (column, _) in FLAGS.items():
                    if bool(nodes[index][column]) != (attrs.get(name) == "true"):
                        mismatches[name] += 1
                for name, column, default in (("Speed", 6, 1), ("Special", 7, 0)):
                    if nodes[index][column] != int(attrs.get(name, default)):
                        mismatches[name] += 1
            else:
                counts["nodes_ambiguous" if candidates else "nodes_without_ipl_match"] += 1
        elif kind == "vehiclelink":
            xml_links.append(([r.get("guid") for r in element.findall("./references/ref")], attrs))
        element.clear()
        if objects is not None:
            objects.remove(element)
    for references, attrs in xml_links:
        endpoints = tuple(guid_map.get(guid) for guid in references)
        candidates = link_map.get(endpoints, ())
        if len(candidates) != 1:
            counts["links_without_unique_ipl_match"] += 1
            continue
        counts["links_matched_to_ipl"] += 1
        link = candidates[0]
        for name, col, default in (("Lanes In", 3, 1), ("Lanes Out", 4, 1)):
            if link[col] != int(attrs.get(name, default)):
                mismatches[name] += 1
        for name, flag in LINK_FLAGS.items():
            if bool(link[5] & flag) != (attrs.get(name) == "true"):
                mismatches[name] += 1
    return {"sha256": sha256(path).hex(),
            "counts": dict(sorted(counts.items())), "attribute_mismatches": dict(sorted(mismatches.items())),
            "policy": "Use generated IPL values; authoring XML disagreements are reported, not silently substituted."}


def export(ipl: Path, output: Path, xml: Path | None = None):
    ipl, output = Path(ipl), Path(output)
    xml = Path(xml) if xml is not None else None
    sources = (ipl, *((xml,) if xml is not None else ()))
    # Standard resource paths identify external player game roots too. Loose
    # fixture inputs may share a directory with exports, but never a file.
    protected_roots = []
    for source in sources:
        for candidate in (source.absolute(), source.resolve()):
            if candidate.parts[-6:-1] == ("data", "common", "data", "levels", "gta5"):
                protected_roots.append(candidate.parents[5])
    boundary = {"sources": sources, "protected_roots": protected_roots}
    audit_path = output.with_suffix(".audit.json")
    validate_outputs((output, audit_path), **boundary)
    nodes, links = load_ipl(ipl)
    source_sha = sha256(ipl)
    records = [MAGIC + struct.pack(">II", len(nodes), len(links)) + source_sha]
    for node in nodes:
        flags = sum(bit for column, bit in FLAGS.values() if node[column])
        records.append(NODE.pack(*node[:3], flags, int(node[6]), int(node[7]),
                                 round(node[8] * 15), 0, int(node[9])))
    records.extend(LINK.pack(*link) for link in links)
    audit = {
        "format": MAGIC.decode(), "byte_order": "big_endian", "header_bytes": 48,
        "node_record_bytes": NODE.size, "link_record_bytes": LINK.size,
        "nodes": len(nodes), "links": len(links), "source_sha256": source_sha.hex(),
        "bounds": {key: [fn(node[axis] for node in nodes) for axis in range(3)]
                   for key, fn in (("min", min), ("max", max))},
        "node_flags": {name: bit for name, (_, bit) in FLAGS.items()},
        "node_flag_counts": {name: sum(bool(node[column]) for node in nodes)
                             for name, (column, _) in FLAGS.items()},
        "link_flags": LINK_FLAGS,
        "link_flag_counts": {name: sum(bool(link[5] & bit) for link in links)
                             for name, bit in LINK_FLAGS.items()},
        "lane_counts": {"two_way": sum(l[3] > 0 and l[4] > 0 for l in links),
                        "one_way": sum((l[3] > 0) != (l[4] > 0) for l in links),
                        "no_lanes": sum(l[3] == 0 and l[4] == 0 for l in links)},
        "limitations": ["vehicle centrelines, not a ped navmesh", "no collision geometry",
                        "node altitude is road reference altitude, not terrain height everywhere",
                        "lane direction requires native verification; default routing only uses two-way links"],
    }
    if xml is not None:
        audit["authoring_xml"] = audit_xml(xml, nodes, links)
    atomic_write_bytes(output, b"".join(records), **boundary)
    atomic_write_text(audit_path, json.dumps(audit, indent=2, ensure_ascii=False) + "\n", **boundary)
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paths-ipl", type=Path, default=ROOT / "gta5data/data/common/data/levels/gta5/paths.ipl")
    parser.add_argument("--paths-xml", type=Path, default=ROOT / "gta5data/data/common/data/levels/gta5/paths.xml")
    parser.add_argument("--output", type=Path, default=ROOT / "server/world-data/roads.bin")
    parser.add_argument("--skip-xml-audit", action="store_true")
    args = parser.parse_args()
    audit = export(args.paths_ipl, args.output, None if args.skip_xml_audit else args.paths_xml)
    print(json.dumps({"output": str(args.output), "nodes": audit["nodes"], "links": audit["links"],
                      "bounds": audit["bounds"], "authoring_xml": audit.get("authoring_xml")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
