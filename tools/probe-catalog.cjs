/**
 * 模型目录探针：摸清 `model_catalog_json` 的契约。
 *
 *   node tools/probe-catalog.cjs dump     # 导出内核内置目录（去重后落 tmp-catalog/bundled.json）
 *   node tools/probe-catalog.cjs required # 逐字段剔除，测出哪些字段是必填
 *   node tools/probe-catalog.cjs list     # 用自造目录起 app-server，看 model/list 里有没有我们的模型
 *
 * 结论（2026-09-28 实测，内核 0.158.0-alpha.9）：
 *   - model_catalog_json 是「整体替换」而不是合并：写了它就只剩文件里的模型
 *   - 路径写错/JSON 非法 → 内核报 Invalid configuration 并丢弃整份 config.toml（回退默认）
 *   - 所以要么别写这个键，要么保证文件永远合法
 *
 * 隔离性：全部在 <repo>/tmp-catalog/ 下的临时 CODEX_HOME 里跑，不碰 %APPDATA% 与 ~/.codex
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..");
const codex = path.join(repo, "vendor", "codex", "bin", "codex.exe");
const work = path.join(repo, "tmp-catalog");
const home = path.join(work, "home");
const catalogPath = path.join(work, "custom.json");
const toWin = (p) => p.split(path.sep).join("/");

const BASE_CONFIG = (catalogJsonPath) => `model = "deepseek-chat"
model_provider = "replica_relay"
${catalogJsonPath ? `model_catalog_json = "${catalogJsonPath}"\n` : ""}
[model_providers.replica_relay]
name = "Probe"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
env_key = "REPLICA_RELAY_API_KEY"
`;

function run(args, opts = {}) {
  return spawnSync(codex, args, {
    cwd: repo,
    env: { ...process.env, CODEX_HOME: home, ...(opts.env ?? {}) },
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
}

function writeCatalog(models) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({ models }, null, 2), "utf8");
  fs.writeFileSync(path.join(home, "config.toml"), BASE_CONFIG(toWin(catalogPath)), "utf8");
}

function parseCatalog(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function dump() {
  fs.mkdirSync(work, { recursive: true });
  const r = run(["debug", "models", "--bundled"]);
  const j = parseCatalog(r.stdout);
  if (!j) return console.log("dump 失败:", (r.stderr || "").slice(0, 300));
  fs.writeFileSync(path.join(work, "bundled.json"), JSON.stringify(j, null, 2), "utf8");
  console.log("内置模型:", j.models.map((m) => m.slug).join(", "));
  console.log("单条字段:", Object.keys(j.models[0]).join(", "));
  return j;
}

function required() {
  fs.mkdirSync(work, { recursive: true });
  const bundled = JSON.parse(fs.readFileSync(path.join(work, "bundled.json"), "utf8"));
  const template = JSON.parse(JSON.stringify(bundled.models[0]));
  template.slug = "probe-model";
  template.display_name = "Probe";
  const must = [];
  const optional = [];
  for (const field of Object.keys(template)) {
    const variant = JSON.parse(JSON.stringify(template));
    delete variant[field];
    writeCatalog([variant]);
    const r = run(["debug", "models"]);
    const j = parseCatalog(r.stdout);
    const ok = r.status === 0 && j && j.models.some((m) => m.slug === "probe-model");
    if (ok) optional.push(field);
    else must.push({ field, why: (r.stderr || "").split("\n")[0].slice(0, 120) });
  }
  console.log("必填字段 (" + must.length + "):");
  for (const m of must) console.log("  -", m.field, "→", m.why);
  console.log("可选字段 (" + optional.length + "):", optional.join(", "));
  return { must: must.map((m) => m.field), optional };
}

function minimal() {
  const bundled = JSON.parse(fs.readFileSync(path.join(work, "bundled.json"), "utf8"));
  const template = JSON.parse(JSON.stringify(bundled.models[0]));
  const { must } = JSON.parse(fs.readFileSync(path.join(work, "required.json"), "utf8"));
  // 只留必填，再把身份字段换成我们自己的
  const slim = {};
  for (const k of must) slim[k] = template[k];
  slim.slug = "deepseek-chat";
  slim.display_name = "DeepSeek Chat";
  slim.description = "第三方 OpenAI 兼容模型";
  slim.context_window = 131072;
  slim.max_context_window = 131072;
  writeCatalog([slim]);
  const r = run(["debug", "models"]);
  const j = parseCatalog(r.stdout);
  if (!j) return console.log("最小条目失败:", (r.stderr || "").slice(0, 300));
  console.log("最小条目可用，字段:", Object.keys(slim).join(", "));
  console.log("内核看到的:", JSON.stringify(j.models[0]).slice(0, 400));
}

function list() {
  const home2 = toWin(home);
  const child = spawn(codex, ["app-server"], {
    cwd: repo,
    env: { ...process.env, CODEX_HOME: home2 },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buf = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d.toString()));
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} }) + "\n");
      } else if (m.id === 2) {
        const rows = (m.result?.data ?? []).map((x) => ({
          id: x.id,
          n: x.displayName,
          eff: (x.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).join("/"),
          hidden: x.hidden,
        }));
        console.log("model/list 条目数:", rows.length);
        for (const r of rows) console.log("  ", r.id.padEnd(26), "hidden=" + r.hidden, "|", r.n, "|", r.eff);
        child.kill();
        console.log("stderr:", err.trim().slice(0, 300) || "(空)");
        process.exit(0);
      }
    }
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "Probe", version: "0.1.0" } } }) + "\n",
  );
  setTimeout(() => {
    child.kill();
    console.log("超时；stderr:", err.trim().slice(0, 300));
    process.exit(1);
  }, 15000);
}

const mode = process.argv[2] ?? "dump";
if (mode === "dump") dump();
else if (mode === "required") {
  const r = required();
  fs.writeFileSync(path.join(work, "required.json"), JSON.stringify(r, null, 2), "utf8");
} else if (mode === "minimal") minimal();
else if (mode === "list") list();
else console.log("用法: node tools/probe-catalog.cjs [dump|required|minimal|list]");
