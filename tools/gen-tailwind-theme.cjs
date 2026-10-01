// 从官方主题 CSS 提取全部主题令牌，生成 Tailwind v4 @theme inline 映射
const fs = require("node:fs");
const path = require("node:path");

const themeFile = path.join(__dirname, "..", "src", "renderer", "src", "official-theme.css");
const css = fs.readFileSync(themeFile, "utf-8");

function collect(prefix) {
  const names = new Set();
  const re = new RegExp(`(${prefix}[a-zA-Z0-9-]*)\\s*:`, "g");
  let m;
  while ((m = re.exec(css))) names.add(m[1]);
  return [...names].sort();
}

const groups = {
  color: collect("--color-"),
  radius: collect("--radius-"),
  shadow: collect("--shadow-"),
  font: collect("--font-"),
  text: collect("--text-"),
  spacing: collect("--spacing"),
  ease: collect("--ease-"),
  animate: collect("--animate-"),
  blur: collect("--blur-"),
  leading: collect("--leading-"),
  tracking: collect("--tracking-"),
  breakpoint: collect("--breakpoint-"),
  container: collect("--container-"),
};

for (const [k, v] of Object.entries(groups)) console.log(k, v.length);

let block = "/* Tailwind v4 主题映射：官方语义令牌 → text-*/bg-*/border-*/rounded-*/shadow-* 等工具类（与官方一致） */\n@theme inline {\n";
for (const [k, names] of Object.entries(groups)) {
  if (!names.length) continue;
  block += `  /* ${k} */\n`;
  block += names.map((n) => `  ${n}: var(${n});`).join("\n") + "\n";
}
block += "}\n";

// 官方默认字号/行高变量可能定义在 CSS 里但 Tailwind 需要 text-xs 等标准名
const outFile = path.join(__dirname, "..", "src", "renderer", "src", "tailwind-official-theme.css");
fs.writeFileSync(outFile, block, "utf-8");
console.log("written:", outFile, block.length, "bytes");
