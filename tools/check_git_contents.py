"""检查 Git 暂存区，防止发布游戏资源、大文件或本机生成产物。"""
import subprocess
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
DENIED_PREFIXES = ('gta5data/', 'mirror/', 'runtime/', 'archive/', 'docs/snapshot/')
DENIED_SUFFIXES = {
    '.wasm', '.rpf', '.gfx', '.ytd', '.ydd', '.yft', '.ymt', '.fxc', '.bik', '.bk2',
    '.ttf', '.otf', '.woff', '.woff2', '.jar', '.class', '.zip', '.pyc', '.pyo',
    '.log', '.tmp', '.part',
}


def main():
    result = subprocess.run(['git', 'ls-files', '--stage', '-z'], cwd=ROOT,
                            capture_output=True, check=True)
    entries = []
    for record in result.stdout.split(b'\0'):
        if not record:
            continue
        metadata, raw_path = record.split(b'\t', 1)
        mode, blob, stage = metadata.decode('ascii').split()
        entries.append((raw_path.decode('utf-8'), mode, blob, stage))
    if not entries:
        print('暂存区没有文件，请先 git add 所需源码。', file=sys.stderr)
        return 1
    checks = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname) %(objectsize)'],
                            cwd=ROOT, input='\n'.join(row[2] for row in entries) + '\n',
                            capture_output=True, text=True, check=True)
    sizes = {line.split()[0]: int(line.split()[1]) for line in checks.stdout.splitlines()}
    errors = []
    total = 0
    for name, mode, blob, stage in entries:
        path = PurePosixPath(name)
        size = sizes[blob]
        total += size
        if name.startswith(DENIED_PREFIXES) or path.suffix.lower() in DENIED_SUFFIXES:
            errors.append('禁止提交资源或生成文件：' + name)
        if '__pycache__' in path.parts or path.name == '.DS_Store' or path.name.startswith('.env'):
            errors.append('禁止提交缓存或环境配置：' + name)
        if mode == '120000':
            errors.append('请勿用符号链接引用被忽略的资源：' + name)
        if stage != '0':
            errors.append('文件尚有合并冲突：' + name)
        if size > 5 * 1024 * 1024:
            errors.append('文件超过 5 MiB，请检查是否为资源包：' + name)
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print('通过：%d 个源码/文档文件，共 %.1f KiB，无游戏数据或生成包。' % (len(entries), total / 1024))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
