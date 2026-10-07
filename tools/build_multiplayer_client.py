"""构建公共战局使用的引擎副本；保留生产单机引擎原始字节。"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    subprocess.run([sys.executable, '-B', str(ROOT / 'tools/build_native_probe.py'), '--entity-probe', '--public-client'], check=True)
    source = ROOT / 'archive/cache/native-public.wasm'
    target = ROOT / 'gta5data/b/8b0b5899ed/game-multiplayer.wasm'
    temporary = target.with_suffix('.wasm.tmp')
    shutil.copyfile(source, temporary)
    temporary.replace(target)
    report = json.loads((ROOT / 'archive/cache/native-public.json').read_text(encoding='utf-8'))
    report['deployment'] = {
        'path': '/b/8b0b5899ed/game-multiplayer.wasm',
        'bytes': target.stat().st_size,
        'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'original_engine_changed': False,
        'browser_validation': '原生坐标读取与角色创建已有复测；本次单机模型切换隔离补丁仍待游戏内复测',
    }
    (ROOT / 'docs/snapshot/multiplayer-engine.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('已生成独立公共战局引擎副本：%s' % target)


if __name__ == '__main__':
    main()
