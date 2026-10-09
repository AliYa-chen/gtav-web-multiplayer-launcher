#!/usr/bin/env python3
"""只打包启动器源码；玩家游戏数据、WASM 与生成的运行资源一律不进入 ZIP。"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile
from readonly_game_outputs import atomic_write_bytes, validate_output

ROOT = Path(__file__).resolve().parents[1]
SOURCE_EXTENSIONS = {'.js', '.css', '.html', '.json', '.svg'}
TOOLS = ('build_multiplayer_client.py', 'build_native_probe.py', 'inspect_native_bridge.py',
         'readonly_game_outputs.py', 'build_launcher_zip.py')
FORBIDDEN_SUFFIXES = {'.wasm', '.rpf', '.gfx', '.ytd', '.ydd', '.yft', '.ymt', '.fxc', '.jar', '.class',
                      '.ttf', '.otf', '.woff', '.woff2', '.bik', '.bk2', '.log', '.zip'}


def launcher_sources(root=ROOT, include_server=False):
    root = Path(root).resolve()
    sources = [root / 'serve_local.py', root / 'docs/启动器资源隔离.md']
    sources += [root / 'tools' / name for name in TOOLS]
    for path in (root / 'client').rglob('*'):
        if path.is_file() and path.suffix in SOURCE_EXTENSIONS and 'runtime' not in path.relative_to(root / 'client').parts:
            sources.append(path)
    if include_server:
        sources += [root / 'tools/build_multiplayer_server.py', root / 'server/README.md']
        sources += sorted((root / 'server/src').rglob('*.java'))
        sources += sorted(path for path in (root / 'server').glob('Start-*') if path.suffix in {'.sh', '.cmd', '.command'})
    missing = [path.relative_to(root).as_posix() for path in sources if not path.is_file()]
    if missing:
        raise ValueError('启动器源码不完整：' + '、'.join(missing))
    result = []
    for path in sorted(set(sources)):
        relative = path.relative_to(root)
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('拒绝打包外部符号链接：' + str(relative))
        if (relative.parts[0] in {'gta5data', 'archive', 'runtime'} or 'runtime' in relative.parts
                or path.suffix in FORBIDDEN_SUFFIXES or relative.parts[:2] == ('docs', 'snapshot')):
            raise ValueError('拒绝打包游戏资源或生成物：' + str(relative))
        result.append(path)
    return result


def build_launcher(output, *, root=ROOT, include_server=False):
    root = Path(root).resolve()
    sources = launcher_sources(root, include_server)
    boundary = {'sources': sources, 'protected_roots': (root / 'gta5data',)}
    try:
        output = validate_output(output, **boundary)
    except ValueError as error:
        raise ValueError('启动器压缩包不能写入游戏资源、源文件或符号链接：' + str(error)) from error
    records = [{'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size,
                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in sources]
    # This package contains only small launcher sources. Build and inspect it in
    # memory, then publish through the same input-safe boundary as engine copies.
    with io.BytesIO() as payload:
        with zipfile.ZipFile(payload, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for source in sources:
                archive.write(source, source.relative_to(root).as_posix())
            archive.writestr('启动器说明.txt',
                '此包只有启动器与适配器源码，不包含 GTA 游戏资源。\n'
                '安装 Python 3.11+，准备匹配版本的浏览器游戏资源，目录须包含 data/manifest.json 与 b/8b0b5899ed/game.wasm。\n'
                '先运行 python3 tools/build_multiplayer_client.py --game-dir "你的资源目录"，再运行\n'
                'python3 serve_local.py --game-dir "你的资源目录" --multiplayer --open\n'
                '原游戏资源只读使用；详情见 docs/启动器资源隔离.md。\n')
            archive.writestr('launcher-manifest.json', json.dumps({
                'kind': 'source_only_launcher', 'game_resources_included': False,
                'runtime_resources_included': False, 'server_source_included': include_server, 'files': records,
            }, ensure_ascii=False, indent=2) + '\n')
        with zipfile.ZipFile(payload) as archive:
            if archive.testzip() is not None:
                raise ValueError('启动器压缩包校验失败。')
        atomic_write_bytes(output, payload.getvalue(), **boundary)
    return {'path': str(output), 'bytes': output.stat().st_size, 'source_files': len(sources),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'game_resources_included': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'archive/packages/gta5-launcher-source.zip')
    parser.add_argument('--include-server', action='store_true', help='附带独立服务端 Java 源码和构建工具；不附 JAR 或游戏')
    options = parser.parse_args(argv)
    try:
        report = build_launcher(options.output, include_server=options.include_server)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
