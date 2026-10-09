#!/usr/bin/env python3
"""Read actual local AI resources and WASM task ABIs; never instantiate the engine."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET

from inspect_native_bridge import WasmAudit

ROOT = Path(__file__).resolve().parents[1]


def inventory(root: Path, include_wasm: bool = True) -> dict:
    data = root / "gta5data/data"
    sources = {
        "scenarios": "common/data/ai/scenarios.meta",
        "triggers": "common/data/ai/scenariotriggers.meta",
        "perception": "common/data/pedperception.meta",
        "relationships": "common/data/relationships.dat",
        "dispatch": "common/data/dispatch.meta",
        "population": "common/data/levels/gta5/popcycle.dat",
        "model_sets": "common/data/ai/ambientpedmodelsets.meta",
    }
    files = {}
    raw = {}
    for name, relative in sources.items():
        content = (data / relative).read_bytes()
        raw[name] = content
        files[name] = {"path": relative, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    scenarios = ET.fromstring(raw["scenarios"])
    trigger_xml = ET.fromstring(raw["triggers"])
    triggers = []
    for index, item in enumerate(trigger_xml.findall("./Triggers/Item")):
        triggers.append({
            "index": index,
            "events": [element.text for element in item.iter("EventType")],
            "conditions": [element.get("type") for element in item.findall(".//Conditions/Item")],
            "action": item.find("Action").get("type") if item.find("Action") is not None else None,
            "probability": item.find("Probability").get("value") if item.find("Probability") is not None else None,
        })
    perceptions = []
    for item in ET.fromstring(raw["perception"]).findall("./aPedPerceptionInfoData/Item"):
        perceptions.append({child.tag: child.get("value", child.text) for child in item})
    dispatch = ET.fromstring(raw["dispatch"])
    scalar_dispatch = {child.tag: child.get("value") for child in dispatch if child.get("value") is not None}
    schedules = re.findall(r"(?m)^POP_SCHEDULE:\s*\n([^\r\n]+)", raw["population"].decode("utf-8-sig"))
    result = {
        "scope": "Static local-resource inventory; no script decryption, engine execution, navigation validation or gameplay verification.",
        "files": files,
        "scenarios": {
            "count": len(scenarios.findall("./Scenarios/Item")),
            "names": [item.findtext("Name") for item in scenarios.findall("./Scenarios/Item")],
            "groups": [{"tag": child.tag, "entries": len(child.findall("Item"))} for child in scenarios if child.tag != "Scenarios"],
        },
        "triggers": {
            "count": len(triggers),
            "event_counts": dict(sorted(Counter(event for trigger in triggers for event in trigger["events"]).items())),
            "action_counts": dict(sorted(Counter(trigger["action"] for trigger in triggers if trigger["action"]).items())),
            "rules": triggers,
        },
        "perception_profiles": perceptions,
        "population_schedules": {"count": len(schedules), "names": schedules,
                                 "timing": "Resource comments specify weekday/weekend schedules in two-hour increments."},
        "dispatch": {"scalars": scalar_dispatch,
                     "response_types": sorted({item.text for item in dispatch.iter("DispatchType") if item.text}),
                     "singleplayer_radius": {item.tag: item.get("value") for item in dispatch.find("SingleplayerWantedLevelRadius")},
                     "multiplayer_radius": {item.tag: item.get("value") for item in dispatch.find("MultiplayerWantedLevelRadius")}},
        "script_archives": [],
    }
    for filename in ("script.rpf", "script_rel.rpf", "script_wasm.rpf"):
        path = data / "x64/levels/gta5/script" / filename
        with path.open("rb") as stream:
            magic, entries, name_bytes, encryption = struct.unpack("<IIII", stream.read(16))
        result["script_archives"].append({"path": str(path.relative_to(data)), "bytes": path.stat().st_size,
            "magic": f"0x{magic:08x}", "entry_count": entries, "name_bytes": name_bytes,
            "encryption": f"0x{encryption:08x}", "script_contents_decoded": False})
    if include_wasm:
        wasm = root / "gta5data/b/8b0b5899ed/game.wasm"
        audit = WasmAudit(wasm)
        functions = []
        for index in (41485, 80397, 18883, 60564, 60575, 60576, 60577, 60591, 60593,
                      52957, 52958, 57186, 57187, 61298, 61299, 61300):
            body = audit.body_evidence(index, False)
            functions.append({key: body[key] for key in ("function_index", "name", "signature", "exports", "body_bytes", "decode_complete")})
        patterns = {
            "combat_tasks": r"CTask.*Combat",
            "flee_tasks": r"CTask.*Flee",
            "scenario_tasks": r"CTask.*Scenario",
            "script_scheduler": r"^(?:CTheScripts::|rage::scrThread::|script_commands::CommandTerminate)",
        }
        result["wasm"] = {"sha256": hashlib.sha256(audit.data).hexdigest(), "bytes": len(audit.data),
                          "selected_functions": functions,
                          "symbol_families": {key: {"count": len([name for name in audit.names.values() if re.search(pattern, name)]),
                                                     "sample": [name for name in audit.names.values() if re.search(pattern, name)][:12]}
                                              for key, pattern in patterns.items()}}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/snapshot/world-ai-evidence.json")
    parser.add_argument("--skip-wasm", action="store_true")
    args = parser.parse_args()
    result = inventory(args.root, not args.skip_wasm)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "scenarios": result["scenarios"]["count"],
                      "trigger_rules": result["triggers"]["count"],
                      "event_types": len(result["triggers"]["event_counts"]),
                      "population_schedules": result["population_schedules"]["count"],
                      "response_types": result["dispatch"]["response_types"],
                      "script_archives": result["script_archives"],
                      "wasm": result.get("wasm", {}).get("selected_functions", [])}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
