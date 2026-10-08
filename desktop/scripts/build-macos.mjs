import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...process.env };
const available = () => spawnSync('cargo', ['--version'], { env, stdio: 'ignore' }).status === 0;
if (process.platform !== 'darwin') {
  console.error('此命令仅用于本机 macOS 构建。');
  process.exit(1);
}
if (!available()) {
  const cached = join(desktop, '../archive/cache/toolchains/rust');
  const candidates = [
    { cargo: env.CARGO_HOME || join(homedir(), '.cargo'), rustup: env.RUSTUP_HOME },
    { cargo: join(cached, 'cargo'), rustup: join(cached, 'rustup') },
  ];
  for (const candidate of candidates) {
    if (!existsSync(join(candidate.cargo, 'bin/cargo'))) continue;
    env.CARGO_HOME = candidate.cargo;
    if (candidate.rustup) env.RUSTUP_HOME = candidate.rustup;
    env.PATH = join(candidate.cargo, 'bin') + delimiter + (process.env.PATH || '');
    if (available()) break;
  }
}
if (!available()) {
  console.error('找不到可用的 Cargo：请安装 Rust，或恢复 archive/cache/toolchains/rust 工具链。');
  process.exit(1);
}
const result = spawnSync(process.execPath, [
  join(desktop, 'node_modules/@tauri-apps/cli/tauri.js'),
  'build', '--bundles', 'app', ...process.argv.slice(2),
], { cwd: desktop, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
