import { app, BrowserWindow, dialog, shell, ipcMain, nativeTheme, session, protocol } from "electron";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { createAppServer, type AppServer } from "./appServer";
import { KernelManager, type KernelCandidate as ManagedKernelCandidate } from "./kernelManager";
import { DeskState } from "./deskState";
import { EnvManager, type EnvProfile } from "./envManager";
import { startRelayCompatServer, stopRelayCompatServer } from "./relayCompat";
import { browserManager } from "./browserManager";
import { startBrowserBridge } from "./browserBridge";

// ---------------------------------------------------------------------------
// 启动环境守卫（本机 Chromium 沙箱起不来这件事见 tools/start-forge.cjs）：
// `--no-sandbox` **必须由命令行传入**，主进程里 appendSwitch 太晚（沙箱更早就初始化了，
// 实测加了也没用，进程仍静默以 0x80000003 退出）。所以这里只做一件事：
// 如果既没有命令行开关、也没有显式放行标记，就明确告诉用户为什么没窗口，而不是静默死掉。
// ---------------------------------------------------------------------------
const sandboxSwitchGiven = process.argv.includes("--no-sandbox") || process.env.ELECTRON_DISABLE_SANDBOX === "1";
if (!sandboxSwitchGiven && process.env.REPLICA_NO_SANDBOX !== "0") {
  console.error(
    "[提示] 未检测到 --no-sandbox：本机 Chromium 沙箱无法初始化，Electron 可能不建窗口就退出。\n" +
      "        用 `npm start` 启动（已自动追加该开关），或直接加在命令行上。",
  );
}

// ---------------------------------------------------------------------------
// 启动环境守卫：ELECTRON_RUN_AS_NODE 一旦存在，electron.exe 就退化成纯 Node 宿主，
// 本文件会被当普通脚本执行 —— 结果是「不建窗口、不报错、直接退出」，
// 用户看到的就是 `npm start` 打完 Launched Electron app 就回到提示符。
// 这里必须吼出来，不能再静默失败。
//   - npm start 已由 forge.config.js 提前 delete（正常情况到不了这里）；
//   - 直接跑 electron.exe 的场景（计划任务/调试）会命中这条。
// ---------------------------------------------------------------------------
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) {
  console.error(
    "[致命] 环境变量 ELECTRON_RUN_AS_NODE 存在，electron.exe 已退化为纯 Node 宿主：不会创建窗口。\n" +
      "        解决办法：在启动它的外壳里删掉这个变量，或改用 `npm start`（已在 forge.config.js 里清除）。\n" +
      "        注意 `set ELECTRON_RUN_AS_NODE=` 只是置空，Electron 只检查变量是否存在，必须 delete。",
  );
  process.exit(78);
}

// ---------------------------------------------------------------------------
// 主进程未捕获异常兜底：Electron 默认会弹「A JavaScript error occurred in the main process」
// 模态框，用户只能点确定，应用等于打不开（实测踩过两次：desk-state 写盘 EPERM、
// 探测内核版本时 execFileSync 的 EPIPE）。这些都不是致命错误，不该让整个程序停摆。
// 这里统一降级成日志 + 控制台输出，让窗口继续活着。
// ---------------------------------------------------------------------------
function reportMainProcessError(kind: string, error: unknown): void {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  console.error(`[主进程${kind}] ${text.slice(0, 800)}`);
  try {
    logEvent({ kind: "note", method: `main/${kind}`, detail: text.slice(0, 400) });
  } catch {
    /* 日志不可用时只打控制台 */
  }
}
process.on("uncaughtException", (error) => reportMainProcessError("未捕获异常", error));
process.on("unhandledRejection", (reason) => reportMainProcessError("未处理的 Promise 拒绝", reason));

// ---------------------------------------------------------------------------
// 本地图片协议（replica-media://）
//   用户消息里的附件是内核给的本地绝对路径（D:\...\xxx.png），渲染进程不能直接
//   用 file:// 引用。官方做法同样是自定义协议；这里注册一个只读、仅图片后缀的
//   协议，把文件字节流回渲染进程。必须在 app ready 之前 registerSchemesAsPrivileged。
// ---------------------------------------------------------------------------
const MEDIA_SCHEME = "replica-media";
const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  // 应用外壳走自定义协议而不是 file://（见下方 APP_SCHEME 注释）
  {
    scheme: "replica-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

/**
 * 应用外壳协议（replica-app://）。
 *
 * 为什么不用 loadFile()（file://）—— 2026-10-01 第三轮启动优化：
 *
 *   `file://` 在 Chromium 里是**不透明来源(origin)**，HTTP 缓存与 **V8 code cache
 *   一律不生效**。于是每次启动，renderer 都必须把 361KB 的 entry bundle 重新
 *   解析+编译一遍（parse + compile 通常 150~400ms，冷机器更久），而这段
 *   恰恰发生在"窗口已经出现但里面什么都没有"的时间里 —— 正是用户看到的空白。
 *
 *   改成 standard+secure 的自定义协议后，Chromium 把它当普通 HTTP 来源对待：
 *     - `cache-control: immutable`（产物是 hash 命名的，内容永不改）→ 二次启动
 *       直接从 HTTP 磁盘缓存读；
 *     - 缓存命中之外，还有 **code cache**：同一份字节流的 V8 编译结果会被复用，
 *       跳过重新 parse/compile。实测这一项对"二次启动首帧"最有效。
 *
 * 安全性：只映射 dist-renderer/ 目录，且做了一次 path.resolve 前缀校验，
 * 防止 `..` 逃逸读到应用外的文件。
 */
const APP_SCHEME = "replica-app";
/** 自定义协议是否注册成功。false 时 createWindow 回落到 loadFile()，行为与旧版一致 */
let appProtocolReady = false;
function registerAppProtocol(): void {
  const rendererRoot = (() => {
    const candidates = [
      path.join(__dirname, "../../dist-renderer"),
      path.join(process.resourcesPath ?? "", "dist-renderer"),
      path.join(app.getAppPath(), "dist-renderer"),
      path.join(__dirname, "../renderer"),
    ];
    return candidates.find((p) => p && fs.existsSync(path.join(p, "index.html"))) ?? null;
  })();
  if (!rendererRoot) {
    boot("app-protocol:no-root", "未找到 dist-renderer/index.html，将回退 file://");
    return;
  }
  const rootResolved = path.resolve(rendererRoot);
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json; charset=utf-8",
  };
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // replica-app://app/<相对路径>，host 固定为 app
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === "/") rel = "/index.html";
      const target = path.resolve(rootResolved, "." + rel);
      // 前缀校验：解析后必须仍在 rendererRoot 之内，挡住 ../ 逃逸
      if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
        return new Response("forbidden", { status: 403 });
      }
      const data = await fs.promises.readFile(target);
      const mime = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
      const isHtml = mime.startsWith("text/html");
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": mime,
          // 产物按 hash 命名 → 除 index.html 外永不变化，可以放心长缓存。
          // index.html 必须每次校验，否则升级后用户会一直加载旧的 chunk 名。
          "cache-control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
          // vite 给入口 script / modulepreload 都带了 `crossorigin` 属性，
          // 浏览器会按 CORS 语义发请求。这里显式回同源许可，避免被拦成
          // "跨域资源加载失败 → 白屏"。（同源其实不需要，但显式声明零成本。）
          "access-control-allow-origin": "*",
        },
      });
    } catch (error) {
      // 404 时回落 index.html 没有意义（这是靠 hash 定位的资源），直接报错更好排查
      boot("app-protocol:miss", `${request.url} err=${String(error).slice(0, 120)}`);
      return new Response(`not found: ${request.url}`, { status: 404 });
    }
  });
  boot("app-protocol:ready", rootResolved);
  appProtocolReady = true;
}

/** 把本地图片路径转成渲染进程可用的 URL（供 preload/渲染层复用同一套规则） */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).searchParams.get("p") ?? "");
      const mime = MEDIA_MIME[path.extname(filePath).toLowerCase()];
      if (!filePath || !mime) return new Response("unsupported media", { status: 415 });
      const data = await fs.promises.readFile(filePath);
      return new Response(new Uint8Array(data), { headers: { "content-type": mime, "cache-control": "no-cache" } });
    } catch (error) {
      return new Response(String(error), { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// 数据隔离：本应用所有数据都在独立目录，绝不读写官方应用的任何数据
//   userData  = %APPDATA%/codex-desk-replica
//   默认环境  = <userData>/codex-home        (codex CLI 的 auth/config/sessions)
//   多环境    = <userData>/envs/<id>/codex-home（EnvManager 登记，见 envs.json）
//   官方导入  = 仅一次性复制 ~/.codex 的 auth/sessions，绝不写官方目录
//
// ⚠️ 目录名 `codex-desk-replica` 是**历史遗留**，应用改名为 LINGHL 后**刻意没有跟着改**：
//    里面装着用户已有的全部数据（会话、项目归属、多环境配置、各环境的 API Key）。
//    改名会让应用认不出旧目录、等于把用户数据全部"弄丢"。
//    真要改必须配套写迁移逻辑（旧目录存在且新目录不存在时整体搬迁），
//    那是独立的一次改动，不能顺手做。
// ---------------------------------------------------------------------------
let USER_DATA_DIR = path.join(app.getPath("appData"), "codex-desk-replica");
let CODEX_HOME = path.join(USER_DATA_DIR, "codex-home");

/**
 * ⚠️ 建目录永远不许抛异常。
 * 这些语句在**模块加载期**执行：一旦抛出去，Electron 只会打印 "App threw an error during load"
 * 并弹一个模态框 —— 不建窗口、不做任何业务日志、进程还吊着不退出。
 * 用户看到的就是「npm start 打完 Launched Electron app 之后卡住，一分钟也没窗口」。
 * 2026-10-01 就是被这个坑掉了一整天（见下面 userData 自检的注释）。
 */
function ensureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 启动轨迹（logs/boot.log）：任何一次启动都能事后回答"到底卡在哪一步"
//   之所以必须落盘：Electron 主进程在模块加载期抛异常时，控制台什么都没有、
//   窗口也不建，除了落盘没有别的线索（这次排查最费时间的恰恰是"没有任何输出"）。
// ---------------------------------------------------------------------------
const BOOT_LOG = (() => {
  for (const file of [path.join(USER_DATA_DIR, "logs", "boot.log"), path.join(app.getAppPath(), "boot.log")]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, "", "utf8");
      return file;
    } catch {
      /* 换下一个候选位置 */
    }
  }
  return null;
})();
function boot(mark: string, detail = ""): void {
  if (!BOOT_LOG) return;
  try {
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} pid=${process.pid} ${mark}${detail ? ` ${detail}` : ""}\n`, "utf8");
  } catch {
    /* 轨迹写不了不影响主流程 */
  }
}
boot("module:loaded", `electron=${process.versions.electron} userData=${USER_DATA_DIR}`);

/**
 * 渲染层首帧打点（2026-10-01 第三轮启动优化）。
 *
 * 渲染层在三个时刻各发一个点，这里换算成"相对主进程模块加载"的毫秒数写进 boot.log。
 * 之所以要这条链路：窗口的**创建时间**在主进程侧很好测，但"窗口里到底什么时候
 * 才有画面"只有渲染层知道 —— 而用户抱怨的恰恰是后者（2~3 秒空白）。
 * 有了 script / first-commit / first-paint 三个点，就能一眼分清瓶颈在
 * bundle 解析、React 首屏渲染，还是浏览器绘制/CSS。
 *
 * 用 ipcMain.on（不是 handle）：打点是单向的，不给启动路径加任何 IPC 往返。
 * 记录必须用**渲染层自己的 performance.now()**换算绝对时间，
 * 因为两个进程的 monotonic 起点不同，不能直接相减。
 */
const MAIN_BOOT_EPOCH = Date.now();
ipcMain.on("app:boot-mark", (_e, payload: { mark?: unknown; atMs?: unknown }) => {
  const mark = typeof payload?.mark === "string" ? payload.mark : "renderer:unknown";
  const atMs = typeof payload?.atMs === "number" ? payload.atMs : null;
  // 渲染层 performance.now() 的 0 点 ≈ 导航开始，主进程此刻已跑了一段。
  // 这里不做精确对齐，只标注"渲染层自报的毫秒数"+"主进程接收时的绝对耗时"，
  // 两个数并排看就够定位瓶颈了。
  boot(mark, `renderer=${atMs ?? "?"}ms main=${Date.now() - MAIN_BOOT_EPOCH}ms`);
});

// ---------------------------------------------------------------------------
// 数据目录可用性自检（2026-10-01 新增，踩坑后补的）
//
// 本机实测链条：工作区目录被沙箱加了一条 `Mandatory Label\Low Mandatory Level`，
// 目录下**所有文件**继承该标签（含 node_modules/electron/dist/electron.exe）。
// Windows 建进程时采用映像文件的强制标签 → 即使父进程是 Medium，Electron 主进程也会以
// **Low 完整性** 运行 → 写不了 Medium 标签的 %APPDATA%（连 mkdir 都是 EPERM）。
// 而 KernelManager 的构造函数正好在模块加载期 mkdir，于是又回到上面那条"静默卡死"路径。
//
// 结论：**能打开** 永远优先于 "目录正统"。不可写就退回应用目录下的 .replica-userdata，
// 并把原因写到轨迹 + 弹一次说明，而不是让用户对着一个没有窗口的进程发呆。
// 修法（开发态）：`npm run fix-integrity` 把相关 exe 的标签改回 Medium。
// ---------------------------------------------------------------------------
function dirWritable(dir: string): boolean {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
let userDataNotice: string | null = null;
if (!ensureDir(USER_DATA_DIR) || !dirWritable(USER_DATA_DIR)) {
  const fallback = path.join(app.getAppPath(), ".replica-userdata");
  if (ensureDir(fallback) && dirWritable(fallback)) {
    userDataNotice =
      `默认数据目录不可写：${USER_DATA_DIR}\n\n` +
      `已临时改用：${fallback}\n\n` +
      `原因：本机工作区被加了 Low 完整性标签，node_modules/electron/dist/electron.exe 继承该标签后\n` +
      `Electron 会以 Low 完整性启动，从而无法写入 %APPDATA%。\n\n` +
      `修法：在项目目录执行  npm run fix-integrity  ，然后用普通（非沙箱）终端重新启动。`;
    USER_DATA_DIR = fallback;
    CODEX_HOME = path.join(USER_DATA_DIR, "codex-home");
    boot("userData:fallback", `-> ${fallback}`);
    console.error(`[userData] 默认目录不可写，已回退到 ${fallback}`);
  } else {
    userDataNotice = `数据目录不可写，回退目录也建不出来：${USER_DATA_DIR}`;
    boot("userData:unwritable", USER_DATA_DIR);
    console.error(`[userData] ${userDataNotice}`);
  }
}
ensureDir(CODEX_HOME);
app.setPath("userData", USER_DATA_DIR);
app.setPath("sessionData", path.join(USER_DATA_DIR, "sessionData"));

// ---------------------------------------------------------------------------
// 延迟诊断日志（logs/timeline.jsonl）：把每个 RPC 的发起/返回耗时、关键通知、
// 内核 stderr 告警按时间线落盘。「发一条消息为什么这么慢」这类问题以后靠数据
// 说话，不再靠猜。文件超过 5MB 时启动时轮转一次。
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(USER_DATA_DIR, "logs");
ensureDir(LOG_DIR);
const TIMELINE_LOG = path.join(LOG_DIR, "timeline.jsonl");
const KERNEL_LOG = path.join(LOG_DIR, "kernel.log");
try {
  for (const f of [TIMELINE_LOG, KERNEL_LOG]) {
    if (fs.existsSync(f) && fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, `${f}.old`);
  }
} catch {
  /* 轮转失败不影响主流程 */
}

function logEvent(evt: Record<string, unknown>): void {
  try {
    fs.appendFile(TIMELINE_LOG, JSON.stringify({ t: new Date().toISOString(), ...evt }) + "\n", () => {});
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 内核 stderr 里的关键行落盘。info 级噪音（fs.read_file 等）不进文件，
 *  但 session_loop / submission_dispatch / models_manager / auth / plugin 这些
 *  span 是定位「发送后内核内部卡在哪几秒」的关键证据，必须记。 */
function logKernelStderrLine(line: string): void {
  if (
    !/WARN|ERROR|retry|reconnect|timeout|timed out|session_loop|submission|dispatch|codex_models_manager|codex_login|plugin|mcp|websocket|proxy/i.test(
      line,
    )
  )
    return;
  const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!clean) return;
  try {
    fs.appendFile(KERNEL_LOG, `${new Date().toISOString()} ${clean}\n`, () => {});
  } catch {
    /* ignore */
  }
  logEvent({ kind: "stderr", text: clean.slice(0, 300) });
}

// 环境管理器：多隔离环境 + 自定义模型接入（自研，见 envManager.ts）
const envMgr = new EnvManager(USER_DATA_DIR);

// 内置 codex 内核位置：开发态 vendor/，打包态 resources/vendor/
function bundledCodexPath(): string {
  const devPath = path.join(app.getAppPath(), "vendor", "codex", "bin", "codex.exe");
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath ?? "", "vendor", "codex", "bin", "codex.exe");
  if (fs.existsSync(prodPath)) return prodPath;
  return "codex"; // 兜底：PATH 中的 codex
}

const kernelManager = new KernelManager(USER_DATA_DIR, bundledCodexPath());
function managedRuntimeForEnv(env: EnvProfile, _candidate: ManagedKernelCandidate): boolean {
  // Only the local environment needs a writable projection. App-managed and
  // custom isolated environments already own their CODEX_HOME directly.
  return env.kind === "local";
}
function runtimeHomeForCandidate(envId: string, candidate: ManagedKernelCandidate): string {
  if (!activeRuntimeHome) throw new Error(`内核 ${candidate.version ?? "?"} 尚未建立可提交的运行目录（环境 ${envId}）`);
  return activeRuntimeHome;
}

/**
 * 从 `codex --version` 输出里取版本号（形如 `codex-cli 0.159.2`）。
 *
 * ⚠️ 这里踩过坑：`execFileSync` 写 stdin 时如果内核进程已经退出，Node 会在
 * `Socket._write` 抛 **EPIPE**，而且它是「未捕获异常」—— Electron 会直接弹
 * 「A JavaScript error occurred in the main process」模态框，等于把应用打挂。
 * 所以：① 用 spawnSync + 显式忽略 stdin（stdio: ["ignore","pipe","ignore"]）避免写管道；
 * ② 结果按路径缓存，同一个内核只探一次（每次要起一个 300MB 进程，很贵）。
 */
const kernelVersionCache = new Map<string, string | null>();
function probeKernelVersion(exePath: string): string | null {
  if (!exePath || exePath === "codex") return null;
  if (kernelVersionCache.has(exePath)) return kernelVersionCache.get(exePath) ?? null;
  let version: string | null = null;
  try {
    if (fs.existsSync(exePath)) {
      const res = spawnSync(exePath, ["--version"], {
        timeout: 20000,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"], // 不写 stdin：写已退出的子进程会抛 EPIPE
        maxBuffer: 1024 * 1024,
      });
      const text = `${res.stdout ?? ""}`;
      const m = /codex-cli\s+([0-9][0-9A-Za-z.\-+]*)/.exec(text);
      version = m ? m[1] : null;
    }
  } catch (error) {
    console.error(`[kernel] 探测版本失败（当作未知）：${exePath}`, String(error).slice(0, 160));
    version = null;
  }
  kernelVersionCache.set(exePath, version);
  return version;
}

/** 版本号比较：0.159.2 > 0.158.0-alpha.9（同段数字比较，预发布号视为小于正式版） */
function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre = ""] = v.split("-", 2);
    return { parts: core.split(".").map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i += 1) {
    const dx = x.parts[i] ?? 0;
    const dy = y.parts[i] ?? 0;
    if (dx !== dy) return dx > dy;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true; // 正式版 > 预发布版
  if (!y.pre) return false;
  return x.pre > y.pre;
}

/**
 * 「自动探测 Codex」：找出本机**最新的** codex 内核。
 *
 * 官方桌面应用会把内核装在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe 并且**自动升级**。
 * 版本探测只决定协议候选顺序，不能单独证明数据兼容；启动必须在应用托管的运行目录中完成，
 * 并以真实 initialize/只读接口响应作为兼容判断。官方安装目录只作为内核来源和只读数据源。
 */
function detectOfficialCodexPaths(): string[] {
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Codex") : "",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Codex") : "",
  ].filter(Boolean);
  const found: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // 官方按内容哈希分目录；一层不够就再往下找一层
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && /^codex\.exe$/i.test(entry.name)) found.push(full);
        else if (entry.isDirectory() && dir.split(path.sep).length - root.split(path.sep).length < 2) stack.push(full);
      }
    }
  }
  return found;
}

/**
 * 收集所有候选内核，**按版本从新到旧**排序。
 *
 * 「自动探测 Codex」的核心：官方桌面应用会自己升级内核
 * （%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe），我们永远优先用最新那个；
 * 自带的内核只作为最后兜底。这样**官方升级不需要我们发版**。
 */
function kernelCandidates(): { path: string; source: string; version: string | null; fingerprint: string }[] {
  return kernelManager.candidates().map((candidate) => ({
    path: candidate.path,
    source: candidate.source,
    version: candidate.version,
    fingerprint: candidate.fingerprint,
  }));
}

/** 解析结果缓存：内核可能被重启多次（切环境/接入方式），不必每次都探测 */
let kernelChoice: { path: string; source: string; version: string | null } | null = null;
let activeRuntimeHome: string | null = null;
function codexBinaryPath(): string {
  if (!kernelChoice) {
    kernelChoice = kernelCandidates()[0] ?? { path: bundledCodexPath(), source: "自带内核", version: null };
    console.log(
      `[kernel] 首选内核：${kernelChoice.path}\n        来源=${kernelChoice.source} 版本=${kernelChoice.version ?? "未知"}`,
    );
    logEvent({ kind: "note", method: "kernel/selected", detail: `${kernelChoice.source} ${kernelChoice.version ?? "?"} ${kernelChoice.path}` });
  }
  return kernelChoice.path;
}

/**
 * 内核启动失败 → 换下一个候选重试（版本次新的）。
 * 典型场景：自带的旧内核读不了新版迁移过的 state db，换官方新版立刻可用；
 * 反过来（官方内核某天出问题）也能退回自带内核。
 */
function nextKernelCandidate(after: string): { path: string; source: string; version: string | null } | null {
  const list = kernelCandidates();
  const idx = list.findIndex((k) => path.resolve(k.path).toLowerCase() === path.resolve(after).toLowerCase());
  if (idx < 0) return list[0] ?? null;
  return list[idx + 1] ?? null;
}

/**
 * 内核兼容性诊断：给界面/日志看「现在用的是哪个内核、为什么不是首选」。
 * 官方升级内核导致不兼容时，这里会明确写出来，而不是让用户看到空列表。
 */
type KernelHealth = {
  path: string;
  source: string;
  version: string | null;
  ok: boolean;
  reason?: string;
  attempts: { path: string; source: string; version: string | null; ok: boolean; reason?: string; retried?: boolean }[];
};
let kernelHealth: KernelHealth | null = null;
function setKernelHealth(health: KernelHealth): void {
  kernelHealth = health;
  console.log(`[kernel] 健康：ok=${health.ok} 版本=${health.version ?? "?"} 来源=${health.source}${health.reason ? ` 原因=${health.reason}` : ""}`);
  logEvent({
    kind: "note",
    method: "kernel/health",
    detail: JSON.stringify({
      ok: health.ok,
      version: health.version,
      source: health.source,
      reason: health.reason?.slice(0, 200),
      attempts: health.attempts.map((a) => `${a.version ?? "?"}:${a.ok ? "ok" : (a.reason ?? "fail").slice(0, 80)}`),
    }).slice(0, 600),
  });
  broadcast("codex:notification", { method: "kernel/health", params: health });
}
function getKernelHealth(): KernelHealth | null {
  return kernelHealth;
}
function syncKernelHealthToRenderer(): void {
  const health = getKernelHealth();
  if (!health) return;
  broadcast("codex:notification", {
    method: "kernel/health",
    params: { ok: health.ok, version: health.version, source: health.source, reason: health.reason ?? null },
  });
}

let win: BrowserWindow | null = null;
let server: AppServer | null = null;
let desk: DeskState | null = null;

/**
 * 内核就绪闸门。
 *
 * 为什么要它（2026-10-01 启动诊断）：渲染层一挂载就会发 env/list、thread/list 等 RPC，
 * 而窗口创建（~60ms）远早于内核就绪（~700ms 热启 / ~9s 冷启）。
 * 旧实现是 `if (!server) throw "app-server 未运行"` —— 渲染层请求一到就**立刻失败**，
 * 于是 init() 整条链当场崩掉，只能干等 server/ready 广播再重来一遍，
 * 这段"什么都没发生"的时间实测有 **9134ms**（timeline.jsonl：04:47:45.309 kernel ready
 * → 04:47:54.443 第一条渲染层 RPC）。
 *
 * 现在改成：请求先在这里排队等内核起来（带上限），好了就正常发。
 * 界面因此可以"一挂载就发请求"，数据到达时间从 9s 降到 ~700ms。
 *
 * 注意：waiters 是"一次性"的 —— 每次内核就绪只唤醒当前排队的人。
 * 换环境时内核会重启，新的请求会重新排队等下一轮 ready（不能复用同一个 Promise，
 * 否则第二次启动的请求会被上一轮的已决议 Promise 直接放行，结果又是"未运行"）。
 */
let kernelReady = false;
let waiters: (() => void)[] = [];

function waitForKernel(ms: number): Promise<void> {
  if (kernelReady) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    waiters.push(finish);
    setTimeout(finish, ms);
  });
}

function markKernelReady() {
  kernelReady = true;
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
}

/** 内核重启（换环境）：闸门重新落下，后续请求重新排队 */
function markKernelNotReady() {
  kernelReady = false;
}

/** 渲染层请求等内核就绪的上限：超过就照旧报错，别让 UI 无声地卡死 */
const KERNEL_WAIT_TIMEOUT_MS = 25_000;

/**
 * 窗口显示闸门的硬超时（2026-10-01 第四轮，见 createWindow 里的 revealNow）。
 *
 * 正常路径下渲染层会在 React 首次提交后立刻发 `app:reveal`（实测 +1.2s 左右），
 * 这个超时永远轮不到。它存在的唯一意义是**保证窗口一定会出现**：
 * 万一渲染层 bundle 缺文件、JS 抛异常、或机器异常慢，用户也不该面对
 * "进程在跑但屏幕上什么都没有"这种最坏情况。
 *
 * 取 8s：足够覆盖冷启动 + 慢磁盘 + 首次无缓存的解析编译（实测最差 ~3s），
 * 又不至于让真正卡死的场景无限期等下去。
 */
const REVEAL_TIMEOUT_MS = 8_000;

const isDev = !app.isPackaged;

/** 已记录过「首条 delta」的线程集合（turn/completed 时清掉，下轮重新记） */
const firstDeltaSeen = new Set<string>();

/** 单实例锁：第二个实例直接退出，避免两份进程同时读写 envs.json/desk-state.json
 *  并各自 spawn 一个 codex 内核（数据竞争 + 会话互相覆盖）。
 *
 *  ⚠️ 拿不到锁时**绝不能静默 app.quit()**：2026-09-30 排查「npm start 启动不了」时，
 *  Electron 的 ProcessSingleton 因为建不出锁文件（chromium 报 `Lock file can not be created!
 *  Error code: 5`）而返回 false，进程一声不响退出，界面上什么都没有。
 *  所以这里：① 把判断依据写进日志；② 锁建不出来但**没有活着的实例**时默认继续启动
 *  （用户要的是能打开，不是安全洁癖）。仍要防的是「同一份数据被两个进程同时写」——
 *  用 `<userData>/instance.lock` 记 pid 并探活来判断，而不是只看锁文件。
 *  显式设 REPLICA_ALLOW_MULTI=0 可恢复严格的单实例语义。 */
const lockHeldByLiveInstance = (() => {
  const marker = path.join(USER_DATA_DIR, "instance.lock");
  try {
    const raw = fs.readFileSync(marker, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); // 探活：进程不存在会抛错
    return true;
  } catch {
    return false;
  }
})();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
// 默认允许降级：本机 ProcessSingleton 建不出锁文件是常态（Chromium 报 Lock file can not be created），
// 只要没有**活着的**实例就继续启动 —— 用户不该为了打开程序去记环境变量。
// 显式设 REPLICA_ALLOW_MULTI=0 可关掉降级（严格单实例）。
const allowMultiFallback = process.env.REPLICA_ALLOW_MULTI !== "0";
// ⚠️ 这两个判断必须和上面第 391 行的 allowMultiFallback 用**同一个**口径。
// 曾经的 bug：上面按「!== "0"」放行、下面却要求「=== "1"」，
// 于是当 REPLICA_ALLOW_MULTI 是空串/其它值时，两条路都不走 —— 不建窗口、不报错、
// 进程永远吊着（表现为"启动到一半就没反应了"）。默认放行才是这个应用该有的语义：
// 用户要的是能打开，数据串写用 instance.lock 探活来防。
const multiAllowed = gotSingleInstanceLock || allowMultiFallback;
boot("lock:checked", `lock=${gotSingleInstanceLock} allowMulti=${allowMultiFallback} multiAllowed=${multiAllowed}`);
if (!gotSingleInstanceLock) {
  if (allowMultiFallback && !lockHeldByLiveInstance) {
    console.error(
      "[警告] 单实例锁创建失败（Chromium ProcessSingleton 常见报错 Lock file can not be created），" +
        "但未检测到仍在运行的实例 → 继续启动。",
    );
  } else {
    console.error(
      "[致命] 未取得单实例锁：另一个 Codex 实例正在运行。\n" +
        "        若确认没有别的窗口，删掉 %APPDATA%\\codex-desk-replica\\instance.lock 后重试。",
    );
    app.quit();
  }
}
if (multiAllowed) {
  // 记下自己的 pid，供下一个实例判断「是不是真的还有活的实例」
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(USER_DATA_DIR, "instance.lock"), String(process.pid), "utf8");
    app.on("will-quit", () => {
      try {
        const marker = path.join(USER_DATA_DIR, "instance.lock");
        if (fs.readFileSync(marker, "utf8").trim() === String(process.pid)) fs.unlinkSync(marker);
      } catch { /* 尽力而为 */ }
    });
  } catch { /* 写不了标记不影响启动 */ }
  app.on("second-instance", () => {
    const existing = win ?? BrowserWindow.getAllWindows()[0];
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });
}

/** 向所有存活窗口广播（多窗口时 win 引用只指向最后创建的窗口，
 *  直接 win?.send 会让其他窗口收不到通知/审批）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 原生窗口控件（最小化/最大化/关闭）的图标色：必须跟随主题，
 *  否则深色模式下 #0d0d0d 画在深色标题栏上 = 完全看不见。 */
const TITLEBAR_SYMBOL = { light: "#0d0d0d", dark: "#f3f3f3" } as const;

function applyTitlebarTheme(theme: "light" | "dark"): void {
  try {
    // 多窗口时每个窗口的 overlay 都要同步，不能只改最后创建的那个
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.setTitleBarOverlay({ color: "#00000000", symbolColor: TITLEBAR_SYMBOL[theme], height: 40 });
    }
  } catch {
    /* 非 Windows / 不支持 overlay 时忽略 */
  }
}

function createWindow() {
  const startTheme: "light" | "dark" = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  // 恢复上次窗口大小/位置（记录的是还原态 bounds；最大化状态单独记录）
  const saved = desk?.data.bounds;
  const restoreBounds =
    saved && saved.width >= 720 && saved.height >= 560
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : undefined;
  const newWin = new BrowserWindow({
    ...(restoreBounds ?? { width: 1272, height: 810 }),
    minWidth: 480,
    minHeight: 560,
    title: "LINGHL",
    backgroundColor: startTheme === "dark" ? "#131313" : "#ffffff",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: TITLEBAR_SYMBOL[startTheme],
      height: 40,
    },
    trafficLightPosition: { x: 12, y: 12 },
    /**
     * ⚠️ show:false + 首帧后再显示（2026-10-01 第四轮，针对"空白窗口 2~3 秒"）。
     *
     * 实测（boot.log）：窗口 +332ms 就显示了，但首帧要到 +2.8s —— 于是用户
     * 盯着一个**已经出现但纯白**的窗口看了整整 1.6~2.4 秒。这正是用户抱怨的
     * "打开了程序，然后它打开了之后，有两到三秒"。
     *
     * 为什么不用 Electron 官方推荐的 `ready-to-show`？
     *   实测该事件在本机**经常根本不触发**（本轮日志里就没有 window:ready-to-show）。
     *   原因是它依赖渲染层真的完成一次绘制，而 Chromium 对"尚未显示的窗口"
     *   会推迟光栅化（这正是我们之前所有测量翻车的同一个根因）。
     *   把"显示窗口"这个关键动作绑在一个可能永不触发的事件上，风险太高。
     *
     * 所以改用一条**有明确兜底**的路径：
     *   渲染层在 React 首次提交（DOM 已就绪、样式已可用）后立刻发 `app:reveal`，
     *   主进程收到就 show()。这比 first-paint 略早一点点，但足够保证
     *   "窗口一旦出现，里面已经有内容"，而且完全不依赖 Chromium 的光栅化时机。
     *   同时设一个硬超时（下面 REVEAL_TIMEOUT_MS）—— 渲染层万一崩了/太大，
     *   窗口也一定会出来，不会变成"进程在跑但永远没有窗口"。
     *
     * 注意：show:false 时要显式 `paintWhenInitiallyHidden` 保持默认 true，
     * 否则渲染层会因为"不可见"而完全不绘制，首帧永远不会发生。
     */
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 内置浏览器走主进程 WebContentsView（对齐官方），渲染层不用 <webview>；
      // 官方自己的 webPreferences 里这个开关也是关的
      webviewTag: false,
    },
  });
  win = newWin;
  // 内置浏览器：主进程 WebContentsView 挂在窗口的 contentView 上（对齐官方做法）
  browserManager.attachWindow(newWin);
  browserManager.setEmitter((state) => broadcast("codex:browser-state", state));
  browserManager.setOpenUrlHandler((url) => broadcast("codex:browser-open-url", url));
  browserManager.setTabAddedHandler((tab) => broadcast("codex:browser-add-tab", tab));
  if (saved?.maximized) newWin.maximize();

  // 窗口大小/位置记忆（resize/move 抖动大，500ms 去抖后写入 desk-state.json）
  let boundsTimer: NodeJS.Timeout | null = null;
  const saveBounds = () => {
    if (newWin.isDestroyed() || newWin.isMinimized()) return;
    desk?.update({
      bounds: { ...newWin.getNormalBounds(), maximized: newWin.isMaximized() },
    });
  };
  const scheduleBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  newWin.on("resize", scheduleBounds);
  newWin.on("move", scheduleBounds);
  newWin.on("close", saveBounds);

  // 只有显式给了开发服务器地址（electron-forge start / VITE_DEV_SERVER_URL）才连 dev server，
  // 否则一律加载已构建的产物。旧逻辑在 isDev 下硬编码 http://localhost:5173/，
  // 直接 `electron .` 启动时没人监听这个端口 → 白屏。
  const rendererDevServerUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : process.env.VITE_DEV_SERVER_URL;
  const rendererName = typeof MAIN_WINDOW_VITE_NAME !== "undefined" ? MAIN_WINDOW_VITE_NAME : "main_window";
  /**
   * 已构建界面的位置。
   *
   * ⚠️ 首选 `dist-renderer/`（vite.renderer.config.mts 的 outDir）——
   * **刻意放在 `.vite/` 之外**：electron-forge 的 Vite 插件在 preStart 会
   * `fs.remove('.vite')`，本机安全删除垫片会中途抛错，把渲染层产物删掉一半，
   * 结果就是"窗口出来但里面什么都没有"。
   * 后面几个候选是历史路径，留着兼容旧构建。
   */
  const builtIndexCandidates = [
    path.join(__dirname, "../renderer", rendererName, "index.html"),
    path.join(__dirname, "../../dist-renderer/index.html"),
    path.join(process.resourcesPath ?? "", "dist-renderer/index.html"),
    path.join(app.getAppPath(), "dist-renderer/index.html"),
    path.join(__dirname, "../renderer/index.html"),
  ];
  const builtIndex = builtIndexCandidates.find((p) => p && fs.existsSync(p)) ?? builtIndexCandidates[0];

  /**
   * 兜底：主框架加载失败（dev server 挂了 / 产物缺失）时，往窗口里塞一张
   * 可读的错误页，而不是留一片白。用户至少能知道发生了什么、去哪里看日志。
   */
  const showLoadFailure = (detail: string) => {
    if (newWin.isDestroyed()) return;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#fff;color:#0d0d0d;
        font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
      .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center}
      h1{font-size:16px;font-weight:600;margin:0}
      p{font-size:13px;color:#5d5d5d;margin:0;max-width:560px;line-height:1.6}
      code{font-size:12px;background:#f3f3f3;border-radius:4px;padding:2px 6px;word-break:break-all}
    </style></head><body><div class="wrap">
      <h1>界面加载失败</h1>
      <p>应用窗口已经打开，但渲染层资源没能载入。这通常是开发服务器未启动，或构建产物缺失。</p>
      <p><code>${detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</code></p>
      <p>日志：<code>%APPDATA%/codex-desk-replica/logs/boot.log</code></p>
    </div></body></html>`;
    void newWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  };

  if (rendererDevServerUrl) {
    // dev server 挂了也要能退回构建产物，而不是留一个白窗口
    newWin.webContents.once("did-fail-load", (_event, code, desc, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      if (newWin.isDestroyed()) return;
      // 只对主框架的真实失败做处理：-3 是用户主动中断导航（重载/跳转），不是错误
      if (code === -3) return;
      console.error(`[renderer] dev server 加载失败（${code} ${desc}），回退到构建产物`);
      if (fs.existsSync(builtIndex)) {
        void newWin.webContents.loadFile(builtIndex);
      } else {
        showLoadFailure(`dev server 不可达（${code} ${desc}），且未找到构建产物：${builtIndex}`);
      }
    });
    void newWin.loadURL(rendererDevServerUrl);
  } else {
    /**
     * 走自定义协议而不是 loadFile()（2026-10-01 第三轮启动优化）。
     *
     * loadFile() 是 `file://`，在 Chromium 里不透明来源 → **没有 HTTP 缓存、
     * 也没有 V8 code cache** → 每次启动都要重新 parse+compile 361KB 的 entry bundle，
     * 这段时间正好是"窗口已出现、里面还什么都没有"。
     * replica-app:// 是 standard+secure 协议，能吃到上面两者，二次启动首帧显著变快。
     *
     * 兜底：协议注册失败（找不到产物目录）时回落到原来的 loadFile，行为与之前一致。
     */
    const appUrl = "replica-app://app/index.html";
    newWin.webContents.once("did-fail-load", (_event, code, desc, url, isMainFrame) => {
      if (isMainFrame === false || code === -3) return;
      // 自定义协议不可用 → 立刻退回 file://，用户不会看到白屏
      if (url.startsWith(`${APP_SCHEME}://`) && fs.existsSync(builtIndex)) {
        console.error(`[renderer] 自定义协议加载失败（${code} ${desc}），回退 file://`);
        boot("app-protocol:fallback", `${code} ${desc}`);
        void newWin.webContents.loadFile(builtIndex);
        return;
      }
      showLoadFailure(`无法载入界面（${code} ${desc}）`);
    });
    if (appProtocolReady) {
      void newWin.loadURL(appUrl);
    } else {
      void newWin.loadFile(builtIndex);
    }
  }

  newWin.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 渲染层重载（Ctrl+R / 开发期刷新）后 store 里的标签页就没了，
  // 但主进程的 WebContentsView 还在、而且还浮在界面上 —— 会变成盖住聊天区的孤儿视图
  newWin.webContents.on("did-finish-load", () => browserManager.closeAll());

  /**
   * 窗口可见性打点（2026-10-01 首帧测量的关键前提）。
   *
   * Chromium 对 `hidden` 的窗口会**推迟光栅化** —— 此时渲染层的 first-paint
   * 会拖到 2s 之后，但那不是应用慢。把可见性记进 boot.log，
   * 以后看首帧数字时能一眼判断这次测量是否可信。
   */
  const noteVisibility = () => {
    if (newWin.isDestroyed()) return;
    boot("window:visibility", `visible=${newWin.isVisible()} minimized=${newWin.isMinimized()}`);
  };
  newWin.once("show", noteVisibility);
  newWin.once("ready-to-show", () => boot("window:ready-to-show"));

  /**
   * 窗口显示闸门（2026-10-01 第四轮，配合上面 BrowserWindow 的 show:false）。
   *
   * 目标：**窗口一旦出现在屏幕上，里面就已经有内容**，而不是先给一个纯白框。
   * 三条触发路径，谁先到算谁：
   *   ① 渲染层 React 首次提交后发 `app:reveal`（最快、最常见）；
   *   ② `ready-to-show`（若 Chromium 真的给了这个事件，用它更保险）；
   *   ③ 硬超时 REVEAL_TIMEOUT_MS（渲染层崩了/极慢时兜底，保证窗口一定会出现）。
   *
   * 用 `revealed` 标志保证只 show 一次；show 之后把监听都摘掉，避免重复调用
   * （重复 show() 本身无害，但会打乱 boot.log 的时序读数）。
   */
  let revealed = false;
  const revealEpoch = Date.now();
  let revealTimer: NodeJS.Timeout | null = null;
  const revealNow = (reason: string) => {
    if (revealed || newWin.isDestroyed()) return;
    revealed = true;
    boot("window:reveal", `reason=${reason} delayed=${Date.now() - revealEpoch}ms`);
    newWin.show();
    if (revealTimer) clearTimeout(revealTimer);
    // 显示之后就不再需要这条通道/这个事件了（多窗口时各自摘各自的）
    ipcMain.removeListener("app:reveal", onRevealIpc);
    newWin.removeListener("ready-to-show", onReadyToShow);
  };
  /**
   * ⚠️ 不能用 `ipcMain.once("app:reveal", ...)`：
   * 多窗口（app:new-window）时 once 会被**第一个**窗口的 reveal 消费掉，
   * 之后新建的窗口永远收不到自己的 reveal，只能干等 8s 硬超时。
   * 所以用常驻 on + 在 reveal 后自行摘除；并用 `event.sender` 校验来源窗口，
   * 避免 A 窗口发出的 reveal 把 B 窗口提前显示出来。
   */
  const onRevealIpc = (event: Electron.IpcMainEvent) => {
    if (event.sender !== newWin.webContents) return;
    revealNow("renderer");
  };
  const onReadyToShow = () => revealNow("ready-to-show");
  ipcMain.on("app:reveal", onRevealIpc);
  newWin.once("ready-to-show", onReadyToShow);
  revealTimer = setTimeout(() => revealNow("timeout"), REVEAL_TIMEOUT_MS);

  newWin.webContents.once("did-finish-load", noteVisibility);

  newWin.on("closed", () => {
    // 只有被关闭的是当前引用时才清空，避免旧窗口关闭清掉新窗口引用
    if (win === newWin) win = null;
    // 清理显示闸门的残留监听：窗口在 reveal 之前就被关掉时，
    // ipcMain 上的常驻监听和超时定时器会泄漏（每开一次窗口泄漏一份）
    ipcMain.removeListener("app:reveal", onRevealIpc);
    if (revealTimer) clearTimeout(revealTimer);
  });
}

/**
 * 从内核 stderr 里认出"配置被丢弃"这类致命但静默的问题。
 *
 * 内核遇到 config.toml 校验失败时**不会退出、也不会发 error 通知**，只会在 stderr 里打一行
 *   ERROR codex_app_server: Invalid configuration; using defaults. <path>:<line>:<col>: <原因>
 * 然后整份 config.toml 作废、回落到默认 provider —— 表现就是"我明明配了模型，却还在走官方登录"。
 * 这是用户无法自救的一类故障，必须抬到界面上。
 */
function extractConfigIssue(text: string): { level: "error" | "warn"; message: string } | null {
  // 内核 stderr 带 ANSI 颜色码与日志前缀，不清掉界面上会显示成一串 \u001b[2m 和 ISO 时间戳
  const clean = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARNING|WARN)\s+codex_app_server:\s*/g, "");

  // ② 只忽略了若干"不认识的配置项"：配置整体仍然生效，但值得告诉用户（多半是拼写错误或已废弃的键）
  const ignored = /is ignoring (\d+) unrecognized configuration setting/i.exec(clean);
  if (ignored) {
    const detail = clean
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/is ignoring \d+ unrecognized/i.test(l))
      .filter((l) => !/^Check for typos/i.test(l))
      .join(" ")
      .replace(/\(([A-Za-z]:[\\/][^)]*?)\\?config\.toml\)/, "(config.toml)")
      .slice(0, 300)
      .trim();
    return {
      level: "warn",
      message: `内核不认识这份 config.toml 里的 ${ignored[1]} 个配置项，已经忽略（其余配置正常生效）。${detail}`,
    };
  }

  if (!/Invalid configuration/i.test(clean)) return null;
  // "using defaults." 之后才是具体原因（<path>:<line>:<col>: <why>）
  const after = clean.split(/using defaults\.?/i)[1] ?? clean;
  const reason = after
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^How to fix:/i.test(l))
    .filter((l) => !/^More info:/i.test(l))
    .filter((l) => !/^Caused by:/i.test(l))
    .filter((l) => !/^in `/i.test(l))
    .filter((l) => !/^\^+$/.test(l))
    .join(" ")
    // 绝对路径对用户没意义，留文件名就够定位了
    .replace(/[A-Za-z]:[\\/][^\s]*?\\?config\.toml/, "config.toml")
    .slice(0, 300)
    .trim();
  if (!reason) {
    return { level: "error", message: "内核读取 config.toml 失败，已丢弃整份配置并改用默认设置。" };
  }
  // 把已知的高频原因翻成人话并给出修法
  const hint = /wire_api\s*=\s*"chat"/i.test(reason)
    ? "本版内核已移除 chat 协议，请在「模型」里把协议改成 responses（或让网关把 /responses 转发到 /chat/completions）。"
    : "";
  return {
    level: "error",
    message: `内核读取 config.toml 失败，已丢弃整份配置并改用默认设置。${hint}原因：${reason}`,
  };
}

/**
 * 最近一次内核配置问题。
 * 必须缓存：内核是在窗口加载**之前**启动的，那时候渲染层还没订阅通知，
 * 直接 broadcast 会丢（表现为"启动时的配置告警永远不显示，只有切环境才显示"）。
 */
let kernelIssue: { level: "error" | "warn"; message: string } | null = null;
let kernelStderrBuffer = "";

function setKernelIssue(issue: { level: "error" | "warn"; message: string } | null): void {
  kernelIssue = issue;
  broadcast("codex:notification", {
    method: "kernel/config-error",
    params: issue ? { message: issue.message, level: issue.level } : { message: null },
  });
}

// ---------------------------------------------------------------------------
// 内核网络路径修复（2026-09-29 实测根因）：
//   本应用由计划任务拉起，进程环境里没有任何代理变量；而 codex 内核（Rust reqwest）
//   只认 HTTP_PROXY/HTTPS_PROXY 环境变量、不读 Windows 系统代理。实测本机直连
//   OpenAI 的路是死的（DNS 污染 11s + TCP 被封 20s 超时），唯一健康路径是系统
//   代理（127.0.0.1:7890，curl 实测 2.2s 到 401）。内核摸黑走坏路时首字节要
//   9~14s，断流后 "Reconnecting... N/5" 每次退避 3~8s、整轮重试全部重来——
//   这就是「发送后很久才回复 + 中途重试中」的根因。
//   修法：启动内核前用 Chromium 的 resolveProxy 解析系统代理 → TCP 探活 →
//   探活通过才注入 HTTP(S)_PROXY（代理没开时绝不注入，避免彻底断网）。
// ---------------------------------------------------------------------------

/** 问 Chromium 要「访问这个 URL 该走哪个代理」，返回 host:port 或 null（DIRECT） */
async function resolveSystemProxy(url: string): Promise<{ host: string; port: number } | null> {
  try {
    const rules = await session.defaultSession.resolveProxy(url);
    const m = /PROXY\s+([^;\s]+)/.exec(rules ?? "");
    if (!m) return null;
    const [host, portStr] = m[1].split(":");
    const port = Number(portStr);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  } catch {
    return null;
  }
}

/** TCP 探活：代理端口真的有人听才注入，否则（代理客户端没开）保持直连 */
function probeTcp(host: string, port: number, ms = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * 解析系统代理并注入进程环境（内核 spawn 时经 process.env 继承）。
 * 必须在 startServerForActive() 之前调用；返回实际注入的代理描述（用于日志）。
 */
async function applySystemProxyForKernel(): Promise<string | null> {
  const target = await resolveSystemProxy("https://chatgpt.com/");
  if (!target) {
    logEvent({ kind: "proxy", result: "direct（系统无代理或 DIRECT）" });
    return null;
  }
  const alive = await probeTcp(target.host, target.port);
  if (!alive) {
    logEvent({ kind: "proxy", result: `代理 ${target.host}:${target.port} 探活失败，保持直连` });
    return null;
  }
  const proxyUrl = `http://${target.host}:${target.port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  logEvent({ kind: "proxy", result: `已注入 ${proxyUrl}` });
  return proxyUrl;
}

/** 按当前激活环境启动 app-server（CODEX_HOME 与模型 API Key 都按环境注入）
 *
 *  `kernelOverride` 用于「内核起不来 → 换本机官方内核重试」的降级路径（见 startServerWithFallback）；
 *  `opts.initializeTimeoutMs` 用于冷启动很慢时延长等待（同一内核再试一次）。 */
async function startServerForActive(
  kernelOverride?: string,
  envOverride?: EnvProfile,
  opts?: { initializeTimeoutMs?: number; kernelCandidate?: ManagedKernelCandidate },
): Promise<void> {
  const env = envOverride ?? envMgr.activeEnv();
  kernelStderrBuffer = "";
  const managedCandidate = opts?.kernelCandidate ?? kernelManager.candidates().find((candidate) =>
    path.resolve(candidate.path).toLowerCase() === path.resolve(kernelOverride ?? codexBinaryPath()).toLowerCase(),
  );
  // A local environment points at the official ~/.codex. Never let a replica
  // kernel migrate or write that directory while the official app is open.
  // Build a SQLite online-backup snapshot and run the kernel from app-owned data.
  const runtimeHome = env.kind === "local" && managedCandidate
    ? await kernelManager.prepareRuntime(managedCandidate, env.id, env.codexHome)
    : env.codexHome;
  const runtimeEnv = runtimeHome === env.codexHome ? env : { ...env, codexHome: runtimeHome };
  activeRuntimeHome = runtimeHome;
  // New start clears stale configuration diagnostics.
  setKernelIssue(null);
  // relay config must be written into the runtime home, never the official home.
  envMgr.syncRelayConfig(runtimeEnv);
  const created: AppServer = createAppServer({
    codexPath: kernelOverride ?? codexBinaryPath(),
    initializeTimeoutMs: opts?.initializeTimeoutMs,
    codeHome: runtimeEnv.codexHome,
    extraEnv: envMgr.spawnEnvFor(runtimeEnv),
    onNotification: (notification) => {
      // 延迟诊断：关键通知全记（delta 只记每个线程的第一条 —— 那是「首字延迟」的终点）
      const params = (notification.params ?? {}) as Record<string, unknown>;
      if (notification.method === "item/agentMessage/delta") {
        const tid = typeof params.threadId === "string" ? params.threadId : "?";
        if (!firstDeltaSeen.has(tid)) {
          firstDeltaSeen.add(tid);
          logEvent({ kind: "note", method: notification.method, first: true, threadId: tid });
        }
      } else {
        if (notification.method === "turn/completed") {
          const tid = typeof params.threadId === "string" ? params.threadId : null;
          if (tid) firstDeltaSeen.delete(tid);
        }
        logEvent({
          kind: "note",
          method: notification.method,
          threadId: typeof params.threadId === "string" ? params.threadId : undefined,
          // error 通知带原因（Reconnecting... N/5 就从这里看出来的）
          detail:
            notification.method === "error"
              ? JSON.stringify({ willRetry: params.willRetry, error: params.error }).slice(0, 400)
              : undefined,
        });
      }
      broadcast("codex:notification", notification);
    },
    onStderr: (text) => {
      for (const line of text.split(/\r?\n/)) logKernelStderrLine(line);
      kernelStderrBuffer = (kernelStderrBuffer + text).slice(-32_768);
      const issue = extractConfigIssue(kernelStderrBuffer);
      if (issue) {
        console.error(`[app-server] 配置${issue.level === "error" ? "未生效" : "提示"}:`, issue.message);
        setKernelIssue(issue);
        kernelStderrBuffer = "";
      }
    },
    onServerRequest: (req) => {
      // 审批/提问类服务端请求转发给渲染层裁决。必须保证最终一定有响应发回内核，
      // 否则内核会一直等下去（turn 永久挂起）。
      return new Promise((resolve) => {
        if (!RENDERER_HANDLED.has(req.method)) {
          // 没有对应 UI 的请求（如 item/tool/call）立刻答复，别让它悬着
          console.warn("[app-server] 无人处理的 server request:", req.method);
          resolve(unattendedResponse(req.method));
          return;
        }
        const timer = setTimeout(() => {
          if (!pendingApprovals.has(req.id)) return;
          pendingApprovals.delete(req.id);
          broadcast("codex:approval-timeout", req.id);
          resolve(fallbackResponse(req.method));
        }, APPROVAL_TIMEOUT_MS);
        pendingApprovals.set(req.id, {
          respond: (resp) => {
            clearTimeout(timer);
            resolve(resp);
          },
          fallback: fallbackResponse(req.method),
        });
        broadcast("codex:server-request", req);
      });
    },
    onExit: (code, reason) => {
      // 重启时旧实例会稍后才退出，这里必须按实例身份判断，
      // 否则旧实例的 close 会把刚启动的新实例引用清成 null。
      if (server !== created) return;
      for (const [id, item] of pendingApprovals) {
        item.respond(item.fallback);
        pendingApprovals.delete(id);
      }
      server = null;
      // 内核没了：闸门落下。此时排队中的请求应立刻失败（而不是等满 25s 超时），
      // 所以直接唤醒它们 —— 唤醒后 `if (!server)` 会照旧抛「未运行」。
      markKernelNotReady();
      markKernelReady();
      const current = getKernelHealth();
      setKernelHealth({
        path: managedCandidate?.path ?? (kernelOverride ?? codexBinaryPath()),
        source: managedCandidate?.source ?? "当前内核",
        version: managedCandidate?.version ?? null,
        ok: false,
        reason: reason ?? `app-server 已退出（退出码 ${code ?? "未知"}）`,
        attempts: current?.attempts ?? [],
      });
      broadcast("codex:exit", code);
      void syncKernelHealthToRenderer();
    },
  });
  server = created;
  try {
    await created.start();
  } catch (error) {
    if (server === created) server = null;
    await created.stop().catch(() => undefined);
    throw error;
  }
  // 预热模型目录：内核 thread/start 里的 list_models(online_if_uncached) 在进程内
  // 首次调用时必然发起在线刷新，网络不顺就吃 5s 超时并把 thread/start 拖到 5.1s。
  // 实测只要"刷新尝试过一次"（哪怕失败），后续调用一律 µs 级走缓存快路径 ——
  // 所以启动后立刻在后台打一发 model/list，把这次昂贵的尝试在用户发消息前烧掉。
  // fire-and-forget：失败无所谓，别让它拖慢启动。
  try {
    /**
     * 就绪门禁。两条 RPC 必须都过，但**不能串行**（2026-10-01 启动诊断）：
     *   - initialize 只证明握手成功，内核可能开了 state 库再挂 —— 所以要一次稳定只读 RPC。
     *   - 旧的串行写法是 `await thread/list` 然后 `await account/read`，
     *     两条各自 30s 超时，最坏 60s 才 `server/ready`；而前端 loadThreads
     *     排在 ready 之后 —— 内核慢启动时侧栏就一直是空的。
     *   - 这两条 RPC 彼此无依赖，并发发出即可，最坏仍是 30s 而不是 60s。
     *   - 超时也收到 20s：真要 20s 还没答，说明内核状态不对，
     *     让 fallback 循环尽早换候选，比干等更有意义。
     */
    const HEALTH_TIMEOUT_MS = 20_000;
    await Promise.all([
      created.request("thread/list", { limit: 1, archived: false, useStateDbOnly: true }, HEALTH_TIMEOUT_MS),
      // refreshToken: false —— 启动期绝不联网刷新登录态（实测 15~21s），
      // 读缓存态即可；真要刷新由渲染层 checkAccount({refresh:true}) 显式触发。
      created.request("account/read", { refreshToken: false }, HEALTH_TIMEOUT_MS),
    ]);
  } catch (error) {
    await created.stop().catch(() => undefined);
    if (server === created) server = null;
    throw new Error(`内核健康检查失败：${String(error).replace(/^Error:\s*/, "")}`);
  }
  void created.request("model/list", { refresh_strategy: "online_if_uncached" })
    .then(() => logEvent({ kind: "note", method: "model/list", detail: "warmup done" }))
    .catch((e) => logEvent({ kind: "note", method: "model/list", detail: `warmup failed: ${String(e).slice(0, 120)}` }));
  // The fallback loop emits server/ready after it commits a prepared runtime
  // to runtime-map. This prevents the renderer from reading history before the
  // durable runtime pointer exists.
  return;
}

/** 这个内核还能用吗：initialize 有响应（上面 await 通过）且进程还活着 */
function kernelIsAlive(): boolean {
  return server?.isAlive() === true;
}

/**
 * 启动内核：**按版本从新到旧逐个试**，第一个能起来的就用它。
 *
 * 为什么要「逐个试」而不是「取最新一次」：官方升级内核会同时迁移 ~/.codex 里的
 * state 库。某个内核报版本号正常、却读不了当前数据（或反过来）时，
 * 只有真的把它拉到 `initialize` 成功才算兼容 —— 否则界面就是空列表，
 * 用户完全看不出是内核/数据的版本错配。逐试 + 记录原因，才能既自愈又可见。
 */
async function startServerWithFallback(): Promise<void> {
  const env = envMgr.activeEnv();
  const candidates = kernelCandidates();
  if (!candidates.length) throw new Error("没有检测到可用 Codex 内核（请安装官方 Codex 或补齐 vendor/codex）");
  const attempts: KernelHealth["attempts"] = [];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await startServerForActive(candidate.path, env, { kernelCandidate: candidate });
      if (!kernelIsAlive()) throw new Error("内核启动后立即退出（详见 logs/kernel.log）");
      kernelChoice = candidate;
      if (managedRuntimeForEnv(env, candidate)) {
        await kernelManager.commitRuntime(candidate, env.id, env.codexHome, runtimeHomeForCandidate(env.id, candidate));
        envMgr.setRuntimeHome(env.id, runtimeHomeForCandidate(env.id, candidate));
      }
      attempts.push({ ...candidate, ok: true });
      setKernelHealth({
        ...candidate,
        ok: true,
        // 不是首选 = 之前的候选不兼容，界面上要说清楚
        reason: attempts.length > 1 ? `已跳过 ${attempts.length - 1} 个不兼容内核` : undefined,
        attempts,
      });
      if (attempts.length > 1) {
        console.error(`[app-server] 已切换到可用内核：${candidate.version ?? "?"}（${candidate.source}）`);
      }
      markKernelReady();
      broadcast("codex:notification", { method: "server/ready", params: {} });
      return;
    } catch (error) {
      lastError = error;
      await server?.stop().catch(() => undefined);
      if (server) server = null;
      const reason = String(error).replace(/^Error:\s*/, "").slice(0, 500);
      attempts.push({ ...candidate, ok: false, reason });
      logEvent({ kind: "note", method: "kernel/attempt-failed", detail: `${candidate.version ?? "?"} ${reason}`.slice(0, 300) });
      // 「超时」和「退出」要区别对待：
      //   超时 = 内核还活着、只是在慢慢冷启动（实测要 25~30s）→ 把它的等待窗口翻倍再试一次同一内核，
      //          不要直接换版本（换版本同样慢，会白白多等一轮，还可能连累可用的内核被误判）。
      //   退出 = 它真的起不来（例如读不了新版 state 库）→ 换下一个版本。
          const isTimeout = /初始化?超时|initialize 超时|timed? ?out/i.test(reason);
      if (isTimeout && !attempts[attempts.length - 1].retried) {
        attempts[attempts.length - 1].retried = true;
        console.error(`[app-server] 内核 ${candidate.version ?? "?"} 冷启动较慢（${reason}），延长等待再试一次同一内核`);
        try {
          await startServerForActive(candidate.path, env, { initializeTimeoutMs: 180_000, kernelCandidate: candidate });
          if (!kernelIsAlive()) throw new Error("内核第二次仍未能就绪");
          kernelChoice = candidate;
          attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], ok: true, reason: undefined };
          setKernelHealth({ ...candidate, ok: true, reason: `冷启动较慢，已在延长等待后就绪`, attempts });
          markKernelReady();
          broadcast("codex:notification", { method: "server/ready", params: {} });
          return;
        } catch (retryError) {
          const failedServer = server as unknown as AppServer | null;
          if (failedServer) await failedServer.stop().catch(() => undefined);
          server = null;
          attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], ok: false, reason: String(retryError).slice(0, 500) };
        }
      }
      console.error(`[app-server] 内核 ${candidate.version ?? "?"}（${candidate.source}）起不来，试下一个：${reason}`);
    }
  }
  setKernelHealth({
    path: candidates[0]?.path ?? "",
    source: candidates[0]?.source ?? "",
    version: candidates[0]?.version ?? null,
    ok: false,
    reason: String(lastError ?? "没有可用内核").slice(0, 300),
    attempts,
  });
  // 没有可用内核：放行排队中的请求，让它们拿到"未运行"错误而不是一直挂着
  markKernelReady();
  throw lastError ?? new Error("没有可用内核");
}

/** 切换环境/改接入方式后重启 app-server，并通知渲染层重置会话状态 */
async function restartServer(): Promise<void> {
  const previous = server;
  server = null;
  // 内核要重启：闸门重新落下，渲染层的新请求排队等下一轮 ready，
  // 否则它们会立刻拿到「app-server 未运行」。
  markKernelNotReady();
  try {
    if (previous) await previous.stop();
  } catch (error) {
    console.error("[app-server] 旧内核未能退出，取消本次切换：", error);
    setKernelHealth({
      path: kernelChoice?.path ?? bundledCodexPath(),
      source: kernelChoice?.source ?? "当前内核",
      version: kernelChoice?.version ?? null,
      ok: false,
      reason: String(error).slice(0, 500),
      attempts: kernelHealth?.attempts ?? [],
    });
    broadcast("codex:exit", null);
    return;
  }
  // 切环境时把悬着的审批按"拒绝"收尾：回 null 会让内核反序列化失败，
  // 表现成切环境后那一轮莫名报错。
  for (const [, item] of pendingApprovals) item.respond(item.fallback);
  pendingApprovals.clear();
  try {
    await startServerWithFallback();
  } catch (error) {
    console.error("[app-server] 重启失败:", error);
    broadcast("codex:exit", null);
    syncKernelHealthToRenderer();
  }
  broadcast("codex:notification", {
    method: "env/changed",
    params: { envId: envMgr.activeId() },
  });
}

// 未拿到单实例锁、且没有降级放行时不再启动窗口与内核（app.quit() 是异步的，
// 不设这道闸门的话退出过程里仍可能建出窗口）
if (multiAllowed) {
  app.whenReady().then(async () => {
    boot("ready:enter");
    desk = new DeskState(USER_DATA_DIR);
    envMgr.ensureDefault(CODEX_HOME);
    registerMediaProtocol();
    registerAppProtocol();

    /**
     * 内核与窗口**并行**启动（2026-10-01 第二轮优化）。
     *
     * 旧顺序是严格串行：先 createWindow()，再代理，再 relay/browser 服务，最后才
     * `await startServerWithFallback()`。于是窗口早就建好了（~60ms），
     * 内核却要等前面几件事做完才开始 spawn —— 而那 300ms 的 codex.exe 冷启动
     * 是整条链里最贵的一步。窗口在这段时间里没有任何数据可显示。
     *
     * 现在：内核的启动 Promise 立刻发出（不等窗口），窗口照常先建。
     * 两者互不依赖（内核不需要窗口存在，窗口靠请求排队等内核），
     * 所以总耗时 ≈ max(窗口, 内核) 而不是 窗口 + 内核。
     *
     * 前提：内核启动内部先 await 代理注入（见下面 startServerWithFallback 前的那步），
     * 因为它 spawn 时必须带上代理环境变量。
     */
    const proxyReady = applySystemProxyForKernel().catch(() => null);
    const kernelBoot = proxyReady.then(() => startServerWithFallback());

    // 先创建窗口：即使内置 codex 启动失败，用户仍能看到
    // 设置/环境页面并获得错误反馈，而不是整个应用白屏或无窗口。
    createWindow();
    boot("window:created");
    // 数据目录被降级（见文件上半部分的 userData 自检）时必须让用户知道，
    // 否则他会以为"项目和会话怎么没了"。非阻塞，窗口照常可用。
    if (userDataNotice && win && !win.isDestroyed()) {
      void dialog
        .showMessageBox(win, {
          type: "warning",
          title: "数据目录不可写",
          message: "本应用已临时改用备用数据目录",
          detail: userDataNotice,
          buttons: ["知道了"],
        })
        .catch(() => undefined);
    }

    /**
     * 关键路径优化（2026-10-01 第二轮）：
     * 旧顺序是「代理 → relay 兼容层 → 浏览器桥 → 启动内核」，四步全程串行。
     * 其中 relay 兼容层与浏览器桥都要起本地 HTTP 服务，各自几十到几百毫秒，
     * 而内核冷启动本身才是最大的一块 —— 它们和内核**并不互相依赖**
     * （relay 的 config.toml 里 base_url 指向 compat 层，但 compat 层只要在
     *  内核真正发请求前起来即可，不需要卡在内核 spawn 之前）。
     *
     * 所以把这三件事并发：内核立刻开冷启动，其余服务在后台起来。
     * 实测能把"窗口出来 → 数据可用"再压掉一段。
     */
    // 内置浏览器的 IPC 是同步注册的，先做（开浏览器窗口要用）
    browserManager.registerIpc();
    void startRelayCompatServer().catch((error) => {
      console.error("[relay-compat] 启动失败，自定义模型将直连上游:", error);
    });
    void startBrowserBridge().catch((error) => {
      console.error("[browser-bridge] 启动失败，模型侧将无法使用内置浏览器:", error);
    });

    try {
      // 复用上面在 createWindow() 之前就发出的那个 Promise —— 内核只启动一次，
      // 但冷启动的时钟从"窗口还没建"的时候就开始走了。
      await kernelBoot;
      boot("kernel:ready");
    } catch (error) {
      console.error("[app-server] startup failed", error);
      boot("kernel:failed", String(error).slice(0, 200));
      logEvent({ kind: "fatal", error: String(error).slice(0, 300) });
      broadcast("codex:exit", null);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---------------------------------------------------------------------------
// 服务端请求（内核 → 客户端）的响应兜底
//
// app-server 的审批/提问是**服务端发起的 JSON-RPC 请求**：我们如果不回响应，
// 内核会一直等下去，整个 turn 就永久挂住（界面看起来只是"卡住了"）。
// 所以每一个请求都必须有一个确定的归宿。
// ---------------------------------------------------------------------------

/** 渲染层有对应 UI、应该由用户裁决的请求 */
const RENDERER_HANDLED = new Set<string>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

/** 用户迟迟不响应时的兜底答复（与"拒绝/不提供"同义，让 turn 能继续跑完） */
function fallbackResponse(method: string): unknown {
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: "decline" };
  }
  if (method === "mcpServer/elicitation/request") return { action: "decline" };
  if (method === "attestation/generate") return {};
  return {};
}

/** 渲染层根本没有 UI 的请求：立刻答复，不要让它悬着 */
function unattendedResponse(method: string): unknown {
  // item/tool/call = 内核请客户端执行一个动态工具。本应用不执行外部工具，
  // 回一个 schema 合法的"失败"结果，模型会据此自己收尾，而不是无限等待。
  if (method === "item/tool/call") return { success: false, contentItems: [] };
  return fallbackResponse(method);
}

interface PendingApproval {
  respond: (resp: unknown) => void;
  /** 超时/切环境时用这个答复收尾 */
  fallback: unknown;
}
const pendingApprovals = new Map<string, PendingApproval>();

/** 等待用户在界面上下决心的上限；超过就按 fallback 答复并收起横幅 */
const APPROVAL_TIMEOUT_MS = 150_000;

ipcMain.handle("codex:request", async (_e, payload: { method: string; params: unknown }) => {
  // 窗口创建（~60ms）远早于内核就绪（热启 ~700ms / 冷启数秒）。
  // 旧实现直接 throw，渲染层请求当场失败、init() 整条链崩掉，
  // 只能等 server/ready 广播重来 —— 那一段就是用户看到的空白（实测 9.1s）。
  // 现在短等一下（带上限），内核一就绪就放行。
  let waited = false;
  if (!server) {
    const t0 = Date.now();
    waited = true;
    await waitForKernel(KERNEL_WAIT_TIMEOUT_MS);
    logEvent({ kind: "note", method: "kernel-wait", detail: `${Date.now() - t0}ms ready=${Boolean(server)}` });
  }
  if (!server) throw new Error("app-server 未运行");
  const t0 = Date.now();
  logEvent({ kind: "req", method: payload.method });
  try {
    const result = await server.request(payload.method, payload.params);
    logEvent({ kind: "res", method: payload.method, ms: Date.now() - t0 });
    return result;
  } catch (error) {
    logEvent({ kind: "res", method: payload.method, ms: Date.now() - t0, error: String(error).slice(0, 200) });
    throw error;
  }
});

ipcMain.handle("codex:approval-response", (_e, payload: { id: string; response: unknown }) => {
  const pending = pendingApprovals.get(payload.id);
  if (pending) {
    pendingApprovals.delete(payload.id);
    pending.respond(payload.response);
  }
  return true;
});

ipcMain.handle("desk-state:get", () => desk?.data);
ipcMain.handle("desk-state:set", (_e, patch: Record<string, unknown>) => {
  desk?.update(patch);
  return desk?.data;
});

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  codexHome: envMgr.activeEnv()?.codexHome ?? CODEX_HOME,
  userData: USER_DATA_DIR,
  isDev,
}));

// 渲染层解析出最终主题（system/light/dark 三态已折算）后同步给原生窗口控件
ipcMain.handle("app:set-theme", (_e, theme: unknown) => {
  applyTitlebarTheme(theme === "dark" ? "dark" : "light");
  return { ok: true };
});

// 跟随系统时，系统切换深浅色也要同步原生控件
nativeTheme.on("updated", () => {
  applyTitlebarTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light");
});

ipcMain.handle("app:open-external", async (_e, value: unknown) => {
  const url = String(value ?? "");
  if (!/^https?:\/\//i.test(url)) throw new Error("只允许打开 http(s) 地址");
  await shell.openExternal(url);
});

// ------------------------------------------------------------- 环境管理 IPC

ipcMain.handle("env:list", () => {
  const reg = envMgr.list();
  return {
    ...reg,
    activeId: envMgr.activeId(),
    // managed = 数据目录归应用托管（删环境会整目录清理）；自定义目录/本地 Codex 只解除登记
    envs: reg.envs.map((e) => ({ ...e, managed: envMgr.isManagedHome(e) })),
    official: envMgr.detectOfficial(),
  };
});

ipcMain.handle(
  "env:create",
  (_e, p: { name?: unknown; codexHome?: unknown; importAuthFromLocal?: unknown } | unknown) => {
    // 兼容旧的纯字符串调用
    if (typeof p === "string") return envMgr.createEnv({ name: p });
    const opts = (p ?? {}) as { name?: unknown; codexHome?: unknown; importAuthFromLocal?: unknown };
    return envMgr.createEnv({
      name: String(opts.name ?? ""),
      codexHome: opts.codexHome == null ? undefined : String(opts.codexHome),
      importAuthFromLocal: opts.importAuthFromLocal === true,
    });
  },
);

/** 在文件管理器里打开某个环境的数据目录（路径由主进程按 id 解析，渲染层不能传任意路径） */
ipcMain.handle("env:open-dir", async (_e, id: unknown) => {
  const env = envMgr.envById(String(id));
  if (!env) throw new Error("环境不存在");
  if (!fs.existsSync(env.codexHome)) throw new Error(`目录不存在：${env.codexHome}`);
  const error = await shell.openPath(env.codexHome);
  if (error) throw new Error(error);
  return { ok: true, path: env.codexHome };
});

ipcMain.handle("env:read-file", (_e, p: { id: unknown; name: unknown }) =>
  envMgr.readEnvFile(String(p.id), String(p.name)),
);

/**
 * 取最近一次内核配置问题（界面在启动/切环境后主动来拿，弥补错过广播的窗口）。
 *
 * 同时把「内核兼容性」并进这条通道：如果当前用的不是首选内核（说明有内核起不来，
 * 多半是官方升级后版本/数据错配），或者所有内核都起不来，就在界面上明说 ——
 * 这一整类问题以前是**静默**的（表现为空列表），现在必须可见。
 */
ipcMain.handle("app:kernel-retry", async () => {
  try {
    await restartServer();
    return { ok: Boolean(server), message: server ? undefined : "内核重试后仍未就绪" };
  } catch (error) {
    return { ok: false, message: String(error).replace(/^Error:\s*/, "").slice(0, 500) };
  }
});

ipcMain.handle("app:kernel-issue", () => {
  const health = getKernelHealth();
  if (health && !health.ok) {
    return {
      level: "error",
      silent: false,
      message:
        `内核无法启动（已试 ${health.attempts.length} 个版本：` +
        health.attempts.map((a) => `${a.version ?? "?"}${a.ok ? "" : "✗"}`).join(" / ") +
        `）。历史会话仍可浏览，但发送消息不可用。原因：${health.reason ?? "未知"}`,
    };
  }
  if (health?.reason) {
    return {
      level: "warn",
      silent: false,
      message: `内核已自动切换：当前 ${health.version ?? "未知版本"}（${health.source}），${health.reason}。`,
    };
  }
  if (kernelIssue) return kernelIssue;
  return health ? { level: "info", message: `内核 ${health.version ?? "未知"}（${health.source}）`, silent: true } : null;
});

/** 读该环境里的项目清单（官方桌面版存在 .codex-global-state.json，只读） */
ipcMain.handle("env:projects", (_e, id: unknown) => {
  try {
    return envMgr.readEnvProjects(String(id));
  } catch {
    return { projects: [], selectedProjectId: null };
  }
});

/**
 * 不经内核直读会话清单（内核起不来时的兜底，见 envManager.readEnvThreads）。
 * 渲染层在 thread/list 失败或返回空时会来取这份数据，至少让左侧能看到历史会话。
 */
ipcMain.handle("env:threads", (_e, id: unknown) => {
  try {
    return { threads: envMgr.readEnvThreads(String(id)) };
  } catch (error) {
    return { threads: [], error: String(error).slice(0, 200) };
  }
});

/**
 * 不经内核直读某个会话的正文（turns + items，内核起不来时的兜底）。
 * 没有它，内核不可用时点开会话是全空白的。
 */
ipcMain.handle("env:turns", (_e, p: { id: unknown; threadId: unknown }) => {
  try {
    return { data: envMgr.readEnvTurns(String(p.id), String(p.threadId)) };
  } catch (error) {
    return { data: [], error: String(error).slice(0, 200) };
  }
});

ipcMain.handle("env:write-file", async (_e, p: { id: unknown; name: unknown; text: unknown }) => {
  const result = envMgr.writeEnvFile(String(p.id), String(p.name), String(p.text ?? ""));
  // 改的是使用中环境的配置文件：必须重启内核才会重新读
  if (String(p.id) === envMgr.activeId()) await restartServer();
  return result;
});

// 登记「本地 Codex」环境：原地复用 ~/.codex，零拷贝零导入
ipcMain.handle("env:add-local", () => envMgr.addLocalEnv());

ipcMain.handle("env:switch", async (_e, id: unknown) => {
  envMgr.setActive(String(id));
  await restartServer();
  return { ok: true };
});

ipcMain.handle("env:delete", (_e, id: unknown) => {
  envMgr.deleteEnv(String(id));
  return { ok: true };
});

ipcMain.handle(
  "env:set-mode",
  async (_e, p: { id: unknown; mode: "chatgpt" | "relay"; relayId?: unknown }) => {
    envMgr.setEnvMode(String(p.id), p.mode, p.relayId == null ? null : String(p.relayId));
    if (String(p.id) === envMgr.activeId()) await restartServer();
    return { ok: true };
  },
);

ipcMain.handle(
  "relay:upsert",
  async (
    _e,
    p: {
      id?: unknown;
      name: unknown;
      baseUrl: unknown;
      apiKey?: unknown;
      wireApi?: unknown;
      model?: unknown;
      managedAuth?: unknown;
      experimentalBearerToken?: unknown;
      contextWindow?: unknown;
      reasoningEffort?: unknown;
    },
  ) => {
    const relay = envMgr.upsertRelay({
      id: p.id == null ? undefined : String(p.id),
      name: String(p.name ?? ""),
      baseUrl: String(p.baseUrl ?? ""),
      apiKey: p.apiKey == null ? "" : String(p.apiKey),
      wireApi: p.wireApi === "chat" ? "chat" : "responses",
      model: p.model == null ? "gpt-6-astra" : String(p.model),
      // 托管鉴权档案（本地代理代持鉴权）必须把这两个字段带上：
      // 丢了它们，重新保存一次就会变成"需要 env_key"的直连档案，鉴权随之失效
      managedAuth: p.managedAuth === true,
      experimentalBearerToken:
        p.experimentalBearerToken == null ? undefined : String(p.experimentalBearerToken),
      contextWindow: p.contextWindow == null ? null : Number(p.contextWindow) || null,
      reasoningEffort: p.reasoningEffort == null ? null : String(p.reasoningEffort) || null,
    });
    // 这份档案正被使用中的环境引用时，config.toml 已被改写：重启内核才会生效
    const active = envMgr.activeEnv();
    if (active && active.mode === "relay" && active.relayId === relay.id) await restartServer();
    return relay;
  },
);

ipcMain.handle("relay:delete", (_e, id: unknown) => {
  envMgr.deleteRelay(String(id));
  return { ok: true };
});

ipcMain.handle("env:import-local-config", () => envMgr.importLocalCodexConfig());

ipcMain.handle(
  "relay:test",
  async (_e, p: { baseUrl?: unknown; apiKey?: unknown; relayId?: unknown }) => {
    // 编辑既有档案时没重填密钥，就用档案里已存的那把去测（resolveRelayKey 内处理）
    return testRelayConnection(String(p?.baseUrl ?? ""), resolveRelayKey(p).apiKey);
  },
);

/** /models 返回的一条模型：能认出来的元数据都带上，认不出就只留 id */
export interface RelayModelEntry {
  id: string;
  label?: string;
  /** 服务端自报的上下文窗口（OpenRouter 这类会带，普通网关不会） */
  contextWindow?: number;
  maxOutput?: number;
  supportsReasoning?: boolean;
}

export interface RelayModelsResult {
  ok: boolean;
  status?: number;
  /** 响应体是否解析成了模型数组：false 时别把 models:[] 当成"0 个模型" */
  parsed: boolean;
  models: RelayModelEntry[];
  message?: string;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
}

/** 各家 /models 的字段名五花八门，统一抹平成 { id, contextWindow, ... } */
function normalizeModelEntries(raw: unknown): RelayModelEntry[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["data", "models", "result", "items"]) {
      if (Array.isArray(o[key])) {
        list = o[key] as unknown[];
        break;
      }
    }
  }
  const out: RelayModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    let id: string | undefined;
    let rec: Record<string, unknown> = {};
    if (typeof item === "string") id = item;
    else if (item && typeof item === "object") {
      rec = item as Record<string, unknown>;
      for (const key of ["id", "model", "slug", "name"]) {
        const v = rec[key];
        if (typeof v === "string" && v.trim()) {
          id = v.trim();
          break;
        }
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const top = (rec.top_provider ?? {}) as Record<string, unknown>;
    const params = Array.isArray(rec.supported_parameters) ? (rec.supported_parameters as unknown[]) : [];
    const entry: RelayModelEntry = { id };
    const displayName = rec.display_name ?? rec.name;
    if (typeof displayName === "string" && displayName.trim() && displayName.trim() !== id) {
      entry.label = displayName.trim();
    }
    const ctx = pickNumber(rec, ["context_window", "context_length", "max_context_window", "max_model_len", "max_input_tokens"]);
    if (ctx) entry.contextWindow = ctx;
    const maxOut = pickNumber(rec, ["max_completion_tokens", "max_output_tokens", "max_tokens"]) ?? pickNumber(top, ["max_completion_tokens", "context_length"]);
    if (maxOut) entry.maxOutput = maxOut;
    if (
      params.some((p) => typeof p === "string" && p.includes("reasoning")) ||
      rec.supports_reasoning === true ||
      rec.reasoning === true
    ) {
      entry.supportsReasoning = true;
    }
    out.push(entry);
    if (out.length >= 2000) break;
  }
  return out;
}

/** OpenAI 兼容接口探测：GET {baseUrl}/models（只读，不落盘任何数据） */
async function fetchRelayModels(baseUrl: string, apiKey: string): Promise<RelayModelsResult> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("接口地址必须以 http(s):// 开头");
  const url = /\/models$/i.test(base) ? base : `${base}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    let models: RelayModelEntry[] = [];
    let parsed = false;
    try {
      models = normalizeModelEntries(JSON.parse(text));
      parsed = true;
    } catch {
      /* 非 JSON 响应：只按状态码判断 */
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        parsed,
        models,
        message: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      };
    }
    return { ok: true, status: res.status, parsed, models };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      parsed: false,
      models: [],
      message: aborted ? "请求超时（12 秒）" : String(error).replace(/^Error:\s*/, ""),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testRelayConnection(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; status?: number; models?: number; message?: string }> {
  const r = await fetchRelayModels(baseUrl, apiKey);
  return {
    ok: r.ok,
    status: r.status,
    models: r.parsed ? r.models.length : undefined,
    message: r.message,
  };
}

/** 探活 / 拉列表共用的密钥解析：表单没填就退回已保存档案里的那把 */
function resolveRelayKey(p: { apiKey?: unknown; relayId?: unknown } | undefined): { apiKey: string; relayId: string } {
  let apiKey = p?.apiKey == null ? "" : String(p.apiKey).trim();
  const relayId = p?.relayId == null ? "" : String(p.relayId);
  if (!apiKey && relayId) {
    apiKey = envMgr.list().relays.find((r) => r.id === relayId)?.apiKey ?? "";
  }
  return { apiKey, relayId };
}

ipcMain.handle(
  "relay:models",
  async (_e, p: { baseUrl?: unknown; apiKey?: unknown; relayId?: unknown }) => {
    const { apiKey } = resolveRelayKey(p);
    return fetchRelayModels(String(p?.baseUrl ?? ""), apiKey);
  },
);

ipcMain.handle("env:import-auth", (_e, id: unknown) => envMgr.importOfficialAuth(String(id)));

ipcMain.handle("env:import-sessions", async (_e, id: unknown) => {
  const result = await envMgr.importOfficialSessions(String(id));
  if (String(id) === envMgr.activeId()) await restartServer();
  return result;
});

ipcMain.handle("env:skills-share", (_e, p: { id: unknown; enabled: unknown }) =>
  envMgr.setSkillsShare(String(p.id), Boolean(p.enabled)),
);

// 新建窗口：多窗口共享同一 app-server 与数据目录（通知已按窗口广播）
ipcMain.handle("app:new-window", () => {
  createWindow();
  return { ok: true };
});

// 编辑菜单命令（撤销/重做/剪切/复制/粘贴/全选）：走 Chromium 原生编辑能力
const EDIT_COMMANDS = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
ipcMain.handle("app:edit-command", (_e, cmd: unknown) => {
  const name = String(cmd ?? "");
  if (!EDIT_COMMANDS.has(name)) throw new Error("不支持的编辑命令");
  const target = BrowserWindow.getFocusedWindow() ?? win;
  if (!target || target.isDestroyed()) return false;
  const wc = target.webContents;
  if (name === "undo") wc.undo();
  else if (name === "redo") wc.redo();
  else if (name === "cut") wc.cut();
  else if (name === "copy") wc.copy();
  else if (name === "paste") wc.paste();
  else wc.selectAll();
  return true;
});

ipcMain.handle("app:pick-folder", async () => {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  if (!target) return null;
  const result = await dialog.showOpenDialog(target, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("customize:list-skills", () => {
  const env = envMgr.activeEnv();
  const dir = path.join(env.codexHome, "skills");
  const out: { name: string; desc: string }[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const md = path.join(dir, e.name, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      const text = fs.readFileSync(md, "utf-8");
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? e.name;
      const desc = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
      out.push({ name, desc });
    }
  } catch {
    /* skills 目录不存在时返回空 */
  }
  return out;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.stop();
  stopRelayCompatServer();
});
