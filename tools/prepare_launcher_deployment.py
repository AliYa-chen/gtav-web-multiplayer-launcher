"""Prepare a verified, immutable launcher release and a deployment-only PHP config.

GitHub CLI inherits GH_TOKEN/GITHUB_TOKEN; credentials are never arguments or
output. This tool downloads published assets without building or relabeling them.
Only launcher update fields are replaced in the current repository PHP template.
Installed game resources and the template itself are never written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from check_release_assets import all_asset_names, payload_names, verify_release_directory
from prepare_release import (ROOT, command, component_path, component_versions,
                             github_release, github_tag_commit, source_fingerprint)
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_outputs

TEMPLATE = ROOT / "remote-config/index.php"
HEX_SHA256 = re.compile(r"[0-9a-f]{64}")
PLATFORMS = ("windows_x64", "macos_arm64")


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    start: int
    end: int


def php_tokens(text):
    """Tokenize strings/comments before locating the small editable PHP arrays."""
    tokens = []
    cursor = 0
    while cursor < len(text):
        start, character = cursor, text[cursor]
        if character.isspace():
            cursor += 1
            continue
        if text.startswith("//", cursor) or character == "#":
            end = text.find("\n", cursor)
            cursor = len(text) if end == -1 else end + 1
            continue
        if text.startswith("/*", cursor):
            end = text.find("*/", cursor + 2)
            if end == -1:
                raise ValueError("PHP template contains an unterminated comment")
            cursor = end + 2
            continue
        if character in "\"'":
            quote = character
            cursor += 1
            while cursor < len(text):
                if text[cursor] == "\\":
                    cursor += 2
                elif text[cursor] == quote:
                    cursor += 1
                    break
                else:
                    cursor += 1
            else:
                raise ValueError("PHP template contains an unterminated string")
            tokens.append(Token("string", text[start:cursor], start, cursor))
            continue
        match = re.match(r"\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|=>", text[cursor:])
        if match:
            cursor += len(match.group())
            word = match.group()
            kind = "variable" if word.startswith("$") else "symbol"
            tokens.append(Token(kind, word, start, cursor))
        else:
            cursor += 1
            tokens.append(Token("symbol", character, start, cursor))
    return tokens


def bracket_pairs(tokens):
    stack, pairs = [], {}
    closing = {")": "(", "]": "[", "}": "{"}
    for index, token in enumerate(tokens):
        if token.kind == "string":
            continue
        if token.text in ("(", "[", "{"):
            stack.append(index)
        elif token.text in closing:
            if not stack or tokens[stack[-1]].text != closing[token.text]:
                raise ValueError("PHP template has unbalanced brackets")
            first = stack.pop()
            pairs[first] = index
    if stack:
        raise ValueError("PHP template has unbalanced brackets")
    return pairs


def literal_string(token):
    if token.kind != "string":
        raise ValueError("Editable PHP keys/URLs must use literal strings")
    body = token.text[1:-1]
    if token.text[0] == "'":
        return re.sub(r"\\([\\'])", lambda match: match.group(1), body)
    # Keys and URLs need no PHP interpolation or escape evaluation.
    if "$" in body or "\\" in body:
        raise ValueError("Editable PHP keys/URLs must not use string interpolation")
    return body


def assignment(tokens, pairs, name):
    found = [index for index, token in enumerate(tokens[:-1])
             if token.kind == "variable" and token.text == "$" + name
             and tokens[index + 1].text == "="]
    if len(found) != 1:
        raise ValueError(f"PHP template needs one unambiguous ${name} assignment")
    first = found[0] + 2
    if first >= len(tokens):
        raise ValueError("PHP template assignment has no value")
    last = pairs.get(first, first)
    if last + 1 >= len(tokens) or tokens[last + 1].text != ";":
        raise ValueError(f"Editable ${name} must have one literal value or short array")
    return first, last


def array_entries(tokens, pairs, first, last):
    if tokens[first].text != "[" or pairs.get(first) != last:
        raise ValueError("Editable PHP data must use a short array")
    entries, cursor = {}, first + 1
    while cursor < last:
        if tokens[cursor].text == ",":
            raise ValueError("PHP template array contains an empty entry")
        key = literal_string(tokens[cursor])
        if key in entries or cursor + 2 >= last or tokens[cursor + 1].text != "=>":
            raise ValueError("PHP template array has duplicate or ambiguous keys")
        value_first = cursor + 2
        value_last = pairs.get(value_first, value_first)
        cursor = value_last + 1
        if cursor < last and tokens[cursor].text != ",":
            raise ValueError("Editable PHP array entries must have one literal value or array")
        entries[key] = (value_first, value_last)
        if cursor < last:
            cursor += 1
    return entries


def php_string(value):
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value):
        raise ValueError("Release text contains unsupported control characters")
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def updated_download_url(previous, name):
    if re.search(r"[\s\\\x00-\x1f\x7f]", previous):
        raise ValueError("Template download URL contains unsafe characters")
    parts = urlsplit(previous)
    if (parts.scheme != "https" or not parts.hostname or parts.username is not None
            or parts.password is not None or parts.query or parts.fragment
            or not parts.path.startswith("/")):
        raise ValueError("Template download URL must be a public HTTPS file URL")
    # Accessing the port also checks invalid/non-numeric values.
    if parts.port is not None and not 1 <= parts.port <= 65535:
        raise ValueError("Template download URL has an invalid port")
    return urlunsplit(parts._replace(path=parts.path.rsplit("/", 1)[0] + "/" + name))


def generate_candidate(template, item, notes, payloads):
    tokens = php_tokens(template)
    pairs = bracket_pairs(tokens)
    replacements = []

    def replace(span, text):
        first, last = span
        replacements.append((tokens[first].start, tokens[last].end, text))

    for name, value in (("latestVersion", item["version"]), ("releaseNotes", notes["zh-CN"])):
        span = assignment(tokens, pairs, name)
        if span[0] != span[1] or tokens[span[0]].kind != "string":
            raise ValueError(f"Editable ${name} must be a literal string")
        replace(span, php_string(value))

    translations = array_entries(tokens, pairs, *assignment(tokens, pairs, "translations"))
    if not {"en", "zh-CN"}.issubset(translations):
        raise ValueError("PHP template must include English and Simplified Chinese translations")
    for locale in ("en", "zh-CN"):
        entries = array_entries(tokens, pairs, *translations[locale])
        if "release_notes" not in entries:
            raise ValueError(f"PHP template lacks {locale} release_notes")
        first, last = entries["release_notes"]
        if first != last or (tokens[first].kind != "string"
                            and tokens[first].text != "$releaseNotes"):
            raise ValueError("Translated release notes must use a literal or $releaseNotes")
        if locale == "en" or tokens[first].text != "$releaseNotes":
            replace((first, last), php_string(notes[locale]))

    download_span = assignment(tokens, pairs, "downloadCandidates")
    candidates = array_entries(tokens, pairs, *download_span)
    if set(candidates) != set(PLATFORMS):
        raise ValueError("PHP download template must contain exactly Windows x64 and macOS ARM64")
    downloads = {}
    rows = ["["]
    for platform in candidates:
        fields = array_entries(tokens, pairs, *candidates[platform])
        if set(fields) != {"url", "sha256"} or any(first != last for first, last in fields.values()):
            raise ValueError("PHP downloads must contain exactly literal URL and SHA-256 fields")
        previous = literal_string(tokens[fields["url"][0]])
        literal_string(tokens[fields["sha256"][0]])
        payload = payloads[platform]
        entry = {"url": updated_download_url(previous, payload["name"]), "sha256": payload["sha256"]}
        downloads[platform] = entry
        rows.extend([f"    {php_string(platform)} => [",
                     f"        'url' => {php_string(entry['url'])},",
                     f"        'sha256' => {php_string(entry['sha256'])},", "    ],"])
    rows.append("]")
    replace(download_span, "\n".join(rows))
    replacements.sort()
    if any(previous[1] > following[0] for previous, following in zip(replacements, replacements[1:])):
        raise ValueError("PHP update fields overlap")
    candidate = template
    for start, end, value in reversed(replacements):
        candidate = candidate[:start] + value + candidate[end:]
    return candidate, downloads


def notes_sections(body):
    english = list(re.finditer(r"^## English\s*$", body, re.MULTILINE))
    chinese = list(re.finditer(r"^## 简体中文\s*$", body, re.MULTILINE))
    if len(english) != 1 or len(chinese) != 1 or english[0].end() >= chinese[0].start():
        raise ValueError("Release notes must contain English followed by Simplified Chinese")
    notes = {"en": re.sub(r"\n---\s*$", "", body[english[0].end():chinese[0].start()].strip()),
             "zh-CN": body[chinese[0].end():].strip()}
    # The immutable full MD is verified above. The launcher displays the change
    # summary and compatibility paragraphs, excluding build checks/download help.
    for locale, heading in (("en", "Changes"), ("zh-CN", "更新内容")):
        starts = list(re.finditer(r"^### " + re.escape(heading) + r"\s*$", notes[locale], re.MULTILINE))
        if len(starts) > 1:
            raise ValueError("Release notes contain ambiguous change-summary headings")
        if starts:
            section = notes[locale][starts[0].end():]
            following = re.search(r"^#{1,3} ", section, re.MULTILINE)
            notes[locale] = section[:following.start()].strip() if following else section.strip()
    for text in notes.values():
        if not text or len(text) > 8192:
            raise ValueError("Each release-notes translation must contain 1–8192 Unicode characters")
        php_string(text)
    return notes


def matching_notes(release, provenance):
    candidates = []
    if isinstance(release.get("body"), str):
        candidates.append(release["body"].replace("\r\n", "\n"))
    notes_path = ROOT / "release-notes" / f"{provenance['tag']}.md"
    if notes_path.is_file() and not notes_path.is_symlink():
        candidates.append(notes_path.read_text(encoding="utf-8"))
    candidates.append(command(["git", "show", f"{provenance['source_commit']}:release-notes/{provenance['tag']}.md"]))
    for body in candidates:
        if hashlib.sha256(body.encode("utf-8")).hexdigest() == provenance["notes_sha256"]:
            return notes_sections(body)
    raise ValueError("Neither published nor committed release notes match the immutable provenance")


def output_sources():
    return [ROOT / name.decode("utf-8") for name in command(["git", "ls-files", "-z"], binary=True).split(b"\0")
            if name] + [TEMPLATE, Path(__file__)]


def download_asset_bytes(repository, asset_id):
    try:
        result = subprocess.run(["gh", "api", f"repos/{repository}/releases/assets/{asset_id}",
                                 "-H", "Accept: application/octet-stream"], cwd=ROOT,
                                capture_output=True, check=False, timeout=300)
    except subprocess.TimeoutExpired as error:
        raise ValueError("GitHub asset download timed out; retry preparation after connectivity recovers") from error
    if result.returncode:
        # Authenticated redirect URLs and CLI diagnostics must not reach logs.
        raise ValueError("GitHub asset download failed; check token permissions and connectivity")
    return result.stdout


def download_published_assets(repository, release, item, directory, sources):
    expected = set(all_asset_names("launcher", item))
    assets = release.get("assets")
    if (not isinstance(assets, list) or len(assets) != len(expected)
            or any(not isinstance(row, dict) for row in assets)
            or {row.get("name") for row in assets} != expected):
        raise ValueError("Published launcher release must contain exactly its seven original assets")
    ids = set()
    for row in assets:
        if (type(row.get("id")) is not int or row["id"] <= 0 or row["id"] in ids
                or type(row.get("size")) is not int or not 0 < row["size"] <= 2 ** 31
                or not isinstance(row.get("digest"), str)
                or re.fullmatch(r"sha256:[0-9a-f]{64}", row["digest"]) is None
                or row.get("state") != "uploaded"):
            raise ValueError("Every GitHub asset needs a distinct ID, uploaded state, size and SHA-256 digest")
        ids.add(row["id"])
    if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
        raise ValueError("Downloaded assets need an ordinary isolated directory")
    if directory.exists() and {path.name for path in directory.iterdir()} - expected:
        raise ValueError("Asset directory contains unrelated files; use a dedicated deployment directory")
    paths = validate_outputs([directory / name for name in sorted(expected)], sources=sources)
    directory.mkdir(parents=True, exist_ok=True)
    for row in assets:
        path = directory / row["name"]
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise ValueError("Cached release assets must be ordinary files")
            cached = path.read_bytes()
            if len(cached) == row["size"] and hashlib.sha256(cached).hexdigest() == row["digest"][7:]:
                continue
        # Asset IDs avoid wildcard/tag/name ambiguity and authenticated URLs in logs.
        body = download_asset_bytes(repository, row["id"])
        if len(body) != row["size"] or hashlib.sha256(body).hexdigest() != row["digest"][7:]:
            raise ValueError(f"GitHub asset bytes differ from published metadata: {row['name']}")
        atomic_write_bytes(path, body, sources=sources)
    return paths, assets


def render_php(path):
    php = shutil.which("php")
    if php is None:
        raise ValueError("PHP CLI is required when --expected-json-output is requested")
    lint = subprocess.run([php, "-l", str(path)], capture_output=True, check=False)
    if lint.returncode:
        raise ValueError("Generated PHP configuration failed syntax validation")
    rendered = subprocess.run([php, str(path)], capture_output=True, check=False)
    if rendered.returncode:
        raise ValueError("Generated PHP configuration failed JSON rendering")
    payload = json.loads(rendered.stdout)
    if not isinstance(payload, dict) or payload.get("status") == "fail":
        raise ValueError("Generated PHP configuration returned a failure response")
    return payload


def prepare(repository, directory, config_output, metadata_output, github_output=None, expected_json_output=None):
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("--repository or GITHUB_REPOSITORY must identify an owner/repository")
    item = component_versions()["launcher"]
    item["tag"] = f"launcher-v{item['version']}"
    head = command(["git", "rev-parse", "HEAD"]).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("Checkout must have an ordinary 40-character Git commit")
    dirty = command(["git", "diff", "HEAD", "--name-only", "-z"], binary=True)
    untracked = command(["git", "ls-files", "--others", "--exclude-standard", "-z"], binary=True)
    if any(component_path("launcher", name.decode("utf-8"))
           for name in [*dirty.split(b"\0"), *untracked.split(b"\0")] if name):
        raise ValueError("Launcher sources have uncommitted changes; commit and increment the version first")
    if TEMPLATE.is_symlink() or not TEMPLATE.is_file():
        raise ValueError("Current PHP template must be an ordinary repository file")
    sources = output_sources()
    outputs = [Path(config_output), Path(metadata_output)]
    outputs += [Path(path) for path in (github_output, expected_json_output) if path is not None]
    expected = all_asset_names("launcher", item)
    validate_outputs([*outputs, *(directory / name for name in expected)], sources=sources)
    release = github_release(repository, item["tag"])
    if (not isinstance(release, dict) or release.get("draft") is not False
            or release.get("tag_name") != item["tag"]
            or type(release.get("id")) is not int or release["id"] <= 0):
        raise ValueError("Launcher deployment requires a complete published GitHub release")
    paths, assets = download_published_assets(repository, release, item, directory, sources)
    provenance = json.loads((directory / f"provenance-{item['tag']}.json").read_text(encoding="utf-8"))
    if not isinstance(provenance, dict):
        raise ValueError("Published launcher provenance must be a JSON object")
    for key, expected_value in {"schema": 1, "component": "launcher", "repository": repository,
                                "tag": item["tag"], "version": item["version"],
                                "runtime_version": item["runtime_version"], "workflow": "release.yml"}.items():
        if provenance.get(key) != expected_value:
            raise ValueError(f"Published launcher provenance has an unexpected {key}")
    commit = provenance.get("source_commit")
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise ValueError("Published launcher source commit is invalid")
    for key in ("source_sha256", "notes_sha256"):
        if not isinstance(provenance.get(key), str) or HEX_SHA256.fullmatch(provenance[key]) is None:
            raise ValueError(f"Published launcher provenance has an invalid {key}")
    if github_tag_commit(repository, item["tag"]) != commit:
        raise ValueError("Published launcher tag differs from its provenance source commit")
    original_fingerprint, count = source_fingerprint("launcher", commit)
    current_fingerprint, _ = source_fingerprint("launcher", head)
    if original_fingerprint != provenance["source_sha256"] or provenance.get("source_files") != count:
        raise ValueError("Published launcher provenance does not match its original source files")
    if current_fingerprint != original_fingerprint:
        raise ValueError("Launcher sources changed since publication; increment the launcher version before deployment")
    item.update({"source_sha256": original_fingerprint, "notes_sha256": provenance["notes_sha256"]})
    original_plan = {"schema": 1, "repository": repository, "commit": commit,
                     "components": {"launcher": item}}
    verify_release_directory(original_plan, "launcher", directory)
    notes = matching_notes(release, provenance)
    payloads = {platform: {"platform": platform, "name": name,
                          "bytes": (directory / name).stat().st_size,
                          "sha256": hashlib.sha256((directory / name).read_bytes()).hexdigest()}
                for platform, name in zip(PLATFORMS, payload_names("launcher", item["version"]))}
    template = TEMPLATE.read_bytes().decode("utf-8")
    candidate, downloads = generate_candidate(template, item, notes, payloads)
    for platform, payload in payloads.items():
        payload["url"] = downloads[platform]["url"]
    sources = [*sources, *paths]
    validate_outputs(outputs, sources=sources)
    config_path = atomic_write_text(config_output, candidate, sources=sources)
    rendered = render_php(config_path) if shutil.which("php") or expected_json_output is not None else None
    if rendered is not None:
        if (rendered.get("update") != {"latest_version": item["version"], "release_notes": notes["zh-CN"],
                                      "downloads": downloads}
                or any(rendered.get("i18n", {}).get(locale, {}).get("release_notes") != notes[locale]
                       for locale in ("en", "zh-CN"))):
            raise ValueError("Rendered PHP update fields differ from the verified launcher release")
    metadata = {"schema": 1, "repository": repository, "component": "launcher", "tag": item["tag"],
                "version": item["version"], "release_id": release["id"], "source_commit": commit,
                "source_sha256": original_fingerprint, "prepared_from_commit": head,
                "config_sha256": hashlib.sha256(candidate.encode("utf-8")).hexdigest(),
                "release_notes": notes, "payloads": list(payloads.values()),
                "github_assets": [{"id": row["id"], "name": row["name"], "bytes": row["size"],
                                   "sha256": row["digest"][7:]} for row in assets],
                "php_validated": rendered is not None}
    atomic_write_text(metadata_output, json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", sources=sources)
    if expected_json_output is not None:
        atomic_write_text(expected_json_output, json.dumps(rendered, ensure_ascii=False, indent=2) + "\n", sources=sources)
    if github_output is not None:
        destination = Path(github_output)
        previous = destination.read_text(encoding="utf-8") if destination.exists() else ""
        values = {"launcher_version": item["version"], "launcher_tag": item["tag"],
                  "source_commit": commit, "config_sha256": metadata["config_sha256"]}
        atomic_write_text(destination, previous + "".join(f"{key}={value}\n" for key, value in values.items()), sources=sources)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--assets-directory", type=Path, required=True)
    parser.add_argument("--config-output", type=Path, required=True)
    parser.add_argument("--metadata-output", type=Path, required=True)
    parser.add_argument("--github-output", type=Path)
    parser.add_argument("--expected-json-output", type=Path)
    args = parser.parse_args()
    try:
        metadata = prepare(args.repository, args.assets_directory, args.config_output, args.metadata_output,
                           args.github_output, args.expected_json_output)
        print(f"Prepared {metadata['tag']}: all seven published assets, source, versions and SHA-256 values verified")
        print("Generated deployment-only PHP candidate preserving all non-update configuration")
        if not metadata["php_validated"]:
            print("PHP CLI unavailable locally; deployment must validate PHP syntax and rendered JSON before publication")
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError, zipfile.BadZipFile,
            subprocess.SubprocessError) as error:
        print(f"Launcher preparation rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
