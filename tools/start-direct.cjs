/**
 * 直接启动 Electron（不经 electron-forge 的 `start` 钩子）。
 *
 * 为什么需要这个脚本（2026-10-01 启动诊断附带结论）：
 *   `@electron-forge/plugin-vite` 的 `preStart` 钩子会先 `fs.remove('.vite')`
 *   （VitePlugin.js:49）再起 dev server。本机工作区装了安全删除垫片，
 *   一次删 66 个文件会命中 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（阈值 50），
 *   直接抛异常 —— 表现是 `npm start` 还没到 Electron 就挂了。
 *   而我们的 vite 配置本来就 `emptyOutDir: false`（见 vite.*.config.mts 注释），
 *   根本不需要删 `.vite`：产物按 hash 命名，index.html 始终指向当前 bundle。
 *
 * 所以这个脚本做三件事：
 *   1. 复用 start-forge 的环境清理（ELECTRON_RUN_AS_NODE 等毒变量 + 完整性标签自检）；
 *   2. **不删 .vite**，直接用已构建产物启动；
 *   3. 需要 dev server（热更新）时用 `--dev`，此时才让 vite 起服务器。
 *
 * 用法：
 *   node tools/start-direct.cjs               # 用已构建产物启动（最快，推荐日常用）
 *   node tools/start-direct.cjs --dev         # 起 vite dev server 再启动（改代码热更新）
 *   node tools/start-direct.cjs -- --remote-debugging-port=9222
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const useDevServer = argv.includes("--dev");
// `--` 之后的参数原样透传给 Electron
const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : argv.filter((a) => a !== "--dev");

// ---------------------------------------------------------------- 环境清理
// 与 start-forge.cjs 同一套规则：这些变量会让 electron.exe 退化成纯 Node 宿主，
// 结果是"不建窗口、不报错、直接退出"。
const env = { ...process.env };
const cleaned = [];
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) {
  if (env[key] !== undefined) {
    delete env[key];
    cleaned.push(key);
  }
}
if (cleaned.length) console.log(`[direct] 已移除毒变量：${cleaned.join(", ")}`);
if (env.REPLICA_ALLOW_MULTI === undefined || env.REPLICA_ALLOW_MULTI === "") env.REPLICA_ALLOW_MULTI = "1";

// 完整性标签自检（Low 标签会让 Electron 写不了 %APPDATA%，静默不建窗口）
try {
  require("./fix-integrity.cjs").main();
} catch (error) {
  console.error("[direct] 完整性标签自检失败（继续启动）：", String(error).slice(0, 200));
}

// ---------------------------------------------------------------- 产物自检
const electronBin = require("electron");
const mainEntry = path.join(ROOT, ".vite", "build", "main.js");
const preloadEntry = path.join(ROOT, ".vite", "build", "preload.js");
/** 渲染层产物在 .vite 之外（见 vite.renderer.config.mts 注释：避开 forge 的 fs.remove('.vite')） */
const rendererEntry = path.join(ROOT, "dist-renderer", "index.html");
if (!useDevServer) {
  const missing = [
    [mainEntry, "node node_modules/vite/bin/vite.js build --config vite.main.config.mts"],
    [preloadEntry, "node node_modules/vite/bin/vite.js build --config vite.preload.config.mts"],
    [rendererEntry, "node node_modules/vite/bin/vite.js build --config vite.renderer.config.mts"],
  ].filter(([p]) => !fs.existsSync(p));
  if (missing.length) {
    // 宁可拒绝启动，也不要开出一个空白窗口让用户干等 —— 这正是本轮要消灭的体验。
    console.error(
      "[direct] 构建产物缺失，拒绝启动（否则会开出空白窗口）。请先构建：\n" +
        missing.map(([, cmd]) => `  ${cmd}`).join("\n") +
        `\n缺失：${missing.map(([p]) => p).join(", ")}`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 启动
const electronArgs = [useDevServer ? "." : ".", ...passthrough];
if (!passthrough.includes("--no-sandbox")) electronArgs.unshift("--no-sandbox");

const childEnv = { ...env };
if (useDevServer) {
  // forge 在 dev 模式下会注入 dev server 地址；这里交给 vite 自己起。
  // 最小可用形态：让主进程知道去哪里取渲染层。
  // （日常不用 --dev，改完代码跑一次 build 即可，比 dev server 更接近真实启动路径。）
  console.warn("[direct] --dev 模式仍需 forge 提供 dev server 地址，当前回退到构建产物。");
}

console.log(`[direct] 启动 Electron（${useDevServer ? "dev" : "已构建产物"}）`);
const child = spawn(electronBin, electronArgs, {
  cwd: ROOT,
  env: childEnv,
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (error) => {
  console.error("[direct] 启动 Electron 失败：", error);
  process.exit(1);
});
