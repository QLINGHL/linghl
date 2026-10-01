// 从官方 app-shared CSS 中提取全部主题变量规则（只保留纯自定义属性定义块）
const fs = require("node:fs");
const path = require("node:path");

const cssFile = path.join(__dirname, "..", "..", "_research", "asar-out", "webview", "assets", "app-shared-fa3f1d5d5942.css");
const css = fs.readFileSync(cssFile, "utf-8");

function extractAt(i) {
  const j = css.indexOf("{", i);
  if (j < 0) return null;
  let depth = 0;
  for (let k = j; k < css.length; k++) {
    if (css[k] === "{") depth++;
    else if (css[k] === "}") {
      depth--;
      if (depth === 0) return { text: css.slice(i, k + 1), body: css.slice(j + 1, k) };
    }
  }
  return null;
}

// 判断规则体是否只包含自定义属性声明 / color-scheme
function isVarOnly(body) {
  const decls = body.split(";").map((s) => s.trim()).filter(Boolean);
  if (!decls.length) return false;
  return decls.every((d) => /^--[a-zA-Z0-9-]+\s*:/.test(d) || /^color-scheme\s*:/.test(d));
}

// 排除 Tailwind 工具类变量与带伪类/复杂选择器的规则
function isClean(ruleText) {
  const sel = ruleText.slice(0, ruleText.indexOf("{"));
  if (/:is\(|:focus|:hover|:enabled|:disabled|:active|~|\+|>/.test(sel)) return false;
  const body = ruleText.slice(ruleText.indexOf("{") + 1, ruleText.lastIndexOf("}"));
  const decls = body.split(";").map((s) => s.trim()).filter(Boolean);
  return !decls.every((d) => /^--tw-/.test(d));
}

const rules = [];
const seen = new Set();
const markers = [
  ":where([data-theme=light])",
  ":where([data-theme=dark])",
  ":where(:root),:where([data-theme])",
  ":root{",
  ":root[data-theme=dark]",
  ":root[data-theme=light]",
];

for (const m of markers) {
  let idx = 0;
  while ((idx = css.indexOf(m, idx)) >= 0) {
    const r = extractAt(idx);
    if (r && isVarOnly(r.body) && isClean(r.text) && !seen.has(r.text)) {
      seen.add(r.text);
      rules.push(r.text);
    }
    idx += m.length;
  }
}

// 按“基础色板 → 语义色 → 阴影/圆角/其他”排序输出，保证覆盖顺序合理
const header = "/* ============================================================================\n * 官方 Codex 桌面版主题变量 — 原样提取自 app-shared-fa3f1d5d5942.css\n * 明暗机制：lightningcss 的 --lightningcss-light/dark 开关（见文件末尾注释）\n * ========================================================================== */\n\n";
let out = header + rules.join("\n\n");

// 字体与文本变量（官方 @theme 里的 --font-* / --text-*）
const fontVars = [...new Set([...css.matchAll(/(--font[a-zA-Z0-9-]*:[^;}]+)/g)].map((m) => m[1].trim()))];
if (fontVars.length) out += "\n\n/* 字体变量 */\n:root{\n" + fontVars.join(";\n") + ";\n}\n";

// 附加：高 DPI 下的 hairline .5px（官方包在 @media (resolution>=150dpi) 内）
out += "\n/* 高 DPI 发丝线（官方 @media (resolution>=150dpi)） */\n@media (resolution >= 150dpi), (resolution >= 1.5x) {\n  :where(:root), :where([data-theme]) { --hairline: .5px; }\n}\n";

const outFile = path.join(__dirname, "..", "src", "renderer", "src", "official-theme.css");
fs.writeFileSync(outFile, out, "utf-8");
console.log("rules:", rules.length, "bytes:", out.length, "fontVars:", fontVars.length);
for (const r of rules) console.log(" -", r.slice(0, 64).replace(/\s+/g, " "), `(${r.length})`);
