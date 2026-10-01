// 从官方 zh-CN bundle 中提取完整 i18n 目录（key -> 中文文案）
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "..", "_research", "asar-out", "webview", "assets", "zh-CN-1adc76a05252.js");
const src = fs.readFileSync(file, "utf-8");

// 匹配 "some.key":`value` 或 "some.key":"value"
const re = /"([a-zA-Z0-9_.\-]+)"\s*:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;
const dict = {};
let m;
while ((m = re.exec(src))) {
  const key = m[1];
  let val = m[2];
  if (val.startsWith("`")) {
    val = val.slice(1, -1).replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
  } else {
    val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (!(key in dict)) dict[key] = val;
}

const out = path.join(__dirname, "..", "..", "_research", "official-i18n-zh-CN.json");
fs.writeFileSync(out, JSON.stringify(dict, null, 1), "utf-8");
console.log("total keys:", Object.keys(dict).length);

// 打印 codex.* 与 home.* 相关 key
const interesting = Object.keys(dict).filter((k) => /^(codex|home|composer|thread|sidebar|approval|permission|model|settings|customize|schedule|task)/i.test(k));
console.log("interesting:", interesting.length);
const dump = path.join(__dirname, "..", "..", "_research", "official-i18n-codex-keys.json");
const sub = {};
for (const k of interesting.sort()) sub[k] = dict[k];
fs.writeFileSync(dump, JSON.stringify(sub, null, 1), "utf-8");
console.log("dumped:", dump);
