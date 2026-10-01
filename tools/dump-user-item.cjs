// 只读探针：dump 某个 thread 里 userMessage item 的 content 结构（不发 turn）。
// 用法: node tools/dump-user-item.cjs "<thread 标题关键词>"
const { spawn } = require("child_process");
const path = require("path");

const CODEX = path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe");
const HOME = process.env.PROBE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
const KEYWORD = process.argv[2] || "对齐";

const child = spawn(CODEX, ["app-server"], {
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: HOME, RUST_LOG: "error" },
  stdio: ["pipe", "pipe", "pipe"],
});

let id = 1;
const pending = new Map();
const send = (method, params) => {
  const msg = { jsonrpc: "2.0", id: id++, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((res) => pending.set(msg.id, res));
};

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));

(async () => {
  await send("initialize", { clientInfo: { name: "dump", version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
  const list = await send("thread/list", { limit: 40 });
  const rows = (list.result && list.result.data) || (list.result && list.result.threads) || [];
  const hit = rows.filter((t) => JSON.stringify(t).includes(KEYWORD));
  console.log("candidates:", hit.length);
  for (const t of hit.slice(0, 4)) console.log("  ", t.id, JSON.stringify(t.name || t.title || t.preview || "").slice(0, 60));
  if (!hit.length) { child.kill(); return; }
  const tid = hit[0].id;
  const read = await send("thread/read", { threadId: tid });
  const th = read.result && (read.result.thread || read.result);
  console.log("read keys:", Object.keys(read.result || {}), "thread keys:", th && Object.keys(th).slice(0, 20));
  triallist(tid);
  if (th && th.turns && th.turns.length) {
    dumpTurns(th.turns);
  } else {
    const tl = await send("thread/turns/list", { threadId: tid, limit: 40 });
    const r2 = tl.result || {};
    console.log("turns/list keys:", Object.keys(r2));
    const arr = r2.turns || r2.data || [];
    console.log("turns:", arr.length);
    dumpTurns(arr);
  }
  child.kill();
})();

function triallist(tid) {
  for (const m of ["thread/turns/list", "thread/items/list"]) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: id++, method: m, params: { threadId: tid, limit: 5 } }) + "\n");
  }
}

function dumpTurns(turns) {
  for (const turn of turns) {
    for (const it of turn.items || []) {
      if (it.type !== "userMessage") continue;
      const parts = (it.content || []).map((c) => {
        if (c.type === "text") return { type: "text", len: (c.text || "").length, head: (c.text || "").slice(0, 40), tail: (c.text || "").slice(-30) };
        return { type: c.type, keys: Object.keys(c), path: c.path || c.url || null };
      });
      console.log("USER ITEM", it.id, "parts:", parts.length);
      console.log(JSON.stringify(parts, null, 1));
      const txt = (it.content || []).find((c) => c.type === "text" && (c.text || "").length > 400);
      if (txt) {
        const s = txt.text;
        console.log("TEXT LEN", s.length);
        for (const marker of ["# Files mentioned by the user:", "# my request", "## Instructions in attached documents", "# Instructions in attached documents"]) {
          console.log("  marker", JSON.stringify(marker), "at", s.indexOf(marker));
        }
        console.log("  FIRST 240:", JSON.stringify(s.slice(0, 240)));
        const cut = s.indexOf("Image attachment: true");
        console.log("  around last 'Image attachment':", JSON.stringify(s.slice(Math.max(0, s.lastIndexOf("Image attachment: true") - 120), s.lastIndexOf("Image attachment: true") + 260)));
        console.log("  LAST 300:", JSON.stringify(s.slice(-300)));
      }
      console.log("---");
    }
  }
}
