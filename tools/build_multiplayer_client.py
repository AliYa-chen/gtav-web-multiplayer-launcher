"""只读玩家原引擎，在启动器生成独立的离线与在线运行副本。"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_WASM_SHA256 = '11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0'


def write_json(path, value, *, sources=(), protected_roots=()):
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n',
                      sources=sources, protected_roots=protected_roots)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=ROOT / 'gta5data', help='玩家提供的资源总目录，含 b 和 data；只读使用')
    parser.add_argument('--runtime-dir', type=Path, default=ROOT / 'client/runtime', help='离线和在线副本输出目录，必须位于游戏资源之外')
    args = parser.parse_args(argv)
    game_root = args.game_dir.expanduser().resolve()
    if game_root.name == 'data' and (game_root / 'manifest.json').is_file(): game_root = game_root.parent
    runtime = args.runtime_dir.expanduser().resolve()
    if runtime.is_relative_to(game_root) or game_root.is_relative_to(runtime):
        parser.error('适配输出目录不能与游戏资源目录重叠，请选择 client/runtime 或其它外部目录。')
    original = game_root / 'b/8b0b5899ed/game.wasm'
    if not original.is_file(): parser.error('未找到原 game.wasm，请用 --game-dir 指定包含 b 与 data 的同版本资源目录。')
    sources, protected_roots = (original,), (game_root,)
    offline, target = runtime / 'offline/game.wasm', runtime / 'online/game.wasm'
    try:
        outputs = validate_outputs((offline, target, offline.with_suffix('.json'), target.with_suffix('.json')),
                                   sources=sources, protected_roots=protected_roots)
        if any(not path.is_relative_to(runtime) for path in outputs):
            raise ValueError('运行副本不能通过符号链接输出到运行目录之外。')
    except ValueError as error:
        parser.error(str(error))
    original_digest = hashlib.sha256(original.read_bytes()).hexdigest()
    if original_digest != ORIGINAL_WASM_SHA256:
        parser.error('原 game.wasm 版本不兼容；未生成运行副本，玩家游戏资源未修改。')
    subprocess.run([sys.executable, '-B', str(ROOT / 'tools/build_native_probe.py'), '--wasm', str(original),
                    '--output', str(target), '--entity-probe', '--public-client'], check=True)
    report_path = target.with_suffix('.json')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    report['deployment'] = {
        'mode': 'online',
        'path': '/engine/online/game.wasm',
        'bytes': target.stat().st_size,
        'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'original_engine_changed': False,
        'runtime_path': str(target),
        'game_resources_changed': False,
        'browser_validation': '适配器构建完成；实际游戏效果仍需双客户端验证',
    }
    write_json(report_path, report, sources=sources, protected_roots=protected_roots)
    original_bytes = original.read_bytes()
    copied_digest = hashlib.sha256(original_bytes).hexdigest()
    if copied_digest != original_digest:
        raise ValueError('原引擎复制校验失败，未发布离线副本。')
    atomic_write_bytes(offline, original_bytes, sources=sources, protected_roots=protected_roots)
    write_json(offline.with_suffix('.json'), {
        'original': {'path': str(original), 'sha256': original_digest, 'bytes': original.stat().st_size},
        'prototype': {'path': str(offline), 'sha256': copied_digest, 'bytes': offline.stat().st_size},
        'deployment': {'mode': 'offline', 'path': '/engine/offline/game.wasm',
                       'runtime_path': str(offline), 'original_engine_changed': False,
                       'game_resources_changed': False, 'patched': False},
    }, sources=sources, protected_roots=protected_roots)
    print('已生成启动器离线引擎：%s' % offline)
    print('已生成启动器公共战局引擎：%s；玩家游戏目录未修改' % target)


if __name__ == '__main__':
    main()
