// 从官方 bundle 提取所有 className 中使用到的工具类 token，按颜色/语义类归类
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "_research", "asar-out", "webview", "assets", "app-initial-ff48311587c5.js");
const src = fs.readFileSync(file, "utf-8");

// 提取反引号字符串中的 class 列表（官方 JSX className 用反引号模板）
const classStrings = new Set();
const re = /className\s*:\s*`([^`]*)`/g;
let m;
while ((m = re.exec(src))) classStrings.add(m[1]);
const re2 = /className\s*=\s*"([^"]*)"/g;
while ((m = re2.exec(src))) classStrings.add(m[1]);

// 也提取所有反引号字符串里看起来像 class 列表的（含空格分隔的已知工具类模式）
const re3 = /`((?:[a-z0-9\[\]\/\-_.%:#\(\)&,>~*="' ]+?\s)+[a-z0-9\[\]\/\-_.%:#\(\)&,>~*="' ]+)`/g;
while ((m = re3.exec(src))) {
  const s = m[1];
  if (/\b(?:flex|grid|items-center|justify-|text-|bg-|border|rounded|p[xyltrb]?-|m[xyltrb]?-|gap-|w-|h-|absolute|relative|hidden|block|inline)/.test(s)) {
    classStrings.add(s);
  }
}

const all = new Set();
for (const cs of classStrings) {
  for (const tok of cs.split(/\s+/)) {
    if (tok && !tok.includes("${") && tok.length < 60) all.add(tok);
  }
}

const sorted = [...all].sort();
const colorish = sorted.filter((t) => /^(?:text|bg|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-/.test(t));

const out = {
  total: sorted.length,
  colorish,
  sample: sorted.slice(0, 3000),
};
fs.writeFileSync(path.join(__dirname, "..", "..", "_research", "official-classes.json"), JSON.stringify(out, null, 1), "utf-8");
console.log("total class tokens:", sorted.length);
console.log("colorish:", colorish.length);
console.log(colorish.slice(0, 150).join(" "));
