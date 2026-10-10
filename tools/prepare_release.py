"""Plan immutable, component-specific GitHub releases and publish verified assets.

Release notes are data, never commands. Source fingerprints use Git blob IDs so
Windows checkout line endings cannot change component identity. This tool neither
changes versions nor writes website configuration or installed game resources.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

from readonly_game_outputs import atomic_write_text, validate_output

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
COMPONENTS = ("launcher", "server")
LAUNCHER_TOOLS = {
    "tools/build_multiplayer_client.py", "tools/generate_launcher_engine_spec.py",
    "tools/bundle_runtime.py", "tools/readonly_game_outputs.py",
}
SERVER_TOOLS = {"tools/build_multiplayer_server.py", "tools/readonly_game_outputs.py"}


def command(arguments, *, binary=False):
    result = subprocess.run(arguments, cwd=ROOT, capture_output=True,
                            text=not binary, check=False)
    if result.returncode:
        # CLI errors may contain authenticated download URLs; never relay them.
        raise ValueError(f"Command failed ({Path(arguments[0]).name}, exit {result.returncode})")
    return result.stdout


def version(value):
    if not isinstance(value, str) or SEMVER.fullmatch(value) is None:
        raise ValueError(f"A release version must be a stable X.Y.Z value: {value!r}")
    return value


def component_versions():
    package = json.loads((ROOT / "desktop/package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "desktop/package-lock.json").read_text(encoding="utf-8"))
    tauri = json.loads((ROOT / "desktop/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((ROOT / "desktop/src-tauri/Cargo.toml").read_text(encoding="utf-8"))
    cargo_lock = tomllib.loads((ROOT / "desktop/src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    cargo_packages = [row["version"] for row in cargo_lock["package"]
                      if row["name"] == cargo["package"]["name"]]
    versions = [package["version"], lock["version"], lock["packages"][""]["version"],
                tauri["version"], cargo["package"]["version"], *cargo_packages]
    if len(cargo_packages) != 1 or len({version(item) for item in versions}) != 1:
        raise ValueError("Launcher package, lockfiles, Cargo and Tauri versions must agree")
    main = (ROOT / "server/src/main/java/offline/multiplayer/Main.java").read_text(encoding="utf-8")
    matches = re.findall(r'private\s+static\s+final\s+String\s+VERSION\s*=\s*"([^"]+)"\s*;', main)
    if len(matches) != 1:
        raise ValueError("Expected exactly one server VERSION declaration")
    runtime = re.fullmatch(r"([0-9]+\.[0-9]+\.[0-9]+)(?:-([a-z0-9.-]+))?", matches[0])
    if runtime is None:
        raise ValueError("Server VERSION must begin with X.Y.Z and an optional lowercase qualifier")
    return {"launcher": {"version": versions[0], "runtime_version": versions[0]},
            "server": {"version": version(runtime.group(1)), "runtime_version": matches[0]}}


def component_path(component, path):
    if component == "launcher":
        return ((path.startswith("desktop/") and not path.endswith(".md"))
                or path.startswith("client/") or path in LAUNCHER_TOOLS)
    return ((path.startswith("server/") and not path.endswith(".md")) or path in SERVER_TOOLS)


def source_fingerprint(component, commit):
    records = command(["git", "ls-tree", "-rz", "--full-tree", commit], binary=True)
    entries = []
    for record in records.split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, kind, blob = metadata.decode("ascii").split()
        path = name.decode("utf-8")
        if component_path(component, path):
            if kind != "blob" or mode == "120000":
                raise ValueError(f"Release sources must be ordinary Git files: {path}")
            entries.append([path, mode, blob])
    if not entries:
        raise ValueError(f"No {component} sources found in the build commit")
    payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest(), len(entries)


def output_sources(plan):
    names = command(["git", "ls-files", "-z"], binary=True).split(b"\0")
    return tuple([ROOT / name.decode("utf-8") for name in names if name]
                 + [Path(__file__), *(ROOT / item["notes"] for item in plan["components"].values())])


def release_notes(tag):
    path = ROOT / "release-notes" / f"{tag}.md"
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing ordinary release notes: release-notes/{tag}.md")
    body = path.read_text(encoding="utf-8")
    english = re.search(r"^## English\s*$", body, re.MULTILINE)
    chinese = re.search(r"^## 简体中文\s*$", body, re.MULTILINE)
    if english is None or chinese is None or english.end() >= chinese.start():
        raise ValueError(f"{tag}.md needs '## English' before '## 简体中文'")
    if not body[english.end():chinese.start()].strip() or not body[chinese.end():].strip():
        raise ValueError(f"Both release-note languages must contain text: {tag}.md")
    # GitHub Windows checkout may use CRLF; notes identity is canonical UTF-8/LF.
    return path, hashlib.sha256(body.encode("utf-8")).hexdigest()


def github_json(endpoint, *, missing=False):
    result = subprocess.run(["gh", "api", endpoint], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        if missing and "(HTTP 404)" in result.stderr:
            return None
        raise ValueError("GitHub API request failed; check token permissions and connectivity")
    return json.loads(result.stdout)


def github_release(repository, tag):
    """Find published releases by tag and authenticated drafts by release ID.

GitHub's releases/tags endpoint deliberately omits drafts. Listing authenticated
releases is required both before a retry and immediately after draft creation.
"""
    release = github_json(f"repos/{repository}/releases/tags/{tag}", missing=True)
    if release is not None:
        return release
    page = 1
    matches = []
    while True:
        rows = github_json(f"repos/{repository}/releases?per_page=100&page={page}")
        if not isinstance(rows, list):
            raise ValueError("GitHub releases listing returned an unexpected response")
        matches.extend(row for row in rows if row.get("tag_name") == tag)
        if len(rows) < 100:
            break
        page += 1
    if len(matches) > 1:
        raise ValueError(f"Multiple releases use {tag}; refuse an ambiguous draft upload")
    if not matches:
        return None
    release_id = matches[0].get("id")
    if not isinstance(release_id, int) or release_id <= 0:
        raise ValueError("GitHub release has an invalid numeric ID")
    release = github_json(f"repos/{repository}/releases/{release_id}")
    if release.get("tag_name") != tag:
        raise ValueError("Release ID does not match its expected tag")
    return release


def github_tag_commit(repository, tag):
    reference = github_json(f"repos/{repository}/git/ref/tags/{tag}", missing=True)
    if reference is None:
        return None
    obj = reference["object"]
    for _ in range(5):
        if obj["type"] == "commit":
            return obj["sha"]
        if obj["type"] != "tag":
            break
        obj = github_json(f"repos/{repository}/git/tags/{obj['sha']}")["object"]
    raise ValueError(f"Release tag does not resolve to an ordinary commit: {tag}")


def download_asset(repository, tag, name, destination):
    validate_output(destination / name)
    command(["gh", "release", "download", tag, "--repo", repository,
             "--pattern", name, "--dir", str(destination)])
    path = destination / name
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing ordinary downloaded release asset: {name}")
    return path


def existing_provenance(repository, release, component):
    name = f"provenance-{release['tag_name']}.json"
    assets = release.get("assets", [])
    if not any(row["name"] == name for row in assets):
        if release["draft"] and not assets:
            return None
        raise ValueError(f"{release['tag_name']} has no build provenance; refuse to relabel its files")
    with tempfile.TemporaryDirectory(prefix="gtav-release-provenance-") as temp:
        path = download_asset(repository, release["tag_name"], name, Path(temp))
        body = json.loads(path.read_text(encoding="utf-8"))
    if body.get("schema") != 1 or body.get("component") != component:
        raise ValueError(f"Unrecognized {component} release provenance")
    if body.get("tag") != release["tag_name"]:
        raise ValueError("Release provenance tag does not match its GitHub release")
    return body


def build_plan(repository, commit):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must be an owner/name value")
    head = command(["git", "rev-parse", "HEAD"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or head != commit:
        raise ValueError("Checkout HEAD must match the exact 40-character build commit")
    plan = {"schema": 1, "repository": repository, "commit": commit, "components": {}}
    for component, item in component_versions().items():
        tag = f"{component}-v{item['version']}"
        notes, notes_digest = release_notes(tag)
        digest, count = source_fingerprint(component, commit)
        release = github_release(repository, tag)
        build = release is None or release["draft"]
        if release is not None:
            previous = existing_provenance(repository, release, component)
            if previous is not None and previous.get("source_sha256") != digest:
                raise ValueError(f"{component} sources changed but {tag} already exists. "
                                 "Increment that component's version and add its release-notes MD.")
            if release["draft"] and (release.get("target_commitish") != commit
                                     or github_tag_commit(repository, tag) not in (None, commit)):
                raise ValueError(f"Existing draft {tag} belongs to another commit; do not overwrite it")
        elif github_tag_commit(repository, tag) not in (None, commit):
            raise ValueError(f"Tag {tag} already points at another commit; increment the version")
        plan["components"][component] = {**item, "tag": tag, "build": build,
            "notes": notes.relative_to(ROOT).as_posix(), "notes_sha256": notes_digest,
            "source_sha256": digest, "source_files": count}
    return plan


def load_plan(path):
    plan = json.loads(Path(path).read_text(encoding="utf-8"))
    if plan.get("schema") != 1 or set(plan.get("components", {})) != set(COMPONENTS):
        raise ValueError("Invalid release plan")
    if not isinstance(plan.get("repository"), str) or not re.fullmatch(
            r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", plan["repository"]):
        raise ValueError("Release plan has an invalid repository")
    if not isinstance(plan.get("commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", plan["commit"]):
        raise ValueError("Release plan has an invalid build commit")
    if command(["git", "rev-parse", "HEAD"]).strip() != plan.get("commit"):
        raise ValueError("Release plan and checkout refer to different commits")
    versions = component_versions()
    for component, item in plan["components"].items():
        if item["version"] != versions[component]["version"]:
            raise ValueError("Source versions changed after release planning")
        if item["runtime_version"] != versions[component]["runtime_version"]:
            raise ValueError("Runtime version changed after release planning")
        if item["tag"] != f"{component}-v{version(item['version'])}":
            raise ValueError("Release tag does not match component/version")
        notes, digest = release_notes(item["tag"])
        if item["notes"] != notes.relative_to(ROOT).as_posix() or item["notes_sha256"] != digest:
            raise ValueError("Release notes changed after release planning")
        digest, _ = source_fingerprint(component, plan["commit"])
        if item["source_sha256"] != digest:
            raise ValueError("Component fingerprint does not match the checkout")
    return plan


def remote_asset_matches(repository, release, asset, path):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if asset.get("size") != path.stat().st_size:
        return False
    if asset.get("digest"):
        return asset["digest"] == f"sha256:{digest}"
    with tempfile.TemporaryDirectory(prefix="gtav-release-verify-") as temp:
        downloaded = download_asset(repository, release["tag_name"], asset["name"], Path(temp))
        return hashlib.sha256(downloaded.read_bytes()).hexdigest() == digest


def publish(plan, component, assets_directory):
    # Import only here to keep plan generation independent of build artifacts.
    from check_release_assets import verify_release_directory
    files = verify_release_directory(plan, component, assets_directory)
    repository, commit = plan["repository"], plan["commit"]
    item = plan["components"][component]
    tag, notes = item["tag"], ROOT / item["notes"]
    title = (f"[Launcher] GTAV Web Multiplayer Launcher {item['version']} / GTAV 网页多人启动器"
             if component == "launcher"
             else f"[Server] GTAV Web Multiplayer Server {item['version']} / GTAV 网页多人服务端")
    release = github_release(repository, tag)
    if release is None:
        existing_tag = github_tag_commit(repository, tag)
        if existing_tag not in (None, commit):
            raise ValueError("Refuse to publish artifacts under a tag from another commit")
        command(["gh", "release", "create", tag, "--repo", repository, "--target", commit,
                 "--title", title, "--notes-file", str(notes), "--draft", "--prerelease", "--latest=false"])
        release = github_release(repository, tag)
        if release is None:
            raise ValueError("Created draft could not be found by authenticated release listing")
    tag_commit = github_tag_commit(repository, tag)
    if (tag_commit not in (None, commit) or (tag_commit is None and not release["draft"])
            or (release["draft"] and release.get("target_commitish") != commit)):
        raise ValueError("Release tag no longer matches the build commit")
    existing = {row["name"]: row for row in release.get("assets", [])}
    expected = {path.name: path for path in files}
    if set(existing) - set(expected):
        raise ValueError("Release has unexpected assets; refuse to replace an unrelated release")
    for name, asset in existing.items():
        if not remote_asset_matches(repository, release, asset, expected[name]):
            raise ValueError(f"Existing release asset differs; immutable upload refused: {name}")
    if not release["draft"]:
        if set(existing) != set(expected):
            raise ValueError("Published release is incomplete; do not modify it automatically")
        print(f"Already published and verified: {tag}")
        return
    missing = [str(path) for name, path in expected.items() if name not in existing]
    if missing:
        command(["gh", "release", "upload", tag, *missing, "--repo", repository])
    release = github_json(f"repos/{repository}/releases/{release['id']}")
    if release.get("tag_name") != tag:
        raise ValueError("Uploaded release ID no longer matches its expected tag")
    uploaded = {row["name"]: row for row in release.get("assets", [])}
    if set(uploaded) != set(expected):
        raise ValueError("Uploaded assets do not match the complete release manifest")
    for name, asset in uploaded.items():
        if not remote_asset_matches(repository, release, asset, expected[name]):
            raise ValueError(f"GitHub asset SHA-256 verification failed: {name}")
    command(["gh", "release", "edit", tag, "--repo", repository, "--draft=false",
             "--prerelease", "--latest=false", "--title", title, "--notes-file", str(notes)])
    if github_tag_commit(repository, tag) != commit:
        raise ValueError("Published release tag does not match its recorded build commit")
    print(f"Published {tag}: all assets verified before making the release public")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    plan_parser = subparsers.add_parser("plan", help="Validate versions/notes and choose components to build")
    plan_parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"), required=False)
    plan_parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA"), required=False)
    plan_parser.add_argument("--output", type=Path, required=True)
    plan_parser.add_argument("--github-output", type=Path)
    publish_parser = subparsers.add_parser("publish", help="Upload to a draft, verify, then publish")
    publish_parser.add_argument("--plan", type=Path, required=True)
    publish_parser.add_argument("--component", choices=COMPONENTS, required=True)
    publish_parser.add_argument("--assets-directory", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.operation == "plan":
            if not args.repository or not args.commit:
                raise ValueError("--repository and --commit (or GitHub environment variables) are required")
            plan = build_plan(args.repository, args.commit)
            sources = output_sources(plan)
            atomic_write_text(args.output, json.dumps(plan, ensure_ascii=False, indent=2) + "\n", sources=sources)
            if args.github_output:
                destination = validate_output(args.github_output, sources=sources)
                lines = []
                for component, item in plan["components"].items():
                    lines.extend([f"{component}={str(item['build']).lower()}",
                                  f"{component}_version={item['version']}"])
                with destination.open("a", encoding="utf-8") as stream:
                    stream.write("\n".join(lines) + "\n")
            for component, item in plan["components"].items():
                print(f"{component}: {item['tag']} — {'build and publish' if item['build'] else 'already published; skip'}")
        else:
            publish(load_plan(args.plan), args.component, args.assets_directory)
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        print(f"Release error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
