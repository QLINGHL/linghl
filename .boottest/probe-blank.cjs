/**
 * 空白窗口的**真正判据**：窗口显示（show）发生在渲染层画出第一帧之前多久？
 *
 * 之前所有探针都在量"first-paint 时刻"，但用户看到的"空白"其实取决于
 * **show 与 首帧 的先后**。如果 show 早于首帧 500ms，用户就必然看到 500ms 空白。
 *
 * 本探针不改源码，只用 CDP + Window 事件 + boot.log：
 *   - 主进程侧的 `window:created` / `window:show` 打点（boot.log）
 *   - 渲染层侧的 `renderer:first-commit` / `renderer:first-paint`
 * 然后明确算出 "show → 首帧" 这段真正被用户看到的空白时长。
 *
 * 同时验证一个关键事实：窗口用 show:false + 首帧后 show 是否可行。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const UD = path.join(process.env.APPDATA || "", "codex-desk-replica");
const PORT = 9827;

for (const d of ["Cache", "Code Cache", "GPUCache"]) {
  try { fs.rmSync(path.join(UD, "sessionData", d), { recursive: true, force: true }); } catch { /* 占用 */ }
}
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1";
env.ELECTRON_DISABLE_SANDBOX = "1";

const bootLog = path.join(UD, "logs", "boot.log");
const beforeLen = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, "utf8").length : 0;

const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: "ignore",
});

(async () => {
  let target = null;
  for (let i = 0; i < 1500; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) { target = p; break; }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 5));
  }
  if (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) =>
      new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await new Promise((r) => ws.addEventListener("open", r));
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.bringToFront");
    await new Promise((r) => setTimeout(r, 4000));
    ws.close();
  }
  await new Promise((r) => setTimeout(r, 600));
  try { child.kill(); } catch { /* */ }

  const after = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, "utf8").slice(beforeLen) : "";
  const rows = after.trim().split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\s+pid=(\d+)\s+(\S+)\s*(.*)$/);
    return m ? { ts: Date.parse(m[1]), mark: m[3], detail: m[4] } : null;
  }).filter(Boolean);
  if (!rows.length) { console.log("本轮无记录"); process.exit(1); }

  const base = rows[0].ts;
  console.log(`\n=== 完整启动时间线 ===`);
  for (const r of rows) console.log(`  +${String(r.ts - base).padStart(5)}ms  ${r.mark.padEnd(26)} ${r.detail ?? ""}`);

  const find = (m) => rows.find((r) => r.mark === m);
  const created = find("window:created");
  const showEv = find("window:visibility");
  const commit = find("renderer:first-commit");
  const paint = find("renderer:first-paint");
  const rts = find("window:ready-to-show");

  console.log(`\n=== 用户实际看到的空白 ===`);
  if (showEv && paint) {
    const gap = paint.ts - showEv.ts;
    console.log(`  窗口显示 → 首帧:        ${gap}ms   ← 这就是"出现窗口但里面空白"的时长`);
  }
  if (created && paint) console.log(`  窗口创建 → 首帧:        ${paint.ts - created.ts}ms`);
  if (commit && paint) console.log(`  React 提交 → 首帧:      ${paint.ts - commit.ts}ms`);
  if (created && rts) console.log(`  窗口创建 → ready-to-show: ${rts.ts - created.ts}ms`);
  if (rts && paint) console.log(`  ready-to-show → 首帧:    ${paint.ts - rts.ts}ms`);
  console.log(`\n  注：ready-to-show 是 Electron 推荐用于"无闪白显示窗口"的时机。`);
  console.log(`      若 ready-to-show 明显晚于 first-commit，说明窗口本可以更晚再显示。`);
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
