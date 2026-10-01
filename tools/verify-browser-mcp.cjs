/**
 * 验证「内置浏览器」= 主进程 WebContentsView + CDP + MCP 桥。
 *   1) 本机桥：list / create / navigate / snapshot / screenshot
 *   2) MCP server（stdio）：initialize → tools/list → tools/call(browser_tabs / browser_snapshot / browser_cdp 越权)
 *   3) 截图落在工作区根目录，用来看主进程视图是不是真的渲染了页面
 * 用法：node tools/verify-browser-mcp.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const BRIDGE = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "codex-desk-replica",
  "browser-bridge.json",
);

function call(payload) {
  const cfg = JSON.parse(fs.readFileSync(BRIDGE, "utf-8"));
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: cfg.port,
        method: "POST",
        path: "/",
        headers: { "content-type": "application/json", "content-length": body.length, "x-browser-token": cfg.token },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.result);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("bridge timeout")));
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log("bridge file:", BRIDGE, fs.existsSync(BRIDGE) ? "(存在)" : "(缺失)");

  // ---------------- 1) 本机桥 ----------------
  const list = await call({ op: "list" });
  console.log("bridge list:", JSON.stringify(list).slice(0, 260));

  const tid = "verify_" + Date.now().toString(36);
  await call({ op: "create", id: tid });
  await call({ op: "navigate", id: tid, url: "https://example.com" });
  await new Promise((r) => setTimeout(r, 4500));
  const tabs = await call({ op: "list" });
  const mine = (tabs.tabs || []).find((t) => t.id === tid);
  console.log(
    "navigate 后状态:",
    JSON.stringify(mine && { url: mine.url, title: mine.title, loading: mine.loading, error: mine.error }),
  );

  const snap = await call({ op: "snapshot", id: tid });
  console.log(
    "snapshot.url:",
    snap.url,
    "| title:",
    snap.title,
    "| 可交互元素:",
    (snap.elements || []).length,
    "| 文本前 70:",
    String(snap.text || "").replace(/\s+/g, " ").slice(0, 70),
  );

  const shot = await call({ op: "screenshot", id: tid });
  const b64 = String(shot.dataUrl || "").replace(/^data:image\/png;base64,/, "");
  console.log("screenshot 字节数:", b64.length ? Buffer.from(b64, "base64").length : 0);
  if (b64.length) fs.writeFileSync(path.join(__dirname, "..", "..", "browser-mcp-shot.png"), Buffer.from(b64, "base64"));

  // ---------------- 2) MCP server（stdio） ----------------
  const electronExe = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
  const child = spawn(electronExe, [path.join(__dirname, "browser-mcp.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.on("data", (c) => process.stderr.write("[mcp stderr] " + c));
  let seq = 1;
  const rpc = (method, params) =>
    new Promise((res) => {
      const id = seq++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify", version: "1" },
  });
  console.log("MCP initialize:", JSON.stringify(init.result && init.result.serverInfo));
  const tools = await rpc("tools/list", {});
  console.log("MCP tools:", (tools.result.tools || []).map((t) => t.name).join(", "));

  const t1 = await rpc("tools/call", { name: "browser_tabs", arguments: {} });
  const t1text = t1.result && t1.result.content && t1.result.content[0] && t1.result.content[0].text;
  console.log("MCP browser_tabs:", String(t1text || "").slice(0, 200));

  const t2 = await rpc("tools/call", { name: "browser_snapshot", arguments: { tabId: tid } });
  const t2text = t2.result && t2.result.content && t2.result.content[0] && t2.result.content[0].text;
  console.log("MCP browser_snapshot 前 220:", String(t2text || "").replace(/\s+/g, " ").slice(0, 220));

  const t3 = await rpc("tools/call", { name: "browser_cdp", arguments: { tabId: tid, method: "Browser.getVersion" } });
  const t3text = t3.result && t3.result.content && t3.result.content[0] && t3.result.content[0].text;
  console.log("MCP 白名单外 CDP:", String(t3text || "").slice(0, 160));

  child.kill();
  console.log("DONE");
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
