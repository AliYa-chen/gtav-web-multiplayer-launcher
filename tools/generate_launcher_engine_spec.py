#!/usr/bin/env python3
"""从已审计构建器导出桌面启动器的确定性补丁描述，不分发游戏引擎。

这是维护者构建工具；玩家启动 Tauri 程序时无需 Python。描述中仅有导出索引、
校验散列和三个短补丁，运行时仍须读取玩家自己提供的完整原引擎。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
from build_native_probe import (  # noqa: E402
    CALLBACK_IMPORT, EXPECTED_MODEL_WRAPPER, EXPECTED_RUN_PREFIX,
    FRONTEND_FUNCTION, FRONTEND_TAIL, HOOK_FUNCTION, HOOK_INSTRUCTION_OFFSET,
    HOOK_INSTRUCTION_START, ORIGINAL_SHA256, PUBLIC_MODEL_WRAPPER,
    build, checked_audit, export_map,
)
from inspect_native_bridge import DEFAULT_WASM, ROOT  # noqa: E402
from readonly_game_outputs import atomic_write_text, validate_output  # noqa: E402


def generate(path: Path) -> dict:
    audit = checked_audit(path, entity_probe=True, public_client=True)
    online, report = build(audit, entity_probe=True, public_client=True)
    patches = []
    for index, label, operation, offset, patch_bytes, prefix, tail in (
        (HOOK_FUNCTION, 'script_context_callback', 'insert',
         report['hook']['original_file_offset'] - audit.bodies[HOOK_FUNCTION][0],
         bytes.fromhex(report['hook']['inserted_bytes_hex']), EXPECTED_RUN_PREFIX, b''),
        (FRONTEND_FUNCTION, 'pause_menu_callback', 'insert',
         audit.bodies[FRONTEND_FUNCTION][1] - audit.bodies[FRONTEND_FUNCTION][0] - len(FRONTEND_TAIL),
         bytes.fromhex(report['frontend_hook']['inserted_bytes_hex']), b'', FRONTEND_TAIL),
        (PUBLIC_MODEL_WRAPPER, 'singleplayer_model_wrapper', 'replace', 0,
         bytes.fromhex(report['public_model_patch']['replacement_body_hex']), EXPECTED_MODEL_WRAPPER, b''),
    ):
        start, end = audit.bodies[index]
        patches.append({
            'label': label,
            'function_index': index,
            'original_body_offset': start,
            'original_body_bytes': end - start,
            'original_body_sha256': hashlib.sha256(audit.data[start:end]).hexdigest(),
            'operation': operation,
            'offset': offset,
            'bytes_hex': patch_bytes.hex(),
            'expected_prefix_hex': prefix.hex(),
            'expected_tail_hex': tail.hex(),
        })
    return {
        'format_version': 1,
        'purpose': '玩家提供原引擎；启动器仅在外部缓存生成离线和公共战局运行副本。',
        'original_sha256': ORIGINAL_SHA256,
        'original_bytes': len(audit.data),
        'online_sha256': hashlib.sha256(online).hexdigest(),
        'online_bytes': len(online),
        'imported_functions': audit.import_count,
        'callback_import': CALLBACK_IMPORT,
        'exports': [
            {'name': name, 'function_index': value[0], 'parameters': value[2], 'results': value[3]}
            for name, value in export_map(True).items()
        ],
        'patches': patches,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wasm', type=Path, default=DEFAULT_WASM)
    parser.add_argument('--output', type=Path, default=ROOT / 'desktop/src-tauri/assets/engine-spec.json')
    parser.add_argument('--check', action='store_true', help='仅校验已提交描述与当前构建器是否一致')
    args = parser.parse_args(argv)
    original = args.wasm.resolve()
    protected_roots = tuple(path.parents[2] for path in (args.wasm.absolute(), original)
                            if path.parent.parent.name == 'b')
    if not args.check:
        try:
            args.output = validate_output(args.output, sources=(original, DEFAULT_WASM),
                                          protected_roots=protected_roots)
        except ValueError as error:
            parser.error(str(error))
    text = json.dumps(generate(args.wasm), ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding='utf-8') != text:
            parser.error('桌面引擎补丁描述已过期，请重新生成并提交。')
        print('桌面引擎补丁描述与 Python 参考构建器一致。')
    else:
        atomic_write_text(args.output, text, sources=(original, DEFAULT_WASM),
                          protected_roots=protected_roots)
        print(f'已生成不含完整游戏引擎的补丁描述：{args.output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
