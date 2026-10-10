"""Verify built platform/version identities, package assets, and record SHA-256.

Every published file uses the read-only game-resource output boundary. Platform
checks operate on actual executable headers rather than runner names or filenames.
No installed game data is needed by the automatic release workflow.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import plistlib
import re
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from prepare_release import ROOT, component_versions, load_plan
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_output

LEGAL_ASSETS = ("LICENSE", "NOTICE.md", "NOTICE.zh-CN.md")


def committed_legal_files(plan):
    """Read exact tracked legal notices from the recorded build commit."""
    files = {}
    for name in LEGAL_ASSETS:
        source = ordinary_file(ROOT / name)
        result = subprocess.run(["git", "show", f"{plan['commit']}:{name}"], cwd=ROOT,
                                capture_output=True, check=False)
        if result.returncode or not result.stdout.strip():
            raise ValueError(f"Build commit must contain a nonempty {name}")
        # Checkout bytes may use platform line endings, so publish Git's exact bytes.
        files[name] = (source, result.stdout)
    if b"MIT License" not in files["LICENSE"][1]:
        raise ValueError("Build commit must contain the project's complete MIT license")
    return files


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def payload_names(component, version):
    if component == "launcher":
        return [f"GTA5Data-Launcher-Windows-x64-v{version}.exe",
                f"GTA5Data-Launcher-macOS-arm64-v{version}-development.zip"]
    return [f"multiplayer-server-v{version}.jar", f"GTAV-Web-Multiplayer-Server-v{version}.zip"]


def all_asset_names(component, item):
    return [*payload_names(component, item["version"]), *LEGAL_ASSETS,
            f"provenance-{item['tag']}.json", f"SHA256SUMS-{item['tag']}.txt"]


def safe_directory(path):
    path = Path(path)
    validate_output(path / ".release-output-check")
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def ordinary_file(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected an ordinary release file: {path}")
    return path


def inspect_windows(body, version):
    if len(body) < 64 or body[:2] != b"MZ":
        raise ValueError("Windows asset is not a DOS/PE executable")
    offset = struct.unpack_from("<I", body, 0x3C)[0]
    if offset + 26 > len(body) or body[offset:offset + 4] != b"PE\0\0":
        raise ValueError("Windows asset has an invalid PE header")
    if struct.unpack_from("<H", body, offset + 4)[0] != 0x8664:
        raise ValueError("Windows asset must be x64 (IMAGE_FILE_MACHINE_AMD64)")
    if struct.unpack_from("<H", body, offset + 24)[0] != 0x20B:
        raise ValueError("Windows asset must be PE32+")
    # VS_FIXEDFILEINFO carries independent file/product versions as DWORD pairs.
    target = tuple(int(part) for part in version.split(".")) + (0,)
    valid_version = False
    for match in re.finditer(re.escape(struct.pack("<I", 0xFEEF04BD)), body):
        if match.start() + 24 > len(body):
            continue
        values = struct.unpack_from("<6I", body, match.start())
        file_version = (values[2] >> 16, values[2] & 0xFFFF, values[3] >> 16, values[3] & 0xFFFF)
        product_version = (values[4] >> 16, values[4] & 0xFFFF, values[5] >> 16, values[5] & 0xFFFF)
        if file_version == product_version == target:
            valid_version = True
            break
    if not valid_version:
        raise ValueError(f"Windows file/product version must be {version}.0")


def inspect_macos_binary(body):
    if len(body) < 32 or body[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("macOS asset must contain a 64-bit little-endian Mach-O executable")
    if struct.unpack_from("<I", body, 4)[0] != 0x0100000C:
        raise ValueError("macOS asset must be ARM64/Apple Silicon")


def inspect_plist(body, version):
    plist = plistlib.loads(body)
    if plist.get("CFBundleShortVersionString") != version or plist.get("CFBundleVersion") != version:
        raise ValueError(f"macOS app bundle versions must both equal {version}")
    executable = plist.get("CFBundleExecutable")
    if executable != "gta5data-launcher":
        raise ValueError("Unexpected macOS launcher executable")
    return executable


def inspect_macos_zip(body, version):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if archive.testzip() is not None:
            raise ValueError("macOS ZIP CRC verification failed")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("macOS ZIP has duplicate entries")
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("macOS ZIP contains an unsafe path")
        roots = [name[:-len("/Contents/Info.plist")] for name in names
                 if name.endswith("/Contents/Info.plist") and not name.startswith("__MACOSX/")]
        if len(roots) != 1 or "/" in roots[0] or not roots[0].endswith(".app"):
            raise ValueError("macOS ZIP must contain exactly one top-level .app")
        root = roots[0]
        executable = inspect_plist(archive.read(f"{root}/Contents/Info.plist"), version)
        inspect_macos_binary(archive.read(f"{root}/Contents/MacOS/{executable}"))
        if f"{root}/Contents/_CodeSignature/CodeResources" not in names:
            raise ValueError("macOS ZIP is missing the verified development signature")


def inspect_server_jar(body, runtime_version, *, execute=False):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if archive.testzip() is not None:
            raise ValueError("Server JAR CRC verification failed")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Server JAR has duplicate entries")
        manifest = archive.read("META-INF/MANIFEST.MF").decode("utf-8")
        if "Main-Class: offline.multiplayer.Main" not in manifest:
            raise ValueError("Server JAR has an unexpected main class")
        main = archive.read("offline/multiplayer/Main.class")
        if len(main) < 8 or main[:4] != b"\xca\xfe\xba\xbe" or struct.unpack_from(">H", main, 6)[0] != 61:
            raise ValueError("Server JAR must target Java 17 class-file version 61")
        if runtime_version.encode("utf-8") not in main:
            raise ValueError("Server JAR does not contain the expected runtime version")
    if execute:
        with tempfile.TemporaryDirectory(prefix="gtav-server-version-") as temp:
            jar = Path(temp) / "server.jar"
            atomic_write_bytes(jar, body)
            result = subprocess.run(["java", "-jar", str(jar), "--help"], capture_output=True,
                                    text=True, encoding="utf-8", timeout=30, check=False)
        if result.returncode or f"GTA V 沙盒公共战局服务 {runtime_version}（" not in result.stdout:
            raise ValueError("Executing server --help did not confirm the source runtime version")


def package_windows(plan, source, directory):
    item = plan["components"]["launcher"]
    source = ordinary_file(source)
    body = source.read_bytes()
    inspect_windows(body, item["version"])
    output = safe_directory(directory) / payload_names("launcher", item["version"])[0]
    atomic_write_bytes(output, body, sources=(source,))
    print(f"Verified Windows x64 file/product version {item['version']}.0: {output.name}")


def package_macos(plan, source, directory):
    if sys.platform != "darwin":
        raise ValueError("macOS packaging/signature verification must run on macOS")
    item = plan["components"]["launcher"]
    source = Path(source)
    if source.is_symlink() or not source.is_dir() or source.suffix != ".app":
        raise ValueError("Expected a built ordinary .app bundle")
    plist_path = ordinary_file(source / "Contents/Info.plist")
    executable = inspect_plist(plist_path.read_bytes(), item["version"])
    executable_path = ordinary_file(source / "Contents/MacOS" / executable)
    inspect_macos_binary(executable_path.read_bytes())
    subprocess.run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(source)], check=True)
    output = safe_directory(directory) / payload_names("launcher", item["version"])[1]
    validate_output(output, sources=(plist_path, executable_path))
    with tempfile.TemporaryDirectory(prefix="gtav-macos-package-") as temp:
        temporary = Path(temp) / "completed.zip"
        validate_output(temporary, sources=(plist_path, executable_path))
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(source), str(temporary)], check=True)
        body = temporary.read_bytes()
    inspect_macos_zip(body, item["version"])
    atomic_write_bytes(output, body, sources=(plist_path, executable_path))
    print(f"Verified ARM64 macOS {item['version']} app and development signature (not notarized): {output.name}")


def server_bundle(plan, jar):
    item = plan["components"]["server"]
    files = {"multiplayer-server.jar": jar}
    candidates = [ROOT / "server" / name for name in
                  ("README.md", "Start-Server.cmd", "Start-Server.command", "Start-Server.sh")]
    candidates += sorted((ROOT / "server/deploy").rglob("*"))
    for path in candidates:
        if path.is_dir():
            continue
        ordinary_file(path)
        relative = path.relative_to(ROOT / "server").as_posix()
        files[relative] = path.read_bytes()
    for name, (_, body) in committed_legal_files(plan).items():
        files[name] = body
    metadata = {"version": item["runtime_version"], "release_version": item["version"],
                "protocol": 1, "world_protocol": 2, "java_minimum": 17,
                "game_resources_required": False, "source_commit": plan["commit"],
                "repository": plan["repository"], "world_data": "not bundled"}
    files["VERSION.json"] = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    files["SHA256SUMS.txt"] = ("".join(f"{hashlib.sha256(body).hexdigest()}  {name}\n"
                                      for name, body in sorted(files.items()))).encode("utf-8")
    with io.BytesIO() as payload:
        with zipfile.ZipFile(payload, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, body in sorted(files.items()):
                entry = zipfile.ZipInfo("gtav-multiplayer-server/" + name)
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.external_attr = (0o100755 if name.endswith((".sh", ".command")) else 0o100644) << 16
                archive.writestr(entry, body)
        return payload.getvalue()


def inspect_server_bundle(body, plan, jar):
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if archive.testzip() is not None:
            raise ValueError("Server bundle CRC verification failed")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Server bundle has duplicate entries")
        prefix = "gtav-multiplayer-server/"
        for name in names:
            path = PurePosixPath(name)
            if not name.startswith(prefix) or path.is_absolute() or ".." in path.parts:
                raise ValueError("Server bundle contains an unsafe path")
            if path.suffix.lower() in (".rpf", ".wasm", ".gfx", ".pem", ".key") or "world-data" in path.parts:
                raise ValueError("Server bundle includes prohibited game data or credentials")
        if archive.read(prefix + "multiplayer-server.jar") != jar:
            raise ValueError("Server bundle JAR differs from the independently verified JAR")
        for name, (_, expected_legal) in committed_legal_files(plan).items():
            if archive.read(prefix + name) != expected_legal:
                raise ValueError(f"Server ZIP {name} differs from the build commit")
        metadata = json.loads(archive.read(prefix + "VERSION.json"))
        if metadata.get("source_commit") != plan["commit"] or metadata.get("version") != plan["components"]["server"]["runtime_version"]:
            raise ValueError("Server bundle version/provenance differs from the release plan")
        expected = set(names) - {prefix + "SHA256SUMS.txt"}
        actual = set()
        for line in archive.read(prefix + "SHA256SUMS.txt").decode("utf-8").splitlines():
            digest, name = line.split("  ", 1)
            if prefix + name in actual or hashlib.sha256(archive.read(prefix + name)).hexdigest() != digest:
                raise ValueError("Server bundle file SHA-256 verification failed")
            actual.add(prefix + name)
        if expected != actual:
            raise ValueError("Server bundle checksum coverage is incomplete")


def package_server(plan, source, directory):
    item = plan["components"]["server"]
    source = ordinary_file(source)
    body = source.read_bytes()
    inspect_server_jar(body, item["runtime_version"], execute=True)
    directory = safe_directory(directory)
    jar_name, bundle_name = payload_names("server", item["version"])
    bundle = server_bundle(plan, body)
    inspect_server_bundle(bundle, plan, body)
    for name, payload in ((jar_name, body), (bundle_name, bundle)):
        atomic_write_bytes(directory / name, payload, sources=(source,))
    print(f"Verified Java 17 server runtime {item['runtime_version']}, JAR and deployment ZIP")


def inspect_payloads(plan, component, directory):
    item = plan["components"][component]
    paths = [ordinary_file(Path(directory) / name) for name in payload_names(component, item["version"])]
    if component == "launcher":
        inspect_windows(paths[0].read_bytes(), item["version"])
        inspect_macos_zip(paths[1].read_bytes(), item["version"])
    else:
        jar = paths[0].read_bytes()
        inspect_server_jar(jar, item["runtime_version"])
        inspect_server_bundle(paths[1].read_bytes(), plan, jar)
    return paths


def metadata(plan, component, directory):
    directory = safe_directory(directory)
    item = plan["components"][component]
    payloads = inspect_payloads(plan, component, directory)
    legal_paths = []
    for name, (source, body) in committed_legal_files(plan).items():
        path = directory / name
        atomic_write_bytes(path, body, sources=(source, *payloads))
        legal_paths.append(path)
    provenance = {"schema": 1, "component": component, "tag": item["tag"],
        "version": item["version"], "runtime_version": item["runtime_version"],
        "source_commit": plan["commit"], "source_sha256": item["source_sha256"],
        "source_files": item["source_files"], "notes_sha256": item["notes_sha256"],
        "repository": plan["repository"], "workflow": "release.yml",
        "run_id": os.environ.get("GITHUB_RUN_ID"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "assets": [{"name": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)} for path in payloads]}
    if component == "launcher":
        provenance["platforms"] = ["windows-x64", "macos-arm64"]
        provenance["macos_distribution"] = "ad-hoc development signature; not notarized"
    else:
        provenance["java_minimum"] = 17
        provenance["world_data_bundled"] = False
    provenance_path = directory / f"provenance-{item['tag']}.json"
    atomic_write_text(provenance_path, json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", sources=payloads)
    sums = "".join(f"{sha256(path)}  {path.name}\n" for path in [*payloads, *legal_paths, provenance_path])
    atomic_write_text(directory / f"SHA256SUMS-{item['tag']}.txt", sums, sources=[*payloads, *legal_paths, provenance_path])
    verify_release_directory(plan, component, directory)
    print(f"Prepared complete {item['tag']} asset manifest and SHA-256 checksums")


def verify_release_directory(plan, component, directory):
    directory = Path(directory)
    item = plan["components"][component]
    expected = all_asset_names(component, item)
    actual = {path.name for path in directory.iterdir()}
    if actual != set(expected):
        raise ValueError(f"Release directory must contain exactly the {component} assets")
    paths = {name: ordinary_file(directory / name) for name in expected}
    payloads = inspect_payloads(plan, component, directory)
    for name, (_, body) in committed_legal_files(plan).items():
        if paths[name].read_bytes() != body:
            raise ValueError(f"Published {name} must match the exact build commit bytes")
    provenance = json.loads(paths[f"provenance-{item['tag']}.json"].read_text(encoding="utf-8"))
    for key, value in {"schema": 1, "component": component, "tag": item["tag"], "version": item["version"],
                       "runtime_version": item["runtime_version"], "source_commit": plan["commit"],
                       "source_sha256": item["source_sha256"], "notes_sha256": item["notes_sha256"],
                       "repository": plan["repository"]}.items():
        if provenance.get(key) != value:
            raise ValueError(f"Release provenance has an unexpected {key}")
    assets = provenance.get("assets", [])
    if len(assets) != len(payloads) or {row["name"] for row in assets} != {path.name for path in payloads}:
        raise ValueError("Release provenance has incomplete payload coverage")
    for row in assets:
        path = paths[row["name"]]
        if row["bytes"] != path.stat().st_size or row["sha256"] != sha256(path):
            raise ValueError("Release payload differs from its SHA-256/provenance")
    covered = set()
    for line in paths[f"SHA256SUMS-{item['tag']}.txt"].read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or name not in paths or name in covered:
            raise ValueError("Malformed release checksum entry")
        if sha256(paths[name]) != digest:
            raise ValueError("Release checksum does not match its file")
        covered.add(name)
    if covered != set(expected) - {f"SHA256SUMS-{item['tag']}.txt"}:
        raise ValueError("Release checksum coverage is incomplete")
    return [paths[name] for name in expected]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("windows", "macos", "server", "metadata", "verify"))
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--component", choices=("launcher", "server"))
    args = parser.parse_args()
    try:
        plan = load_plan(args.plan)
        if args.operation in ("windows", "macos", "server"):
            if not args.input:
                raise ValueError("Packaging requires --input")
            {"windows": package_windows, "macos": package_macos, "server": package_server}[args.operation](
                plan, args.input, args.output_directory)
        else:
            if not args.component:
                raise ValueError("Metadata/verification requires --component")
            if args.operation == "metadata":
                metadata(plan, args.component, args.output_directory)
            else:
                verify_release_directory(plan, args.component, args.output_directory)
                print("All release files, versions, architectures and SHA-256 values verified")
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(f"Release asset error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
