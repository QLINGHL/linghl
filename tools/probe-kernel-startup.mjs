/**
 * 量内核 app-server 的冷启动耗时，并列出拖时间的阶段。
 *
 * 用法：node tools/probe-kernel-startup.mjs [内核路径] [CODEX_HOME]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const codex = process.argv[2] || path.join(process.cwd(), 'vendor', 'codex', 'bin', 'codex.exe');
const home = process.argv[3] || path.join(os.homedir(), '.codex');

console.log(`内核: ${codex}\nCODEX_HOME: ${home}\n`);

// ~/.codex 里的体积/垃圾文件（清理它们可能缩短启动）
const arg0 = path.join(home, 'tmp', 'arg0');
const count = (dir) => {
  try { return fs.readdirSync(dir).length; } catch { return -1; }
};
console.log(`tmp/arg0 残留目录: ${count(arg0)} 个`);
const tmpPlugins = path.join(home, '.tmp', 'plugins');
console.log(`.tmp/plugins 存在: ${fs.existsSync(tmpPlugins)}`);

const t0 = Date.now();
const child = spawn(codex, ['app-server'], {
  cwd: os.homedir(),
  env: { ...process.env, CODEX_HOME: home, RUST_LOG: 'info' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let out = '';
let firstLog = null;
const marks = [];
child.stdout.on('data', (c) => {
  out += c;
  if (out.includes('"result"') && !marks.some((m) => m.what === 'initialize OK')) {
    marks.push({ what: 'initialize OK', ms: Date.now() - t0 });
    console.log(marks.map((m) => `${m.what}: ${m.ms}ms`).join('\n'));
    child.kill();
    setTimeout(() => process.exit(0), 200);
  }
});
child.stderr.on('data', (c) => {
  const text = String(c);
  if (firstLog == null) { firstLog = Date.now() - t0; marks.push({ what: '首条 stderr', ms: firstLog }); }
  for (const line of text.split('\n')) {
    const m = /\b(INFO|WARN)\s+(\S+)/.exec(line);
    if (m && marks.length < 12 && !marks.some((x) => x.what === m[2])) marks.push({ what: m[2].slice(0, 48), ms: Date.now() - t0 });
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'probe', title: 'probe', version: '1' } } }) + '\n');

setTimeout(() => {
  console.log('超时（60s）未完成 initialize');
  for (const m of marks) console.log(`  ${m.ms}ms  ${m.what}`);
  child.kill();
  process.exit(1);
}, 60000);
