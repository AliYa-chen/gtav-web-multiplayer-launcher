"""Publish launcher/server artifacts without writing into installed game data.

All destinations, including audit sidecars, must use this boundary. Validation is
also available before expensive work so a multi-file export fails before it has
published anything. The original files are never opened for writing; publishing
replaces a directory entry from a new, exclusively created temporary file.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GAME_ROOT = ROOT / "gta5data"


class UnsafeOutputError(ValueError):
    """An artifact destination could change read-only game inputs."""


def _absolute(path: Path | str) -> Path:
    path = Path(path).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except (OSError, RuntimeError) as error:
        raise UnsafeOutputError(f"Cannot resolve artifact path: {path}") from error


def _inside(path: Path, root: Path) -> bool:
    if path.is_relative_to(root):
        return True
    # macOS volumes may compare names without case while PosixPath does not.
    # Check existing directory identities before trusting lexical inequality.
    for ancestor in (path, *path.parents):
        try:
            if ancestor.samefile(root):
                return True
        except FileNotFoundError:
            continue
        except OSError as error:
            raise UnsafeOutputError(f"Cannot inspect protected output directory: {ancestor}") from error
    return False


def validate_output(path: Path | str, *, sources=(), protected_roots=()) -> Path:
    """Return a safe absolute destination, rejecting game paths and input aliases.

The repository's installed game is always protected, even when another source
game root was selected. Existing output symlinks are rejected (including broken
ones); parent links are resolved and checked against every protected directory.
An existing hard link to an explicitly supplied source is rejected as well.
"""
    absolute = _absolute(path)
    if absolute.is_symlink():
        raise UnsafeOutputError(f"Artifact output must not be a symbolic link: {absolute}")
    destination = _resolved(absolute)
    lexical = Path(os.path.abspath(absolute))
    for root in (GAME_ROOT, *protected_roots):
        root = _absolute(root)
        if (_inside(destination, _resolved(root))
                or _inside(lexical, Path(os.path.abspath(root)))):
            raise UnsafeOutputError(f"Artifact output is inside read-only game resources: {absolute}")
    for source in sources:
        source = _absolute(source)
        if destination == _resolved(source):
            raise UnsafeOutputError(f"Artifact output would overwrite an input: {absolute}")
        try:
            aliases_source = destination.exists() and source.exists() and destination.samefile(source)
        except OSError as error:
            raise UnsafeOutputError(f"Cannot inspect artifact input alias: {absolute}") from error
        if aliases_source:
            raise UnsafeOutputError(f"Artifact output is a hard link to an input: {absolute}")
    if destination.exists() and not destination.is_file():
        raise UnsafeOutputError(f"Artifact output is not a regular file: {absolute}")
    return destination


def validate_outputs(paths, *, sources=(), protected_roots=()) -> tuple[Path, ...]:
    """Check every artifact before publication, including duplicate destinations."""
    sources, protected_roots = tuple(sources), tuple(protected_roots)
    outputs = tuple(validate_output(path, sources=sources, protected_roots=protected_roots)
                    for path in paths)
    if len(set(outputs)) != len(outputs):
        raise UnsafeOutputError("Artifact outputs must have distinct paths")
    return outputs


def atomic_write_bytes(path: Path | str, data: bytes, *, sources=(), protected_roots=()) -> Path:
    """Write a fresh temporary file, then atomically publish its directory entry."""
    sources, protected_roots = tuple(sources), tuple(protected_roots)
    destination = validate_output(path, sources=sources, protected_roots=protected_roots)
    destination.parent.mkdir(parents=True, exist_ok=True)
    validate_output(path, sources=sources, protected_roots=protected_roots)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.launcher-", suffix=".tmp", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        validate_output(path, sources=sources, protected_roots=protected_roots)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def atomic_write_text(path: Path | str, text: str, encoding="utf-8", *, sources=(), protected_roots=()) -> Path:
    return atomic_write_bytes(path, text.encode(encoding), sources=sources, protected_roots=protected_roots)
