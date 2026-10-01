/**
 * 协议服务延迟定位：requestStart → responseEnd 有 ~580ms，
 * 对本地磁盘读来说高得反常。到底是
 *   (a) 读文件慢（磁盘/杀软扫描），
 *   (b) Response 构造/流式传输开销，
 *   (c) 自定义协议自身的调度延迟（protocol.handle 在主进程事件循环上排队）？
 *
 * 手法：在 boot.log 旁边再打一份 protocol 计时（临时插桩，跑完即删），
 * 并同时用 CDP 的 Network 域看每个资源的真实生命周期。
 * 这里只用 CDP Network，不动源码 —— 更干净。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const UD = path.join(process.env.APPDATA || "", "codex-desk-replica");
const PORT = 9826;

for (const d of ["Cache", "Code Cache", "GPUCache"]) {
  try { fs.rmSync(path.join(UD, "sessionData", d), { recursive: true, force: true }); } catch { /* 占用 */ }
}
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1";
env.ELECTRON_DISABLE_SANDBOX = "1";

const t0 = Date.now();
const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: "ignore",
});

(async () => {
  let target = null;
  for (let i = 0; i < 1500; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) { target = p; break; }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!target) { console.log("no target"); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const reqs = new Map();
  const done = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Network.requestWillBeSent") {
      reqs.set(m.params.requestId, { url: m.params.request.url, start: m.params.timestamp });
    } else if (m.method === "Network.responseReceived") {
      const r = reqs.get(m.params.requestId);
      if (r) { r.resp = m.params.timestamp; r.status = m.params.response.status; r.fromDisk = m.params.response.fromDiskCache; }
    } else if (m.method === "Network.loadingFinished") {
      const r = reqs.get(m.params.requestId);
      if (r) { r.end = m.params.timestamp; done.push(r); reqs.delete(m.params.requestId); }
    } else if (m.method === "Network.loadingFailed") {
      const r = reqs.get(m.params.requestId);
      if (r) { r.failed = m.params.errorText; done.push(r); reqs.delete(m.params.requestId); }
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.addEventListener("open", r));

  await send("Network.enable", { maxTotalBufferSize: 1e8, maxResourceBufferSize: 5e7 });
  await send("Page.enable");
  await send("Page.bringToFront");

  await new Promise((r) => setTimeout(r, 4500));
  ws.close();
  try { child.kill(); } catch { /* */ }

  console.log(`\n=== 资源加载时间线（相对 spawn，共 ${done.length} 个请求）===`);
  console.log(`   状态  磁盘缓存   发送→响应   响应→完成   总计   资源`);
  const base = done.length ? Math.min(...done.map((r) => r.start)) : 0;
  for (const r of done.sort((a, b) => a.start - b.start)) {
    if (!r.end) { console.log(`   FAIL  ${r.failed}  ${String(r.url).slice(-50)}`); continue; }
    const send = ((r.resp ?? r.end) - r.start) * 1000;
    const recv = ((r.end) - (r.resp ?? r.end)) * 1000;
    const tot = (r.end - r.start) * 1000;
    const name = String(r.url).replace(/^replica-app:\/\/app\//, "").slice(0, 44);
    console.log(
      `   ${String(r.status).padEnd(4)} ${(r.fromDisk ? "HIT " : "miss").padEnd(8)} ` +
      `${send.toFixed(0).padStart(7)}ms ${recv.toFixed(0).padStart(9)}ms ${tot.toFixed(0).padStart(6)}ms   ${name}`,
    );
  }
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
