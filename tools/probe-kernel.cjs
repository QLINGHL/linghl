/* 内核探针：验证 app-server 握手 / 参数容错 / 响应结构
   用法：node tools/probe-kernel.cjs
   隔离性：CODEX_HOME 指向临时目录，绝不触碰 %APPDATA% 或 ~/.codex */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe-codex-home-" + Date.now());
fs.mkdirSync(home, { recursive: true });

const child = spawn(codex, ["app-server"], {
  cwd: os.homedir(),
  env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buf = "";
const pending = new Map();
let id = 0;
const notifications = [];

child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m); }
    } else if (m.method) {
      notifications.push(m.method);
    }
  }
});
child.stderr.on("data", (d) => {
  const s = String(d).trim();
  if (s) console.log("[stderr]", s.slice(0, 400));
});

function req(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params: params ?? {} }) + "\n");
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); resolve({ TIMEOUT: true }); } }, 20000);
  });
}

(async () => {
  console.log("codex:", codex);
  console.log("CODEX_HOME:", home);

  const init = await req("initialize", { clientInfo: { name: "codex-replica", title: "Codex Replica", version: "0.1.0" } });
  console.log("\n[1] initialize =>", JSON.stringify(init).slice(0, 400));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");

  const acc = await req("account/read", {});
  console.log("\n[2] account/read =>", JSON.stringify(acc).slice(0, 300));

  const models = await req("model/list", {});
  console.log("\n[3] model/list =>", JSON.stringify(models).slice(0, 500));

  // 带未知字段 effort 的 thread/start —— 验证内核是否拒收额外参数
  const t1 = await req("thread/start", {
    cwd: os.homedir(),
    approvalPolicy: "on-request",
    sandbox: "read-only",
    effort: "high",
  });
  console.log("\n[4] thread/start(+effort) =>", JSON.stringify(t1).slice(0, 500));

  const t2 = await req("thread/start", { sandbox: "workspace-write", approvalPolicy: "untrusted" });
  const tid = t2?.result?.thread?.id;
  console.log("\n[5] thread/start(clean) => threadId:", tid);

  if (tid) {
    const items = await req("thread/items/list", { threadId: tid, limit: 200, sortDirection: "asc" });
    console.log("[6] thread/items/list =>", JSON.stringify(items).slice(0, 300));
  }

  const tl = await req("thread/list", { limit: 50, useStateDbOnly: true, archived: false });
  console.log("\n[7] thread/list =>", JSON.stringify(tl).slice(0, 300));

  console.log("\n[notifications]", notifications.slice(0, 20).join(", "));
  child.kill();
  setTimeout(() => process.exit(0), 300);
})();
