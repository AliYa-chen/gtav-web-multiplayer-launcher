"""Compile the launcher's own short WAT instruction fragments using only stdlib.

These sources are additions to an audited, player-supplied engine. They are not
the original engine's source. The supported flat WAT subset is intentionally
small: unsupported syntax, missing sources and out-of-range immediates fail
before the builder publishes a runtime copy. No precompiled byte fallback exists.

The files contain standard instruction sequences, suitable for wrapping in a
WAT function when checking them with a full compiler such as WABT. Function
locals and the final binary end instruction belong to the surrounding function,
not to these fragments.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re

SOURCE_ROOT = Path(__file__).resolve().parents[1] / "engine/online"
SOURCE_FILES = (
    "script-tick.wat",
    "public-script-gate.wat",
    "frontend-callback.wat",
    "public-model-wrapper.wat",
)
COMPILER_VERSION = "stdlib-flat-wat-v1"

# No general module parser or opaque byte injection is accepted. Extend this
# table together with independent standard-compiler checks for new operations.
_OPERATIONS = {
    "nop": (0x01, None),
    "drop": (0x1A, None),
    "local.get": (0x20, "u32"),
    "call": (0x10, "u32"),
    "br_if": (0x0D, "u32"),
    "i32.const": (0x41, "i32"),
    "i64.const": (0x42, "i64"),
}
_INTEGER = re.compile(r"[+-]?(?:0x[0-9a-fA-F](?:_?[0-9a-fA-F])*|[0-9](?:_?[0-9])*)\Z")


@dataclass(frozen=True)
class CompiledSource:
    name: str
    source_sha256: str
    source_bytes: int
    instructions: bytes

    def evidence(self) -> dict:
        return {
            "path": "engine/online/" + self.name,
            "source_sha256": self.source_sha256,
            "source_bytes": self.source_bytes,
            "instructions_sha256": hashlib.sha256(self.instructions).hexdigest(),
            "instructions_bytes": len(self.instructions),
        }


def _tokens(text: str, origin: str):
    """Read flat tokens and standard WAT line/nested block comments."""
    position, line = 0, 1
    while position < len(text):
        if text[position].isspace():
            line += text[position] == "\n"
            position += 1
        elif text.startswith(";;", position):
            end = text.find("\n", position)
            position = len(text) if end < 0 else end
        elif text.startswith("(;", position):
            start_line, depth = line, 1
            position += 2
            while position < len(text) and depth:
                if text.startswith("(;", position):
                    depth += 1
                    position += 2
                elif text.startswith(";)", position):
                    depth -= 1
                    position += 2
                else:
                    line += text[position] == "\n"
                    position += 1
            if depth:
                raise ValueError(f"{origin}:{start_line}: unterminated WAT comment")
        else:
            start = position
            while (position < len(text) and not text[position].isspace()
                   and not text.startswith((";;", "(;"), position)):
                position += 1
            yield text[start:position], line


def _leb(value: int, *, signed: bool) -> bytes:
    result = bytearray()
    while True:
        byte, value = value & 0x7F, value >> 7
        done = ((value == 0 and not byte & 0x40) or (value == -1 and bool(byte & 0x40))) if signed else value == 0
        result.append(byte if done else byte | 0x80)
        if done:
            return bytes(result)


def _immediate(token: str, kind: str, origin: str, line: int) -> bytes:
    if not _INTEGER.fullmatch(token):
        raise ValueError(f"{origin}:{line}: invalid WAT integer {token!r}")
    digits = token.lstrip("+-").replace("_", "")
    value = int(digits, 16 if digits.startswith("0x") else 10)
    if token.startswith("-"):
        value = -value
    bits = 64 if kind == "i64" else 32
    minimum = 0 if kind == "u32" else -(1 << (bits - 1))
    maximum = (1 << bits) - 1
    if not minimum <= value <= maximum:
        raise ValueError(f"{origin}:{line}: {kind} integer is out of range: {token}")
    # WAT constants accept either signed integers or their unsigned bit pattern.
    # The binary representation always uses canonical signed LEB encoding.
    if kind != "u32" and value >= 1 << (bits - 1):
        value -= 1 << bits
    return _leb(value, signed=kind != "u32")


def compile_fragment(text: str, *, origin: str = "<WAT fragment>") -> bytes:
    tokens = iter(_tokens(text, origin))
    result = bytearray()
    instruction_count = 0
    for operation, line in tokens:
        if operation not in _OPERATIONS:
            raise ValueError(f"{origin}:{line}: unsupported WAT instruction {operation!r}")
        opcode, immediate_kind = _OPERATIONS[operation]
        result.append(opcode)
        if immediate_kind:
            try:
                token, immediate_line = next(tokens)
            except StopIteration as error:
                raise ValueError(f"{origin}:{line}: missing immediate for {operation}") from error
            result.extend(_immediate(token, immediate_kind, origin, immediate_line))
        instruction_count += 1
    if not instruction_count:
        raise ValueError(f"{origin}: empty WAT instruction fragment")
    return bytes(result)


def load_online_sources(source_root: Path = SOURCE_ROOT) -> dict[str, CompiledSource]:
    """Compile every required source; absence or invalid UTF-8 never falls back."""
    source_root = Path(source_root)
    result = {}
    for name in SOURCE_FILES:
        path = source_root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Required owned WAT source is missing or a symbolic link: {path}")
        data = path.read_bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"Owned WAT source must be UTF-8: {path}") from error
        result[name] = CompiledSource(name, hashlib.sha256(data).hexdigest(), len(data),
                                      compile_fragment(text, origin=str(path)))
    return result
