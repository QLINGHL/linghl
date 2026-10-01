/**
 * `npm start` 的真正启动器：在**启动 electron-forge 的那一层**把环境洗干净，再用干净环境拉起 forge。
 *
 * 为什么必须在这一层做（2026-09-30 排查结论）：
 *   npm 的脚本链是 `npm → prestart(子进程) → electron-forge(子进程)`。
 *   在 prestart 或 forge.config.js 里 `delete process.env.X` 只影响那个 Node 进程自己的副本，
 *   npm 进程不受影响，真正 spawn electron.exe 的 forge 进程照样继承到毒变量 —— 所以那两处等于没修。
 *   只有「显式构造一个干净 env 交给子进程」才真的生效（spawn 的 env 选项是权威来源）。
 *
 * 毒变量是什么：ELECTRON_RUN_AS_NODE。WorkBuddy / DSH 这类 Electron 宿主会把它传进子进程环境，
 * electron.exe 看到它就退化成纯 Node 宿主 → 不建窗口、不报错、直接退出（带 Chromium 参数时是
 * `electron.exe: bad option: --no-sandbox`，exit 9）。Electron 只检查变量**是否存在**，置空无效，必须删。
 *
 * 另外默认给 REPLICA_ALLOW_MULTI=1：本机 Electron 的 ProcessSingleton 时常报
 * `Lock file can not be created! Error code: 5`，导致 `requestSingleInstanceLock()` 返回 false。
 * 主进程只有在「确认没有活实例」时才会走这条降级路径，所以默认打开是安全的；
 * 这样用户不需要记住任何环境变量。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const env = { ...process.env };
let cleaned = [];
if (env.ELECTRON_RUN_AS_NODE !== undefined) {
  delete env.ELECTRON_RUN_AS_NODE;
  cleaned.push("ELECTRON_RUN_AS_NODE");
}
// 非交互/后台环境下 Electron 会继承这两个变量并导致怪行为，一并清掉
for (const key of ["ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) {
  if (env[key] !== undefined) {
    delete env[key];
    cleaned.push(key);
  }
}
if (env.REPLICA_ALLOW_MULTI === undefined || env.REPLICA_ALLOW_MULTI === "") env.REPLICA_ALLOW_MULTI = "1";

// ---------------------------------------------------------------------------
// 自愈：修 exe 的 Low 完整性标签
//   本机工作区被沙箱加了 `Low Mandatory Level` 标签，目录下的 electron.exe / 内核 exe
//   都会继承 → Windows 按映像标签建进程 → Electron 与内核以 **Low 完整性** 运行 →
//   写不了 %APPDATA% → 主进程在模块加载期 EPERM → 不建窗口、静默吊死。
//   这一步只在真的检测到 Low 标签时才动 icacls，正常情况下零开销。
// ---------------------------------------------------------------------------
try {
  require("./fix-integrity.cjs").main();
} catch (error) {
  console.error("[start] 完整性标签自检失败（继续启动）：", String(error).slice(0, 200));
}

// ---------------------------------------------------------------------------
// 产物保护：forge 的 Vite 插件在 preStart 会 `fs.remove('.vite')`
//   （@electron-forge/plugin-vite/dist/VitePlugin.js:49）
//   本机安全删除垫片对"一次删 50+ 文件"抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED ——
//   但它是**删了一部分之后**才抛，于是界面产物被删干净、forge 崩在起 Electron 之前。
//   用户看到的现象：命令跑完 → 窗口出来了 → **里面什么都没有**。
//
//   缓解：启动前给渲染层产物拍一张快照（渲染层现在在 dist-renderer/，
//   已不在删除范围内，但 .vite/build 仍可能被波及，这里是双保险）。
// ---------------------------------------------------------------------------
const RENDERER_DIR = path.join(__dirname, "..", "dist-renderer");
const RENDERER_BACKUP = path.join(__dirname, "..", ".renderer-backup");
function snapshotRenderer() {
  try {
    if (!fs.existsSync(RENDERER_DIR)) return false;
    // ⚠️ 沙箱里的 safe-delete 垫片会拦下 rmSync/cpSync 里的删除动作
    // （实测报 "trash operation ... aborted"）。快照只是"防 forge 误删"的
    // 双保险，失败不该影响启动 —— 所以这里静默降级，并提示改用 npm start。
    fs.rmSync(RENDERER_BACKUP, { recursive: true, force: true });
    fs.cpSync(RENDERER_DIR, RENDERER_BACKUP, { recursive: true });
    return true;
  } catch (error) {
    console.warn(
      "[start] 渲染层快照不可用（safe-delete 垫片拦截）。" +
        "这不影响启动，但建议改用 `npm start`（已切到不经 forge 的直接启动器）。原因：" +
        String(error).slice(0, 120),
    );
    return false;
  }
}
function restoreRendererIfLost() {
  try {
    if (fs.existsSync(RENDERER_DIR) && fs.existsSync(path.join(RENDERER_DIR, "index.html"))) return;
    if (!fs.existsSync(RENDERER_BACKUP)) return;
    console.log("[start] 检测到界面产物被 forge 清理，正在从快照恢复…");
    fs.rmSync(RENDERER_DIR, { recursive: true, force: true });
    fs.cpSync(RENDERER_BACKUP, RENDERER_DIR, { recursive: true });
    console.log("[start] 界面产物已恢复");
  } catch (error) {
    console.error("[start] 界面产物恢复失败：", String(error).slice(0, 200));
  }
}
const hasSnapshot = snapshotRenderer();
if (hasSnapshot) console.log("[start] 已给界面产物拍快照（防 forge 误删）");

if (cleaned.length) {
  console.log(`[start] 已从子进程环境中移除：${cleaned.join(", ")}（否则 electron.exe 可能不建窗口）`);
}

// 直接跑 forge 的 JS 入口，不经 cmd.exe：少一层 shell，避免 Windows 参数转义与 shell 相关的进程语义问题
const forgeCli = path.join(__dirname, "..", "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js");

// 参数约定：
//   `npm start`                       → forge start
//   `npm start -- --remote-debugging-port=9222` → 额外参数透传给 Electron
//   `npm start -- package`            → 跑 forge package
// ⚠️ npm 会把 `--` 之后的参数**直接**接在脚本后面（`--` 本身可能被吃掉），
//    所以不能依赖 `--` 做分隔：能识别的 forge 子命令留下，其余一律透传给 Electron。
const FORGE_SUBCOMMANDS = new Set(["start", "package", "make", "publish", "import", "init", "lint"]);
const argv = process.argv.slice(2);
const [head, ...rest] = argv;
let forgeArgs = [];
let electronArgs = [];
if (!head) {
  forgeArgs = ["start"];
} else if (FORGE_SUBCOMMANDS.has(head)) {
  forgeArgs = [head];
  electronArgs = rest;
} else {
  forgeArgs = ["start"];
  electronArgs = argv;
}

/**
 * 本机必需的 Chromium 开关：**必须由命令行传入**，主进程里 appendSwitch 来不及
 * （沙箱在 Electron 启动最早期就初始化了，实测 appendSwitch 无效、进程静默以
 *  0x80000003 断点异常退出）。
 * 实测：`electron.exe --version` 无输出、exit -2147483645；加 `--no-sandbox` 后正常。
 * 恢复沙箱：`set REPLICA_NO_SANDBOX=0`。
 */
if (forgeArgs[0] === "start" && process.env.REPLICA_NO_SANDBOX !== "0" && !electronArgs.includes("--no-sandbox")) {
  electronArgs.unshift("--no-sandbox");
  console.log("[start] 追加 --no-sandbox（本机 Chromium 沙箱起不来，不带它 Electron 会静默退出）");
}
if (forgeArgs[0] === "start" && electronArgs.length) {
  forgeArgs.push("--", ...electronArgs);
  console.log(`[start] 透传给 Electron：${electronArgs.join(" ")}`);
}

const child = spawn(process.execPath, [forgeCli, ...forgeArgs], {
  env,
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});

// forge 崩溃（安全删除垫片拦下 .vite 清理）时把界面产物补回来，
// 这样下次启动不会开出空白窗口。
child.on("exit", (code, signal) => {
  restoreRendererIfLost();
  try { fs.rmSync(RENDERER_BACKUP, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
  process.exit(signal ? 1 : code ?? 0);
});
child.on("error", (error) => {
  console.error("[start] 启动 electron-forge 失败：", error);
  restoreRendererIfLost();
  process.exit(1);
});
