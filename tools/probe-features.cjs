/* 探针 3：实验特性开关 —— 排查 list_turns / items-list 是否被 feature flag 关闭 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = process.argv[2] || path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe3-home-" + Date.now());
fs.mkdirSync(home, { recursive: true });

const child = spawn(codex, ["app-server"], {
  cwd: os.homedir(),
  env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buf = "", id = 0;
const pending = new Map();
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
    }
  }
});
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s && !s.includes("PATH aliases") && !s.includes("trusted project") && !s.includes("Project-local")) console.log("[stderr]", s.slice(0, 200)); });
function req(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params: params ?? {} }) + "\n");
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ TIMEOUT: method }); } }, 15000);
  });
}

(async () => {
  console.log("### kernel:", codex);
  await req("initialize", { clientInfo: { name: "codex-replica", title: "Codex Replica", version: "0.1.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");

  const feats = await req("experimentalFeature/list", {});
  console.log("\n[features] =>", JSON.stringify(feats).slice(0, 1200));

  const ts = await req("thread/start", { sandbox: "read-only", approvalPolicy: "on-request" });
  const tid = ts?.result?.thread?.id;
  console.log("\nthreadId:", tid, "historyMode:", ts?.result?.thread?.historyMode);

  console.log("\nitems/list   =>", JSON.stringify(await req("thread/items/list", { threadId: tid, limit: 50 })).slice(0, 200));
  console.log("turns/list   =>", JSON.stringify(await req("thread/turns/list", { threadId: tid, limit: 50 })).slice(0, 200));
  console.log("read+turns   =>", JSON.stringify(await req("thread/read", { threadId: tid, includeTurns: true })).slice(0, 200));
  console.log("resume(noex) =>", JSON.stringify(await req("thread/resume", { threadId: tid })).slice(0, 200));
  console.log("resume(excl) =>", JSON.stringify(await req("thread/resume", { threadId: tid, excludeTurns: true })).slice(0, 300));
  console.log("loaded/list  =>", JSON.stringify(await req("thread/loaded/list", {})).slice(0, 300));

  child.kill();
  setTimeout(() => process.exit(0), 300);
})();
