#!/usr/bin/env python3
"""Recover the supported online engine as local WAT, with a verified index.

This is a maintainer analysis tool, not the launcher runtime. It reads the
player's original engine, applies the same audited online adaptation in memory,
and uses explicitly selected WABT tools. Recovered game code stays outside the
game directory and must not be distributed as project-owned source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from build_native_probe import build, checked_audit, export_map
from generate_launcher_engine_spec import generate
from inspect_native_bridge import DEFAULT_WASM, ROOT, Reader, WasmAudit
from readonly_game_outputs import atomic_write_bytes, atomic_write_text, validate_output, validate_outputs


def digest_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def executable(value: str, name: str) -> str:
    selected = shutil.which(value)
    if not selected:
        raise ValueError(f'{name} not found: {value}; select an existing WABT executable')
    return selected


def run(command: list[str], *, stdout=None) -> str:
    try:
        result = subprocess.run(command, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, check=False, timeout=180)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f'{Path(command[0]).name} exceeded the 180-second conversion limit') from error
    if result.returncode:
        detail = result.stderr.decode('utf-8', 'replace')[-4000:]
        raise ValueError(f'{Path(command[0]).name} failed ({result.returncode}): {detail}')
    return result.stdout.decode('utf-8', 'replace').strip() if stdout is None else ''


def standard_sections(data: bytes) -> list[tuple[int, bytes]]:
    """Keep order, section headers and payloads, excluding custom metadata."""
    reader = Reader(data, 8)
    result = []
    while reader.pos < reader.end:
        start = reader.pos
        kind, length = reader.byte(), reader.leb()
        reader.take(length)
        if kind:
            result.append((kind, data[start:reader.pos]))
    return result


def publish_staged(staged: Path, destination: Path, boundary: dict) -> None:
    """Atomically replace from a new private file; never write an input inode."""
    destination = validate_output(destination, **boundary)
    destination.parent.mkdir(parents=True, exist_ok=True)
    validate_output(staged, **boundary)
    with staged.open('rb') as stream:
        os.fsync(stream.fileno())
    validate_output(destination, **boundary)
    os.replace(staged, destination)


def recover(original: Path, output: Path, wasm2wat: str, wat2wasm: str) -> dict:
    lexical_original = original.absolute()
    original = original.resolve()
    protected = tuple(path.parents[2] if path.parent.parent.name == 'b' else path.parent
                      for path in (lexical_original, original))
    spec_path = ROOT / 'desktop/src-tauri/assets/engine-spec.json'
    boundary = {'sources': (original, DEFAULT_WASM, spec_path), 'protected_roots': protected}
    destinations = validate_outputs((output / 'online-engine.wat', output / 'functions.tsv',
                                     output / 'interfaces.json', output / 'recovery.json'), **boundary)
    output = destinations[0].parent
    # Reject unsafe outputs before version checks, subprocesses or file creation.
    audit = checked_audit(original, entity_probe=True, public_client=True)
    online, adaptation = build(audit, entity_probe=True, public_client=True)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    # Sidecar patch provenance must also match; a final online hash alone does
    # not prove that a hand-edited spec describes how that output was produced.
    if spec != generate(original):
        raise ValueError('The committed launcher engine spec does not match the complete current adaptation')
    online_digest = hashlib.sha256(online).hexdigest()
    if online_digest != spec['online_sha256'] or len(online) != spec['online_bytes']:
        raise ValueError('The committed launcher engine spec does not match the current adaptation')
    converters = {'wasm2wat': run([wasm2wat, '--version']), 'wat2wasm': run([wat2wasm, '--version'])}
    output.mkdir(parents=True, exist_ok=True)
    validate_outputs(destinations, **boundary)
    with tempfile.TemporaryDirectory(prefix='.online-recovery-', dir=output) as directory:
        temporary = Path(directory)
        runtime, text, roundtrip, index = validate_outputs(
            (temporary / 'online.wasm', temporary / 'online.wat',
             temporary / 'roundtrip.wasm', temporary / 'functions.tsv'), **boundary)
        atomic_write_bytes(runtime, online, **boundary)
        # WABT only writes to private, explicitly validated temporary paths.
        # Retain actual debug names; do not generate invented names or skip validation.
        run([wasm2wat, '--enable-all', str(runtime), '-o', str(text)])
        run([wat2wasm, '--enable-all', '--debug-names', str(text), '-o', str(roundtrip)])
        rebuilt = WasmAudit(roundtrip)
        source_online = WasmAudit(runtime)
        if standard_sections(source_online.data) != standard_sections(rebuilt.data):
            raise ValueError('Round-trip changed standard section order, headers or payloads')
        if source_online.sections.keys() != rebuilt.sections.keys():
            raise ValueError('Round-trip changed standard section coverage')
        sections = []
        for kind, (start, end) in source_online.sections.items():
            rebuilt_start, rebuilt_end = rebuilt.sections[kind]
            expected = source_online.data[start:end]
            if expected != rebuilt.data[rebuilt_start:rebuilt_end]:
                raise ValueError(f'Round-trip changed standard WASM section {kind}')
            sections.append({'section_id': kind, 'bytes': len(expected),
                             'sha256': hashlib.sha256(expected).hexdigest()})
        function_lines = {}
        next_function = source_online.import_count
        with text.open(encoding='utf-8') as stream:
            for number, line in enumerate(stream, 1):
                if re.match(r'^  \(func\s', line):
                    function_lines[next_function] = number
                    next_function += 1
        if next_function != len(source_online.function_types):
            raise ValueError('WAT function declarations do not match the verified binary index')
        with index.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write('function_index\twat_line\tparameters\tresults\tbody_sha256\tname_json\texports_json\n')
            for function in range(len(source_online.function_types)):
                descriptor = source_online.descriptor(function)
                body = source_online.bodies.get(function)
                fields = (str(function), str(function_lines.get(function, '')),
                          ','.join(descriptor['signature']['parameters']),
                          ','.join(descriptor['signature']['results']),
                          hashlib.sha256(source_online.data[slice(*body)]).hexdigest() if body else '',
                          json.dumps(descriptor['name'], ensure_ascii=False),
                          json.dumps(descriptor['exports'], ensure_ascii=False))
                stream.write('\t'.join(fields) + '\n')
        for name, value in export_map(True).items():
            if value[0] not in function_lines:
                raise ValueError(f'Multiplayer export {name} is not a defined function in the recovered WAT')
        interfaces = {'schema_version': 1, 'online_sha256': online_digest,
                      'exports': [{'export_name': name, **source_online.descriptor(value[0]),
                                   'wat_line': function_lines[value[0]]}
                                  for name, value in export_map(True).items()],
                      'patches': spec['patches']}
        interface_text = json.dumps(interfaces, ensure_ascii=False, indent=2) + '\n'
        if digest_file(original) != adaptation['original']['sha256']:
            raise ValueError('Original engine changed during recovery; no recovered outputs published')
        report = {'schema_version': 1, 'kind': 'recovered_wat_not_original_cpp',
                  'original': adaptation['original'],
                  'online': {'sha256': online_digest, 'bytes': len(online)},
                  'functions': len(source_online.function_types),
                  'defined_functions': len(source_online.bodies),
                  'named_functions': len(source_online.names),
                  'multiplayer_exports': len(interfaces['exports']),
                  'tools': converters, 'launcher_spec_sha256': digest_file(spec_path),
                  'adapter': {'owned_sources': adaptation['owned_sources']},
                  'original_engine_changed': False,
                  'roundtrip': {'standard_sections_byte_identical': True, 'sections': sections,
                                'standard_section_order_and_headers_identical': True,
                                'custom_sections_preserved': False, 'execution_observed': False},
                  'files': [{'path': str(destinations[0]), 'sha256': digest_file(text), 'bytes': text.stat().st_size},
                            {'path': str(destinations[1]), 'sha256': digest_file(index), 'bytes': index.stat().st_size},
                            {'path': str(destinations[2]), 'sha256': hashlib.sha256(interface_text.encode()).hexdigest(),
                             'bytes': len(interface_text.encode())}],
                  'limitations': ['Original C/C++ files, local variable names, macros, comments and build project are not recovered.',
                                  'WAT contains derived game code/data and is local analysis material, not project-owned distributable source.',
                                  'WABT regenerates debug custom sections and omits other custom sections; the whole binary digest can differ.',
                                  'Section equality proves binary round-trip fidelity, not live gameplay or new engine-version support.']}
        # The last published manifest includes hashes for all outputs; consumers
        # must verify them before treating a previous/interrupted run as complete.
        validate_outputs(destinations, **boundary)
        publish_staged(text, destinations[0], boundary)
        publish_staged(index, destinations[1], boundary)
        atomic_write_text(destinations[2], interface_text, **boundary)
        atomic_write_text(destinations[3], json.dumps(report, ensure_ascii=False, indent=2) + '\n', **boundary)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wasm', type=Path, default=DEFAULT_WASM, help='Supported read-only original engine')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'archive/recovered/online-engine')
    parser.add_argument('--wasm2wat', default='wasm2wat', help='Existing WABT wasm2wat executable')
    parser.add_argument('--wat2wasm', default='wat2wasm', help='Existing WABT wat2wasm executable')
    args = parser.parse_args(argv)
    try:
        report = recover(args.wasm, args.output_dir,
                         executable(args.wasm2wat, 'wasm2wat'), executable(args.wat2wasm, 'wat2wasm'))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps({key: report[key] for key in ('online', 'functions', 'defined_functions',
                     'named_functions', 'multiplayer_exports', 'original_engine_changed')}, ensure_ascii=False))
    print(f"Recovered WAT and index: {args.output_dir}; standard sections round-trip byte-identical")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
