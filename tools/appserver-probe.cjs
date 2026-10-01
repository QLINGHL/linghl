// 用 app-server JSONL 协议发一条消息，触发内核真正发往上游的请求（配 probe 假上游抓包）。
// 用法：node tools/appserver-probe.cjs
const { spawn } = require("child_process");
const path = require("path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const HOME = process.env.PROBE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");

const child = spawn(CODEX, ["app-server"], {
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: HOME, PROBE_KEY: "x", REPLICA_RELAY_API_KEY: "x", RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});

let id = 1;
const send = (method, params) => {
  const msg = { jsonrpc: "2.0", id: id++, method, params };
  console.log(">>", method);
  child.stdin.write(JSON.stringify(msg) + "\n");
  return msg.id;
};

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method) console.log("<<", m.method, JSON.stringify(m.params).slice(0, 200));
    else console.log("<< result id=" + m.id, JSON.stringify(m.result ?? m.error ?? null).slice(0, 300));
    if (m.id === 2 && m.result && m.result.thread) {
      const threadId = m.result.thread.id;
      console.log("threadId =", threadId);
      setTimeout(() => send("turn/start", { threadId, input: [{ type: "text", text: "列出当前目录的文件" }] }), 500);
    }
    if (m.method === "turn/completed") {
      console.log("=== turn completed ===");
      setTimeout(() => { child.kill(); process.exit(0); }, 500);
    }
  }
});
child.stderr.on("data", (d) => console.error("[stderr]", d.toString().slice(0, 400)));

(async () => {
  send("initialize", { clientInfo: { name: "probe", title: "Probe", version: "0.0.1" } });
  await new Promise((r) => setTimeout(r, 1200));
  const tid = send("thread/start", {});
  setTimeout(() => { console.log("timeout"); child.kill(); process.exit(0); }, 30000);
})();
