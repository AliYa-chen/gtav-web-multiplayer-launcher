"""使用 Python 标准库下载公开资源快照，支持断点续传。"""
import argparse, concurrent.futures, hashlib, json, os, re, shutil, threading, time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
import ipaddress

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'gta5data'
STATE = ROOT / 'docs' / 'snapshot'
ORIGINAL = ROOT / 'archive' / 'original'
ORIGIN = ''
BUILD = '/b/8b0b5899ed'
RATE = 24 * 1024 * 1024
WORKERS = 3
lock = threading.Lock()
rate_lock = threading.Lock()
rate_next = time.monotonic()
received = 0
completed = 0
started = time.monotonic()
records = {}
failures = []

def validate_origin(value):
    """只接受带合法主机名的 HTTP(S) 根源地址，不携带凭据或附加参数。"""
    if not value or any(c.isspace() or ord(c) < 32 for c in value):
        raise argparse.ArgumentTypeError('资源来源地址不能为空，也不能包含空白或控制字符')
    try:
        parts = urlsplit(value)
        host, port = parts.hostname, parts.port
    except ValueError as exc:
        raise argparse.ArgumentTypeError('资源来源地址格式无效') from exc
    if (parts.scheme not in ('http', 'https') or not host or parts.username is not None
            or parts.password is not None or parts.path not in ('', '/')
            or '?' in value or '#' in value or '\\' in value or parts.netloc.endswith(':')):
        raise argparse.ArgumentTypeError('资源来源须为 HTTP(S) 根地址，例如 https://资源域名:端口；不能包含凭据、路径或参数')
    try:
        ipaddress.ip_address(host)
        normalized_host = '[' + host + ']' if ':' in host else host
    except ValueError:
        try:
            ascii_host = host.encode('idna').decode('ascii').rstrip('.')
        except UnicodeError as exc:
            raise argparse.ArgumentTypeError('资源来源主机名无效') from exc
        if not ascii_host or len(ascii_host) > 253 or any(
                not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                for label in ascii_host.split('.')):
            raise argparse.ArgumentTypeError('资源来源主机名无效')
        normalized_host = ascii_host.lower()
    if port is not None and not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError('资源来源端口须在 1～65535 之间')
    return parts.scheme + '://' + normalized_host + (':' + str(port) if port is not None else '')

def target_path(path):
    """限定所有快照输出在 gta5data 内，拒绝路径穿越及链接逃逸。"""
    if not path.startswith('/') or any(c in path for c in ('\\', ':', '\0')) or '..' in path.split('/'):
        raise ValueError('不安全的资源路径 ' + path)
    target = (SITE / path.lstrip('/')).resolve()
    if not target.is_relative_to(SITE.resolve()):
        raise ValueError('资源路径超出 gta5data 目录 ' + path)
    return target

def emit(message):
    with lock:
        with (STATE / 'download.log').open('a', encoding='utf-8') as out:
            out.write(time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + message + '\n')
    print(message, flush=True)

def throttle(n):
    global rate_next, received
    if RATE:
        with rate_lock:
            now = time.monotonic()
            rate_next = max(now, rate_next) + n / RATE
            delay = rate_next - now
        if delay > 0:
            time.sleep(delay)
    with lock:
        received += n

def download(task):
    global completed
    path, expected, query = task
    target = target_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    url = ORIGIN + quote(path, safe='/') + query
    previous = records.get(path)
    if target.exists() and previous and target.stat().st_size == previous['bytes']:
        with lock:
            completed += 1
        return
    partial = target.with_name(target.name + '.part')
    for attempt in range(4):
        try:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {'User-Agent': 'PersonalResearchSnapshot/1.0', 'Accept-Encoding': 'identity'}
            if offset:
                headers['Range'] = 'bytes=%d-' % offset
            with urlopen(Request(url, headers=headers), timeout=60) as response:
                status = response.status
                if status != 206:
                    offset = 0
                if status == 206 and not response.headers.get('Content-Range', '').startswith('bytes %d-' % offset):
                    raise ValueError('断点续传响应的 Content-Range 无效')
                length = response.headers.get('Content-Length')
                actual_expected = offset + int(length) if length is not None else None
                if status == 206 and actual_expected is None:
                    actual_expected = int(response.headers['Content-Range'].split('/')[-1])
                if 'text/html' in response.headers.get('Content-Type', '') and not path.endswith(('.html', '/')):
                    raise ValueError('资源请求返回了 HTML 页面')
                digest = hashlib.sha256()
                if offset:
                    with partial.open('rb') as old:
                        while chunk := old.read(1024 * 1024):
                            digest.update(chunk)
                with partial.open('ab' if offset else 'wb') as out:
                    while chunk := response.read(256 * 1024):
                        throttle(len(chunk))
                        out.write(chunk)
                        digest.update(chunk)
                size = partial.stat().st_size
                if actual_expected is not None and size != actual_expected:
                    raise ValueError('响应内容长度 %d 与预期 %d 不一致' % (size, actual_expected))
                os.replace(partial, target)
                rec = {'path': path, 'url': url, 'bytes': size, 'sha256': digest.hexdigest(),
                       'manifest_bytes': expected, 'etag': response.headers.get('ETag'),
                       'last_modified': response.headers.get('Last-Modified')}
                with lock:
                    records[path] = rec
                    completed += 1
                    with (STATE / 'files.jsonl').open('a', encoding='utf-8') as out:
                        out.write(json.dumps(rec) + '\n')
                if expected is not None and size != expected:
                    emit('文件大小不一致 ' + path + ': 清单=%d 服务器=%d' % (expected, size))
                return
        except Exception as exc:
            emit('第 %d 次尝试失败 %s: %s' % (attempt + 1, path, exc))
            if isinstance(exc, HTTPError) and exc.code == 416 and partial.exists():
                partial.unlink()
            if attempt < 3:
                time.sleep(2 ** (attempt + 1))
    with lock:
        failures.append({'path': path, 'url': url, 'error': str(exc) if 'exc' in locals() else '请查看下载日志'})

def add_existing(path, source):
    # 从原始副本记录采集时的元数据，保留运行目录已有的字体和页面修复。
    original = ORIGINAL / source
    b = original.read_bytes()
    target = target_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copyfile(original, target)
    records[path] = {'path': path, 'url': ORIGIN + path, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest(), 'manifest_bytes': None}

def main(argv=None):
    global ORIGIN, WORKERS, RATE, records, failures, received, completed, started, rate_next
    parser = argparse.ArgumentParser(description='下载或补齐公开资源快照，保留已有的本地启动和页面修复。')
    parser.add_argument('--origin', default=os.environ.get('GTA5DATA_SOURCE_URL'), type=validate_origin,
                        help='资源来源的 HTTP(S) 根地址；也可使用 GTA5DATA_SOURCE_URL 环境变量')
    parser.add_argument('--workers', type=int, default=3, help='并发下载数量，默认为 3')
    parser.add_argument('--rate-mib', type=float, default=24, help='总下载速率上限（MiB/秒），0 表示不限速')
    args = parser.parse_args(argv)
    if not args.origin:
        parser.error('请通过 --origin 或 GTA5DATA_SOURCE_URL 指定资源来源地址')
    ORIGIN, WORKERS = args.origin, args.workers
    try:
        RATE = int(args.rate_mib * 1024 * 1024)
    except (ValueError, OverflowError):
        parser.error('下载速率须为有限的非负数')
    if WORKERS < 1 or RATE < 0:
        parser.error('并发下载数量必须大于 0，下载速率不能为负数')
    required = ['homepage.html', 'loader.js', 'game.js', 'io_worker.js', 'wgpu_worker.js',
                'data-manifest.json', 'shader-index.json']
    missing = [name for name in required if not (ORIGINAL / name).is_file()]
    if missing:
        parser.error('缺少 archive/original 中的采集参考文件：' + '、'.join(missing)
                     + '；请先准备本地资源快照，Git 仓库不包含游戏数据')
    STATE.mkdir(parents=True, exist_ok=True)
    SITE.mkdir(parents=True, exist_ok=True)
    records, failures, received, completed = {}, [], 0, 0
    started = rate_next = time.monotonic()
    if (STATE / 'files.jsonl').exists():
        for line in (STATE / 'files.jsonl').read_text(encoding='utf-8').splitlines():
            try:
                rec = json.loads(line)
                records[rec['path']] = rec
            except ValueError:
                pass
    for path, source in [('/index.html', 'homepage.html'), (BUILD + '/loader.js', 'loader.js'),
                         (BUILD + '/game.js', 'game.js'), (BUILD + '/io_worker.js', 'io_worker.js'),
                         (BUILD + '/wgpu_worker.js', 'wgpu_worker.js'), ('/data/manifest.json', 'data-manifest.json'),
                         (BUILD + '/shaders/index.json', 'shader-index.json')]:
        add_existing(path, source)
    manifest = json.loads((ORIGINAL / 'data-manifest.json').read_text(encoding='utf-8'))
    shaders = json.loads((ORIGINAL / 'shader-index.json').read_text(encoding='utf-8'))
    version = manifest['version']
    tasks = [(BUILD + '/game.wasm', 63201802, ''), (BUILD + '/audio-worklet.js', None, ''),
             ('/data/bootset.json', None, ''), ('/data/bootset_low.json', None, ''),
             (BUILD + '/shaders/pipelines.json', None, ''), (BUILD + '/shaders/pipelines_low.json', None, '')]
    tasks += [(BUILD + '/shaders/' + p['file'], p['bytes'], '') for p in shaders['_packs']]
    art = ['beach_bg', 'beach_fg'] + ['ls%d_background' % i for i in range(17)]
    art += ['ls%d_foreground' % i for i in range(17) if i != 12]
    art += ['ls1_foreground_franklin', 'ls2_foreground_chop', 'ls12_foreground_michael']
    tasks += [(BUILD + '/title/art/' + name + '.webp', None, '') for name in art]
    tasks += [(BUILD + '/title/' + name, None, '') for name in ['logo.png', 'spinner.png', 'chalet.woff']]
    for key, rec in shaders.items():
        if isinstance(rec, dict) and rec.get('ok') and not rec.get('p'):
            tasks.append((BUILD + '/shaders/' + key + '.wgsl', None, ''))
            if rec.get('consts'):
                tasks.append((BUILD + '/shaders/' + key + '.consts.json', None, ''))
    tasks += [('/data/' + f[0], f[1], '?v=' + quote(version)) for f in manifest['files']]
    # 写入资源前检查路径穿越和 Windows 文件名大小写冲突。
    names = set()
    for path, _, _ in tasks:
        target_path(path)
        folded = path.casefold()
        if folded in names:
            raise ValueError('文件名大小写冲突 ' + path)
        names.add(folded)
    (STATE / 'download-plan.json').write_text(json.dumps({'origin': ORIGIN, 'build': BUILD, 'version': version,
        'workers': WORKERS, 'bandwidth_cap_bytes_s': RATE, 'tasks': tasks}, indent=2), encoding='utf-8')
    emit('开始下载：进程=%d 文件=%d 数据字节=%d 限速字节/秒=%d' % (os.getpid(), len(tasks), sum(f[1] for f in manifest['files']), RATE))
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(download, task) for task in tasks]
        while any(not f.done() for f in futures):
            time.sleep(10)
            elapsed = time.monotonic() - started
            summary = {'pid': os.getpid(), 'completed': completed, 'total': len(tasks), 'received_bytes_this_run': received,
                       'elapsed_seconds': round(elapsed), 'average_MiB_s': round(received / max(1, elapsed) / 2**20, 2), 'failures': len(failures)}
            (STATE / 'status.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
            emit('下载进度 ' + json.dumps(summary))
        for f in futures:
            f.result()
    # 从着色器包展开资源，避免重复发起数千次 HTTP 请求。
    expanded = 0
    for key, rec in shaders.items():
        if not isinstance(rec, dict) or not rec.get('ok') or not rec.get('p'):
            continue
        k, off, wl, cl = rec['p']
        pack_path = BUILD + '/shaders/' + shaders['_packs'][k]['file']
        pack = target_path(pack_path)
        if not pack.exists():
            continue
        with pack.open('rb') as src:
            src.seek(off)
            b = src.read(wl + cl)
        if len(b) != wl + cl:
            raise ValueError('着色器包内容不完整 ' + key)
        for suffix, content in [('.wgsl', b[:wl])] + ([('.consts.json', b[wl:])] if cl else []):
            path = BUILD + '/shaders/' + key + suffix
            target_path(path).write_bytes(content)
            records[path] = {'path': path, 'url': ORIGIN + path, 'bytes': len(content),
                'sha256': hashlib.sha256(content).hexdigest(), 'derived_from': pack_path, 'offset': off if suffix == '.wgsl' else off + wl}
            expanded += 1
    (STATE / 'manifest-sha256.json').write_text(json.dumps(list(records.values()), indent=2), encoding='utf-8')
    (STATE / 'failures.json').write_text(json.dumps(failures, indent=2), encoding='utf-8')
    emit('下载结束：完成=%d 失败=%d 展开的着色器文件=%d' % (completed, len(failures), expanded))
    return 1 if failures else 0

if __name__ == '__main__':
    raise SystemExit(main())
