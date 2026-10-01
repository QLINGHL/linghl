// 只读探针：按顺序 dump 某个 thread 每轮的 item 类型序列（找 steering/中途用户消息）。
// 用法: node tools/dump-turn-items.cjs "<thread 关键词>"
const { spawn } = require("child_process");
const path = require("path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const HOME = process.env.PROBE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
const KEYWORD = process.argv[2] || "对齐";

const child = spawn(CODEX, ["app-server"], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, CODEX_HOME: HOME, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

child.stdout.on("data", (data) => {
  buf += data.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
      send(2, "thread/list", { limit: 40 });
    } else if (msg.id === 2) {
      const rows = (msg.result && msg.result.data) || [];
      const hit = rows.find((t) => JSON.stringify(t).includes(KEYWORD));
      if (!hit) { console.log("no thread"); child.kill(); return; }
      console.log("thread", hit.id, hit.name);
      send(3, "thread/turns/list", { threadId: hit.id, limit: 50, sortDirection: "asc", itemsView: "full" });
    } else if (msg.id === 3) {
      const turns = (msg.result && msg.result.data) || [];
      turns.forEach((turn, ti) => {
        console.log(`--- TURN ${ti} ${turn.id.slice(0, 12)} status=${turn.status} items=${(turn.items || []).length}`);
        (turn.items || []).forEach((item, ii) => {
          let extra = "";
          if (item.type === "userMessage") {
            const text = (item.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
            const imgs = (item.content || []).filter((c) => c.type === "localImage").length;
            extra = ` textLen=${text.length} imgs=${imgs} :: ${JSON.stringify(text.slice(0, 70))}`;
          } else if (item.type === "agentMessage") {
            extra = ` phase=${item.phase} len=${String(item.text || "").length}`;
          } else if (item.type === "reasoning") {
            extra = ` summary=${JSON.stringify(String(JSON.stringify(item.summary || []).slice(0, 40)))}`;
          } else if (item.type === "commandExecution") {
            extra = ` status=${item.status} :: ${JSON.stringify(String(item.command || "").slice(0, 40))}`;
          }
          console.log(`    ${String(ii).padStart(2)} ${item.type}${extra}`);
        });
      });
      child.kill();
    }
  }
});
send(1, "initialize", { clientInfo: { name: "dump", version: "0.0.1" }, capabilities: { experimentalApi: true } });
