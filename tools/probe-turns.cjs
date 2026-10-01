/* 探针 4：确认会话历史正确读取路径 = thread/turns/list（需会话已物化）*/
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = process.argv[2] || path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe4-home-" + Date.now());
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
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s && !/PATH aliases|trusted project|Project-local/.test(s)) console.log("[stderr]", s.slice(0, 200)); });
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

  const ts = await req("thread/start", { sandbox: "read-only", approvalPolicy: "on-request" });
  const tid = ts?.result?.thread?.id;

  // 注入一个用户消息使其"物化"
  const inj = await req("thread/inject_items", {
    threadId: tid,
    items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "探针用户消息" }] }],
  });
  console.log("inject =>", JSON.stringify(inj).slice(0, 200));

  const tl = await req("thread/turns/list", { threadId: tid, limit: 20, sortDirection: "asc", itemsView: "full" });
  console.log("\nturns/list(full) =>", JSON.stringify(tl).slice(0, 1500));

  const tl2 = await req("thread/turns/list", { threadId: tid, limit: 20, sortDirection: "asc" });
  console.log("\nturns/list(default view) =>", JSON.stringify(tl2).slice(0, 800));

  child.kill();
  setTimeout(() => process.exit(0), 300);
})();
