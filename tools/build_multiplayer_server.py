"""将多人大厅服务端编译成 Java 17 可执行 JAR，不依赖 Maven 或第三方库。"""
import argparse
import io
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from readonly_game_outputs import atomic_write_bytes, validate_output

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description='编译独立多人大厅服务端，需要 JDK 17 或更新版本')
    parser.add_argument('--javac', default=shutil.which('javac'), help='Java 编译器路径，默认查找 PATH 中的 javac')
    parser.add_argument('--output', type=Path, default=ROOT / 'server/multiplayer-server.jar', help='输出 JAR 的路径')
    args = parser.parse_args(argv)
    if not args.javac:
        parser.error('未找到 javac，请安装 JDK 17 或更新版本，或使用 --javac 指定编译器')
    sources = sorted((ROOT / 'server/src/main/java').rglob('*.java'))
    if not sources:
        parser.error('没有找到多人服务端 Java 源码')
    boundary = {'sources': sources, 'protected_roots': (ROOT / 'gta5data',)}
    try:
        output = validate_output(args.output, **boundary)
    except ValueError as error:
        parser.error(str(error))
    with tempfile.TemporaryDirectory(prefix='gta5-lobby-build-') as temp:
        classes = Path(temp) / 'classes'
        classes.mkdir()
        command = [args.javac, '--release', '17', '-encoding', 'UTF-8',
                   '-d', str(classes), *map(str, sources)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        if result.returncode:
            parser.exit(result.returncode, 'Java 编译失败：\n' + result.stdout + result.stderr)
        with io.BytesIO() as payload:
            with zipfile.ZipFile(payload, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('META-INF/MANIFEST.MF',
                                 'Manifest-Version: 1.0\r\nMain-Class: offline.multiplayer.Main\r\n\r\n')
                for source in sorted(classes.rglob('*.class')):
                    archive.write(source, source.relative_to(classes).as_posix())
            with zipfile.ZipFile(payload) as archive:
                assert archive.testzip() is None
                assert 'offline/multiplayer/Main.class' in archive.namelist()
            atomic_write_bytes(output, payload.getvalue(), **boundary)
    print('多人大厅 JAR 已生成：%s（%d 字节，运行需要 Java 17+）' % (output, output.stat().st_size))


if __name__ == '__main__':
    main()
