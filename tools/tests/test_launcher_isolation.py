#!/usr/bin/env python3
"""用临时外部资源验证启动器隔离，绝不写本项目 gta5data/data。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import zipfile
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tools'))
import serve_local
import build_launcher_zip


class LauncherIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='launcher-isolation-')
        self.base = Path(self.temp.name)
        self.game = self.base / '玩家自己的游戏'
        self.runtime = self.base / '启动器生成物'
        self.game.mkdir(); self.runtime.mkdir()
        data = self.game / 'data'; data.mkdir()
        (data / 'manifest.json').write_text(json.dumps({'mount': '/game/', 'version': 'fixture-original',
            'files': [['sample.bin', 6, 0]]}), encoding='utf-8')
        (data / 'sample.bin').write_bytes(b'abcdef')
        original = self.game / ('b/' + serve_local.BUILD_ID); original.mkdir(parents=True)
        for name, content in {'game.wasm': b'fixture-original-wasm', 'game.js': b'original-js',
                              'io_worker.js': b'original-io', 'wgpu_worker.js': b'original-gpu'}.items():
            (original / name).write_bytes(content)
        (original / 'game-multiplayer.wasm').write_bytes(b'old-game-copy-do-not-use')
        (self.runtime / 'game-multiplayer.wasm').write_bytes(b'isolated-adapter')
        self.digest = hashlib.sha256(b'fixture-original-wasm').hexdigest()
        (self.runtime / 'game-multiplayer.json').write_text(json.dumps({
            'original': {'sha256': self.digest},
            'prototype': {'sha256': hashlib.sha256(b'isolated-adapter').hexdigest()}}), encoding='utf-8')
        self.before = self.inventory(self.game)

    def tearDown(self):
        self.assertEqual(self.inventory(self.game), self.before, '启动器不得改变、增删或触碰游戏资源内容')
        self.temp.cleanup()

    @staticmethod
    def inventory(root):
        return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in root.rglob('*') if path.is_file()}

    def inspect(self, **kwargs):
        with patch.object(serve_local, 'ORIGINAL_WASM_SHA256', self.digest):
            return serve_local.inspect_game_resources(self.game, self.runtime, **kwargs)

    def test_external_root_and_data_child_preflight_are_read_only(self):
        status = self.inspect(require_runtime=True)
        self.assertEqual(status['root'], self.game.resolve()); self.assertTrue(status['multiplayer_ready'])
        self.assertEqual(serve_local.resolve_game_directory(self.game / 'data'), self.game.resolve())
        self.assertEqual(serve_local.resource_path('/data/sample.bin', self.game, self.runtime), self.game / 'data/sample.bin')
        self.assertEqual(serve_local.resource_path('/b/8b0b5899ed/game-multiplayer.wasm', self.game, self.runtime),
                         self.runtime / 'game-multiplayer.wasm')

    def test_missing_resources_and_wrong_original_or_adapter_hash_fail_clearly(self):
        with self.assertRaisesRegex(ValueError, '游戏资源不完整'):
            serve_local.inspect_game_resources(self.base / 'missing', self.runtime)
        with patch.object(serve_local.Path, 'is_file', autospec=True, side_effect=lambda path:
                False if path.name == 'sample.bin' else Path.exists(path)):
            with self.assertRaisesRegex(ValueError, '清单登记的文件缺失'):
                self.inspect()
        with self.assertRaisesRegex(ValueError, '版本不兼容'):
            serve_local.inspect_game_resources(self.game, self.runtime)
        with self.assertRaisesRegex(ValueError, '不能位于游戏资源目录内'):
            serve_local.inspect_game_resources(self.game, self.game / 'data/runtime')
        (self.runtime / 'game-multiplayer.wasm').write_bytes(b'corrupted')
        with self.assertRaisesRegex(ValueError, '校验失败'):
            self.inspect(require_runtime=True)
        (self.runtime / 'game-multiplayer.wasm').unlink()
        with self.assertRaisesRegex(ValueError, '缺少隔离'):
            self.inspect(require_runtime=True)

    def test_http_reads_selected_resources_and_isolated_fork_and_rejects_escape_or_game_logs(self):
        status = self.inspect(require_runtime=True)
        server = serve_local.LocalServer(('127.0.0.1', 0), game_root=self.game,
            runtime_root=self.runtime, log_file=self.base / 'logs/local.log', resource_status=status)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with urlopen(base + '/data/sample.bin') as response:
                self.assertEqual(response.read(), b'abcdef')
                self.assertEqual(response.headers['Cross-Origin-Opener-Policy'], 'same-origin')
            with urlopen(Request(base + '/data/sample.bin', headers={'Range': 'bytes=1-3'})) as response:
                self.assertEqual(response.status, 206); self.assertEqual(response.read(), b'bcd')
            fork_url = base + '/b/8b0b5899ed/game-multiplayer.wasm?v=melee-intent-animation-8'
            with urlopen(fork_url) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get_content_type(), 'application/wasm')
                self.assertEqual(response.read(), b'isolated-adapter')
            with urlopen(Request(fork_url, headers={'Range': 'bytes=0-7'})) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.read(), b'isolated')
            with urlopen(Request(base + '/data/batch', data=json.dumps([['sample.bin', 1, 3]]).encode(), method='POST')) as response:
                self.assertEqual(response.read(), b'bcd')
            with urlopen(base + '/api/local-config') as response:
                self.assertTrue(json.load(response)['multiplayer_ready'])
            with self.assertRaises(HTTPError) as caught:
                urlopen(base + '/data/%2e%2e/%2e%2e/private.txt')
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        with self.assertRaisesRegex(ValueError, '日志不能写入'):
            serve_local.LocalServer(('127.0.0.1', 0), game_root=self.game, log_file=self.game / 'data/unsafe.log')

    def test_launcher_archive_allowlist_excludes_game_runtime_and_server_binary(self):
        output = self.base / 'launcher.zip'
        report = build_launcher_zip.build_launcher(output, root=ROOT, include_server=True)
        self.assertFalse(report['game_resources_included'])
        with zipfile.ZipFile(output) as archive:
            names = archive.namelist()
            self.assertIn('serve_local.py', names); self.assertIn('client/index.html', names)
            self.assertIn('server/src/main/java/offline/multiplayer/Main.java', names)
            self.assertFalse(any(name.startswith(('gta5data/', 'runtime/', 'client/runtime/', 'archive/')) for name in names))
            self.assertFalse(any(Path(name).suffix in build_launcher_zip.FORBIDDEN_SUFFIXES for name in names))
            manifest = json.loads(archive.read('launcher-manifest.json'))
            self.assertFalse(manifest['runtime_resources_included'])
            self.assertTrue(manifest['server_source_included'])
            self.assertIsNone(archive.testzip())
        with self.assertRaisesRegex(ValueError, '不能写入游戏'):
            build_launcher_zip.build_launcher(ROOT / 'gta5data/data/forbidden.zip')


if __name__ == '__main__':
    unittest.main(verbosity=2)
