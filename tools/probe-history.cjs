/* 探针 2：确定「读取会话历史」的可用方法（thread/items/list 运行时不可用） */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe2-codex-home-" + Date.now());
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
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s && !s.includes("PATH aliases")) console.log("[stderr]", s.slice(0, 300)); });
function req(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params: params ?? {} }) + "\n");
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ TIMEOUT: method }); } }, 15000);
  });
}

(async () => {
  await req("initialize", { clientInfo: { name: "codex-replica", title: "Codex Replica", version: "0.1.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");

  const ts = await req("thread/start", { sandbox: "read-only", approvalPolicy: "on-request" });
  const tid = ts?.result?.thread?.id;
  console.log("threadId:", tid);

  const r1 = await req("thread/read", { threadId: tid, includeTurns: true });
  console.log("\n[A] thread/read(includeTurns) =>", JSON.stringify(r1).slice(0, 700));

  const r2 = await req("thread/turns/list", { threadId: tid, limit: 20, sortDirection: "asc", itemsView: "full" });
  console.log("\n[B] thread/turns/list =>", JSON.stringify(r2).slice(0, 700));

  const r3 = await req("thread/read", { threadId: tid });
  console.log("\n[C] thread/read(meta only) =>", JSON.stringify(r3).slice(0, 400));

  const r4 = await req("thread/resume", { threadId: tid });
  console.log("\n[D] thread/resume =>", JSON.stringify(r4).slice(0, 400));

  // 注入两条 item 后再读，验证历史能真正取出内容
  const inj = await req("thread/inject_items", { threadId: tid, items: [{ type: "userMessage", id: "probe-u1", content: [{ type: "text", text: "探针用户消息" }] }] });
  console.log("\n[E] thread/inject_items =>", JSON.stringify(inj).slice(0, 400));

  const r5 = await req("thread/read", { threadId: tid, includeTurns: true });
  console.log("\n[F] thread/read after inject =>", JSON.stringify(r5).slice(0, 900));

  child.kill();
  setTimeout(() => process.exit(0), 300);
})();
