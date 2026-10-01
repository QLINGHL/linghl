import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from "node:timers";
import os from "node:os";

export interface AppServerOptions {
  codexPath: string;
  codeHome: string;
  args?: string[];
  initializeTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  onNotification: (n: { method: string; params: unknown }) => void;
  onServerRequest: (req: { id: string; method: string; params: unknown }) => Promise<unknown>;
  onExit?: (code: number | null, reason?: string) => void;
  onStderr?: (text: string) => void;
}

export interface AppServer {
  start: () => Promise<void>;
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  stop: () => Promise<void>;
  isAlive: () => boolean;
}

export class AppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(error: unknown) {
    const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
    super(String(record?.message ?? error ?? "未知协议错误"));
    this.name = "AppServerRpcError";
    this.code = typeof record?.code === "number" ? record.code : undefined;
    this.data = record?.data;
  }
}

export class AppServerStopError extends Error {
  constructor() {
    super("旧内核未确认退出；已停止切换，避免两个内核同时写入状态库");
    this.name = "AppServerStopError";
  }
}

/** Keep provider env_key/MCP variables; strip only host runtime controls. */
export function buildKernelEnv(codeHome: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (value === undefined || /^(?:ELECTRON_|CHROME_|VSCODE_INSPECTOR_|NODE_OPTIONS$|NODE_INSPECT_RESUME_ON_START$|NODE_CHANNEL_FD$|NODE_UNIQUE_ID$|CODEX_HOME$)/i.test(key)) continue;
    env[key] = value;
  }
  env.RUST_LOG = process.env.CODEX_RUST_LOG ?? "warn";
  env.CODEX_HOME = codeHome;
  return env;
}

export function isUnsupportedMethod(error: unknown): boolean {
  return (error instanceof AppServerRpcError && error.code === -32601) ||
    /(?:method not found|unknown (?:method|variant)|not supported yet|unsupported method)/i.test(String(error));
}

export function describeKernelFailure(code: number | null, stderr: string, signal?: string | null): string {
  const lines = stderr.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const important = lines.filter(line => /error|failed|denied|拒绝|migration|sqlite|panic/i.test(line));
  const detail = (important.length ? important.slice(-3) : lines.slice(-2)).join(" | ").slice(0, 1200);
  return `app-server 已退出（退出码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）${detail ? `：${detail}` : "，未输出错误详情"}`;
}

const INITIALIZE_TIMEOUT_MS = 75_000;
const MAX_JSONL_BUFFER = 16 * 1024 * 1024;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

/** JSONL JSON-RPC. No candidate may replace a process until close confirms it is gone. */
export function createAppServer(opts: AppServerOptions): AppServer {
  let child: ChildProcess | null = null;
  let nextId = 1;
  let generation = 0;
  let ready = false;
  let stopping = false;
  let closed = true;
  let closePromise: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  const pending = new Map<number, Pending>();

  function failPending(error: Error) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }

  function write(value: Record<string, unknown>) {
    if (!child?.stdin?.writable || closed || stopping) throw new Error("app-server 输入管道不可用");
    child.stdin.write(JSON.stringify(value) + "\n");
  }

  function call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method === "initialize" ? "initialize 超时" : `请求超时: ${method}`}（内核 ${Math.round(timeoutMs / 1000)} 秒未响应）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ jsonrpc: "2.0", id, method, params: params ?? {} }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  async function start() {
    if (stopPromise) await stopPromise;
    if (child && !closed) throw new Error("app-server 已启动或仍在退出");
    ready = false;
    stopping = false;
    const currentGeneration = ++generation;
    let stderr = "";
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let terminalError: Error | null = null;
    let closeDone!: () => void;
    closePromise = new Promise(resolve => { closeDone = resolve; });
    let current: ChildProcess;
    try {
      current = spawn(opts.codexPath, [...(opts.args ?? []), "app-server"], {
        cwd: os.homedir(), env: buildKernelEnv(opts.codeHome, opts.extraEnv),
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) {
      closed = true;
      closeDone();
      throw error;
    }
    child = current;
    closed = false;
    const belongs = () => child === current && generation === currentGeneration;
    let finished = false;
    function finish(code?: number | null, signal?: string | null) {
      if (finished) return;
      finished = true;
      closeDone();
      if (!belongs()) return;
      closed = true;
      ready = false;
      const error = terminalError ?? new Error(describeKernelFailure(code ?? exitCode, stderr, signal ?? exitSignal));
      failPending(error);
      if (!stopping) opts.onExit?.(code ?? exitCode, error.message);
    }
    current.on("error", error => {
      if (!belongs()) return;
      terminalError = new Error(`app-server 启动或进程操作失败：${error.message}`);
      failPending(terminalError);
      // No pid means spawn failed: no process exists to await or terminate.
      if (!current.pid) finish();
    });
    current.stdin?.on("error", error => {
      if (!belongs() || closed || stopping) return;
      terminalError = new Error(`app-server 输入管道已断开：${error.message}`);
      failPending(terminalError);
      try { current.kill(); } catch { /* close/stop will confirm termination. */ }
    });
    // exit marks the process unusable, but only close drains the final stderr.
    current.on("exit", (code, signal) => {
      exitCode = code; exitSignal = signal;
      if (belongs()) ready = false;
    });
    current.on("close", finish);
    current.stderr?.setEncoding("utf8");
    current.stderr?.on("data", (chunk: string) => {
      if (!belongs()) return;
      stderr = (stderr + chunk).slice(-16_384);
      try { opts.onStderr?.(chunk); } catch { /* Diagnostics must not break transport. */ }
    });
    let buffer = "";
    function handleLine(line: string) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
        const id = typeof msg.id === "number" ? msg.id : typeof msg.id === "string" && /^\d+$/.test(msg.id) ? Number(msg.id) : NaN;
        const p = pending.get(id);
        if (p) {
          pending.delete(id); clearTimeout(p.timer);
          msg.error ? p.reject(new AppServerRpcError(msg.error)) : p.resolve(msg.result);
        }
        return;
      }
      if (typeof msg.method !== "string") return;
      if (msg.id !== undefined) {
        const reply = (value: Record<string, unknown>) => {
          if (!belongs() || closed || stopping) return;
          try { write(value); } catch { /* Already closing. */ }
        };
        const requestKey = `sr_${currentGeneration}_${typeof msg.id === "number" ? "n" : "s"}_${String(msg.id)}`;
        Promise.resolve().then(() => {
          if (!belongs() || closed || stopping) throw new Error("内核请求已过期");
          return opts.onServerRequest({ id: requestKey, method: msg.method as string, params: msg.params });
        }).then(result => reply({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }))
          .catch(error => reply({ jsonrpc: "2.0", id: msg.id, error: {
            code: error instanceof AppServerRpcError ? error.code ?? -32603 : -32603,
            message: error instanceof Error ? error.message : String(error),
          } }));
      } else {
        try { opts.onNotification({ method: msg.method, params: msg.params ?? {} }); } catch { /* Isolate UI callbacks. */ }
      }
    }
    current.stdout?.setEncoding("utf8");
    current.stdout?.on("data", (chunk: string) => {
      if (!belongs() || closed || stopping) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.trim()) handleLine(line);
      }
      if (buffer.length > MAX_JSONL_BUFFER) {
        terminalError = new Error("内核返回了过大的无换行协议帧");
        failPending(terminalError);
        try { current.kill(); } catch { /* close/stop will confirm termination. */ }
      }
    });
    current.stdout?.on("end", () => { if (belongs() && !stopping && buffer.trim()) handleLine(buffer); });
    try {
      const result = await call("initialize", { clientInfo: { name: "codex-replica", title: "Codex Replica", version: "0.1.0" } }, opts.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
      if (closed || child !== current || current.exitCode !== null && current.exitCode !== undefined) throw new Error("内核握手后已退出");
      console.log("[app-server] initialize OK:", JSON.stringify(result).slice(0, 200));
      write({ jsonrpc: "2.0", method: "initialized", params: {} });
      ready = true;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!ready || closed || stopping || !child?.stdin?.writable) throw new Error("app-server 未就绪");
    return call(method, params, timeoutMs ?? (/^(?:turn|thread)\//.test(method) ? 600_000 : 120_000));
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    failPending(new Error("app-server 已停止"));
    if (!child || closed) return Promise.resolve();
    const current = child;
    const operation = new Promise<void>((resolve, reject) => {
      const killTimer = nativeSetTimeout(() => {
        if (child === current && !closed) { try { current.kill(); } catch { /* deadline rejects. */ } }
      }, 500);
      const deadline = nativeSetTimeout(() => {
        nativeClearTimeout(killTimer);
        reject(new AppServerStopError());
      }, 6000);
      closePromise.then(() => {
        nativeClearTimeout(killTimer); nativeClearTimeout(deadline); resolve();
      });
      try { current.stdin?.end(); } catch { try { current.kill(); } catch { /* deadline rejects. */ } }
    });
    stopPromise = operation.then(() => { stopPromise = null; });
    // Keep a failed stop promise until close so callers cannot start another writer.
    closePromise.then(() => { if (closed) stopPromise = null; });
    return stopPromise;
  }

  return { start, request, stop, isAlive: () => ready && !closed && !stopping && Boolean(child?.stdin?.writable) };
}
