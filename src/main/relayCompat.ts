import http from "node:http";
import { net } from "electron";

/**
 * 自定义模型接入的「工具兼容层」（本机透明转发，非网络代理）。
 *
 * 背景（2026-09-29 实测）：内核 0.158 在 responses 模式下，只要模型上一轮产生过
 * reasoning，就会把 `{"type":"reasoning",...}` 条目回传进下一轮请求的 `input` 里
 * （OpenAI 官方 API 保持推理连续性所需）。但第三方 OpenAI 兼容网关大多不支持
 * 这个条目类型 —— 实测 agnes `/v1/responses` 会直接 400：
 *   "unknown variant of untagged enum ResponseInput"
 * 因为上游是对**整份请求体**做反序列化，一个条目不认就全盘拒绝。
 *
 * 表现极具迷惑性：**简单问答一切正常，一问复杂问题（必然触发工具调用）就报错**，
 * 因为只有调用过工具才会有第二轮请求，才轮得到把 reasoning 回传。
 *
 * 内核与网关都是第三方代码，改不了任何一边 —— 所以在本机加一层透明转发：
 *   · 请求侧：只剥掉网关不认的条目（reasoning），其余原样透传
 *   · 响应侧：完全不改（SSE 流式原样转发）
 * 出口网络完全由 Electron 网络栈按系统代理走，本层不参与任何网络设置。
 */

/** 网关不认的 input 条目类型（黑名单制，其余一律原样透传） */
const DROP_TYPES = new Set(["reasoning"]);

/**
 * 网关认的 tools 类型白名单（2026-09-29 实测 agnes 的报错原文枚举）：
 *   `function`, `web_search_preview`, `code_interpreter`, `mcp`
 *
 * 内核 0.158 只要 config.toml 注册了 `[mcp_servers.*]`，就会把该 server 的**全部工具**
 * 打包成一个 `{"type":"namespace","name":"mcp__xxx","tools":[...]}` 条目（官方后端认识
 * 这个变体，第三方网关不认识 → 400 `unknown variant \`namespace\``）。
 * 另外开启 `features.code_mode` 时还会多出 `{"type":"custom","name":"exec"}`。
 *
 * 处理方式：**展开**而不是删除 —— namespace 里的子工具本身就是标准 function 结构，
 * 且名字已是 `browser_*` 这类完整可调用名，平铺后模型照样能调，内置浏览器不丢功能。
 */
const TOOL_TYPE_ALLOWLIST = new Set(["function", "web_search_preview", "web_search", "code_interpreter", "mcp"]);

/** 优先使用的固定端口；被占用则让系统分配 */
const PREFERRED_PORT = 18991;

let server: http.Server | null = null;
let port = 0;
let upstreamBase = "";

/** 更新上游地址（每次写 relay 配置时同步） */
export function setRelayCompatUpstream(baseUrl: string): void {
  if (!baseUrl) {
    upstreamBase = "";
    return;
  }
  try {
    // 只保留 origin：内核请求的 path 里已经带上了 base_url 的路径部分（如 /v1），
    // 这里若再拼一次 /v1 会变成 /v1/v1/responses → 上游 404。
    upstreamBase = new URL(baseUrl).origin;
  } catch {
    upstreamBase = baseUrl.replace(/\/+$/, "");
  }
}

/** 兼容层是否就绪；就绪则返回应写进 config.toml 的 base_url */
export function relayCompatBaseUrl(): string | null {
  return server && port ? `http://127.0.0.1:${port}/v1` : null;
}

function sanitize(bodyBuf: Buffer): { body: Buffer<ArrayBufferLike>; dropped: string[]; flattened: string[] } {
  try {
    const parsed = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
    const dropped: string[] = [];
    const flattened: string[] = [];
    let changed = false;

    // ① input：剥掉网关不认的条目（reasoning）
    if (Array.isArray(parsed.input)) {
      const input = parsed.input as Array<{ type?: string }>;
      const hits = input.filter((it) => it && it.type && DROP_TYPES.has(it.type)).map((it) => it.type as string);
      if (hits.length) {
        parsed.input = input.filter((it) => !(it && it.type && DROP_TYPES.has(it.type)));
        dropped.push(...hits);
        changed = true;
      }
    }

    // ② tools：展开内核打包的 namespace，清掉网关不认的 custom 等类型
    if (Array.isArray(parsed.tools)) {
      const out: Array<Record<string, unknown>> = [];
      for (const raw of parsed.tools as Array<Record<string, unknown>>) {
        const type = typeof raw?.type === "string" ? raw.type : "";
        if (type === "namespace" && Array.isArray(raw.tools)) {
          // 展开：子工具已是标准 function 结构（name/description/strict/parameters）
          for (const child of raw.tools as Array<Record<string, unknown>>) out.push(child);
          flattened.push(String(raw.name ?? "namespace"));
          changed = true;
          continue;
        }
        if (type === "custom") {
          // code_mode 的 `exec` 变体：无对应 function 语义，直接丢弃（内核另有 exec_command 兜底）
          flattened.push(String(raw.name ?? "custom"));
          changed = true;
          continue;
        }
        if (type && !TOOL_TYPE_ALLOWLIST.has(type)) {
          // 其它未知类型一律丢弃，避免 serde 逐个报错把整份请求打回
          flattened.push(`${type}:${String(raw.name ?? "")}`);
          changed = true;
          continue;
        }
        out.push(raw);
      }
      if (changed) parsed.tools = out;
    }

    if (changed) return { body: Buffer.from(JSON.stringify(parsed), "utf8"), dropped, flattened };
  } catch {
    /* 非 JSON：原样转发 */
  }
  return { body: bodyBuf, dropped: [], flattened: [] };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: Buffer<ArrayBufferLike> = Buffer.concat(chunks);
  let dropped: string[] = [];
  let flattened: string[] = [];

  const contentType = String(req.headers["content-type"] ?? "");
  if (req.method === "POST" && body.length && contentType.includes("json")) {
    const result = sanitize(body);
    body = result.body;
    dropped = result.dropped;
    flattened = result.flattened;
  }

  if (!upstreamBase) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "relay compat: 上游地址未设置" } }));
    return;
  }

  const url = upstreamBase.replace(/\/+$/, "") + (req.url ?? "/");
  console.log(
    `[relay-compat] ${req.method} ${req.url} -> ${url} bytes=${body.length}` +
      (dropped.length ? ` 已剥离: ${dropped.join(",")}` : "") +
      (flattened.length ? ` 已展开/清理 tools: ${flattened.join(",")}` : ""),
  );

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (["host", "content-length", "connection"].includes(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  const upstreamReq = net.request({ method: req.method, url });
  // Cancelling a turn closes the downstream stream: stop paid upstream work too.
  res.on("close", () => { if (!res.writableEnded) upstreamReq.abort(); });
  for (const [key, value] of Object.entries(headers)) {
    try {
      upstreamReq.setHeader(key, value);
    } catch {
      /* 个别受限头忽略即可 */
    }
  }

  upstreamReq.on("response", (upstreamRes) => {
    if (res.destroyed) { upstreamReq.abort(); return; }
    const outHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      outHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    res.writeHead(upstreamRes.statusCode, outHeaders);
    upstreamRes.on("data", (chunk) => res.write(chunk));
    upstreamRes.on("end", () => res.end());
    upstreamRes.on("error", () => res.destroy());
  });

  upstreamReq.on("error", (error) => {
    if (res.destroyed) return;
    console.error("[relay-compat] 上游请求失败:", error);
    if (res.headersSent) { res.destroy(); return; }
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `relay compat: ${String(error)}` } }));
  });

  upstreamReq.write(body);
  upstreamReq.end();
}

/** 启动兼容层（必须早于内核 spawn —— config.toml 里的 base_url 指向它） */
export function startRelayCompatServer(): Promise<number> {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    const attempt = (preferred: number | null) => {
      const srv = http.createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
          console.error("[relay-compat] 处理请求异常:", error);
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(error) } }));
        });
      });
      srv.once("error", (error: NodeJS.ErrnoException) => {
        if (preferred !== null && error.code === "EADDRINUSE") {
          console.warn(`[relay-compat] 端口 ${preferred} 被占用，改用系统分配端口`);
          attempt(null);
          return;
        }
        reject(error);
      });
      srv.listen(preferred ?? 0, "127.0.0.1", () => {
        server = srv;
        const address = srv.address();
        port = typeof address === "object" && address ? address.port : 0;
        console.log(`[relay-compat] 已启动 127.0.0.1:${port}`);
        resolve(port);
      });
    };
    attempt(PREFERRED_PORT);
  });
}

export function stopRelayCompatServer(): void {
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  server = null;
  port = 0;
}
