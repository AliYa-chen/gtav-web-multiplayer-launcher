"""只读玩家游戏资源，生成启动器目录中的独立多人引擎适配副本。"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-dir', type=Path, default=ROOT / 'gta5data', help='玩家提供的资源总目录，含 b 和 data；只读使用')
    parser.add_argument('--runtime-dir', type=Path, default=ROOT / 'client/runtime', help='适配副本输出目录，必须位于游戏资源之外')
    args = parser.parse_args(argv)
    game_root = args.game_dir.expanduser().resolve()
    if game_root.name == 'data' and (game_root / 'manifest.json').is_file(): game_root = game_root.parent
    runtime = args.runtime_dir.expanduser().resolve()
    if runtime.is_relative_to(game_root): parser.error('适配输出不能位于游戏资源目录内，请选择 client/runtime 或其它外部目录。')
    original = game_root / 'b/8b0b5899ed/game.wasm'
    if not original.is_file(): parser.error('未找到原 game.wasm，请用 --game-dir 指定包含 b 与 data 的同版本资源目录。')
    target = runtime / 'game-multiplayer.wasm'
    subprocess.run([sys.executable, '-B', str(ROOT / 'tools/build_native_probe.py'), '--wasm', str(original),
                    '--output', str(target), '--entity-probe', '--public-client'], check=True)
    report_path = target.with_suffix('.json')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    report['deployment'] = {
        'path': '/b/8b0b5899ed/game-multiplayer.wasm',
        'bytes': target.stat().st_size,
        'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'original_engine_changed': False,
        'runtime_path': str(target),
        'game_resources_changed': False,
        'browser_validation': '适配器构建完成；实际游戏效果仍需双客户端验证',
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('已生成启动器的独立公共战局引擎副本：%s；玩家游戏目录未修改' % target)


if __name__ == '__main__':
    main()
