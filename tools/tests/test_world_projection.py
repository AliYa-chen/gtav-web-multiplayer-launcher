#!/usr/bin/env python3
"""通过真实 JAR 验证统一实体快照与已确认玩家状态一致，不运行游戏。"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_multiplayer as protocol
import test_combat_world as combat_helpers
APPEARANCE = combat_helpers.APPEARANCE


class WorldProjectionTests(unittest.TestCase):
    get_json = classmethod(protocol.MultiplayerIntegrationTests.get_json.__func__)
    setUp = combat_helpers.CombatWorldIntegrationTests.setUp
    tearDown = combat_helpers.CombatWorldIntegrationTests.tearDown
    raw_client = combat_helpers.CombatWorldIntegrationTests.raw_client
    client = combat_helpers.CombatWorldIntegrationTests.client
    state = combat_helpers.CombatWorldIntegrationTests.state
    body = staticmethod(combat_helpers.CombatWorldIntegrationTests.body)
    shot = combat_helpers.CombatWorldIntegrationTests.shot
    accepted_shot = combat_helpers.CombatWorldIntegrationTests.accepted_shot
    error = combat_helpers.CombatWorldIntegrationTests.error

    def entity(self, client):
        _, snapshot = self.get_json('/world')
        return snapshot, next(entity for entity in snapshot['entities'] if entity['player_id'] == client.player_id)

    def test_verified_player_projection_has_stable_id_and_immutable_world_cut(self):
        player = self.client('统一实体玩家')
        state = self.state(player)
        snapshot, entity = self.entity(player)
        self.assertEqual(snapshot['schema_version'], 2)
        self.assertTrue(entity['entity_id'].startswith('w:' + snapshot['world_epoch'] + ':'))
        self.assertEqual(entity['owner_id'], player.player_id)
        self.assertEqual(entity['components']['transform']['position'], state['position'])
        self.assertEqual(entity['components']['appearance'], APPEARANCE)
        self.assertEqual(entity['components']['combat']['health'], 200)
        identity, before = entity['entity_id'], entity['revision']
        self.state(player, 2, position=[player.position[0] + .5, player.position[1], player.position[2]])
        next_snapshot, moved = self.entity(player)
        self.assertEqual(moved['entity_id'], identity)
        self.assertGreater(moved['revision'], before)
        self.assertGreater(next_snapshot['cut_revision'], snapshot['cut_revision'])
        self.assertEqual(entity['components']['transform']['position'], state['position'])
        self.assertFalse(snapshot['shared_population'])
        self.assertFalse(snapshot['native_clone_transport'])

    def test_damage_death_and_respawn_projection_use_server_facts(self):
        first, second = self.client('统一射手'), self.client('统一目标')
        self.state(first); self.state(second)
        _, initial = self.entity(second)
        for sequence in range(1, 7):
            self.accepted_shot(first, sequence, self.body(second.position))
            first.expect('damage', lambda event: event.get('shot_seq') == sequence)
            time.sleep(.13)
        snapshot, dead = self.entity(second)
        self.assertEqual(dead['components']['combat']['health'], 0)
        self.assertFalse(dead['components']['combat']['alive'])
        self.assertEqual(dead['entity_id'], initial['entity_id'])
        second.expect('respawn', timeout=6)
        _, revived = self.entity(second)
        self.assertEqual(revived['entity_id'], initial['entity_id'])
        self.assertEqual(revived['generation'], initial['generation'] + 1)
        self.assertEqual(revived['components']['combat']['health'], 200)
        self.assertEqual(revived['components']['combat']['deaths'], 1)
        self.assertGreater(revived['combat_revision'], dead['combat_revision'])

    def test_disconnect_revokes_owner_resume_keeps_entity_and_leave_emits_tombstone(self):
        player = self.client('迁移玩家'); self.state(player)
        _, initial = self.entity(player)
        credentials = {key: player.profile[key] for key in ('client_id', 'resume_token')}
        player.close()
        deadline = time.monotonic() + 3
        while True:
            _, offline = self.entity(player)
            if offline['owner_id'] is None: break
            self.assertLess(time.monotonic(), deadline); time.sleep(.03)
        self.assertGreater(offline['owner_epoch'], initial['owner_epoch'])
        resumed = self.client('迁移玩家', resume=credentials)
        self.state(resumed, 2)
        _, restored = self.entity(resumed)
        self.assertEqual(restored['entity_id'], initial['entity_id'])
        self.assertGreater(restored['owner_epoch'], offline['owner_epoch'])
        resumed.send({'type': 'leave_room'})
        deadline = time.monotonic() + 3
        while True:
            _, snapshot = self.get_json('/world')
            if not any(item.get('player_id') == player.player_id for item in snapshot['entities']): break
            self.assertLess(time.monotonic(), deadline); time.sleep(.03)
        self.assertTrue(any(item['entity_id'] == initial['entity_id'] for item in snapshot['tombstones']))

    def test_raw_client_cannot_call_trusted_registry_or_write_combat(self):
        player = self.client('只读快照玩家'); self.state(player)
        snapshot, initial = self.entity(player)
        player.send({'type': 'entity_input', 'entity_id': initial['entity_id'],
                     'owner_epoch': initial['owner_epoch'], 'health': 0, 'owner_id': 'other'})
        self.error(player, 'capability_required')
        _, after = self.entity(player)
        self.assertEqual(after['revision'], initial['revision'])
        self.assertEqual(after['components']['combat']['health'], 200)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=protocol.JAR_PATH)
    parser.add_argument('--java', default=protocol.JAVA_COMMAND)
    args, remainder = parser.parse_known_args()
    protocol.JAR_PATH = args.jar.resolve(); protocol.JAVA_COMMAND = args.java
    unittest.main(argv=[sys.argv[0], *remainder], verbosity=2)
