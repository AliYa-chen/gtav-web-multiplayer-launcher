"""校验资源清单、引擎签名、着色器样本及本地 HTTP 读取。"""
import gzip, hashlib, json, sys, threading
from pathlib import Path
from urllib.request import Request, urlopen
BASE = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(BASE))
from serve_local import LocalServer, ROOT, resource_path

def main():
    inventory = json.loads((BASE / 'docs/snapshot/manifest-sha256.json').read_text(encoding='utf-8'))
    # 保留原采集清单，另行校验有记录的本地修改。
    local_fix_path = BASE / 'docs/snapshot/local-scaleform-fix.json'
    local_fix = json.loads(local_fix_path.read_text(encoding='utf-8')) if local_fix_path.exists() else None
    effective = list(inventory)
    if local_fix:
        original = local_fix['original_manifest']
        original_bytes = (BASE / original['path']).read_bytes()
        assert hashlib.sha256(original_bytes).hexdigest() == original['sha256']
        acquisition_manifest = next(r for r in inventory if r['path'] == '/data/manifest.json')
        assert original['sha256'] == acquisition_manifest['sha256'], '原始清单发生变化'
        override = local_fix['manifest_override']
        overrides = {override['path']: override}
        if local_fix.get('loader_override'):
            original_loader = local_fix['original_loader']
            acquisition_loader = next(r for r in inventory if r['path'] == local_fix['loader_override']['path'])
            assert hashlib.sha256((BASE / original_loader['path']).read_bytes()).hexdigest() == acquisition_loader['sha256']
            overrides[local_fix['loader_override']['path']] = local_fix['loader_override']
        effective = [overrides.get(r['path'], r) for r in inventory]
        effective += local_fix['files']
        active_manifest = json.loads((ROOT / 'data/manifest.json').read_text(encoding='utf-8'))
        original_manifest = json.loads(original_bytes)
        assert active_manifest['files'][:len(original_manifest['files'])] == original_manifest['files'], '原始文件编号发生变化'
        aliases = active_manifest['files'][len(original_manifest['files']):]
        assert [entry[:2] for entry in aliases] == [
            [r['path'].removeprefix('/data/'), r['bytes']] for r in local_fix['files']]
        assert active_manifest['version'] == override['version']
    # 网页中文化等本地覆盖不能改写原始采集证据。
    overrides_path = BASE / 'docs/snapshot/local-overrides.json'
    if overrides_path.exists():
        local_overrides = json.loads(overrides_path.read_text(encoding='utf-8'))
        overrides = {r['path']: r for r in local_overrides['files']}
        for rec in local_overrides['files']:
            if rec.get('original_reference'):
                original_record = next(r for r in inventory if r['path'] == rec['path'])
                assert hashlib.sha256((BASE / rec['original_reference']).read_bytes()).hexdigest() == original_record['sha256'], '原始参考文件发生变化'
            else:
                assert rec.get('added') is True, '新增本地文件必须明确记录来源'
        effective = [overrides.get(r['path'], r) for r in effective]
        existing_paths = {r['path'] for r in effective}
        effective += [rec for rec in local_overrides['files'] if rec['path'] not in existing_paths]
    missing = []
    wrong_size = []
    for rec in effective:
        path = resource_path(rec['path'])
        if not path.is_file():
            missing.append(rec['path'])
        elif path.stat().st_size != rec['bytes']:
            wrong_size.append(rec['path'])
    manifest = json.loads((BASE / 'archive/original/data-manifest.json').read_text(encoding='utf-8'))
    known = {r['path']: r for r in inventory}
    uncovered = [f[0] for f in manifest['files'] if '/data/' + f[0] not in known]
    discrepancies = [r for r in inventory if r.get('manifest_bytes') is not None and r['bytes'] != r['manifest_bytes']]
    wasm = ROOT / 'b/8b0b5899ed/game.wasm'
    with wasm.open('rb') as source:
        assert source.read(8) == b'\x00asm\x01\x00\x00\x00', 'WASM 签名无效'
    # 重算少量运行文件和着色器样本的哈希，不重复读取全部游戏资源。
    sample = [r for r in effective if r['path'] in ['/index.html', '/data/manifest.json',
        '/b/8b0b5899ed/game.js', '/b/8b0b5899ed/loader.js', '/b/8b0b5899ed/io_worker.js',
        '/b/8b0b5899ed/wgpu_worker.js', '/b/8b0b5899ed/shaders/index.json']]
    sample += [r for r in inventory if r.get('derived_from')][:2]
    if local_fix:
        sample += local_fix['files']
    if overrides_path.exists():
        sample += [rec for rec in local_overrides['files'] if rec['path'] not in {r['path'] for r in sample}]
    for rec in sample:
        assert hashlib.sha256(resource_path(rec['path']).read_bytes()).hexdigest() == rec['sha256']
    httpd = LocalServer(('127.0.0.1', 0))
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    origin = 'http://127.0.0.1:%d' % httpd.server_port
    try:
        with urlopen(origin + '/') as response:
            assert response.headers['Cross-Origin-Opener-Policy'] == 'same-origin'
            assert response.headers['Cross-Origin-Embedder-Policy'] == 'require-corp'
            assert response.read() == resource_path('/index.html').read_bytes()
        with urlopen(Request(origin + '/b/8b0b5899ed/game.wasm', headers={'Range': 'bytes=0-7'})) as response:
            assert response.status == 206 and response.read() == b'\x00asm\x01\x00\x00\x00'
        with urlopen(Request(origin + '/b/8b0b5899ed/game-multiplayer.wasm?v=melee-intent-animation-8',
                             headers={'Range': 'bytes=0-7'})) as response:
            assert response.status == 206 and response.read() == b'\x00asm\x01\x00\x00\x00'
            assert response.headers.get_content_type() == 'application/wasm'
        name = 'common/data/Clouds.xml'
        original = (ROOT / 'data' / name).read_bytes()
        body = json.dumps([[name, 0, 63], [name, 100, 131]]).encode()
        for query in ['', '?gz=1']:
            with urlopen(Request(origin + '/data/batch' + query, data=body)) as response:
                result = response.read()
                if query:
                    result = gzip.decompress(result)
                assert result == original[:64] + original[100:132]
                assert response.headers['X-Run-Lengths'] == '64,32'
    finally:
        httpd.shutdown()
        httpd.server_close()
        worker.join()
    report = {'inventory_files': len(inventory), 'inventory_bytes': sum(r['bytes'] for r in inventory),
        'data_manifest_files': len(manifest['files']), 'missing': missing, 'wrong_size': wrong_size,
        'uncovered_data_files': uncovered, 'source_size_discrepancies': discrepancies,
        'sample_sha256_passed': len(sample), 'wasm_signature': '通过',
        'http_tests': ['跨域隔离响应头', '首页内容', 'WASM 范围读取', '独立多人 WASM 带版本参数读取', '普通批量读取', 'gzip 批量读取'],
        'hash_scope': '下载时已校验所有文件的哈希；此处重新校验部分小文件。',
        'browser_game_execution': '未验证'}
    if local_fix:
        report['local_scaleform_fix'] = {
            'manifest_version': local_fix['manifest_override']['version'],
            'font_aliases_sha256_passed': len(local_fix['files']),
            'original_manifest_sha256': '通过',
            'original_file_ids': '未改变',
            'browser_validation': local_fix['browser_validation'],
        }
        if isinstance(local_fix['browser_validation'], dict):
            report['browser_game_execution'] = local_fix['browser_validation']
    (BASE / 'docs/snapshot/verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    assert not (missing or wrong_size or uncovered), '快照不完整'

if __name__ == '__main__':
    main()
