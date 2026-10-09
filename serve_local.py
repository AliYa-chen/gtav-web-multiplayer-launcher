"""本地游戏服务器：提供跨域隔离响应头、范围读取和引擎批量读取。"""
import argparse, errno, gzip, hashlib, io, ipaddress, json, mimetypes, posixpath, re, shutil, socket, subprocess, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qs, parse_qsl, urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent / 'gta5data'
CLIENT = Path(__file__).resolve().parent / 'client'
RUNTIME_ROOT = CLIENT / 'runtime'
BUILD_ID = '8b0b5899ed'
ORIGINAL_WASM_SHA256 = '11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0'
# Public routes come from REMOTE_URL; only explicit development overrides use local-config.
DEFAULT_ROOM_SERVER = ''
LOG_FILE = Path(__file__).resolve().parent / 'docs' / 'snapshot' / 'browser-local.log'
LOG_LOCK = threading.Lock()
REMOTE_URL = 'https://oss.2t.hk/gtav/'
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.js')

def _remote_text(value, limit, *, optional=False):
    if (not isinstance(value, str) or len(value) > limit
            or re.search(r'[<>\x00-\x1f\x7f]', value)
            or (not optional and not value.strip())):
        raise ValueError('远程配置文字无效')
    return value.strip()


def _remote_url(value, schemes, limit=2048):
    value = _remote_text(value, limit)
    if re.search(r'\s|\\', value):
        raise ValueError('远程配置地址无效')
    url = urlsplit(value)
    if (url.scheme not in schemes or not url.hostname or url.username or url.password
            or url.fragment or (url.port is not None and not 1 <= url.port <= 65535)):
        raise ValueError('远程配置地址无效')
    _remote_host(url.hostname)
    return value


def _remote_title(value):
    """Same display-only title rule as the launcher: text or safe HTTPS."""
    value = _remote_text(value, 160, optional=True)
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', value):
        return _remote_url(value, ('https',), 160)
    return value


def _remote_host(host):
    try:
        ipaddress.ip_address(host)
        return
    except ValueError:
        pass
    if len(host) > 253 or not all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', part)
                                  for part in host.rstrip('.').split('.')):
        raise ValueError('远程服务器主机无效')


def _remote_server(value):
    if not isinstance(value, dict):
        raise ValueError('远程服务器格式无效')
    address = _remote_text(value.get('address'), 512)
    if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*://', address):
        address = _remote_url(address, ('ws', 'wss'), 512)
    else:
        if re.search(r'\s|[\\/?#@]', address):
            raise ValueError('远程服务器地址无效')
        try:
            ipaddress.IPv6Address(address)
        except ValueError:
            url = urlsplit('//' + address)
            if not url.hostname or (url.port is not None and not 1 <= url.port <= 65535):
                raise ValueError('远程服务器地址无效')
            _remote_host(url.hostname)
    result = {'address': address}
    for key, limit in (('id', 80), ('name', 80), ('role', 40), ('region', 64)):
        if key in value:
            result[key] = _remote_text(value[key], limit, optional=True)
    for key in ('health_url', 'status_url', 'websocket_url', 'ws_url'):
        if key in value:
            result[key] = _remote_url(value[key], ('https',) if key in ('health_url', 'status_url') else ('ws', 'wss'))
    if 'i18n' in value:
        translations = value['i18n']
        if not isinstance(translations, dict) or len(translations) > 2 or any(key not in ('zh-CN', 'en') for key in translations):
            raise ValueError('Invalid server translations')
        result['i18n'] = {}
        for locale, entry in translations.items():
            if not isinstance(entry, dict): raise ValueError('Invalid server translation')
            result['i18n'][locale] = {key: _remote_text(entry.get(key, ''), 80, optional=True) for key in ('name', 'role')}
            if 'region' in entry:
                result['i18n'][locale]['region'] = _remote_text(entry['region'], 64, optional=True)
    return result


def online_remote_configuration():
    """只代理已校验的状态地址和线路；不访问接口内指定的服务器URL。"""
    # 每次代理请求都联网；失败不沿用之前的内容，也不提供内置状态地址。
    try:
        with urlopen(REMOTE_URL, timeout=4) as response:
            payload = response.read(256 * 1024 + 1)
            if len(payload) > 256 * 1024:
                raise ValueError('远程配置过大')
            raw = json.loads(payload)
        if not isinstance(raw, dict):
            raise ValueError('远程配置格式无效')
        config = {'oltitle': _remote_title(raw.get('oltitle', ''))}
        for key in ('server', 'servers'):
            if key not in raw:
                continue
            values = raw[key]
            if key == 'server' and isinstance(values, dict):
                values = [values]
            if not isinstance(values, list) or len(values) > 32:
                raise ValueError('远程服务器列表无效')
            config[key] = [_remote_server(value) for value in values]
        config['servers'] = config.get('servers', config.get('server', []))
        if 'website' in raw:
            config['website'] = _remote_url(raw['website'], ('https',))
        if 'i18n' in raw:
            translations = raw['i18n']
            if not isinstance(translations, dict) or len(translations) > 2 or any(key not in ('zh-CN', 'en') for key in translations):
                raise ValueError('Invalid configuration translations')
            config['i18n'] = {}
            for locale, entry in translations.items():
                if not isinstance(entry, dict): raise ValueError('Invalid translation')
                config['i18n'][locale] = {'oltitle': _remote_title(entry.get('oltitle', ''))}
        return {'config': config, 'source': 'remote', 'stale': False}
    except (OSError, ValueError):
        return {'config': {'oltitle': ''}, 'source': 'unavailable', 'stale': True,
                'error': '远程配置暂时无法读取'}

def resolve_game_directory(value):
    """接受资源总目录或其 data 子目录，只定位，不创建、移动或修改资源。"""
    path = Path(value).expanduser().resolve()
    if (path / 'manifest.json').is_file() and path.name == 'data':
        path = path.parent
    return path


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_game_resources(game_dir=ROOT, runtime_dir=RUNTIME_ROOT, *, require_runtime=False):
    """启动前只读检查已提供资源，绝不下载游戏或写入原资源目录。"""
    root = resolve_game_directory(game_dir)
    runtime = Path(runtime_dir).expanduser().resolve()
    if runtime.is_relative_to(root):
        raise ValueError('运行副本目录不能位于游戏资源目录内，请选择启动器 client/runtime 或其它外部目录。')
    manifest_path = root / 'data/manifest.json'
    required = [manifest_path, *[root / ('b/' + BUILD_ID + '/' + name)
        for name in ('game.wasm', 'game.js', 'io_worker.js', 'wgpu_worker.js')]]
    missing = [str(path.relative_to(root)) for path in required if not path.is_file()]
    if missing:
        raise ValueError('游戏资源不完整，缺少：' + '、'.join(missing) + '。请用 --game-dir 指定自己准备的完整资源目录；启动器不会下载游戏。')
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise ValueError('无法读取游戏资源清单 data/manifest.json：' + str(error)) from error
    if (not isinstance(manifest, dict) or manifest.get('mount') != '/game/' or not isinstance(manifest.get('files'), list)
            or not all(isinstance(item, list) and len(item) >= 2 and isinstance(item[0], str)
                       and isinstance(item[1], int) and item[1] >= 0 for item in manifest['files'])):
        raise ValueError('游戏资源清单格式不兼容，需要 mount=/game/ 与有效 files 列表。')
    missing_assets = []
    data_root = root / 'data'
    for item in manifest['files']:
        name = item[0]
        source = data_root / name
        if '\\' in name or name.startswith('/') or '..' in name.split('/') or not source.resolve().is_relative_to(data_root):
            raise ValueError('游戏资源清单包含目录外路径，无法只读挂载：' + name)
        if not source.is_file():
            missing_assets.append(name)
    if missing_assets:
        raise ValueError('资源清单登记的文件缺失，共 %d 项：%s%s。请自行补齐匹配的游戏本体；启动器不会下载。' % (
            len(missing_assets), '、'.join(missing_assets[:8]), ' 等' if len(missing_assets) > 8 else ''))
    original = root / ('b/' + BUILD_ID + '/game.wasm')
    digest = file_sha256(original)
    if digest != ORIGINAL_WASM_SHA256:
        raise ValueError('原游戏引擎版本不兼容，不能使用此版本的多人适配器。请提供已支持的原 game.wasm；原文件未修改。')
    build_command = ('python3 tools/build_multiplayer_client.py --game-dir "' + str(root)
                     + '" --runtime-dir "' + str(runtime) + '"')
    ready = {}
    for mode in ('offline', 'online'):
        engine = runtime / mode / 'game.wasm'
        evidence_path = runtime / mode / 'game.json'
        if (not engine.resolve().is_relative_to(runtime) or not evidence_path.resolve().is_relative_to(runtime)
                or engine.resolve().is_relative_to(root) or evidence_path.resolve().is_relative_to(root)):
            raise ValueError('运行副本不能通过符号链接指向游戏资源目录或运行目录之外。')
        ready[mode] = engine.is_file() and evidence_path.is_file()
        if not ready[mode]:
            if mode == 'offline' or require_runtime:
                raise ValueError('缺少隔离的' + ('离线' if mode == 'offline' else '在线')
                                 + '运行副本或校验记录，请先运行 ' + build_command
                                 + '。生成物只放在启动器目录，游戏资源未修改。')
            continue
        try:
            evidence = json.loads(evidence_path.read_text(encoding='utf-8'))
            if (evidence.get('original', {}).get('sha256') != digest
                    or evidence.get('prototype', {}).get('sha256') != file_sha256(engine)
                    or evidence.get('deployment', {}).get('mode') != mode):
                raise ValueError('运行副本校验记录与模式、原引擎或生成副本不一致')
            if mode == 'offline' and file_sha256(engine) != digest:
                raise ValueError('离线运行副本必须与玩家原引擎完全一致')
        except (OSError, ValueError) as error:
            raise ValueError(mode + ' 运行副本校验失败：' + str(error) + '。请运行 ' + build_command
                             + ' 重新构建；游戏资源未修改。') from error
    return {'root': root, 'data_root': root / 'data', 'runtime_root': runtime,
            'manifest_version': manifest.get('version', ''), 'original_sha256': digest,
            'offline_ready': ready['offline'], 'multiplayer_ready': ready['online']}


class RetiredEnginePath(ValueError):
    """旧引擎入口永久停用；不能回退加载玩家目录中的引擎。"""


def normalized_resource_path(url_path):
    raw = urlsplit(url_path).path
    # 重复转义或路径规范化不能重新启用旧入口，包括大小写不敏感的文件系统。
    for _ in range(8):
        decoded = unquote(raw)
        if decoded == raw:
            break
        raw = decoded
    canonical = posixpath.normpath(raw.replace('\\', '/')).lstrip('/')
    retired = {'b/' + BUILD_ID + '/game.wasm', 'b/' + BUILD_ID + '/game-multiplayer.wasm',
               'game.wasm', 'game-multiplayer.wasm'}
    if canonical.casefold() in retired:
        raise RetiredEnginePath('旧引擎入口已停用；请使用 /engine/offline/game.wasm 或 /engine/online/game.wasm。')
    if '\\' in raw or '..' in raw.split('/'):
        raise ValueError('资源路径不能越过已选择目录')
    return canonical


def resource_path(url_path, game_root=None, runtime_root=None):
    """网页来自 client，游戏数据只读挂载，引擎仅来自隔离的运行目录。"""
    root = Path(game_root) if game_root is not None else ROOT
    runtime = Path(runtime_root) if runtime_root is not None else RUNTIME_ROOT
    path = normalized_resource_path(url_path)
    if path in ('', '.', 'index.html', 'play'):
        return CLIENT / 'index.html'
    if path == 'b/8b0b5899ed/loader.js':
        return CLIENT / 'loader.js'
    if path == 'i18n.js':
        return CLIENT / 'i18n.js'
    if path in ('engine/offline/game.wasm', 'engine/online/game.wasm'):
        selected = runtime / path.removeprefix('engine/')
        if not selected.resolve().is_relative_to(runtime.resolve()) or selected.resolve().is_relative_to(root.resolve()):
            raise ValueError('运行引擎不能指向游戏资源目录或运行目录之外')
        return selected
    if path == 'engine' or path.startswith('engine/'):
        raise ValueError('引擎只允许通过 /engine/offline/game.wasm 或 /engine/online/game.wasm 读取')
    if path == 'multiplayer' or path.startswith('multiplayer/'):
        return CLIENT / path
    selected = root / path
    if not selected.resolve().is_relative_to(root.resolve()):
        raise ValueError('资源链接不能越过已选择目录')
    if selected.suffix.casefold() == '.wasm' or selected.resolve().suffix.casefold() == '.wasm':
        raise RetiredEnginePath('游戏目录中的 WASM 不作为运行入口；请使用 /engine/offline/game.wasm 或 /engine/online/game.wasm。')
    return selected

class ChineseHelpFormatter(argparse.HelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        super().add_usage(usage, actions, groups, prefix or '用法：')

class LocalServer(ThreadingHTTPServer):
    """各实例使用不同端口，从而隔离浏览器存储和引擎广播频道。"""
    daemon_threads = True

    def __init__(self, address, *, multiplayer_server=DEFAULT_ROOM_SERVER,
                 instance_name='玩家1', log_file=LOG_FILE, game_root=ROOT, runtime_root=RUNTIME_ROOT,
                 resource_status=None, language='system'):
        if language not in ('system', 'zh-CN', 'en'):
            raise ValueError('Unsupported language preference')
        self.language = language
        self.multiplayer_server = multiplayer_server
        self.instance_name = instance_name
        self.log_file = Path(log_file)
        self.game_root = resolve_game_directory(game_root)
        self.data_root = self.game_root / 'data'
        self.runtime_root = Path(runtime_root).expanduser().resolve()
        self.resource_status = resource_status or {}
        if self.log_file.resolve().is_relative_to(self.game_root):
            raise ValueError('诊断日志不能写入游戏资源目录，请选择启动器外部日志路径。')
        super().__init__(address, Handler)

class Handler(SimpleHTTPRequestHandler):
    error_message_format = '''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>请求错误</title>
<body><h1>请求未能完成</h1><p>状态码：%(code)d</p>
<p>说明：%(explain)s</p></body></html>'''

    def send_error(self, code, message=None, explain=None):
        descriptions = {
            400: '请求参数或数据格式无效。',
            403: '没有权限访问此文件。',
            404: '未找到请求的文件或接口。',
            410: '旧引擎入口已永久停用，请刷新页面使用启动器的隔离引擎。',
            413: '请求数据超过服务器允许的大小。',
            416: '请求的文件读取范围无效。',
            500: '服务器处理请求时出现错误。',
        }
        if explain is None:
            explain = descriptions.get(code, '服务器无法完成此请求。')
        super().send_error(code, message, explain)

    def __init__(self, *args, **kwargs):
        self.byte_range = None
        super().__init__(*args, directory=str(getattr(args[2], 'game_root', ROOT)), **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Accept-Ranges', 'bytes')
        path = urlsplit(self.path).path
        if path in ('/', '/play/', '/api/local-config') or path.endswith(('.html', '.js', '.css')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def translate_path(self, path):
        return str(resource_path(path, self.server.game_root, self.server.runtime_root))

    def send_head(self):
        self.byte_range = None
        route = urlsplit(self.path)
        if route.path == '/api/language':
            body = json.dumps({'preference': self.server.language,
                               'resolved': None if self.server.language == 'system' else self.server.language,
                               'revision': 1}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        try:
            resource_path(self.path, self.server.game_root, self.server.runtime_root)
        except RetiredEnginePath as error:
            self.send_error(410, explain=str(error))
            return None
        except ValueError as error:
            self.send_error(403, explain=str(error))
            return None
        if route.path in ('/multiplayer', '/multiplayer/'):
            query = parse_qs(route.query)
            params = {'online': '1'}
            for name in ('server', 'name'):
                if query.get(name): params[name] = query[name][0]
            self.send_response(307)
            self.send_header('Location', '/?' + urlencode(params))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        if route.path == '/api/local-config':
            multiplayer = getattr(self.server, 'multiplayer_server', DEFAULT_ROOM_SERVER)
            if multiplayer == 'auto':
                try:
                    hostname = urlsplit('http://' + self.headers.get('Host', '')).hostname or 'localhost'
                except ValueError:
                    hostname = 'localhost'
                if ':' in hostname:
                    hostname = '[' + hostname + ']'
                multiplayer = hostname + ':8787'
            body = json.dumps({
                'multiplayer_server': multiplayer,
                'instance_name': getattr(self.server, 'instance_name', '玩家1'),
                'game_path': '/play/', 'mode': 'sandbox', 'map': 'gta5',
                'debug': False,
                'resources_ready': bool(self.server.resource_status),
                'multiplayer_ready': self.server.resource_status.get('multiplayer_ready', False),
                'resource_version': self.server.resource_status.get('manifest_version', ''),
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        if route.path == '/api/remote-config':
            body = json.dumps(online_remote_configuration(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return io.BytesIO(body)
        # Preserve only the launcher's entry data. Engine/map/debug options are
        # never forwarded into the fixed public-session sandbox.
        launch_fields = ('launcher', 'mode', 'name', 'server', 'preset', 'seed')
        launch_query = parse_qsl(route.query, keep_blank_values=True)
        allowed_query = [(key, value) for key, value in launch_query if key in launch_fields]
        if not any(key == 'launcher' and value == '1' for key, value in allowed_query):
            allowed_query = []
        safe_play_query = urlencode(allowed_query)
        if route.path == '/play' or (route.path == '/play/' and route.query != safe_play_query):
            self.send_response(307)
            self.send_header('Location', '/play/' + ('?' + safe_play_query if safe_play_query else ''))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        if not self.headers.get('Range'):
            return super().send_head()
        path = Path(self.translate_path(self.path))
        if not path.is_file():
            self.send_error(404)
            return None
        size = path.stat().st_size
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers['Range'])
        if not match or not any(match.groups()):
            self.send_error(416)
            return None
        start = int(match[1]) if match[1] else max(0, size - int(match[2]))
        end = min(size - 1, int(match[2])) if match[1] and match[2] else size - 1
        if start >= size or end < start:
            self.send_response(416)
            self.send_header('Content-Range', 'bytes */%d' % size)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        self.byte_range = (start, end)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(str(path)))
        self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        source = path.open('rb')
        source.seek(start)
        return source

    def copyfile(self, source, outputfile):
        if self.byte_range is None:
            return super().copyfile(source, outputfile)
        remaining = self.byte_range[1] - self.byte_range[0] + 1
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == '/api/language':
            body = b'Language configuration is read-only.'
            self.send_response(405)
            self.send_header('Allow', 'GET, HEAD')
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if url.path not in ('/data/batch', '/log'):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0:
                raise ValueError('请求长度不能为负数')
        except ValueError:
            self.send_error(400, 'Invalid Content-Length', '请求长度无效')
            return
        if length > 1024 * 1024:
            self.send_error(413)
            return
        if url.path == '/log':
            # 页面启用 ?log=1 后会向此接口提交诊断信息。
            # 日志仅存储在本机，放在 HTTP 公开目录之外。
            body = self.rfile.read(length).decode('utf-8', errors='replace')
            stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            try:
                with LOG_LOCK:
                    log_file = Path(getattr(self.server, 'log_file', LOG_FILE))
                    log_file.parent.mkdir(parents=True, exist_ok=True)
                    with log_file.open('a', encoding='utf-8') as output:
                        output.write('[%s] %s\n' % (stamp, body))
            except OSError as exc:
                self.send_error(500, 'Cannot write diagnostic log', '无法写入本地诊断日志')
                self.log_error('本地诊断日志：%s', exc)
                return
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        try:
            runs = json.loads(self.rfile.read(length))
            if not isinstance(runs, list) or len(runs) > 1000:
                raise ValueError('批量请求格式无效')
            selected = []
            data_root = self.server.data_root.resolve()
            for name, start, end in runs:
                file = (data_root / name).resolve()
                if not file.is_relative_to(data_root) or start < 0 or end < start:
                    raise ValueError('文件路径或读取范围无效')
                selected.append((file, start, max(0, min(end + 1, file.stat().st_size) - start)))
            total = sum(n for _, _, n in selected)
            if total > 64 * 1024 * 1024:
                raise ValueError('批量请求超过 64 MiB')
            output = io.BytesIO()
            for file, start, n in selected:
                with file.open('rb') as source:
                    source.seek(start)
                    output.write(source.read(n))
            body = output.getvalue()
            compressed = parse_qs(url.query).get('gz') == ['1']
            if compressed:
                body = gzip.compress(body, compresslevel=1)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Run-Lengths', ','.join(str(n) for _, _, n in selected))
            if compressed:
                self.send_header('Content-Encoding', 'gzip')
            self.end_headers()
            self.wfile.write(body)
        except (ValueError, TypeError, OSError) as exc:
            self.send_error(400, 'Invalid batch request', str(exc))

    def log_request(self, code='-', size='-'):
        # 引擎日志每秒可能提交多次；省略成功日志，保留 HTTP 错误。
        if urlsplit(self.path).path == '/log' and str(code) == '204':
            return
        super().log_request(code, size)

def create_local_servers(port=8000, instances=1, multiplayer_server=DEFAULT_ROOM_SERVER,
                         log_file=LOG_FILE, host='127.0.0.1', game_root=ROOT, runtime_root=RUNTIME_ROOT,
                         resource_status=None, language='system'):
    """创建若干独立本地实例；端口占用时寻找下一个可用端口。"""
    if not 0 <= port <= 65535 or not 1 <= instances <= 8:
        raise ValueError('端口须在 0～65535 之间，实例数量须在 1～8 之间')
    servers = []
    candidate = port
    try:
        for i in range(instances):
            for attempt in range(100):
                if candidate > 65535:
                    raise ValueError('没有可用的后续端口')
                try:
                    server = LocalServer((host, candidate),
                                         multiplayer_server=multiplayer_server,
                                         instance_name='玩家%d' % (i + 1), log_file=log_file,
                                         game_root=game_root, runtime_root=runtime_root, resource_status=resource_status, language=language)
                    break
                except OSError as exc:
                    if exc.errno != errno.EADDRINUSE or candidate == 0 or attempt == 99:
                        raise
                    candidate += 1
            if i:
                log_path = Path(log_file)
                server.log_file = log_path.with_name('%s-%d%s' % (
                    log_path.stem, server.server_port, log_path.suffix))
            servers.append(server)
            if port:
                candidate = server.server_port + 1
        return servers
    except Exception:
        for server in servers:
            server.server_close()
        raise


def start_room_server(address, java='java', listen_host='127.0.0.1'):
    """可选的一键本机测试：启动轻量 Java 大厅，停止本地实例时一起退出。"""
    endpoint = urlsplit(address if '://' in address else 'ws://' + address)
    if (endpoint.scheme not in ('ws', 'http') or endpoint.hostname not in ('localhost', '127.0.0.1')
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ('', '/', '/ws')):
        raise ValueError('--start-room-server 仅用于 localhost / 127.0.0.1 的本地大厅')
    port = endpoint.port or 8787
    jar = Path(__file__).resolve().parent / 'server/multiplayer-server.jar'
    if not jar.is_file():
        raise ValueError('未找到服务端 JAR，请先运行 python3 tools/build_multiplayer_server.py')
    executable = shutil.which(java)
    if not executable:
        raise ValueError('未找到 Java，请安装 Java 17 或更新版本')
    process = subprocess.Popen([executable, '-jar', str(jar), '--host', listen_host, '--port', str(port)])
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise ValueError('Java 大厅启动失败，请查看上方日志（可能端口占用或 Java 版本过低）')
            try:
                with urlopen('http://127.0.0.1:%d/health' % port, timeout=.5) as response:
                    status = json.load(response)
                    if (status.get('protocol') == 1 and status.get('map') == 'gta5'
                            and status.get('game_sync') is False):
                        # 给占用端口导致子进程退出的情况留一个检测窗口。
                        time.sleep(.15)
                        if process.poll() is not None:
                            raise ValueError('Java 大厅进程已退出，请检查端口占用')
                        return process
            except (OSError, json.JSONDecodeError):
                pass
            time.sleep(.1)
        raise ValueError('Java 大厅启动超时，请查看上方日志')
    except BaseException:
        stop_room_server(process)
        raise


def stop_room_server(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def lan_addresses():
    """识别可展示的 IPv4 局域网地址；不会向外发送网络数据。"""
    addresses = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if not address.startswith('127.') and address != '0.0.0.0':
                addresses.add(address)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('192.0.2.1', 9))  # 仅查询系统选用的本地接口，不发送数据。
            address = probe.getsockname()[0]
            if not address.startswith('127.') and address != '0.0.0.0':
                addresses.add(address)
    except OSError:
        pass
    return sorted(addresses)


def main(argv=None):
    args = argparse.ArgumentParser(description='启动离线游戏的本地 HTTP 服务器',
                                   add_help=False, formatter_class=ChineseHelpFormatter)
    args._optionals.title = '选项'
    args.add_argument('-h', '--help', action='help', help='显示帮助并退出')
    args.add_argument('--port', type=int, default=8000, help='起始端口，默认 8000；占用时自动顺延，0 表示随机端口')
    args.add_argument('--host', default='0.0.0.0', help='监听地址，默认 0.0.0.0，允许局域网访问；127.0.0.1 仅本机')
    args.add_argument('--instances', type=int, default=1, help='同时启动 1～8 个本地实例，使用不同端口模拟用户')
    args.add_argument('--game-dir', type=Path, default=ROOT, help='玩家自行准备的资源总目录（含 data 与 b），也可选其 data 子目录；只读使用')
    args.add_argument('--runtime-dir', type=Path, default=RUNTIME_ROOT, help='启动器生成的离线/在线运行目录，默认 client/runtime；浏览器不读取游戏目录内任何 WASM')
    args.add_argument('--multiplayer', action='store_true', help='打开轻量多人大厅；多实例时自动启用')
    args.add_argument('--room-server', default=DEFAULT_ROOM_SERVER,
                      help='开发时显式指定战局 IP:端口；默认不提供地址，公共线路通过远程接口读取')
    args.add_argument('--start-room-server', action='store_true', help='一并启动本机 Java 大厅，方便多用户测试；需要 Java 17+')
    args.add_argument('--java', default='java', help='Java 可执行文件路径，用于 --start-room-server')
    args.add_argument('--open', action='store_true', help='服务器就绪后打开默认浏览器')
    args.add_argument('--language', choices=['system', 'zh-CN', 'en'], default='system', help='网页与游戏语言：跟随浏览器系统／中文／英文')
    args.add_argument('--log-file', type=Path, default=LOG_FILE,
                      help='保存 ?log=1 页面提交的本地诊断日志')
    options = args.parse_args(argv)
    room_process = None
    try:
        resources = inspect_game_resources(options.game_dir, options.runtime_dir,
                                          require_runtime=options.multiplayer or options.start_room_server or options.instances > 1)
        if options.start_room_server:
            # Explicit local development startup exposes the same resolved address
            # to /api/local-config; public mode still has no built-in route.
            if not options.room_server:
                options.room_server = '127.0.0.1:8787'
            room_process = start_room_server('127.0.0.1:8787' if options.room_server == 'auto' else options.room_server,
                                             options.java, '127.0.0.1' if options.host == '127.0.0.1' else '0.0.0.0')
        servers = create_local_servers(options.port, options.instances, options.room_server,
                                       options.log_file.expanduser().resolve(), options.host,
                                       resources['root'], resources['runtime_root'], resources,options.language)
    except (OSError, ValueError) as exc:
        stop_room_server(room_process)
        args.error('无法启动本地实例：%s' % exc)
    threads = []
    try:
        print('只读游戏资源：%s' % resources['root'], flush=True)
        if not resources['multiplayer_ready']:
            print('多人运行副本尚未构建；进入战局前请运行 tools/build_multiplayer_client.py。', flush=True)
        for server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            threads.append(thread)
            suffix = ''
            if options.multiplayer or options.start_room_server or options.instances > 1:
                params = {'name': server.instance_name}
                if options.room_server != 'auto':
                    params['server'] = options.room_server
                suffix = '?' + urlencode({'online': '1', **params})
            address = 'http://localhost:%d/%s' % (server.server_port, suffix)
            print('%s：%s' % (server.instance_name, address), flush=True)
            if options.port and server.server_port != options.port + len(threads) - 1:
                print('指定端口已占用，已使用可用端口 %d。' % server.server_port, flush=True)
            if options.open:
                webbrowser.open(address)
            if options.host == '0.0.0.0':
                for ip in lan_addresses():
                    print('局域网 %s：http://%s:%d/%s' % (server.instance_name, ip, server.server_port, suffix), flush=True)
        print('多人大厅服务器：%s%s' % (options.room_server,
              '（由本命令启动）' if room_process else '（单独启动 server/multiplayer-server.jar）'), flush=True)
        print('各实例独立存储与引擎频道；按 Ctrl+C 一起停止。', flush=True)
        if options.host != '127.0.0.1':
            print('局域网 HTTP 可访问公共战局页面；实际 GTA 画面需要 HTTPS 或玩家本机 localhost。', flush=True)
        while True:
            if room_process is not None and room_process.poll() is not None:
                print('Java 大厅已退出，本地实例一起停止。', flush=True)
                break
            time.sleep(.25)
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for thread in threads:
            thread.join(timeout=2)
        stop_room_server(room_process)


if __name__ == '__main__':
    main()
