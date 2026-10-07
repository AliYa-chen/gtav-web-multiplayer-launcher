"""创建完整的 ZIP64 便携包，并在写入时校验源文件哈希。"""
import hashlib, json, time, zipfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))
from serve_local import resource_path
PREFIX = 'playgta5-offline'
OUTPUT = ROOT / 'archive/packages/playgta5-offline-中文整理版.zip'

class HashWriter:
    """不可回退的 ZIP 输出：每个写入字节恰好参与一次哈希计算。"""
    def __init__(self, raw):
        self.raw = raw
        self.digest = hashlib.sha256()
        self.position = 0
    def write(self, data):
        n = self.raw.write(data)
        self.digest.update(data[:n])
        self.position += n
        return n
    def tell(self):
        return self.position
    def flush(self):
        self.raw.flush()

def collect_files(root=ROOT):
    """枚举实际项目文件，排除旧成品、日志、缓存和临时文件。"""
    files = []
    excluded = {'package-manifest.json', 'package-report.json', 'package-status.json',
                'game-data-before.json', '.DS_Store'}
    for name in ['gta5data', 'client', 'runtime', 'tools', 'docs', 'server', 'archive/original']:
        for path in (root / name).rglob('*'):
            if (path.is_file() and '__pycache__' not in path.parts
                    and path.suffix not in {'.part', '.log', '.pyc'}
                    and path.name not in excluded):
                files.append(path)
    files += [root / name for name in ['README.md', 'Launch-Local.cmd', 'Start-Local.ps1', 'serve_local.py']]
    return sorted(files, key=lambda p: str(p.relative_to(root)))


def main():
    expected = {resource_path(r['path']).relative_to(ROOT).as_posix(): r['sha256']
                for r in json.loads((ROOT / 'docs/snapshot/manifest-sha256.json').read_text(encoding='utf-8'))}
    fix_path = ROOT / 'docs/snapshot/local-scaleform-fix.json'
    if fix_path.exists():
        fix = json.loads(fix_path.read_text(encoding='utf-8'))
        for rec in [fix['manifest_override'], fix['loader_override'], *fix['files']]:
            expected[resource_path(rec['path']).relative_to(ROOT).as_posix()] = rec['sha256']
        for rec in [fix['original_manifest'], fix['original_loader']]:
            expected[rec['path']] = rec['sha256']
    expected.update({r['path']: r['sha256'] for r in
        json.loads((ROOT / 'docs/snapshot/runtime-manifest.json').read_text(encoding='utf-8'))['files']})
    # 首页中文化等本地覆盖另有记录，不改写原始采集清单。
    overrides_path = ROOT / 'docs/snapshot/local-overrides.json'
    if overrides_path.exists():
        for rec in json.loads(overrides_path.read_text(encoding='utf-8'))['files']:
            expected[resource_path(rec['path']).relative_to(ROOT).as_posix()] = rec['sha256']
    files = collect_files()
    total = sum(p.stat().st_size for p in files)
    processed = 0
    records = []
    start = time.monotonic()
    last_report = start
    temporary = OUTPUT.with_suffix('.zip.part')
    if OUTPUT.exists():
        raise FileExistsError('成品压缩包已存在，请先移走或重命名：' + str(OUTPUT))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    print('正在打包 %d 个文件，共 %d 字节，使用 ZIP64' % (len(files), total), flush=True)
    with temporary.open('wb') as raw:
        writer = HashWriter(raw)
        with zipfile.ZipFile(writer, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for path in files:
                relative = str(path.relative_to(ROOT)).replace('\\', '/')
                info = zipfile.ZipInfo.from_file(path, PREFIX + '/' + relative)
                digest = hashlib.sha256()
                size = 0
                with path.open('rb') as source, archive.open(info, 'w', force_zip64=True) as target:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                        target.write(chunk)
                        size += len(chunk)
                        processed += len(chunk)
                        if time.monotonic() - last_report >= 10:
                            status = {'phase': 'packaging', 'processed_bytes': processed, 'total_bytes': total,
                                'percent': round(processed / total * 100, 1), 'current_file': relative}
                            (ROOT / 'docs/snapshot/package-status.json').write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
                            print(json.dumps(status), flush=True)
                            last_report = time.monotonic()
                sha = digest.hexdigest()
                if relative in expected and expected[relative] != sha:
                    raise ValueError('源文件哈希发生变化：' + relative)
                records.append({'path': relative, 'bytes': size, 'sha256': sha})
            package_manifest = {'root_folder': PREFIX, 'files': records,
                'scope': '打包时已校验清单内所有文件的哈希；清单不列出自身。'}
            manifest_bytes = json.dumps(package_manifest, ensure_ascii=False, indent=2).encode()
            archive.writestr(PREFIX + '/docs/snapshot/package-manifest.json', manifest_bytes)
        archive_hash = writer.digest.hexdigest()
    temporary.replace(OUTPUT)
    (ROOT / 'docs/snapshot/package-manifest.json').write_bytes(manifest_bytes)
    with zipfile.ZipFile(OUTPUT) as archive:
        assert len(archive.infolist()) == len(records) + 1
        assert archive.read(PREFIX + '/docs/snapshot/package-manifest.json') == manifest_bytes
        assert archive.read(PREFIX + '/Launch-Local.cmd') == (ROOT / 'Launch-Local.cmd').read_bytes()
        assert archive.read(PREFIX + '/runtime/python312._pth') == (ROOT / 'runtime/python312._pth').read_bytes()
        for rec, info in zip(records, archive.infolist()):
            assert info.filename == PREFIX + '/' + rec['path'] and info.file_size == rec['bytes']
    report = {'archive': OUTPUT.name, 'bytes': OUTPUT.stat().st_size, 'sha256': archive_hash,
        'archive_entries': len(records) + 1, 'source_bytes': total,
        'source_sha256_verified_against_inventory': len(expected), 'compression': 'stored ZIP64',
        'seconds': round(time.monotonic() - start, 1),
        'validation': '打包时校验源文件 SHA-256；完成后核对压缩包目录、文件长度、清单、启动脚本与独立运行环境配置。'}
    (ROOT / 'docs/snapshot/package-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    OUTPUT.with_suffix(OUTPUT.suffix + '.sha256').write_text(archive_hash + '  ' + OUTPUT.name + '\n', encoding='utf-8')
    (ROOT / 'docs/snapshot/package-status.json').write_text(json.dumps({'phase': 'complete', **report}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)

if __name__ == '__main__':
    main()
