"""本地游戏服务器：提供跨域隔离响应头、范围读取和引擎批量读取。"""
import argparse, errno, gzip, io, json, mimetypes, posixpath, re, shutil, socket, subprocess, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qs, urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent / 'gta5data'
CLIENT = Path(__file__).resolve().parent / 'client'
LOG_FILE = Path(__file__).resolve().parent / 'docs' / 'snapshot' / 'browser-local.log'
LOG_LOCK = threading.Lock()
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.js')

def resource_path(url_path):
    """源码与资源分目录存放，对外仍使用原有浏览器 URL。"""
    path = posixpath.normpath(unquote(urlsplit(url_path).path)).lstrip('/')
    if path in ('', '.', 'index.html', 'play'):
        return CLIENT / 'index.html'
    if path == 'b/8b0b5899ed/loader.js':
        return CLIENT / 'loader.js'
    if path == 'multiplayer' or path.startswith('multiplayer/'):
        return CLIENT / path
    return ROOT / path

class ChineseHelpFormatter(argparse.HelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        super().add_usage(usage, actions, groups, prefix or '用法：')

class LocalServer(ThreadingHTTPServer):
    """各实例使用不同端口，从而隔离浏览器存储和引擎广播频道。"""
    daemon_threads = True

    def __init__(self, address, *, multiplayer_server='auto',
                 instance_name='玩家1', log_file=LOG_FILE):
        self.multiplayer_server = multiplayer_server
        self.instance_name = instance_name
        self.log_file = Path(log_file)
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
            413: '请求数据超过服务器允许的大小。',
            416: '请求的文件读取范围无效。',
            500: '服务器处理请求时出现错误。',
        }
        if explain is None:
            explain = descriptions.get(code, '服务器无法完成此请求。')
        super().send_error(code, message, explain)

    def __init__(self, *args, **kwargs):
        self.byte_range = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

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
        return str(resource_path(path))

    def send_head(self):
        self.byte_range = None
        route = urlsplit(self.path)
        if route.path == '/api/local-config':
            multiplayer = getattr(self.server, 'multiplayer_server', 'auto')
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
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        # 多人游戏入口只允许固定 GTA V 沙盒，不传递任何查询/调试参数。
        if route.path == '/play' or (route.path == '/play/' and route.query):
            self.send_response(307)
            self.send_header('Location', '/play/')
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
            data_root = (ROOT / 'data').resolve()
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

def create_local_servers(port=8000, instances=1, multiplayer_server='auto',
                         log_file=LOG_FILE, host='127.0.0.1'):
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
                                         instance_name='玩家%d' % (i + 1), log_file=log_file)
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
    args.add_argument('--multiplayer', action='store_true', help='打开轻量多人大厅；多实例时自动启用')
    args.add_argument('--room-server', default='auto', help='公共战局 IP:端口；默认 auto，使用网页访问 IP 的 8787 端口')
    args.add_argument('--start-room-server', action='store_true', help='一并启动本机 Java 大厅，方便多用户测试；需要 Java 17+')
    args.add_argument('--java', default='java', help='Java 可执行文件路径，用于 --start-room-server')
    args.add_argument('--open', action='store_true', help='服务器就绪后打开默认浏览器')
    args.add_argument('--log-file', type=Path, default=LOG_FILE,
                      help='保存 ?log=1 页面提交的本地诊断日志')
    options = args.parse_args(argv)
    room_process = None
    try:
        if options.start_room_server:
            room_process = start_room_server('127.0.0.1:8787' if options.room_server == 'auto' else options.room_server,
                                             options.java, '127.0.0.1' if options.host == '127.0.0.1' else '0.0.0.0')
        servers = create_local_servers(options.port, options.instances, options.room_server,
                                       options.log_file.expanduser().resolve(), options.host)
    except (OSError, ValueError) as exc:
        stop_room_server(room_process)
        args.error('无法启动本地实例：%s' % exc)
    threads = []
    try:
        for server in servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            threads.append(thread)
            suffix = ''
            if options.multiplayer or options.start_room_server or options.instances > 1:
                params = {'name': server.instance_name}
                if options.room_server != 'auto':
                    params['server'] = options.room_server
                suffix = 'multiplayer/?' + urlencode(params)
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
