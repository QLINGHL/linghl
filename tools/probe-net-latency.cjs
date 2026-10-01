// 探针 2：实测 vendored 内核在「无代理环境变量」vs「HTTPS_PROXY 指向系统代理」两种环境下，
// 模型请求（指向 api.openai.com，假 key，预期 401 快速返回）的连通耗时。
// 401 快 = 网络路径通畅；长时间无响应/超时 = 直连被墙。全程隔离临时 CODEX_HOME。
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const WITH_PROXY = process.argv.includes("--proxy");
const HOME = path.join(process.env.TEMP || "/tmp", `codex-probe-net-${WITH_PROXY ? "p" : "d"}`);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(
  path.join(HOME, "config.toml"),
  ['model_provider = "probe"', "", "[model_providers.probe]", 'name = "probe"', `base_url = "${process.env.PROBE_URL || "https://api.openai.com/v1"}"`, 'wire_api = "responses"', 'env_key = "PROBE_KEY"', ""].join("\n"),
);

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`;
const env = { ...process.env, CODEX_HOME: HOME, PROBE_KEY: "sk-dummy", RUST_LOG: "error" };
delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.http_proxy; delete env.https_proxy; delete env.ALL_PROXY; delete env.all_proxy;
if (WITH_PROXY) { const pu = process.env.PROXY_URL || "http://127.0.0.1:7890"; env.HTTPS_PROXY = pu; env.HTTP_PROXY = pu; }
console.log(ts(), `MODE=${WITH_PROXY ? "WITH PROXY 7890" : "DIRECT (no env)"}`);

const child = spawn(CODEX, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; let raw = ""; let tid = null;
child.stdout.on("data", (d) => {
  raw += d.toString(); buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      console.log(ts(), `RESPONSE id=${m.id} ${m.error ? "ERR=" + JSON.stringify(m.error).slice(0, 140) : "OK " + JSON.stringify(m.result).slice(0, 110)}`);
    } else if (m.method) {
      const p = JSON.stringify(m.params ?? {});
      // 只打关键通知：error / turn/* / 第一个 item
      if (/^error$|^turn\//.test(m.method) || m.method === "item/started" || m.method === "item/completed") {
        console.log(ts(), `NOTIFY ${m.method} ${p.slice(0, 200)}`);
      }
    }
  }
  const t = /"id":"([0-9a-f-]{36})"/.exec(raw); if (t && !tid) tid = t[1];
});
child.stderr.on("data", (d) => {
  const s = String(d).trim();
  if (/WARN|ERROR|retry/i.test(s)) console.log(ts(), "STDERR", s.slice(0, 240));
});
function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "probe", version: "0.0.1" } } });
setTimeout(() => send({ jsonrpc: "2.0", method: "initialized", params: {} }), 200);
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { cwd: HOME } }), 400);
setTimeout(() => {
  if (tid) { send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: tid, input: [{ type: "text", text: "hi" }] } }); console.log(ts(), "SEND turn/start"); }
  else console.log(ts(), "NO TID, skip");
}, 800);
setTimeout(() => { child.kill(); process.exit(0); }, 45000);
