/**
 * playwright 解析器（本仓库所有浏览器验收脚本共用）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────
 * 这些脚本原本各自硬编码了**作者本机某个全局安装的绝对路径**，例如：
 *     const pw = await import("file:///C:/Users/<user>/.workbuddy/.../playwright/index.js");
 * 两个问题：
 *   ① 别人 clone 下来根本跑不了（路径不存在，而且 playwright 没写进依赖）；
 *   ② 把作者本机的目录结构写进了公开仓库。
 *
 * ── 解析顺序 ──────────────────────────────────────────────────────────────
 *   ① `PLAYWRIGHT_MODULE` 环境变量（CI / 特殊环境的后门）
 *   ② 常规依赖解析 `playwright` / `playwright-core`
 *   ③ `tools/.playwright-path.local`（**已 gitignore**，放一行绝对路径即可）
 *      —— 给"playwright 装在别处、又不想污染仓库"的场景用
 *   ④ 常见 npm 全局目录
 *
 * 全都找不到时，报一条**能直接照做**的错误，而不是一个看不懂的 ERR_MODULE_NOT_FOUND。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *     const pw = await import("./playwright-loader.mjs");
 *     const chromium = (pw.default ?? pw).chromium;
 *   （默认导出就是 playwright 模块，`(pw.default ?? pw)` 两种取法都兼容）
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 本机专用覆盖文件（已 gitignore）：内容为一行 playwright 的绝对路径或模块名 */
const LOCAL_OVERRIDE = path.join(HERE, ".playwright-path.local");

function localOverride() {
  try {
    const raw = fs.readFileSync(LOCAL_OVERRIDE, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** npm 全局 node_modules 目录（拿不到就返回空数组，不抛） */
function globalRoots() {
  const out = [];
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) out.push(path.join(root, "playwright"), path.join(root, "playwright-core"));
  } catch {
    /* 没有 npm 或超时：跳过 */
  }
  // Windows 上常见的手动安装位置
  if (process.env.APPDATA) {
    out.push(path.join(process.env.APPDATA, "npm", "node_modules", "playwright"));
  }
  return out;
}

function candidates() {
  const list = [];
  if (process.env.PLAYWRIGHT_MODULE) list.push(process.env.PLAYWRIGHT_MODULE);
  list.push("playwright", "playwright-core");
  const local = localOverride();
  if (local) list.push(local);
  list.push(...globalRoots());
  return list;
}

function load() {
  const tried = [];
  for (const spec of candidates()) {
    tried.push(spec);
    try {
      // 绝对路径 / file:// 用 file URL 走 require；裸模块名直接 require（同步、能走 CJS 解析）
      if (spec.startsWith("file:") || path.isAbsolute(spec)) {
        const filePath = spec.startsWith("file:") ? fileURLToPath(spec) : spec;
        return require(filePath);
      }
      return require(spec);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    [
      "找不到 playwright —— 浏览器验收脚本需要它。",
      "",
      "解决办法（任选其一）：",
      "  1) 在本仓库安装：  npm i -D playwright",
      "  2) 用已有的安装：  set PLAYWRIGHT_MODULE=<playwright 的绝对路径>",
      "  3) 写进本机覆盖文件（已 gitignore，不影响他人）：",
      `     echo <playwright 的绝对路径> > ${path.relative(process.cwd(), LOCAL_OVERRIDE)}`,
      "",
      `已尝试：${tried.join(" , ")}`,
    ].join("\n"),
  );
}

const playwright = load();
export default playwright;
