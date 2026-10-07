"""生成可脱离游戏资源独立部署的公共战局服务端压缩包。"""
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    subprocess.run([sys.executable, '-B', str(ROOT / 'tools/build_multiplayer_server.py')], check=True)
    source = ROOT / 'server'
    main_source = (source / 'src/main/java/offline/multiplayer/Main.java').read_text(encoding='utf-8')
    version = re.search(r'private static final String VERSION = "([^"]+)";', main_source)
    if not version:
        raise ValueError('无法读取当前服务端版本，拒绝生成错误的部署清单')
    files = [source / name for name in ['multiplayer-server.jar', 'README.md', 'Start-Server.cmd',
                                       'Start-Server.command', 'Start-Server.sh']]
    files += sorted((source / 'src').rglob('*.java'))
    manifest = {
        'version': version.group(1), 'protocol': 1, 'java_minimum': 17,
        'public_session': 'PUBLIC', 'map': 'gta5', 'mode': 'sandbox',
        'game_resources_required': False,
        'validation': '公共战局、角色状态与射击事件传输通过测试；真实游戏角色同步仍为实验版。',
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
    output_dir = ROOT / 'archive/packages'
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / ('gta5-public-server-' + date.today().isoformat() + '.zip')
    temporary = output.with_suffix('.zip.tmp')
    prefix = 'gta5-public-server/'
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, body in bodies.items():
                info = zipfile.ZipInfo(prefix + relative)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((0o100755 if relative.endswith(('.sh', '.command')) else 0o100644) << 16)
                archive.writestr(info, body)
        with zipfile.ZipFile(temporary) as archive:
            assert archive.testzip() is None
            for name, body in bodies.items():
                assert hashlib.sha256(archive.read(prefix + name)).digest() == hashlib.sha256(body).digest()
            assert not any(name.endswith(('.wasm', '.rpf', '.gfx')) for name in archive.namelist())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    (source / 'VERSION.json').write_bytes(bodies['VERSION.json'])
    (source / 'SHA256SUMS.txt').write_bytes(bodies['SHA256SUMS.txt'])
    print(json.dumps({'服务端压缩包': str(output), '字节数': output.stat().st_size,
                      '文件数': len(bodies), '校验': 'ZIP CRC 与所有文件 SHA-256 通过',
                      '不包含游戏资源': True}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
