// 探针：实测 vendored 内核 turn/start 的 RPC 响应语义。
// 结论写进 stdout：turn/start 的 JSON-RPC 响应是在回合开始时就回来，
// 还是等回合结束（completed/failed）才回来 —— 这决定 120s 请求超时会不会误报。
// 用隔离的临时 CODEX_HOME + 指向必拒绝端口的假 provider，全程不碰真实环境。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const HOME = path.join(process.env.TEMP || "/tmp", "codex-probe-turn");
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(
  path.join(HOME, "config.toml"),
  ['model_provider = "probe"', "", "[model_providers.probe]", 'name = "probe"', 'base_url = "http://127.0.0.1:9/v1"', 'wire_api = "responses"', 'env_key = "PROBE_KEY"', ""].join("\n"),
);

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`;
const child = spawn(CODEX, ["app-server"], {
  env: { ...process.env, CODEX_HOME: HOME, PROBE_KEY: "probe-key", RUST_LOG: "info" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.log(ts(), "RAW", line.slice(0, 200)); continue; }
    const label = m.id !== undefined && (m.result !== undefined || m.error !== undefined)
      ? `RESPONSE id=${m.id} ${m.error ? `error=${JSON.stringify(m.error).slice(0, 160)}` : `result=${JSON.stringify(m.result).slice(0, 160)}`}`
      : `NOTIFY ${m.method ?? "?"} ${JSON.stringify(m.params ?? {}).slice(0, 160)}`;
    console.log(ts(), label);
  }
});
child.stderr.on("data", (d) => console.log(ts(), "STDERR", String(d).trim().slice(0, 220)));
child.on("exit", (c) => console.log(ts(), "EXIT", c));

function send(obj) {
  console.log(ts(), `SEND ${obj.method ?? "(response)"} id=${obj.id ?? "-"}`);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "probe", version: "0.0.1" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "initialized", params: {} }), 300);
setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: HOME } });
}, 600);
setTimeout(() => {
  send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: globalThis.tid, input: [{ type: "text", text: "hi" }] } });
}, 1200);
setTimeout(() => { child.kill(); process.exit(0); }, 15000);
child.stdout.on("data", () => {}); // 保持读循环引用
const origLog = console.log;
// thread/start 的响应里拿 threadId 给 turn/start 用（简单粗暴：直接扫文本）
let raw = "";
child.stdout.on("data", (d) => { raw += String(d); const m = /"id":"([0-9a-f-]{36})"/.exec(raw); if (m && !globalThis.tid) globalThis.tid = m[1]; });
