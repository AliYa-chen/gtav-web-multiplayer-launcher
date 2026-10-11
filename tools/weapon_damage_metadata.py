"""Read the shipped weapon and basic-melee damage metadata without editing it.

The multiplayer protocol currently identifies a weapon and a basic melee strike,
not the game's full action graph. Select a supported ordinary attack from each
weapon's default animation set, then resolve its original damage-and-reaction
record. Finishers, counters, stealth kills and actions with variable damage are
not silently substituted for that strike.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
GAME_DATA = ROOT / "gta5data/data"
WEAPONS = GAME_DATA / "common/data/ai/weapons.meta"
ANIMATIONS = GAME_DATA / "common/data/ai/weaponanimations.meta"
DEFINITIONS = GAME_DATA / "common/data/action/definitions.meta"
RESULTS = GAME_DATA / "common/data/action/results.meta"
DAMAGES = GAME_DATA / "common/data/action/damages.meta"
SOURCES = (WEAPONS, ANIMATIONS, DEFINITIONS, RESULTS, DAMAGES)

# These are source animation names, never server-defined damage amounts.
# The first entry is the same ordinary punch represented by the current bridge.
BASIC_ATTACK_ANIMATIONS = {
    "melee@unarmed@streamed_core": "heavy_punch_a",
    "melee@knife@streamed_core": "plyr_walking_attack_a",
    "melee@small_wpn@streamed_core": "plyr_walking_attack_a",
    "melee@large_wpn@streamed_core": "plyr_walking_attack",
    "melee@pistol@streamed_core": "pistol_idle_whip",
    "melee@rifle@streamed_core": "rifle_idle_whip",
}


def number(node, field, missing=-1.0):
    child = node.find(field) if node is not None else None
    if child is None or "value" not in child.attrib:
        return missing
    value = float(child.get("value"))
    if not math.isfinite(value):
        raise ValueError(f"Non-finite original metadata field: {field}")
    return value


def exact_int(value, label):
    if not math.isfinite(value) or value != int(value) or value < 0:
        raise ValueError(f"{label} cannot be represented without changing source damage: {value}")
    return int(value)


@dataclass(frozen=True)
class MeleeProfile:
    action: str
    reaction: str
    minimum: float
    maximum: float
    attributes: str

    @property
    def damage(self):
        if self.minimum != self.maximum:
            # The protocol has no action phase or random-damage selection.
            return 0
        return exact_int(self.minimum, self.reaction)


@dataclass(frozen=True)
class Metadata:
    weapons: dict
    ammo: dict
    melee: dict
    hashes: dict


def load():
    raw = {path: path.read_bytes() for path in SOURCES}
    trees = {path: ET.fromstring(data) for path, data in raw.items()}
    weapons = {item.findtext("Name"): item for item in trees[WEAPONS].iter("Item")
               if item.get("type") == "CWeaponInfo"}
    ammo = {item.findtext("Name"): item for item in trees[WEAPONS].iter("Item")
            if item.get("type", "").startswith("CAmmo")}
    animations = trees[ANIMATIONS].find('./WeaponAnimationsSets/Item[@key="Default"]/WeaponAnimations')
    if animations is None:
        raise ValueError("Original default weapon animation set is missing")
    clips = {item.get("key"): (item.findtext("MeleeClipSetHash") or "").lower()
             for item in animations}
    results = [item for item in trees[RESULTS].iter("Item") if item.get("type") == "CActionResult"]
    referenced = set()
    for item in trees[DEFINITIONS].iter("Item"):
        if item.get("type") != "CActionDefinition":
            continue
        if "DA_IS_ENABLED" not in (item.findtext("DefinitionAttrs") or "").split():
            continue
        types = (item.findtext("ActionType") or "").split()
        if not any(kind in types for kind in ("AT_MELEE", "AT_FROM_ON_FOOT")):
            continue
        referenced.update(result.findtext("ActionResult") for result in item.findall("aWeaponActionResults/Item"))
    damage_reactions = {item.findtext("Name"): item for item in trees[DAMAGES].iter("Item")
                        if item.get("type") == "CDamageAndReaction"}
    melee = {}
    for name in weapons:
        clip = clips.get(name, "")
        animation = BASIC_ATTACK_ANIMATIONS.get(clip, "attack" if clip.startswith("creatures@") else "")
        if not animation:
            continue
        candidates = [item for item in results
                      if (item.findtext("ClipSet") or "").lower() == clip
                      and item.findtext("Anim") == animation
                      and "RA_IS_STANDARD_ATTACK" in (item.findtext("ResultAttrs") or "").split()
                      and item.findtext("Name") in referenced]
        if not candidates:
            continue
        reactions = {item.findtext("DamageAndReaction") for item in candidates}
        if len(reactions) != 1:
            raise ValueError(f"Ambiguous original basic melee damage for {name}")
        reaction_name = next(iter(reactions))
        reaction = damage_reactions.get(reaction_name)
        if reaction is None:
            raise ValueError(f"Missing original damage reaction {reaction_name} for {name}")
        minimum, maximum = (number(reaction, key) for key in ("OnHitDamageAmountMin", "OnHitDamageAmountMax"))
        if minimum < 0 or maximum < minimum:
            raise ValueError(f"Invalid original damage range for {reaction_name}")
        actions = " ".join(sorted(item.findtext("Name") for item in candidates))
        melee[name] = MeleeProfile(actions, reaction_name, minimum, maximum,
                                  " ".join((reaction.findtext("DamageReactionAttrs") or "").split()))
    hashes = {str(path.relative_to(GAME_DATA)): hashlib.sha256(data).hexdigest() for path, data in raw.items()}
    return Metadata(weapons, ammo, melee, hashes)
