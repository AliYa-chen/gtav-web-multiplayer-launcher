"""Authorize a deployment retry using an unchanged, published server build.

This checks GitHub run/release metadata and every original downloaded asset. It
does not connect to servers, rebuild artifacts, or change existing releases.
The later deployment runs from the original checkout and repeats source checks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

from check_release_assets import all_asset_names
from prepare_release import github_json, github_release, github_tag_commit, version
from readonly_game_outputs import atomic_write_text, validate_outputs


def verify_retry(run_id, plan_path, assets_directory, repository):
    if not isinstance(run_id, str) or not re.fullmatch(r"[1-9][0-9]*", run_id):
        raise ValueError("Retry run ID must be a positive decimal integer")
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("GITHUB_REPOSITORY must identify an owner/repository")
    plan_path, assets_directory = Path(plan_path), Path(assets_directory)
    if plan_path.is_symlink() or not plan_path.is_file() or assets_directory.is_symlink() or not assets_directory.is_dir():
        raise ValueError("Retry plan and asset directory must be ordinary downloaded files")
    run = github_json(f"repos/{repository}/actions/runs/{run_id}")
    if (str(run.get("id")) != run_id or run.get("path") != ".github/workflows/release.yml"
            or run.get("head_branch") != "main" or run.get("event") != "push"
            or run.get("status") != "completed"):
        raise ValueError("Retry must use a completed main-branch push of the release workflow")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    commit = plan.get("commit")
    if (plan.get("schema") != 1 or plan.get("repository") != repository
            or not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or run.get("head_sha") != commit):
        raise ValueError("Original plan does not match the selected GitHub run/repository/commit")
    components = plan.get("components")
    if not isinstance(components, dict) or set(components) != {"launcher", "server"}:
        raise ValueError("Original release plan must contain the two expected components")
    server = components["server"]
    if not isinstance(server, dict):
        raise ValueError("Original server release plan is invalid")
    server_version = version(server.get("version"))
    tag = f"server-v{server_version}"
    if (server.get("tag") != tag or not isinstance(server.get("runtime_version"), str)
            or not re.fullmatch(re.escape(server_version) + r"(?:-[a-z0-9.-]+)?", server["runtime_version"])):
        raise ValueError("Original server tag/runtime version does not match its component version")
    release = github_release(repository, tag)
    if (release is None or release.get("draft") is not False or release.get("tag_name") != tag
            or github_tag_commit(repository, tag) != commit):
        raise ValueError("Retry requires a public server release tagged at the original build commit")
    expected = set(all_asset_names("server", server))
    assets = release.get("assets", [])
    if (not isinstance(assets, list) or len(assets) != len(expected)
            or {asset.get("name") for asset in assets} != expected):
        raise ValueError("Published server release must contain exactly its seven original assets")
    if {path.name for path in assets_directory.iterdir()} != expected:
        raise ValueError("Downloaded server artifacts must match the complete published asset set")
    paths = [assets_directory / name for name in sorted(expected)]
    validate_outputs(paths, sources=(plan_path,))
    for asset in assets:
        path = assets_directory / asset["name"]
        if path.is_symlink() or not path.is_file():
            raise ValueError("Retry assets must be ordinary files")
        digest = asset.get("digest")
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Every published server asset must have a GitHub SHA-256 digest")
        if asset.get("size") != path.stat().st_size:
            raise ValueError("Downloaded server asset size differs from the published release")
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest[7:]:
            raise ValueError("Downloaded server asset SHA-256 differs from the published release")
    return commit, paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--assets-directory", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        commit, paths = verify_retry(args.run_id, args.plan, args.assets_directory,
                                     os.environ.get("GITHUB_REPOSITORY"))
        output, = validate_outputs((args.github_output,), sources=(args.plan, *paths, Path(__file__)))
        previous = output.read_text(encoding="utf-8") if output.exists() else ""
        atomic_write_text(output, previous + f"source_commit={commit}\n",
                          sources=(args.plan, *paths, Path(__file__)))
        print("Verified original server run, public tag and all seven GitHub asset SHA-256 values")
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as error:
        print(f"Deployment retry rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
