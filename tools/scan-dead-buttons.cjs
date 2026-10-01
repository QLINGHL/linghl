/* 扫描渲染层里"没有 onClick 的 <button>"——死按钮是本类项目的通病 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "src", "renderer", "src");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
})(root);

const hits = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf-8");
  const re = /<button\b/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let end = -1;
    for (let j = m.index; j < src.length; j++) {
      const c = src[j];
      if (c === "{" || c === "(") depth++;
      else if (c === "}" || c === ")") depth--;
      else if (c === ">" && depth <= 0) { end = j; break; }
    }
    if (end < 0) continue;
    const tag = src.slice(m.index, end + 1);
    if (/\bonClick\b/.test(tag) || /\btype="submit"/.test(tag)) continue;
    // Radix 的 <X.Trigger asChild><button>：点击行为由 Trigger 接管，不是死按钮
    const before = src.slice(Math.max(0, m.index - 160), m.index);
    if (/\.Trigger\s+asChild\s*>\s*$/.test(before)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    hits.push(`${path.relative(root, f)}:${line}  ${tag.split(/\s+/).join(" ").slice(0, 120)}`);
  }
}
console.log(hits.length ? hits.join("\n") : "OK：没有缺少 onClick 的 button");
