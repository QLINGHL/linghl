/**
 * 诊断：复刻版「项目 / 项目里的会话」到底能不能从当前环境读出来。
 *
 * 复刻 readEnvProjects()（src/main/envManager.ts）的解析逻辑，直接读活动环境的
 * `<codexHome>/.codex-global-state.json` + `state_5.sqlite`，把结果打出来。
 * 用法：node tools/dump-env-projects.cjs [envId]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codex-desk-replica');
const reg = JSON.parse(fs.readFileSync(path.join(userData, 'envs.json'), 'utf-8'));
const wantId = process.argv[2] || reg.activeId;
const env = reg.envs.find((e) => e.id === wantId);
if (!env) {
  console.error(`环境不存在: ${wantId}（可选: ${reg.envs.map((e) => e.id).join(', ')}）`);
  process.exit(1);
}
console.log(`活动环境: ${env.id} (${env.name})  codexHome=${env.codexHome}  kind=${env.kind} mode=${env.mode}`);

const stateFile = path.join(env.codexHome, '.codex-global-state.json');
console.log(`全局状态文件: ${stateFile}  存在=${fs.existsSync(stateFile)}`);
if (!fs.existsSync(stateFile)) {
  console.log('→ 该环境里没有 .codex-global-state.json：项目清单会是空的（这是官方桌面版才会写的文件）');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
const local = raw['local-projects'] ?? {};
const order = Array.isArray(raw['project-order']) ? raw['project-order'].map(String) : [];
const assign = raw['thread-project-assignments'] ?? {};

const threadIdsByProject = new Map();
for (const [threadId, value] of Object.entries(assign)) {
  const pid = value?.projectId;
  if (typeof pid !== 'string') continue;
  threadIdsByProject.set(pid, [...(threadIdsByProject.get(pid) ?? []), threadId]);
}

const ordered = [...order.filter((pid) => pid in local), ...Object.keys(local).filter((pid) => !order.includes(pid))];
const projects = [];
for (const pid of ordered) {
  const p = local[pid];
  const roots = Array.isArray(p?.rootPaths) ? p.rootPaths.filter((x) => typeof x === 'string') : [];
  const root = roots[0];
  if (!root) continue;
  projects.push({
    id: pid,
    name: (typeof p.name === 'string' && p.name.trim()) || path.basename(root),
    path: root,
    threadIds: threadIdsByProject.get(pid) ?? [],
  });
}

// 内核侧真实存在的会话（用于判断「项目里的会话」是不是能对上号）
let dbIds = new Set();
const dbFile = path.join(env.codexHome, 'state_5.sqlite');
if (fs.existsSync(dbFile)) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    dbIds = new Set(db.prepare('select id from threads').all().map((r) => r.id));
  } catch (e) {
    console.log(`（读 state_5.sqlite 失败：${e.message}）`);
  }
}

const selected = raw['selected-project']?.projectId ?? null;
console.log(`\n读到项目 ${projects.length} 个（selected-project=${selected}）：`);
for (const p of projects) {
  const live = p.threadIds.filter((id) => dbIds.has(id));
  console.log(`  - ${p.name}  path=${p.path}`);
  console.log(`      分配会话 ${p.threadIds.length} 个，其中内核里存在 ${live.length} 个`);
}
console.log(`\n无归属会话(projectless)：${(raw['projectless-thread-ids'] ?? []).length} 个`);
console.log(`内核 state_5.sqlite 会话总数：${dbIds.size}`);
