# Online engine source and recovery

## English

The launcher selects two distinct runtime files. Story and sandbox load `/engine/offline/game.wasm`, a byte-identical copy of the player's original engine. Public sessions load `/engine/online/game.wasm`, which the launcher generates from that same read-only original with verified exports and three bounded function-body adaptations. It is an adapted engine, not an independent engine rebuilt from recovered C++.

### Maintained source

| Source | Role |
| --- | --- |
| [`engine/online/script-tick.wat`](../engine/online/script-tick.wat) | Call our JavaScript bridge after the engine installs an active script context. |
| [`engine/online/public-script-gate.wat`](../engine/online/public-script-gate.wat) | Skip the audited single-player VM block when the public-session policy requires it, retaining original context cleanup. |
| [`engine/online/frontend-callback.wat`](../engine/online/frontend-callback.wat) | Call our menu bridge at the verified normal pause-menu tail. |
| [`engine/online/public-model-wrapper.wat`](../engine/online/public-model-wrapper.wat) | Suppress the single-player script model-switch wrapper; the exported native model setter remains available. |
| [`online_engine_source.py`](../tools/online_engine_source.py) | Compile our flat WAT instruction subset using the Python standard library; missing files, unsupported syntax and invalid integers fail. |
| [`build_native_probe.py`](../tools/build_native_probe.py) | Check the supported original digest, function names/ABI, body fingerprints and insertion boundaries; add audited exports and source-compiled hooks. |
| [`engine-spec.json`](../desktop/src-tauri/assets/engine-spec.json), [`engine.rs`](../desktop/src-tauri/src/engine.rs) | Reproduce the same adaptation in packaged launchers with complete input/output hash checks, without Python or WABT. |

The `.wat` files are standard instruction fragments inserted into verified existing functions, not standalone modules or the full game's source. The small compiler intentionally has no binary fallback. Extending its supported syntax requires a matching standard-compiler check. The source ZIP includes exactly these four owned fragments and the compiler; it excludes recovered game code and complete engines.

### Recovered engine text

[`recover_online_engine_source.py`](../tools/recover_online_engine_source.py) builds the current online engine in isolated temporary files and exports:

| Local output under `archive/recovered/online-engine/` | Content |
| --- | --- |
| `online-engine.wat` | Full WebAssembly text, including original function names and data segments. |
| `functions.tsv` | Function index, WAT line, ABI, function-body digest, original name and exports. |
| `interfaces.json` | Audited multiplayer interface names, signatures, source locations and patch descriptors. |
| `recovery.json` | Input/output digests, converter versions, round-trip checks and limitations. |

Use an existing native WABT installation. The tool does not install dependencies:

```sh
python3 -B tools/recover_online_engine_source.py \
  --wasm /path/to/browser-game/b/8b0b5899ed/game.wasm \
  --output-dir archive/recovered/online-engine \
  --wasm2wat /path/to/wabt/bin/wasm2wat \
  --wat2wasm /path/to/wabt/bin/wat2wasm
```

The verified local recovery contains **91,111 named functions** (85 imports and 91,026 defined functions) and **298 multiplayer exports**. WABT 1.0.39 recompiled the recovered WAT, and every standard WASM section was byte-identical to the generated online engine. Custom sections are regenerated or omitted, so the complete recompiled file need not have the same digest. The WAT is approximately 564 MiB; use the function index to inspect a bounded range instead of loading the entire file into an editor.

Recovery cannot reconstruct the original C/C++ source files, classes, local variable names, macros, comments, build configuration or original compiler project. WAT is editable and recompilable low-level text. It is valuable for native analysis, but it does not make arbitrary engine changes equivalent to ordinary C++ development. Recovered code and embedded data remain local derived game material in ignored `archive/`; they are not included in source packages or published as project-owned MIT source. These checks establish static conversion fidelity, not rendered gameplay or support for another engine version.

### Adding a feature

1. Implement shared rules, authority, sequencing and persistence in the Java server; implement intent sampling and presentation in the JavaScript bridges.
2. If an audited native already exists, use its exported interface without changing the engine.
3. If another native is needed, use recovered text and the read-only audit tools to verify its actual ABI, script context, lifecycle and limits. Add its checked export to `build_native_probe.py`.
4. If a hook must change, edit our WAT fragment and extend the small compiler only for verified instructions. Rebuild the online reference and regenerate `engine-spec.json`; check that Rust produces the same bytes.
5. Generate both runtime copies for each supported resource path and check that the original hashes are unchanged, offline bytes match the original, and unsupported versions/unsafe outputs fail.

The complete recovered WAT is not the launcher's build input. Each player still supplies the supported original engine; the launcher generates a checked online copy outside the resource directory. These sources are maintained in launcher 0.2.19. Recovery itself produces local analysis files; releases build the launcher from its owned sources and the checked adaptation specification.

## 简体中文

启动器选择两个不同的运行文件：故事和单机沙盒加载 `/engine/offline/game.wasm`，它与玩家原始引擎逐字节一致；公共在线战局加载 `/engine/online/game.wasm`，由启动器只读同一份原引擎，增加经过核验的导出和三处受限函数体适配后生成。因此在线版是我们的适配引擎，目前还不是从完整 C++ 源码编译的独立游戏引擎。

### 可以直接维护的源码

| 源码 | 用途 |
| --- | --- |
| [`script-tick.wat`](../engine/online/script-tick.wat) | 原引擎安装活动脚本上下文后调用自有 JavaScript 桥。 |
| [`public-script-gate.wat`](../engine/online/public-script-gate.wat) | 按公共战局策略跳过已核验的单机 VM 区段，保留原上下文清理。 |
| [`frontend-callback.wat`](../engine/online/frontend-callback.wat) | 在原暂停菜单正常更新尾部调用自有菜单桥。 |
| [`public-model-wrapper.wat`](../engine/online/public-model-wrapper.wat) | 屏蔽单机脚本角色切换包装器，保留直接导出的原生角色设置函数。 |
| [`online_engine_source.py`](../tools/online_engine_source.py) | 用 Python 标准库编译自有 WAT 小指令集；缺文件、未知语法和整数越界明确失败。 |
| [`build_native_probe.py`](../tools/build_native_probe.py) | 检查原引擎版本、函数名称/ABI、函数体指纹和插入边界，添加已核验接口和源码生成的钩子。 |
| [`engine-spec.json`](../desktop/src-tauri/assets/engine-spec.json)、[`engine.rs`](../desktop/src-tauri/src/engine.rs) | 成品启动器复现同一适配并校验完整输入/输出哈希，玩家无需 Python 或 WABT。 |

四份 `.wat` 是插入已核验原函数的标准指令片段，不是独立模块或完整游戏源码。构建器实际读取这些源码，没有旧二进制兜底；新增编译指令要与标准编译器对照。源码启动器 ZIP 仅包含这四段自有源码及其编译器，不包含完整引擎或原引擎反编译结果。

### 已恢复的引擎文本

[`recover_online_engine_source.py`](../tools/recover_online_engine_source.py) 在隔离临时目录生成当前在线引擎，并导出：

| `archive/recovered/online-engine/` 下的本地文件 | 内容 |
| --- | --- |
| `online-engine.wat` | 完整 WebAssembly 文本，保留原函数名称和数据段。 |
| `functions.tsv` | 函数索引、WAT 行号、ABI、函数体哈希、原名称及导出。 |
| `interfaces.json` | 已核验多人接口的名称、签名、源码位置和补丁描述。 |
| `recovery.json` | 输入/输出摘要、工具版本、往返编译结果和恢复边界。 |

使用已有原生 WABT 工具，命令见上文；恢复工具本身不安装依赖。此次实际恢复 **91,111 个具名函数**，其中 85 个导入、91,026 个有函数体，并整理 **298 个多人接口**。WABT 1.0.39 重新编译后，所有标准 WASM 节与生成的在线引擎逐字节一致；自定义节会重新生成或省略，不能据此要求整个文件哈希相同。完整 WAT 约 564 MiB，建议按函数索引定位有限行数阅读。

反编译不能恢复原 C/C++ 文件、类定义、局部变量名、宏、注释及完整编译工程。WAT 是可以编辑和重新编译的低层源码文本，适合分析原生能力；它不能使任意底层修改变成普通 C++ 开发。完整反编译内容及内嵌数据是本地游戏派生材料，保存在被忽略的 `archive/`，不进入源码包，不作为本项目 MIT 自有源码发布。往返一致证明静态转换正确，不代表已观察实机玩法或支持其他引擎版本。

### 后续添加功能

1. 服务端 Java 实现共同规则、权限、时序和持久化，客户端 JavaScript 桥实现意图采集和表现。
2. 已有已核验 native 时直接使用接口，无需修改引擎。
3. 缺接口时，结合恢复文本和只读审计工具核对 ABI、脚本上下文、生命周期及限制，再在 `build_native_probe.py` 添加受校验导出。
4. 需要变更钩子时修改自有 WAT；编译器只增加经过核验的指令。重建在线参考并生成 `engine-spec.json`，核对 Rust 构建结果一致。
5. 对每份受支持资源路径生成两份运行副本，检查原输入哈希不变、离线逐字节相同、不兼容版本和危险输出明确失败。

启动器不会直接以整份恢复 WAT 构建游戏。每位玩家仍提供受支持原引擎，启动器在资源目录之外生成并核验在线副本。这些源码由启动器 0.2.19 维护。恢复工具只生成本地分析文件；发布流程根据自有源码与已校验适配规格构建启动器。
