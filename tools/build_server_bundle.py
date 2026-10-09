"""生成可脱离游戏资源独立部署的公共战局服务端压缩包。"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path
from readonly_game_outputs import atomic_write_bytes, validate_outputs

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true', help='复用现有 JAR，不重新编译；封包前核对 JAR 与源码版本')
    parser.add_argument('--java', default='java', help='验证现有 JAR 版本使用的 Java 路径')
    args = parser.parse_args(argv)
    source = ROOT / 'server'
    files = [source / name for name in ['multiplayer-server.jar', 'README.md', 'Start-Server.cmd',
                                       'Start-Server.command', 'Start-Server.sh']]
    files += sorted((source / 'src').rglob('*.java'))
    files += sorted(path for path in (source / 'deploy').rglob('*') if path.is_file())
    output = ROOT / 'archive/packages' / ('gta5-public-server-' + date.today().isoformat() + '.zip')
    version_output, sums_output = source / 'VERSION.json', source / 'SHA256SUMS.txt'
    boundary = {'sources': files, 'protected_roots': (ROOT / 'gta5data',)}
    try:
        validate_outputs((output, version_output, sums_output), **boundary)
    except ValueError as error:
        parser.error(str(error))
    if not args.skip_build:
        subprocess.run([sys.executable, '-B', str(ROOT / 'tools/build_multiplayer_server.py')], check=True)
    main_source = (source / 'src/main/java/offline/multiplayer/Main.java').read_text(encoding='utf-8')
    version = re.search(r'private static final String VERSION = "([^"]+)";', main_source)
    if not version:
        raise ValueError('无法读取当前服务端版本，拒绝生成错误的部署清单')
    jar = source / 'multiplayer-server.jar'
    if not jar.is_file():
        parser.error('未找到 server/multiplayer-server.jar，请先构建服务端')
    result = subprocess.run([args.java, '-jar', str(jar), '--help'], capture_output=True,
                            text=True, encoding='utf-8', timeout=20, check=True)
    jar_version = re.search(r'^GTA V 沙盒公共战局服务 ([^\s（]+)', result.stdout, re.MULTILINE)
    if not jar_version or jar_version.group(1) != version.group(1):
        parser.error('现有 JAR 版本与源码不一致，拒绝生成部署包；请先构建当前服务端')
    manifest = {
        'version': version.group(1), 'protocol': 1, 'world_protocol': 2,
        'launcher_minimum': '0.2.0', 'java_minimum': 17,
        'public_session': 'PUBLIC', 'map': 'gta5', 'mode': 'sandbox',
        'game_resources_required': False,
        'validation': '统一世界、共同环境、共享执法及车辆协议回归通过；实际游戏及八人持续玩法仍需验收。',
        'files': [],
    }
    bodies = {}
    for path in files:
        relative = path.relative_to(source).as_posix()
        body = path.read_bytes()
        bodies[relative] = body
        manifest['files'].append({'path': relative, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    bodies['VERSION.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    bodies['SHA256SUMS.txt'] = ('\n'.join(
        hashlib.sha256(body).hexdigest() + '  ' + name for name, body in bodies.items()) + '\n').encode('utf-8')
    prefix = 'gta5-public-server/'
    with io.BytesIO() as payload:
        with zipfile.ZipFile(payload, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, body in bodies.items():
                info = zipfile.ZipInfo(prefix + relative)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((0o100755 if relative.endswith(('.sh', '.command')) else 0o100644) << 16)
                archive.writestr(info, body)
        with zipfile.ZipFile(payload) as archive:
            assert archive.testzip() is None
            for name, body in bodies.items():
                assert hashlib.sha256(archive.read(prefix + name)).digest() == hashlib.sha256(body).digest()
            assert not any(name.endswith(('.wasm', '.rpf', '.gfx')) for name in archive.namelist())
        atomic_write_bytes(output, payload.getvalue(), **boundary)
    atomic_write_bytes(version_output, bodies['VERSION.json'], **boundary)
    atomic_write_bytes(sums_output, bodies['SHA256SUMS.txt'], **boundary)
    print(json.dumps({'服务端压缩包': str(output), '字节数': output.stat().st_size,
                      '文件数': len(bodies), '校验': 'ZIP CRC 与所有文件 SHA-256 通过',
                      '不包含游戏资源': True}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
