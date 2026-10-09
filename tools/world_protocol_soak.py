#!/usr/bin/env python3
"""独立 JAR 的 8 人世界协议持续验证；不启动 GTA，不替代真实游戏验收。"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import select
import socket
import struct
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / 'tests'))
import test_multiplayer as protocol


def drain(client):
    while select.select([client.sock], [], [], 0)[0]:
        chunk = client.sock.recv(65536)
        if not chunk:
            raise AssertionError('持续验证期间服务端关闭连接')
        client.buffer.extend(chunk)
    messages = []
    while len(client.buffer) >= 2:
        first, second = client.buffer[:2]
        if second & 128:
            raise AssertionError('服务端不能发送掩码帧')
        length, offset = second & 127, 2
        if length == 126:
            if len(client.buffer) < 4: break
            length, offset = struct.unpack('!H', client.buffer[2:4])[0], 4
        elif length == 127:
            if len(client.buffer) < 10: break
            length, offset = struct.unpack('!Q', client.buffer[2:10])[0], 10
        if len(client.buffer) < offset + length: break
        payload = bytes(client.buffer[offset:offset + length]); del client.buffer[:offset + length]
        opcode = first & 15
        if opcode == 9: client.frame(10, payload)
        elif opcode == 8: raise AssertionError('持续验证期间服务端发出关闭帧')
        elif opcode == 1: messages.append(json.loads(payload))
    return messages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=protocol.ROOT / 'server/multiplayer-world-experimental.jar')
    parser.add_argument('--seconds', type=int, default=1800)
    parser.add_argument('--players', type=int, default=8, choices=range(1, 9))
    parser.add_argument('--world-data', type=Path, help='加载本地提取的真实道路/碰撞数据；省略为无图协议测试')
    parser.add_argument('--output', type=Path, default=protocol.ROOT / 'docs/snapshot/world-protocol-soak.json')
    args = parser.parse_args()
    if args.seconds < 1: parser.error('持续秒数必须为正数')
    protocol.JAR_PATH = args.jar.resolve()
    if args.world_data: protocol.MultiplayerIntegrationTests.SERVER_ARGUMENTS=['--world-data',str(args.world_data.resolve())]
    protocol.MultiplayerIntegrationTests.setUpClass()
    server = protocol.MultiplayerIntegrationTests
    clients = []
    totals = {'player_states_sent': 0, 'entity_batches_sent': 0, 'world_deltas_received': 0,
              'snapshots_received': 0, 'errors': [], 'stream_gaps': 0}
    def receive(client, message):
        kind = message['type']
        if kind == 'error':
            totals['errors'].append({'code': message['code'], 'message': message['message']})
            raise AssertionError('正常持续验证被拒绝：' + message['code'])
        if kind == 'snapshot_begin':
            client.pending_snapshot = {**message, 'entities': {}}
        elif kind == 'snapshot_chunk':
            assert client.pending_snapshot['snapshot_id'] == message['snapshot_id']
            client.pending_snapshot['entities'].update({e['entity_id']: e for e in message['entities']})
        elif kind == 'snapshot_end':
            client.entities = client.pending_snapshot['entities']; client.epoch = message['world_epoch']
            client.stream_seq = message['stream_seq']; client.pending_snapshot = None
            totals['snapshots_received'] += 1
        elif kind == 'world_delta':
            assert client.epoch == message['world_epoch']
            if message['stream_seq'] != client.stream_seq + 1:
                totals['stream_gaps'] += 1; raise AssertionError('世界增量流序号不连续')
            client.stream_seq = message['stream_seq']; totals['world_deltas_received'] += 1
            for entity in message['entities']: client.entities[entity['entity_id']] = entity
            for deleted in message['tombstones']: client.entities.pop(deleted['entity_id'], None)
            for removed in message['scope_leave']: client.entities.pop(removed, None)
    started = time.monotonic()
    try:
        for index in range(args.players):
            client = protocol.WebSocketClient(server.port); clients.append(client)
            welcome = client.expect('welcome')
            assert 'world_v2' in welcome['capabilities'] and 'entity_batch' in welcome['capabilities']
            client.send({'type': 'hello', 'name': '持续验证' + str(index + 1),
                         'capabilities': ['combat', 'resume', 'world_v2', 'world_environment', 'shared_law', 'session_policy']})
            client.profile = client.expect('profile'); client.pending_snapshot = None
            client.entities = {}; client.epoch = None; client.stream_seq = 0
            client.seq = 0; client.inputs = {}; client.ready = set()
            for message in client.pending: receive(client, message)
            client.pending.clear()
            while client.epoch is None: receive(client, client.receive())
        started = time.monotonic(); next_state = next_batch = next_ping = started
        while time.monotonic() - started < args.seconds:
            now = time.monotonic()
            for client in clients:
                for message in drain(client): receive(client, message)
                for entity in list(client.entities.values()):
                    key = (entity['entity_id'], entity['owner_epoch'])
                    if entity['owner_id'] == client.profile['client_id'] and entity.get('ownership') == 'offered' and key not in client.ready:
                        client.send({'type': 'entity_ready', 'world_epoch': client.epoch,
                                     'entity_id': key[0], 'owner_epoch': key[1]}); client.ready.add(key)
            if now >= next_state:
                for client in clients:
                    client.seq += 1; position = list(client.profile['spawn'])
                    position[0] += math.sin((now - started) * .5)
                    client.send({'type': 'player_state', 'seq': client.seq, 'position': position,
                                 'heading': 90, 'model': 0x705e61f2, 'health': 200,
                                 'weapon': 0xa2719263, 'shooting': False})
                    totals['player_states_sent'] += 1
                next_state = now + .05
            if now >= next_batch:
                for client in clients:
                    updates = []
                    for entity in client.entities.values():
                        if (entity['player_id'] is not None or entity['owner_id'] != client.profile['client_id']
                            or entity.get('ownership') != 'active' or entity['components'].get('attachment')): continue
                        key = (entity['entity_id'], entity['generation'], entity['owner_epoch'])
                        seq = max(client.inputs.get(key, 0), entity.get('last_input_seq', -1)) + 1
                        update = {'entity_id': entity['entity_id'], 'owner_epoch': entity['owner_epoch'],
                                  'input_seq': seq, 'based_on_revision': entity['revision'],
                                  'transform': entity['components']['transform']}
                        if entity['kind'] == 'vehicle':
                            view = entity['components']['vehicle']
                            update['view'] = {'engine_on': view['engine_on'], 'lights_on': view['lights_on']}
                        elif entity['kind'] == 'ped': update['view'] = entity['components']['ped']
                        updates.append(update); client.inputs[key] = seq
                    if updates:
                        client.send({'type': 'entity_batch', 'world_epoch': client.epoch, 'updates': updates[:24]})
                        totals['entity_batches_sent'] += 1
                next_batch = now + .1
            if now >= next_ping:
                for client in clients: client.send({'type': 'ping', 'nonce': int((now - started) * 1000)})
                next_ping = now + 5
            time.sleep(.003)
        _, health = server.get_json('/health')
        assert health['players'] == args.players
        report = {'duration_seconds': round(time.monotonic() - started, 2), 'players': args.players,
                  'server_version': health['server_version'], **totals, 'health': health,
                  'game_execution': '未运行 GTA；本报告只验证协议持续运行'}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        for client in clients: client.close()
        server.tearDownClass()


if __name__ == '__main__': main()
