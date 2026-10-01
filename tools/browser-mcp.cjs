#!/usr/bin/env node
/**
 * 内置浏览器的 MCP server（stdio）。
 *
 * 角色等同于官方 ChatGPT 桌面版里那个 `@oai/browser-desktop/service`
 * （官方把它挂在 `mcp_servers.cua_repl` 下，再配 node REPL 让模型发 CDP）。
 * 这里做成一个独立的小 MCP server：内核按 config.toml 里的 `[mcp_servers.replica_browser]`
 * 把它 spawn 起来，它再把调用转发给桌面应用里的「本机桥」（127.0.0.1 + token），
 * 由主进程用 CDP 操作真正的 WebContentsView。
 *
 * 用法（内核自动拉起，一般不用手跑）：
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> tools/browser-mcp.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const BRIDGE_FILE =
  process.env.REPLICA_BROWSER_BRIDGE ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "codex-desk-replica", "browser-bridge.json");

function readBridge() {
  const cfg = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf-8"));
  if (!cfg || typeof cfg.port !== "number" || typeof cfg.token !== "string") throw new Error("browser-bridge.json 内容不合法");
  return cfg;
}

/** 调应用内的桥（回环 + token） */
function callBridge(payload) {
  return new Promise((resolve, reject) => {
    let cfg;
    try {
      cfg = readBridge();
    } catch (error) {
      reject(new Error(`连不上内置浏览器（${BRIDGE_FILE} 读不到：${error.message}）。桌面应用可能没在运行。`));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), "utf-8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port: cfg.port,
        method: "POST",
        path: "/",
        headers: { "content-type": "application/json", "content-length": body.length, "x-browser-token": cfg.token },
        timeout: 30000,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            reject(new Error(`浏览器桥返回了非 JSON：${raw.slice(0, 200)}`));
            return;
          }
          if (parsed && parsed.error) reject(new Error(String(parsed.error)));
          else resolve(parsed ? parsed.result : null);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("浏览器桥超时")));
    req.on("error", (e) => reject(new Error(`浏览器桥请求失败：${e.message}`)));
    req.write(body);
    req.end();
  });
}

const TOOLS = [
  {
    name: "browser_tabs",
    description: "列出内置浏览器的所有标签页（id、url、标题、是否加载中）以及当前激活的标签。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open_tab",
    description: "在工作区新建一个浏览器标签页（可选直接打开某个网址），并返回新标签的 id。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的网址，可以省略" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_close_tab",
    description: "关闭一个浏览器标签页。",
    inputSchema: { type: "object", properties: { tabId: { type: "string" } }, required: ["tabId"] },
  },
  {
    name: "browser_navigate",
    description: "在当前（或指定）标签页里打开一个网址。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, tabId: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "读取当前页面的结构快照：页面可见文本 + 所有可交互元素的编号(ref)、角色、名称与中心坐标。要和页面交互前**先调用它**，后面的 browser_click 用 ref 编号。",
    inputSchema: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "browser_screenshot",
    description: "对当前页面截图（PNG）。",
    inputSchema: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "browser_click",
    description: "点击元素：优先用 browser_snapshot 给出的 ref 编号，也可以直接给视口坐标 x/y。",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "number" }, x: { type: "number" }, y: { type: "number" }, tabId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "往当前聚焦的输入框输入文本（先 browser_click 选中输入框）。",
    inputSchema: { type: "object", properties: { text: { type: "string" }, tabId: { type: "string" } }, required: ["text"] },
  },
  {
    name: "browser_press_key",
    description: "发送一次按键：Enter / Tab / Escape / Backspace / ArrowUp / ArrowDown / ArrowLeft / ArrowRight。",
    inputSchema: { type: "object", properties: { key: { type: "string" }, tabId: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_history",
    description: "浏览器历史导航：back / forward / reload。",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["back", "forward", "reload"] }, tabId: { type: "string" } },
      required: ["action"],
    },
  },
  {
    name: "browser_evaluate",
    description: "在页面里执行一段 JavaScript 并取回结果（返回 JSON 可序列化的值）。用于读取页面数据。",
    inputSchema: { type: "object", properties: { expression: { type: "string" }, tabId: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "browser_cdp",
    description:
      "直接发一条 Chrome DevTools Protocol 命令（受白名单限制：Page.*/Runtime.*/DOM.*/CSS.*/Input.*/Network.enable）。高级用法，一般不需要。",
    inputSchema: {
      type: "object",
      properties: { method: { type: "string" }, params: { type: "object" }, tabId: { type: "string" } },
      required: ["method"],
    },
  },
];

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case "browser_tabs": {
      const r = await callBridge({ op: "list" });
      return textResult(JSON.stringify(r, null, 2));
    }
    case "browser_open_tab": {
      const id = `mcp_${Date.now().toString(36)}`;
      await callBridge({ op: "create", id });
      if (a.url) await callBridge({ op: "navigate", id, url: a.url });
      return textResult(`已新建标签页 ${id}${a.url ? `，正在打开 ${a.url}` : ""}`);
    }
    case "browser_close_tab":
      await callBridge({ op: "close", id: a.tabId });
      return textResult(`已关闭 ${a.tabId}`);
    case "browser_navigate":
      await callBridge({ op: "navigate", id: a.tabId, url: a.url });
      return textResult(`已导航到 ${a.url}`);
    case "browser_snapshot": {
      const snap = await callBridge({ op: "snapshot", id: a.tabId });
      const lines = [];
      lines.push(`URL: ${snap.url}`);
      lines.push(`标题: ${snap.title}`);
      if (snap.viewport) lines.push(`视口: ${snap.viewport.width}x${snap.viewport.height}，已滚动 ${snap.viewport.scrollY}/${snap.viewport.scrollHeight}`);
      lines.push("");
      lines.push("可交互元素（用 browser_click 传 ref 点击）：");
      for (const el of snap.elements || []) {
        const bits = [`[${el.ref}]`, el.tag];
        if (el.role) bits.push(`role=${el.role}`);
        if (el.type) bits.push(`type=${el.type}`);
        if (el.name) bits.push(`"${el.name}"`);
        if (el.href) bits.push(`href=${el.href}`);
        if (el.value !== undefined) bits.push(`value="${el.value}"`);
        if (el.disabled) bits.push("disabled");
        bits.push(`@(${el.x},${el.y})`);
        lines.push(bits.join(" "));
      }
      lines.push("");
      lines.push("页面可见文本：");
      lines.push(snap.text || "(空)");
      return textResult(lines.join("\n"));
    }
    case "browser_screenshot": {
      const r = await callBridge({ op: "screenshot", id: a.tabId });
      const dataUrl = String(r && r.dataUrl ? r.dataUrl : "");
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      if (!base64) return textResult("截图失败");
      return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
    }
    case "browser_click":
      await callBridge({ op: "click", id: a.tabId, ref: a.ref, x: a.x, y: a.y });
      return textResult(typeof a.ref === "number" ? `已点击 ref=${a.ref}` : `已点击 (${a.x},${a.y})`);
    case "browser_type":
      await callBridge({ op: "type", id: a.tabId, text: a.text });
      return textResult(`已输入 ${String(a.text).length} 个字符`);
    case "browser_press_key":
      await callBridge({ op: "key", id: a.tabId, key: a.key });
      return textResult(`已按键 ${a.key}`);
    case "browser_history":
      await callBridge({ op: a.action, id: a.tabId });
      return textResult(`已执行 ${a.action}`);
    case "browser_evaluate": {
      const r = await callBridge({ op: "evaluate", id: a.tabId, expression: a.expression });
      return textResult(typeof r.value === "string" ? r.value : JSON.stringify(r.value ?? null));
    }
    case "browser_cdp": {
      const r = await callBridge({ op: "cdp", id: a.tabId, method: a.method, params: a.params });
      return textResult(JSON.stringify(r).slice(0, 8000));
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

/* ------------------------------ MCP stdio 循环 ------------------------------ */
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void handleLine(line);
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === undefined) return; // 客户端回的响应，忽略
  try {
    if (method === "initialize") {
      const clientVersion = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "replica-browser", version: "1.0.0" },
          instructions:
            "这是复刻版 Codex 桌面应用的内置浏览器。先用 browser_snapshot 看页面（拿到 ref 编号），再用 browser_click(ref) / browser_type 操作。",
        },
      });
      return;
    }
    if (method === "notifications/initialized" || String(method).startsWith("notifications/")) return;
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await callTool(String(name), args);
        send({ jsonrpc: "2.0", id, result });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `执行失败：${error && error.message ? error.message : String(error)}` }], isError: true },
        });
      }
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `不支持的方法: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((error && error.message) || error) } });
  }
}
