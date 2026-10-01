/* 探针 6：端到端 —— 用本机代理（托管鉴权）在隔离 CODEX_HOME 中跑通
   thread/start → turn/start → 消息流 → turns/list → thread/list
   全程只写临时目录，绝不触碰 ~/.codex 的任何文件。 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = process.argv[2] || path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const home = path.join(os.tmpdir(), "probe6-home-" + Date.now());
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(home, "config.toml"),
  [
    'model_provider = "custom"',
    'model = "gpt-6-astra"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
    'base_url = "http://127.0.0.1:15721/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    'experimental_bearer_token = "PROXY_MANAGED"',
    "",
  ].join("\n"),
);

const child = spawn(codex, ["app-server"], {
  cwd: os.homedir(),
  env: { ...process.env, CODEX_HOME: home, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
console.log("HOME:", home);

let buf = "", id = 0;
const pending = new Map();
const seen = [];
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
      continue;
    }
    if (m.method) {
      const p = m.params || {};
      seen.push(`${m.method}${p.delta ? ":" + String(p.delta).slice(0, 30) : ""}${(p.item && p.item.type) ? " item=" + p.item.type : ""}`);
      if (m.method === "error") console.log("!! error notif:", JSON.stringify(m.params).slice(0, 400));
    }
  }
});
child.stderr.on("data", (d) => { const s = String(d).trim(); if (s && !/PATH aliases|trusted project|Project-local/.test(s)) console.log("[stderr]", s.slice(0, 250)); });
function req(method, params) { const myId = ++id; return new Promise((res) => { pending.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params: params ?? {} }) + "\n"); setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ TIMEOUT: method }); } }, 90000); }); }

(async () => {
  await req("initialize", { clientInfo: { name: "codex-replica", title: "Codex Replica", version: "0.1.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");

  const acc = await req("account/read", {});
  console.log("\n[account/read] =>", JSON.stringify(acc).slice(0, 220));

  const ts = await req("thread/start", { sandbox: "read-only", approvalPolicy: "on-request" });
  const tid = ts?.result?.thread?.id;
  console.log("\n[thread/start] threadId=", tid, "historyMode=", ts?.result?.thread?.historyMode);

  const t = await req("turn/start", { threadId: tid, input: [{ type: "text", text: "只说两个字：收到" }] });
  console.log("\n[turn/start] =>", JSON.stringify(t).slice(0, 300));

  // 等 turn/completed
  await new Promise((r) => setTimeout(r, 30000));

  console.log("\n[notifications 前 25 条]\n" + seen.slice(0, 25).join("\n"));

  const tl = await req("thread/turns/list", { threadId: tid, limit: 20, sortDirection: "asc", itemsView: "full" });
  console.log("\n[turns/list full] 摘要 =>");
  const turns = tl?.result?.data || [];
  for (const turn of turns) {
    console.log(`  turn ${turn.id} status=${turn.status} itemsView=${turn.itemsView} items=${(turn.items || []).length}`);
    for (const it of (turn.items || [])) console.log("    -", it.type, JSON.stringify(it).slice(0, 160));
  }
  if (tl?.error) console.log("  ERROR:", JSON.stringify(tl.error));

  const list = await req("thread/list", { limit: 20, useStateDbOnly: true });
  console.log("\n[thread/list stateDb] =>", JSON.stringify(list).slice(0, 500));
  const list2 = await req("thread/list", { limit: 20 });
  console.log("[thread/list 全扫描] =>", JSON.stringify(list2).slice(0, 500));

  const rd = await req("thread/read", { threadId: tid });
  console.log("\n[thread/read] name=", JSON.stringify(rd?.result?.thread?.name), "preview=", JSON.stringify(rd?.result?.thread?.preview));

  child.kill();
  setTimeout(() => process.exit(0), 300);
})();
