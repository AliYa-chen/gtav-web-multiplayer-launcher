"""仅在 Windows 上，从当前 Python 安装生成包含标准库的便携运行环境。"""
import hashlib, json, shutil, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.executable).parent
TARGET = ROOT / 'runtime'
STATE = ROOT / 'docs' / 'snapshot'
if sys.platform != 'win32':
    raise SystemExit('此工具仅支持 Windows。请在 Windows 上使用包含 Lib 和 DLLs 的完整 Python 安装运行；macOS 和 Linux 无需重建项目自带的 Windows 运行环境。')
TARGET.mkdir(parents=True, exist_ok=True)
STATE.mkdir(parents=True, exist_ok=True)
tag = 'python%d%d' % sys.version_info[:2]
for name in ['python.exe', 'python3.dll', tag + '.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']:
    shutil.copyfile(SOURCE / name, TARGET / name)
shutil.copytree(SOURCE / 'DLLs', TARGET / 'DLLs', dirs_exist_ok=True,
                ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pdb'))
with zipfile.ZipFile(TARGET / (tag + '.zip'), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for path in sorted((SOURCE / 'Lib').rglob('*')):
        rel = path.relative_to(SOURCE / 'Lib')
        if path.is_file() and not any(part in {'site-packages', '__pycache__', 'test', 'tests'} for part in rel.parts) and path.suffix != '.pyc':
            archive.write(path, str(rel))
# 使用隔离的模块搜索路径，避免依赖用户的 Python 安装或第三方包。
(TARGET / (tag + '._pth')).write_text(tag + '.zip\nDLLs\n.\n..\n', encoding='ascii')
records = []
for path in sorted(TARGET.rglob('*')):
    if path.is_file():
        records.append({'path': str(path.relative_to(ROOT)).replace('\\', '/'), 'bytes': path.stat().st_size,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
(STATE / 'runtime-manifest.json').write_text(json.dumps({'python_version': sys.version,
    'source': str(SOURCE), 'scope': 'Python 可执行文件、DLL 和标准库；不包含第三方包',
    'files': records}, indent=2, ensure_ascii=False), encoding='utf-8')
print('便携运行环境：', len(records), '个文件；', sum(r['bytes'] for r in records), '字节')
