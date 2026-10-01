/* 探针 5：turn/start（未登录预期失败）后 turns/list 是否返回该 turn 与用户消息 */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const codex = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe5-home-" + Date.now());
fs.mkdirSync(home, { recursive: true });
const child = spawn(codex, ["app-server"], { cwd: os.homedir(), env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" }, stdio: ["pipe","pipe","pipe"], windowsHide: true });
let buf = "", id = 0; const pending = new Map();
child.stdout.on("data", c => { buf += c.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0,i); buf = buf.slice(i+1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } } } });
child.stderr.on("data", d => { const s = String(d).trim(); if (s && !/PATH aliases|trusted project|Project-local/.test(s)) console.log("[stderr]", s.slice(0,200)); });
function req(method, params) { const myId = ++id; return new Promise(res => { pending.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:myId, method, params: params ?? {} })+"\n"); setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ TIMEOUT: method }); } }, 25000); }); }
(async () => {
  await req("initialize", { clientInfo: { name:"codex-replica", title:"Codex Replica", version:"0.1.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc:"2.0", method:"initialized", params:{} })+"\n");
  const ts = await req("thread/start", { sandbox: "read-only", approvalPolicy: "on-request" });
  const tid = ts?.result?.thread?.id;
  console.log("threadId:", tid);
  const turn = await req("turn/start", { threadId: tid, input: [{ type: "text", text: "你好" }] });
  console.log("\nturn/start =>", JSON.stringify(turn).slice(0, 600));
  await new Promise(r => setTimeout(r, 1500));
  const tl = await req("thread/turns/list", { threadId: tid, limit: 20, sortDirection: "asc", itemsView: "full" });
  console.log("\nturns/list(full) =>", JSON.stringify(tl).slice(0, 2000));
  const rd = await req("thread/read", { threadId: tid });
  console.log("\nthread/read.name =>", rd?.result?.thread?.name, "| preview:", JSON.stringify(rd?.result?.thread?.preview));
  const list = await req("thread/list", { limit: 20, useStateDbOnly: false });
  console.log("\nthread/list =>", JSON.stringify(list).slice(0, 600));
  child.kill(); setTimeout(() => process.exit(0), 300);
})();
