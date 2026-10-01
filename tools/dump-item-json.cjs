// 只读探针：dump 指定类型 item 的完整 JSON（默认 fileChange）。
// 用法: node tools/dump-item-json.cjs "<线程关键词>" [类型] [取第几个]
const { spawn } = require("child_process");
const path = require("path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const HOME = process.env.PROBE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
const KEYWORD = process.argv[2] || "对齐";
const TYPE = process.argv[3] || "fileChange";
const INDEX = Number(process.argv[4] || 0);

const child = spawn(CODEX, ["app-server"], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, CODEX_HOME: HOME, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});
const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
send(1, "initialize", { clientInfo: { name: "dump", version: "0.0.1" }, capabilities: { experimentalApi: true } });

let buf = "";
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
      const hit = ((msg.result && msg.result.data) || []).find((t) => JSON.stringify(t).includes(KEYWORD));
      if (!hit) { console.log("no thread"); child.kill(); return; }
      send(3, "thread/turns/list", { threadId: hit.id, limit: 50, sortDirection: "asc", itemsView: "full" });
    } else if (msg.id === 3) {
      const all = ((msg.result && msg.result.data) || []).flatMap((t) => t.items || []);
      const hits = all.filter((it) => it.type === TYPE);
      console.log(`total ${TYPE}: ${hits.length}`);
      const item = hits[INDEX];
      if (item) console.log(JSON.stringify(item, null, 1).slice(0, 2000));
      child.kill();
    }
  }
});
