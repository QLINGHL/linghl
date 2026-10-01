import { app } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { browserManager } from "./browserManager";

/**
 * 内置浏览器的「本机桥」。
 *
 * 官方的做法是：浏览器能力（CDP 白名单）在应用内，模型侧通过一个 MCP 服务
 * （`mcp_servers.cua_repl` → `@oai/browser-desktop/service` + node REPL）拿到。
 * 我们不需要 node REPL，但**同样需要一条进程外的通道** —— 因为内核是作为
 * 独立子进程 spawn 起来的 MCP server，它必须能反过来指挥本应用里的浏览器。
 *
 * 所以：本文件在 127.0.0.1 上开一个只认 token 的 HTTP 端点，token 落在
 * `<userData>/browser-bridge.json`；`tools/browser-mcp.cjs` 读它、以 MCP 协议
 * 暴露 browser_* 工具给内核。**仅本机回环 + 随机 token**，不对外监听。
 */

const PORT = 18992;

function tokenPath(): string {
  return path.join(app.getPath("userData"), "browser-bridge.json");
}

interface BridgeRequest {
  op: string;
  id?: string | null;
  url?: string;
  ref?: number;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  expression?: string;
  method?: string;
  params?: unknown;
  clip?: { x: number; y: number; width: number; height: number };
}

async function dispatch(body: BridgeRequest): Promise<unknown> {
  // 不传 id 就用当前激活的标签
  const id = body.id ?? browserManager.activeTabId();
  switch (body.op) {
    case "list":
      return { activeId: browserManager.activeTabId(), tabs: browserManager.list() };
    case "create":
      return browserManager.create(String(body.id));
    case "close":
      browserManager.close(String(id));
      return { ok: true };
    case "activate":
      browserManager.activate(id ?? null);
      return { ok: true };
    case "navigate":
      await browserManager.navigate(String(id), String(body.url ?? ""));
      return { ok: true, id };
    case "back":
      browserManager.back(String(id));
      return { ok: true };
    case "forward":
      browserManager.forward(String(id));
      return { ok: true };
    case "reload":
      browserManager.reload(String(id));
      return { ok: true };
    case "snapshot":
      return JSON.parse(await browserManager.snapshot(String(id)));
    case "screenshot":
      return { dataUrl: await browserManager.screenshot(String(id), body.clip) };
    case "click":
      if (typeof body.ref === "number") await browserManager.clickRef(String(id), body.ref);
      else if (typeof body.x === "number" && typeof body.y === "number")
        await browserManager.clickPoint(String(id), body.x, body.y);
      else throw new Error("click 需要 ref 或 x/y");
      return { ok: true };
    case "type":
      await browserManager.typeText(String(id), String(body.text ?? ""));
      return { ok: true };
    case "key":
      await browserManager.pressKey(String(id), String(body.key));
      return { ok: true };
    case "evaluate": {
      const raw = (await browserManager.cdp(String(id), "Runtime.evaluate", {
        expression: String(body.expression ?? ""),
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (raw?.exceptionDetails) return { error: JSON.stringify(raw.exceptionDetails).slice(0, 800) };
      return { value: raw?.result?.value ?? null };
    }
    case "cdp":
      return browserManager.cdp(String(id), String(body.method), body.params);
    default:
      throw new Error(`未知操作: ${body.op}`);
  }
}

export async function startBrowserBridge(): Promise<void> {
  const token = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(tokenPath(), JSON.stringify({ port: PORT, token }, null, 2), "utf-8");
  } catch {
    /* 写不进去也不致命，MCP 那边会报连不上 */
  }

  const server = http.createServer((req, res) => {
    const respond = (code: number, payload: unknown) => {
      const text = JSON.stringify(payload);
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    };
    if (req.method !== "POST" || (req.headers["x-browser-token"] ?? "") !== token) {
      respond(403, { error: "forbidden" });
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      let body: BridgeRequest;
      try {
        body = JSON.parse(raw || "{}") as BridgeRequest;
      } catch {
        respond(400, { error: "bad json" });
        return;
      }
      void dispatch(body)
        .then((result) => respond(200, { result }))
        .catch((error) => respond(200, { error: String(error?.message ?? error) }));
    });
  });

  // 只绑回环，杜绝从局域网访问
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
}
