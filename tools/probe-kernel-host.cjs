// Isolated Node/Electron comparison. Never launches a kernel against the source home.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { DatabaseSync, backup } = require("node:sqlite");
const root = path.resolve(__dirname, "..");
const electronMode = Boolean(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE);

async function probe(exe, home, cwd) {
  const env = { ...process.env, CODEX_HOME: home, RUST_LOG: "warn" };
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|NODE_INSPECT)/i.test(key)) delete env[key];
  }
  const child = spawn(exe, ["app-server"], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "", id = 0, closed = false;
  const pending = new Map();
  const exit = new Promise(resolve => child.once("close", code => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`exit ${code}: ${stderr.slice(-4000)}`)); }
    pending.clear();
    resolve(code);
  }));
  child.on("error", error => { stderr += error.message; });
  child.stdin.on("error", error => { stderr += error.message; });
  child.stderr.setEncoding("utf8").on("data", s => { stderr = (stderr + s).slice(-8000); });
  child.stdout.setEncoding("utf8").on("data", s => {
    buf += s;
    let n;
    while ((n = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, n); buf = buf.slice(n + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      else if (msg.id !== undefined && msg.method) child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Probe does not implement client requests" } }) + "\n");
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`${method} timeout`)); }, 45000);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
    });
  }
  const started = Date.now();
  const result = { host: electronMode ? "electron" : "node", exe, home, ok: false, checks: [], elapsedMs: 0 };
  try {
    await request("initialize", { clientInfo: { name: "compat_probe", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    result.checks.push("initialize");
    const threads = await request("thread/list", { limit: 1, archived: false, useStateDbOnly: true });
    result.checks.push("thread/list:" + (threads.data?.length ?? "invalid"));
    await request("account/read", { refreshToken: false });
    result.checks.push("account/read");
    result.ok = true;
  } catch (error) {
    result.error = error.message;
  } finally {
    if (!closed) child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    result.exitCode = await exit;
    clearTimeout(timer);
    result.elapsedMs = Date.now() - started;
    result.stderr = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  }
  return result;
}

async function run() {
  const out = fs.mkdtempSync(path.join(root, "artifacts", "kernel-host-"));
  const source = path.join(os.homedir(), ".codex");
  const official = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  const bins = [];
  if (fs.existsSync(official)) for (const name of fs.readdirSync(official)) {
    const exe = path.join(official, name, "codex.exe"); if (fs.existsSync(exe)) bins.push(exe);
  }
  bins.push(path.join(root, "vendor", "codex", "bin", "codex.exe"));
  const results = [];
  if (process.argv.includes("--check-source")) {
    // Take a consistent backup first. Only the currently installed kernel opens the source.
    const saved = path.join(out, "source-backup"); fs.mkdirSync(saved);
    for (const name of fs.readdirSync(source).filter(name => /\.sqlite$/.test(name))) {
      const db = new DatabaseSync(path.join(source, name), { readOnly: true });
      try { await backup(db, path.join(saved, name)); } finally { db.close(); }
    }
    console.log("Source database backup: " + saved);
    const result = { profile: "source-with-backup", ...await probe(bins[0], source, os.homedir()) };
    results.push(result);
    console.log(JSON.stringify(result));
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
    return result.ok ? 0 : 1;
  }
  for (let i = 0; i < bins.length; i++) for (const profile of ["clean", "databases", "config-and-databases"]) {
    const home = path.join(out, `${i}-${profile}`); fs.mkdirSync(home);
    if (profile !== "clean") {
      for (const name of fs.readdirSync(source).filter(name => /\.sqlite$/.test(name))) {
        const db = new DatabaseSync(path.join(source, name), { readOnly: true });
        try { await backup(db, path.join(home, name)); } finally { db.close(); }
      }
    }
    if (profile === "config-and-databases") fs.copyFileSync(path.join(source, "config.toml"), path.join(home, "config.toml"));
    const result = { profile, ...await probe(bins[i], home, out) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  return results.every(r => r.ok) ? 0 : 1;
}

if (electronMode) {
  const { app } = require("electron");
  app.whenReady().then(run).then(code => app.exit(code)).catch(error => { console.error(error); app.exit(1); });
} else {
  run().then(code => { process.exitCode = code; }).catch(error => { console.error(error); process.exitCode = 1; });
}
