/**
 * 一条命令自检：内核能不能起来。
 *
 * 用法（在项目根跑）：node tools/test-kernel.cjs
 * 它会：
 *   ① 列出探测到的所有内核（版本 + 来源）
 *   ② 用应用同样的方式（干净环境）逐个试 initialize，打印耗时
 *   ③ 打印当前环境的 CODEX_HOME 与相关数据目录
 * 结论怎么看：
 *   - 有任意一个 ✅ → 应用里应该没有那条红色横幅，发消息可用
 *   - 全部 ❌ → 把这里的输出整段发我（含每个内核的错误行）
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEEP = [
  "PATH", "PATHEXT", "ComSpec", "SystemRoot", "SystemDrive", "windir",
  "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
];
function cleanEnv(codeHome) {
  const env = {};
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.RUST_LOG = process.env.CODEX_RUST_LOG || "warn";
  env.CODEX_HOME = codeHome;
  return env;
}

const userData = path.join(process.env.APPDATA || "", "codex-desk-replica");
const reg = JSON.parse(fs.readFileSync(path.join(userData, "envs.json"), "utf-8"));
const active = reg.envs.find((e) => e.id === reg.activeId) || reg.envs[0];
console.log(`活动环境: ${active.id} (${active.name})\nCODEX_HOME: ${active.codexHome}\n`);

function versionOf(exe) {
  try {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const m = /codex-cli\s+([0-9][0-9A-Za-z.\-+]*)/.exec(r.stdout || "");
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const candidates = [];
const officialRoot = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
if (fs.existsSync(officialRoot)) {
  for (const name of fs.readdirSync(officialRoot)) {
    const exe = path.join(officialRoot, name, "codex.exe");
    if (fs.existsSync(exe)) candidates.push({ exe, source: "官方安装" });
  }
}
candidates.push({ exe: path.join(__dirname, "..", "vendor", "codex", "bin", "codex.exe"), source: "自带内核" });

console.log("探测到的内核：");
for (const c of candidates) c.version = versionOf(c.exe) || "?";
for (const c of candidates) console.log(`  ${c.version.padEnd(18)} ${c.source.padEnd(8)} ${c.exe}`);
console.log("\n逐个试 initialize（与应用同样的干净环境）：");

function tryKernel(c) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(c.exe, ["app-server"], { cwd: os.homedir(), env: cleanEnv(active.codexHome), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "self-test", title: "self-test", version: "1" } } }) + "\n");
    const timer = setInterval(() => {
      if (out.includes('"result"')) {
        clearInterval(timer);
        child.kill();
        resolve({ ok: true, ms: Date.now() - t0 });
      }
    }, 50);
    child.on("exit", (code) => {
      clearInterval(timer);
      const why = err.split("\n").filter((l) => /Error|denied|拒绝/.test(l)).slice(-2).join(" | ");
      resolve({ ok: false, ms: Date.now() - t0, code, why });
    });
    setTimeout(() => { clearInterval(timer); child.kill(); resolve({ ok: false, ms: Date.now() - t0, why: "30s 超时未响应" }); }, 30000);
  });
}

(async () => {
  let anyOk = false;
  for (const c of candidates) {
    const r = await tryKernel(c);
    if (r.ok) anyOk = true;
    console.log(`  ${r.ok ? "✅" : "❌"} ${c.version} (${c.source})  ${r.ms}ms${r.why ? `  ← ${String(r.why).slice(0, 200)}` : ""}`);
  }
  console.log(`\n结论：${anyOk ? "有可用内核 —— 应用里若还显示红色横幅，请重启应用再看一次" : "所有内核都起不来 —— 请把以上输出整段发给我"}`);
  process.exit(anyOk ? 0 : 1);
})();
