// 提取官方 @layer theme 块（Tailwind v4 主题配置：--color-*/--font-*/--radius-*/--text-* 映射）
const fs = require("node:fs");
const path = require("node:path");

const files = [
  "app-shared-fa3f1d5d5942.css",
  "app-initial-5ba553174940.css",
  "app-primary-75218b12d1d9.css",
].map((f) => path.join(__dirname, "..", "..", "_research", "asar-out", "webview", "assets", f));

const blocks = [];
for (const f of files) {
  const css = fs.readFileSync(f, "utf-8");
  let idx = 0;
  while ((idx = css.indexOf("@layer theme", idx)) >= 0) {
    // 找到 @layer theme{ ... } 的完整范围（@layer 后跟规则块）
    let j = idx + "@layer theme".length;
    while (j < css.length && /\s/.test(css[j])) j++;
    if (css[j] !== "{") {
      idx += 12;
      continue;
    }
    let depth = 0;
    let k = j;
    for (; k < css.length; k++) {
      if (css[k] === "{") depth++;
      else if (css[k] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(idx, k + 1));
    idx = k + 1;
  }
}

console.log("theme blocks found:", blocks.length, "total bytes:", blocks.reduce((a, b) => a + b.length, 0));
const out = blocks.join("\n\n");
const outFile = path.join(__dirname, "..", "src", "renderer", "src", "official-tailwind-theme.css");
fs.writeFileSync(outFile, out, "utf-8");
console.log("written:", outFile);

// 统计各命名空间变量数
for (const ns of ["--color-", "--font-", "--radius-", "--text-", "--shadow-", "--spacing", "--leading-", "--tracking-", "--font-weight-", "--ease-", "--animate-", "--blur-", "--breakpoint-", "--container-"]) {
  const n = (out.match(new RegExp(ns.replace(/[-]/g, "\\-") + "[a-zA-Z0-9-]*\\s*:", "g")) || []).length;
  console.log(" ", ns, n);
}
