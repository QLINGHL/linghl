// 统计官方 bundle 中实际使用的语义工具类（text-*/bg-*/border-* 非标准色名）
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "..", "..", "_research", "asar-out", "webview", "assets", "app-initial-ff48311587c5.js"), "utf-8");

// 只匹配反引号 class 字符串，避免误伤
const counts = new Map();
const re = /`([^`]{0,400})`/g;
let m;
while ((m = re.exec(src))) {
  const s = m[1];
  if (!/\b(?:flex|grid|items-|justify-|absolute|relative|rounded|text-\[|bg-\[)/.test(s)) continue;
  if (/[{}]|\$\{/.test(s)) continue;
  for (const tok of s.split(/\s+/)) {
    if (/^(?:text|bg|border|ring|fill|stroke|divide|placeholder|outline|decoration|shadow)-(?:primary|secondary|tertiary|surface|subtle|emphasis|inverse|danger|caution|success|info|discovery|warning|disabled|tooltip|prose|token)[a-zA-Z0-9-]*$/.test(tok)) {
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log("semantic color classes used:", sorted.length);
for (const [k, v] of sorted.slice(0, 120)) console.log(String(v).padStart(5), k);
fs.writeFileSync(path.join(__dirname, "..", "..", "_research", "official-semantic-classes.json"), JSON.stringify(Object.fromEntries(sorted), null, 1));
