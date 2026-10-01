/**
 * 决定性诊断：项目下的会话为什么是空的？
 *
 * 侧栏算 `owned` 的方式是：
 *   owned = threads.filter(t => p.threadIds.includes(t.id))
 * 所以「空」只可能是两件事之一：
 *   A. env:projects 返回的 threadIds 是空的（主进程读全局状态文件失败/格式变了）
 *   B. threadIds 有值，但这些 id 不在 thread/list 返回的 threads 里
 *      （thread/list 只返回最近 N 条，项目里的会话可能更老）
 *
 * 本探针直接调应用自己的 IPC 把两份数据都取回来做集合比对，一次定性。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 9833;
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1";
env.ELECTRON_DISABLE_SANDBOX = "1";

const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 2000; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) { target = p; break; }
    } catch { /* */ }
    await sleep(10);
  }
  if (!target) { console.log("no target"); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable");
  await send("Page.bringToFront");

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };

  // 等渲染层脚本就绪
  for (let i = 0; i < 300; i++) {
    if (await evalJs(`Boolean(window.codex && window.codex.envRpc)`)) break;
    await sleep(100);
  }
  await sleep(3000);

  const out = await evalJs(`(async () => {
    const envs = await window.codex.envRpc('env:list');
    const activeId = envs?.activeId;
    const projectsResp = await window.codex.envRpc('env:projects', activeId);
    const listResp = await window.codex.request('thread/list', { limit: 50, useStateDbOnly: true, archived: false });
    const threads = Array.isArray(listResp?.data) ? listResp.data : [];
    const threadIds = new Set(threads.map(t => t.id));
    return JSON.stringify({
      activeId,
      envName: envs?.envs?.find(e => e.id === activeId)?.name,
      projectsRaw: (projectsResp?.projects ?? []).map(p => ({
        name: p.name, path: p.path,
        assigned: (p.threadIds ?? []).length,
        present: (p.threadIds ?? []).filter(x => threadIds.has(x)).length,
        sample: (p.threadIds ?? []).slice(0, 2),
      })),
      selectedProjectId: projectsResp?.selectedProjectId ?? null,
      threadListCount: threads.length,
      threadListSample: threads.slice(0, 3).map(t => t.id),
    });
  })()`);

  console.log(JSON.stringify(JSON.parse(out), null, 2));

  ws.close();
  try { child.kill(); } catch { /* */ }
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
