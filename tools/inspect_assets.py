"""提取重点平台与来源证据；不解包归档，也不进行反编译。"""
import collections, difflib, json, re, struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'gta5data/data'
FILES = json.loads((ROOT / 'archive/original/data-manifest.json').read_text())['files']

def main():
    headers = []
    counts = collections.Counter()
    extbytes = collections.Counter()
    for name, size, *_ in FILES:
        extbytes[Path(name).suffix] += size
        if name.endswith('.rpf'):
            with (DATA / name).open('rb') as source:
                raw = source.read(16)
            magic, entries, names_bytes, encryption = struct.unpack('<4I', raw)
            counts[(raw[:4].hex(), hex(encryption))] += 1
            headers.append({'path': name, 'bytes': size, 'header_hex': raw.hex(), 'magic_le': hex(magic),
                            'entries': entries, 'names_bytes': names_bytes, 'encryption_le': hex(encryption)})
    startup = (DATA / 'x64/data/startup.ymt').read_bytes()
    pc_marker = b'platform:/data/cdimages/scaleform_platform_pc.rpf'
    shader_info = []
    for name in ['common/shaders/win32_40/adaptiveDof.fxc', 'common/shaders/win32_nvstereo/default.fxc']:
        body = (DATA / name).read_bytes()
        off = body.find(b'DXBC')
        chunk_count = struct.unpack_from('<I', body, off + 28)[0]
        shader_models = []
        for i in range(chunk_count):
            rel = struct.unpack_from('<I', body, off + 32 + 4 * i)[0]
            kind = body[off + rel:off + rel + 4]
            if kind in [b'SHDR', b'SHEX']:
                token = struct.unpack_from('<I', body, off + rel + 8)[0]
                shader_models.append({'kind': kind.decode(), 'offset': off + rel + 8, 'token': hex(token),
                                      'major': (token >> 4) & 15, 'minor': token & 15, 'stage': token >> 16})
        compilers = [{'offset': m.start(), 'text': m.group().decode()}
                     for m in re.finditer(rb'Microsoft \(R\) HLSL Shader Compiler [0-9.]+', body)]
        shader_info.append({'path': name, 'bytes': len(body), 'dxbc_count': body.count(b'DXBC'),
                            'first_dxbc_offset': off, 'first_container_shader_models': shader_models,
                            'compiler_strings': compilers})
    resource_info = []
    for name, *_ in FILES:
        if Path(name).suffix in ['.ytd', '.ydd'] and len(resource_info) < 6:
            with (DATA / name).open('rb') as source:
                raw = source.read(16)
            resource_info.append({'path': name, 'header_hex': raw.hex(),
                                  'resource_version_le': struct.unpack_from('<I', raw, 4)[0]})
    before = (DATA / 'common/data/levels/env_test/images.meta.orig').read_text().splitlines()
    after = (DATA / 'common/data/levels/env_test/images.meta').read_text().splitlines()
    report = {'rpf_headers': headers, 'rpf_header_counts': [
        {'magic_bytes': k[0], 'encryption': k[1], 'count': n} for k, n in counts.items()],
        'bytes_by_extension': dict(extbytes),
        'startup_pc_marker': {'path': 'x64/data/startup.ymt', 'offset': startup.find(pc_marker), 'text': pc_marker.decode()},
        'shader_samples': shader_info, 'resource_samples': resource_info,
        'version_txt': (DATA / 'common/data/version.txt').read_text(),
        'dlc_actual_paths': [f[0] for f in FILES if 'dlcpacks' in f[0].lower()],
        'movie_paths': [f[0] for f in FILES if f[0].lower().endswith(('.bik', '.bk2', '.mp4'))],
        'env_test_florida_paths': [f[0] for f in FILES if 'env_test' in f[0] and 'florida' in f[0].lower()],
        'env_test_mount_list': {'original_lines': len(before), 'current_lines': len(after),
             'diff': list(difflib.unified_diff(before, after, fromfile='images.meta.orig', tofile='images.meta'))},
        'scope': '每个 RPF 读取 16 字节；检查两个着色器容器、六个资源文件头及选定元数据。不解密归档。'}
    (ROOT / 'docs/snapshot/asset-evidence.json').write_text(json.dumps(report, indent=2))
    print('RPF 文件头统计：', report['rpf_header_counts'])
    print('PC 平台标记：', report['startup_pc_marker'])
    print('着色器编译器：', shader_info[0]['compiler_strings'][0])
    print('版本与挂载列表证据已保存到 docs/snapshot/asset-evidence.json')

if __name__ == '__main__':
    main()
