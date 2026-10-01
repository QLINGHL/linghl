/**
 * 诊断：用「当前活动环境」的 CODEX_HOME 直接问内核要一遍会话列表，
 * 确认「项目里的会话」到底有没有数据源。
 *
 * 复刻 appServer.ts 的启动方式（codex app-server + CODEX_HOME 环境变量），
 * 发 initialize → thread/list，把返回的会话与项目归属打出来。
 *
 * 用法：node tools/probe-env-threads.cjs [envId] [limit]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codex-desk-replica');
const reg = JSON.parse(fs.readFileSync(path.join(userData, 'envs.json'), 'utf-8'));
const wantId = process.argv[2] || reg.activeId;
const limit = Number(process.argv[3] || 200);
const env = reg.envs.find((e) => e.id === wantId);
if (!env) {
  console.error(`环境不存在: ${wantId}`);
  process.exit(1);
}

const candidates = [
  path.join(APP_DIR, 'vendor', 'codex', 'bin', 'codex.exe'),
  path.join(APP_DIR, 'vendor', 'codex', 'codex.exe'),
];
const codexPath = candidates.find((p) => fs.existsSync(p));
if (!codexPath) {
  console.error(`找不到内核：${candidates.join(' / ')}`);
  process.exit(1);
}

console.log(`环境: ${env.id} (${env.name})  CODEX_HOME=${env.codexHome}`);
console.log(`内核: ${codexPath}\n`);

const child = spawn(codexPath, ['app-server'], {
  env: { ...process.env, CODEX_HOME: env.codexHome, RUST_LOG: 'warn' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
const stderrLines = [];
child.stderr.on('data', (c) => stderrLines.push(c.toString('utf8')));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时: ${method}`)); } }, 30000);
  });
}

(async () => {
  await rpc('initialize', { clientInfo: { name: 'probe-env-threads', title: 'probe', version: '0.1.0' } });
  const resp = await rpc('thread/list', { limit, useStateDbOnly: true, archived: false });
  const rows = Array.isArray(resp?.data) ? resp.data : [];
  console.log(`thread/list 返回 ${rows.length} 条会话（limit=${limit}）`);

  const stateFile = path.join(env.codexHome, '.codex-global-state.json');
  const assign = fs.existsSync(stateFile)
    ? (JSON.parse(fs.readFileSync(stateFile, 'utf-8'))['thread-project-assignments'] ?? {})
    : {};
  const ids = new Set(rows.map((r) => r.id));
  const assigned = Object.keys(assign);
  console.log(`环境里的会话归属记录 ${assigned.length} 条，其中出现在 thread/list 里的 ${assigned.filter((id) => ids.has(id)).length} 条`);

  console.log('\n前 12 条（id / name / cwd）：');
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${String(r.id).slice(0, 12)}…  ${String(r.name ?? r.title ?? '').slice(0, 28)}  cwd=${String(r.cwd ?? '')}`);
  }
  const missing = assigned.filter((id) => !ids.has(id));
  if (missing.length) {
    console.log(`\n⚠️ 有 ${missing.length} 条归属记录在内核列表里找不到（侧栏项目展开会是空的）：`);
    for (const id of missing.slice(0, 10)) {
      const row = rows.find((r) => r.id === id);
      console.log(`  ${id}  ${row ? '(在列表里但 id 不同?)' : '(列表里没有)'}  assign.projectId=${assign[id]?.projectId}`);
    }
  }
  const errText = stderrLines.join('').trim();
  if (errText) console.log(`\n内核 stderr（尾部）:\n${errText.slice(-800)}`);
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('探测失败:', e.message);
  console.error('内核 stderr:', stderrLines.join('').slice(-1500));
  child.kill();
  process.exit(1);
});
