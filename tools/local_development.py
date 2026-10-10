"""Build and restart checkout-owned local development processes (macOS/Linux)."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request
import uuid

from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_output

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
LOCAL = ROOT / "archive/local-dev"
STATE = LOCAL / "processes.json"
BUILD = LOCAL / "build"


def say(message):
    print(message, flush=True)


def safe_tree(directory, *, hardlink_root=None):
    """Reject unsafe builder outputs; Cargo may link only its own output files."""
    directory = Path(directory)
    hardlink_root = Path(hardlink_root) if hardlink_root is not None else None
    if hardlink_root is not None and not hardlink_root.is_relative_to(directory):
        raise ValueError("硬链接授权目录必须位于检查目录内。")
    # Never follow output/cache symlinks into any selected game directory.
    for part in (directory, *directory.parents):
        if part.is_symlink():
            raise ValueError(f"输出目录不能经过符号链接：{part}")
        if part.exists() and not part.is_dir():
            raise ValueError(f"输出目录不是目录：{part}")
    validate_output(directory / ".output-boundary")
    linked = {}

    def fail_scan(error):
        raise error

    if directory.exists():
        for parent, dirs, files in os.walk(directory, followlinks=False, onerror=fail_scan):
            for name in dirs + files:
                path = Path(parent) / name
                info = path.lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise ValueError(f"构建目录含符号链接：{path}")
                if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                    raise ValueError(f"构建目录含非普通文件：{path}")
                if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                    if hardlink_root is None or not path.is_relative_to(hardlink_root):
                        raise ValueError(f"构建目录含未授权硬链接：{path}")
                    linked.setdefault((info.st_dev, info.st_ino), []).append((path, info.st_nlink))
    # All aliases of an allowed inode must be accounted for within Cargo's
    # isolated output tree; an alias outside it could be a read-only input.
    for aliases in linked.values():
        if any(count != len(aliases) for _, count in aliases):
            raise ValueError(f"构建目录含外部硬链接：{aliases[0][0]}")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def write_json(path, value):
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def processes():
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,lstart=,args="],
                            capture_output=True, text=True, check=True)
    records = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) != 8:
            continue
        try:
            pid, parent = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        records[pid] = {"pid": pid, "parent": parent,
                        "started": " ".join(parts[2:7]), "command": parts[7]}
    return records


def same_process(record, current):
    return bool(current and all(record.get(key) == current.get(key)
                                for key in ("pid", "started", "command")))


def process_cwd(pid):
    result = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                            capture_output=True, text=True)
    return next((Path(line[1:]) for line in result.stdout.splitlines() if line.startswith("n")), None)


def saved_processes():
    if not STATE.exists():
        return []
    validate_output(STATE)
    data = json.loads(STATE.read_text())
    if data.get("root") != str(ROOT) or data.get("schema") != 1:
        raise ValueError("本地进程记录与当前仓库不匹配，未停止任何进程。")
    return data.get("processes", [])


def owned_processes():
    """PID reuse cannot authorize a kill; legacy dev commands also need a cwd."""
    table = processes()
    owned = {item["pid"]: table[item["pid"]] for item in saved_processes()
             if same_process(item, table.get(item.get("pid")))}
    for pid, item in table.items():
        command = item["command"]
        if pid == os.getpid():
            continue
        try:
            args = shlex.split(command)
        except ValueError:
            continue
        if not args:
            continue
        program = Path(args[0]).name
        candidate = (program == "java" and "-jar" in args) or (
            "gta5data-launcher" == program) or (
            program in ("node", "npm") and "tauri" in command and "dev" in args)
        if not candidate:
            continue
        cwd = process_cwd(pid)
        if not cwd or cwd.resolve() not in (ROOT, DESKTOP, DESKTOP / "src-tauri"):
            continue
        if program == "java":
            index = args.index("-jar")
            if index + 1 >= len(args) or "--host" not in args:
                continue
            host = args.index("--host")
            if host + 1 >= len(args) or args[host + 1] not in ("127.0.0.1", "localhost", "::1"):
                continue
            jar = (cwd / args[index + 1]).resolve()
            if jar.name != "multiplayer-server.jar" or not (
                    jar.is_relative_to(ROOT / "archive") or jar == ROOT / "server/multiplayer-server.jar"):
                continue
        elif program == "gta5data-launcher":
            executable = (cwd / args[0]).resolve()
            if executable != DESKTOP / "src-tauri/target/debug/gta5data-launcher" and not executable.is_relative_to(LOCAL):
                continue
        elif str(DESKTOP) not in command and not (command.startswith("npm run tauri ") and cwd == DESKTOP):
            continue
        owned[pid] = item
    # Include Vite and wrappers only when descended from an identified dev root.
    changed = True
    while changed:
        changed = False
        for pid, item in table.items():
            if item["parent"] in owned and pid not in owned:
                owned[pid] = item
                changed = True
    return list(owned.values())


def stop_processes(records, *, force=False):
    live = {item["pid"]: item for item in records}
    current = processes()
    for pid, item in live.items():
        if same_process(item, current.get(pid)):
            try:
                os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + (3 if force else 8)
    while live and time.monotonic() < deadline:
        time.sleep(.15)
        current = processes()
        live = {pid: item for pid, item in live.items() if same_process(item, current.get(pid))}
    for pid, item in live.items():
        if same_process(item, processes().get(pid)):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if live:
        time.sleep(.2)
    current = processes()
    if any(same_process(item, current.get(item["pid"])) for item in records):
        raise RuntimeError("旧本地进程未能停止，未启动第二份服务。")


def port_available(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def check_port(port, owned):
    if port_available(port):
        return
    result = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                            capture_output=True, text=True)
    listeners = {int(value) for value in result.stdout.split() if value.isdigit()}
    if not listeners or not listeners.issubset({item["pid"] for item in owned}):
        raise RuntimeError(f"端口 {port} 被其他程序占用；未停止它。可使用 --port 指定另一个端口。")


def build_environment():
    env = os.environ.copy()
    # Do not inherit a production target/config or a cache path selected by an
    # unrelated shell task. All generated build products belong to this runner.
    for name in ("TAURI_CONFIG", "CARGO_BUILD_TARGET", "CARGO_TARGET_DIR"):
        env.pop(name, None)
    if not shutil.which("cargo", path=env.get("PATH")):
        cached = ROOT / "archive/cache/toolchains/rust"
        for cargo, rustup in ((Path(env.get("CARGO_HOME", Path.home() / ".cargo")), None),
                              (cached / "cargo", cached / "rustup")):
            if (cargo / "bin/cargo").is_file():
                env["CARGO_HOME"] = str(cargo)
                if rustup:
                    env["RUSTUP_HOME"] = str(rustup)
                env["PATH"] = str(cargo / "bin") + os.pathsep + env.get("PATH", "")
                break
    for name in ("java", "javac", "npm", "node", "cargo", "lsof"):
        if not shutil.which(name, path=env.get("PATH")):
            raise RuntimeError(f"缺少 {name}。需要 Python 3.11+、JDK 17+、Node.js/npm 和 Rust/Cargo；macOS 还需 Xcode Command Line Tools。")
    env["CARGO_TARGET_DIR"] = str(safe_tree(BUILD / "cargo-target", hardlink_root=BUILD / "cargo-target"))
    env["CARGO_INCREMENTAL"] = "0"
    env["npm_config_cache"] = str(safe_tree(BUILD / "npm-cache"))
    env["TMPDIR"] = str(safe_tree(BUILD / "tmp"))
    return env


def run_build(command, env, log_path, cwd=ROOT):
    validate_output(log_path)
    with log_path.open("xb") as log:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = child.wait()
        except BaseException:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    if code:
        tail = log_path.read_text(errors="replace").splitlines()[-35:]
        raise RuntimeError("构建失败，本地启动器和服务端保持停止。\n" + "\n".join(tail) + f"\n完整日志：{log_path}")


def detached_child():
    # A terminal closing must not stop the local services after this runner exits.
    signal.signal(signal.SIGHUP, signal.SIG_IGN)


def launch(command, env, log_path):
    validate_output(log_path)
    with log_path.open("xb") as log:
        return subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                preexec_fn=detached_child)


def ready_server(child, port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("本机服务端启动失败，请查看 server.log。")
        try:
            with opener.open(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                result = json.load(response)
            if isinstance(result.get("server_version"), str) and "entry_readiness" in result.get("capabilities", []):
                return result["server_version"]
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError("本机服务端健康检查超时，请查看 server.log。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="构建并重启本仓库的本机 Java 服务端与开发启动器，不构建发布安装包。")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--stop", action="store_true", help="只停止本仓库的本地服务端和开发启动器")
    action.add_argument("--status", action="store_true", help="查看本仓库的本地进程")
    parser.add_argument("--port", type=int, default=18787, help="本机服务端端口，默认 18787")
    args = parser.parse_args(argv)
    if sys.platform not in ("darwin", "linux"):
        parser.error("此脚本用于 macOS/Linux 本地开发。Windows 请使用现有构建命令。")
    if not 1024 <= args.port <= 65535:
        parser.error("端口必须为 1024～65535")
    safe_tree(LOCAL, hardlink_root=BUILD / "cargo-target")
    lock_path = validate_output(LOCAL / "runner.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("另一个本地构建/重启正在运行，请等待它完成。")
        old = owned_processes()
        if args.status:
            say(json.dumps({"root": str(ROOT), "processes": old}, ensure_ascii=False, indent=2))
            return
        if args.stop:
            stop_processes(old, force=True)
            write_json(STATE, {"schema": 1, "root": str(ROOT), "processes": []})
            say(f"已强制停止 {len(old)} 个本仓库本地进程。")
            return
        check_port(args.port, old)
        safe_tree(DESKTOP / "src-tauri/gen")
        env = build_environment()
        run = safe_tree(LOCAL / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]))
        config = run / "launcher-config.json"
        version = json.loads((DESKTOP / "package.json").read_text())["version"]
        endpoint = f"127.0.0.1:{args.port}"
        write_json(config, {"schema_version": 1, "oltitle": "https://gtav.2t.hk", "website": "https://gtav.2t.hk",
                           "servers": [{"id": "local-dev", "name": "本机开发", "role": "本地", "region": "LOCAL",
                                        "address": endpoint, "health_url": f"http://{endpoint}/health",
                                        "websocket_url": f"ws://{endpoint}/ws"}],
                           "announcements": [{"title": "本地开发", "body": f"启动器 {version}；仅连接本机服务端。", "date": time.strftime("%Y-%m-%d")}],
                           "update": {"downloads": {}}})
        frontend = safe_tree(BUILD / "frontend")
        override = run / "tauri-local.json"
        write_json(override, {"identifier": "com.gta5data.launcher.local-entry", "productName": "GTA5Data Local Test",
                              "build": {"beforeBuildCommand": "npm run build -- --configLoader runner --outDir " + shlex.quote(str(frontend)),
                                        "frontendDist": str(frontend)},
                              "app": {"security": {"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data:; connect-src ipc: http://ipc.localhost https: http://" + endpoint}}})
        env["GTA_DEV_CONFIG_PATH"] = str(config)
        needs_dependencies = not (DESKTOP / "node_modules/@tauri-apps/cli/tauri.js").is_file()
        if needs_dependencies:
            safe_tree(DESKTOP / "node_modules")
        say(f"构建日志目录：{run}")
        # Finish path/dependency preflight before stopping anything, then honor
        # the local workflow: force-stop both components BEFORE any compiler.
        old = owned_processes()
        check_port(args.port, old)
        say(f"1/4 强制结束 {len(old)} 个旧本地启动器/服务端进程…")
        stop_processes(old, force=True)
        write_json(STATE, {"schema": 1, "root": str(ROOT), "processes": []})
        if not port_available(args.port):
            raise RuntimeError(f"端口 {args.port} 仍被占用，未开始构建。")
        if needs_dependencies:
            say("安装 package-lock.json 锁定的前端依赖…")
            run_build(["npm", "ci"], env, run / "dependencies.log", DESKTOP)
        jar = run / "multiplayer-server.jar"
        say("2/4 构建 Java 服务端…")
        run_build([sys.executable, "-B", str(ROOT / "tools/build_multiplayer_server.py"), "--output", str(jar)], env, run / "server-build.log")
        say("3/4 构建开发启动器及内嵌网页（首次构建较慢）…")
        run_build(["npm", "run", "tauri", "--", "build", "--debug", "--no-bundle", "--config", str(override), "--", "--locked"],
                  env, run / "launcher-build.log", DESKTOP)
        binary = run / "gta5data-launcher"
        built = BUILD / "cargo-target/debug/gta5data-launcher"
        atomic_write_bytes(binary, built.read_bytes(), sources=(built,))
        binary.chmod(0o700)
        # A manually launched process during compilation must not be replaced
        # or duplicated; another script invocation is already blocked by flock.
        if owned_processes():
            raise RuntimeError("构建期间检测到另行启动的本地进程，未重复启动。请重新运行脚本。")
        check_port(args.port, [])
        say("4/4 构建成功，启动新版服务端和启动器…")
        children = []
        try:
            server = launch(["java", "-jar", str(jar), "--host", "127.0.0.1", "--port", str(args.port),
                             "--world-data", str(ROOT / "server/world-data")], env, run / "server.log")
            children.append(server)
            server_version = ready_server(server, args.port)
            launcher = launch([str(binary)], env, run / "launcher.log")
            children.append(launcher)
            time.sleep(2)
            if launcher.poll() is not None:
                raise RuntimeError("开发启动器未能保持运行，请查看 launcher.log。")
            table = processes()
            current = [{**table[child.pid], "kind": kind} for child, kind in zip(children, ("server", "launcher"))]
            write_json(STATE, {"schema": 1, "root": str(ROOT), "port": args.port, "run": str(run),
                               "launcher_version": version, "server_version": server_version,
                               "server_sha256": hashlib.sha256(jar.read_bytes()).hexdigest(), "processes": current})
        except BaseException:
            for child in children:
                if child.poll() is None:
                    child.terminate()
            for child in children:
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            write_json(STATE, {"schema": 1, "root": str(ROOT), "processes": []})
            raise
        say(f"已启动：服务端 {server_version} / 启动器 {version}\n本机线路：{endpoint}\n日志：{run}\n可关闭此终端；再次运行脚本会重新构建并重启。停止：./start-local.sh --stop")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("已取消。")
        raise SystemExit(130)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"本地启动失败：{error}", file=sys.stderr)
        raise SystemExit(1)
