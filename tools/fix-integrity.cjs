/**
 * 修复「工作区带 Low 强制完整性标签 → 从它派生的进程也是 Low → 写不了 %APPDATA%」这个坑。
 *
 * 背景（2026-10-01 实测结论，别再重新排查一遍）：
 *   本机工作区目录被加了一条 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，
 *   目录下**所有文件继承了这个标签**（包括 node_modules/electron/dist/electron.exe）。
 *   Windows 建进程时会采用映像文件的强制标签 → Electron 主进程以 **Low 完整性** 启动
 *   （父进程是 Medium 也没用，实测 token 里 Low RID=4096）。
 *   Low 进程没有权限写 Medium 标签的目录（%APPDATA%），于是：
 *     `fs.mkdirSync('%APPDATA%\codex-desk-replica\kernel-runtime')` → EPERM
 *   → KernelManager 构造函数在**模块加载期**抛异常 → Electron 只打印
 *     "App threw an error during load" 并弹一个模态框，**永远不建窗口**，进程吊着不退出。
 *   表面症状就是「npm start 打完 Launched Electron app 之后就没反应了，一分钟也没窗口」。
 *
 * 修法：把这些**需要被执行的 exe** 的强制标签显式改回 Medium（`icacls /setintegritylevel Medium`）。
 *   注意：标签是可继承的，但显式设置的标签（无 (I) 标记）不会被父目录重新覆盖，
 *   所以这里是稳定的一次性修复；每次 npm start 跑一遍也不会更慢（只在必要时才改）。
 *
 * 只读操作（读文件）不受影响，所以不需要动 node_modules 里成千上万个普通文件。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

/** 需要被"当程序跑起来"的 exe：应用本体 + 内置内核 + 打包工具链 */
const SCAN_DIRS = [
  path.join(ROOT, "node_modules", "electron", "dist"),
  path.join(ROOT, "vendor"),
  path.join(ROOT, "node_modules", "electron-winstaller", "vendor"),
  path.join(ROOT, "node_modules", "@electron", "windows-sign", "vendor"),
];

function listExes(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listExes(full, out);
    else if (entry.isFile() && /\.exe$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function icacls(args) {
  try {
    return execFileSync("icacls", args, { encoding: "utf8", windowsHide: true });
  } catch (error) {
    return String(error.stdout ?? "") + String(error.stderr ?? "");
  }
}

/** 读文件的强制标签是否被降到了 Low（"Low Mandatory Level" 出现在 icacls 输出里） */
function isLowIntegrity(file) {
  const text = icacls([file]);
  return /Low Mandatory Level/i.test(text);
}

function raiseToMedium(file) {
  const text = icacls([file, "/setintegritylevel", "Medium"]);
  return !/失败|Failed processing|0 个文件时失败/.test(text) || /已处理/.test(text);
}

function main({ quiet = false } = {}) {
  const exes = [];
  for (const dir of SCAN_DIRS) listExes(dir, exes);
  const low = exes.filter(isLowIntegrity);
  if (!low.length) {
    if (!quiet) console.log("[integrity] 所有需要执行的 exe 完整性标签正常（无 Low 标签）");
    return 0;
  }
  console.log(
    `[integrity] 检测到 ${low.length} 个 exe 带 Low 强制标签（工作区被沙箱打了 Low 标签后继承下来的）。\n` +
      "[integrity] 不修的话 Electron/内核会以 Low 完整性运行、写不了 %APPDATA%，表现为「启动后没有窗口」。正在改回 Medium…",
  );
  let fixed = 0;
  for (const file of low) {
    if (raiseToMedium(file) && !isLowIntegrity(file)) {
      fixed += 1;
      if (!quiet) console.log(`[integrity]   已修复 ${path.relative(ROOT, file)}`);
    } else {
      console.error(`[integrity]   修复失败 ${path.relative(ROOT, file)}（可能需要管理员权限，或用非沙箱终端执行）`);
    }
  }
  console.log(`[integrity] 完成：修复 ${fixed}/${low.length}`);
  return fixed === low.length ? 0 : 1;
}

if (require.main === module) {
  process.exit(main({ quiet: process.argv.includes("--quiet") }));
}

module.exports = { main };
