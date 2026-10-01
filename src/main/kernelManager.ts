import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildKernelEnv } from "./appServer";

export interface KernelCandidate { path: string; source: string; version: string | null; fingerprint: string }

type RuntimeHistory = {
  path: string;
  fingerprint: string;
  version: string | null;
  committedAt: string;
};

type RuntimeRecord = {
  envId: string;
  sourceHome: string;
  lastGood?: RuntimeHistory;
  history: RuntimeHistory[];
};

type RuntimeMap = Record<string, RuntimeRecord>;

const SQLITE_STATE_FILE = /^(?:state|thread_history|memories|goals|queue)_\d+\.sqlite$/i;
const COPY_FILES = ["config.toml", "config.toml.bak-codex-replica", "AGENTS.md", ".codex-global-state.json", "auth.json", "session_index.jsonl"];

function normalizeHome(home: string): string {
  const resolved = path.resolve(home);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function kernelRuntimeEnvironmentKey(envId: string, sourceHome: string): string {
  return crypto.createHash("sha256").update(`${envId}\0${normalizeHome(sourceHome)}`).digest("hex").slice(0, 32);
}

/** Only complete, link-free app-owned runtime homes may be used as writers. */
export function isKernelRuntimeHome(userData: string, runtimeHome: string, envId?: string, sourceHome?: string): boolean {
  try {
    const root = path.resolve(userData, "kernel-runtime", "environments");
    const home = path.resolve(runtimeHome);
    const relative = path.relative(root, home);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part.includes(".stage-"))) return false;
    let current = path.resolve(userData);
    for (const part of path.relative(current, home).split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    const markerPath = path.join(home, "runtime.json");
    if (!fs.lstatSync(markerPath).isFile()) return false;
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    return (marker.status === "complete" || marker.status === "prepared") && (!envId || marker.envId === envId) &&
      (!sourceHome || typeof marker.sourceHome === "string" && normalizeHome(marker.sourceHome) === normalizeHome(sourceHome));
  } catch {
    return false;
  }
}

function compareNullableVersion(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return compareKernelVersions(a, b);
}

export function compareKernelVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const clean = value.trim().replace(/^v/i, "");
    const withoutBuild = clean.split("+", 1)[0];
    const [core, pre] = withoutBuild.split("-", 2);
    const coreParts = core.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : 0);
    return { core: coreParts, pre: pre ? pre.split(".") : null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const difference = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const left = x.pre[i], right = y.pre[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left), rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return Math.sign(Number(left) - Number(right));
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** A version identifies a protocol, a fingerprint identifies the actual executable. */
export class KernelManager {
  private versions = new Map<string, { fingerprint: string; version: string | null }>();
  private root: string;
  private runtimeMapFile: string;

  constructor(private userData: string, private bundled: string) {
    this.root = path.join(userData, "kernel-runtime");
    this.runtimeMapFile = path.join(this.root, "runtime-map.json");
    // ⚠️ 这里**绝对不能抛**。构造函数在模块加载期执行（main.ts 顶层 `new KernelManager(...)`），
    // 抛出去的结果是：Electron 打印 "App threw an error during load" + 弹一个模态框，
    // 不建窗口、没有任何业务日志、进程还吊着不退出 —— 用户只看到"启动卡住了"。
    // 2026-10-01 实测踩过一次：工作区带 Low 完整性标签 → Electron 进程是 Low →
    // mkdir %APPDATA% 直接 EPERM。目录建不出来是"稍后功能不可用"，不该是"应用打不开"。
    try {
      fs.mkdirSync(this.root, { recursive: true });
    } catch (error) {
      console.error(`[kernel] 运行目录不可写（相关功能会失败，但先让窗口起来）：${this.root}`, String(error).slice(0, 200));
    }
  }

  private hashFileSync(file: string): string {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let bytes = 0;
      do {
        bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytes) hash.update(buffer.subarray(0, bytes));
      } while (bytes);
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest("hex");
  }

  private readRuntimeMap(): RuntimeMap {
    try {
      const raw = JSON.parse(fs.readFileSync(this.runtimeMapFile, "utf8")) as RuntimeMap;
      if (!raw || typeof raw !== "object") return {};
      const out: RuntimeMap = {};
      for (const [key, record] of Object.entries(raw)) {
        if (!record || typeof record !== "object" || typeof record.envId !== "string" || typeof record.sourceHome !== "string") continue;
        const history = Array.isArray(record.history)
          ? record.history.filter((item): item is RuntimeHistory => this.isHistory(item))
          : [];
        const lastGood = this.isHistory(record.lastGood) ? record.lastGood : undefined;
        out[key] = { envId: record.envId, sourceHome: record.sourceHome, history, lastGood };
      }
      return out;
    } catch {
      return {};
    }
  }

  private isHistory(value: unknown): value is RuntimeHistory {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<RuntimeHistory>;
    return typeof item.path === "string" && typeof item.fingerprint === "string" &&
      (typeof item.version === "string" || item.version === null) && typeof item.committedAt === "string";
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  private runtimeKey(envId: string, sourceHome: string): string {
    return kernelRuntimeEnvironmentKey(envId, sourceHome);
  }

  private runtimeBase(envId: string, sourceHome: string): string {
    return path.join(this.root, "environments", this.runtimeKey(envId, sourceHome));
  }

  private runtimeIdentity(candidate: KernelCandidate): string {
    const version = (candidate.version ?? "unknown").replace(/[^0-9A-Za-z._+-]/g, "_");
    return `${version}-${candidate.fingerprint}`;
  }

  private expectedRuntime(candidate: KernelCandidate, envId: string, sourceHome: string): string {
    return path.join(this.runtimeBase(envId, sourceHome), this.runtimeIdentity(candidate));
  }

  private isInside(dir: string, target: string): boolean {
    const relative = path.relative(path.resolve(dir), path.resolve(target));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private isCompleteRuntime(runtimeHome: string, expected?: Partial<{ envId: string; sourceHome: string; fingerprint: string }>): boolean {
    if (!isKernelRuntimeHome(this.userData, runtimeHome, expected?.envId, expected?.sourceHome)) return false;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(runtimeHome, "runtime.json"), "utf8")) as Record<string, unknown>;
      if (marker.status !== "complete") return false;
      return !expected?.fingerprint || marker.fingerprint === expected.fingerprint;
    } catch {
      return false;
    }
  }

  private candidate(exe: string, source: string): KernelCandidate | null {
    try {
      const stat = fs.statSync(exe);
      if (!stat.isFile()) return null;
      const fingerprint = this.hashFileSync(exe);
      let cached = this.versions.get(exe);
      if (!cached || cached.fingerprint !== fingerprint) {
        const probeHome = path.join(this.root, "version-probe");
        fs.mkdirSync(probeHome, { recursive: true });
        const result = spawnSync(exe, ["--version"], {
          timeout: 5000,
          encoding: "utf8",
          windowsHide: true,
          env: buildKernelEnv(probeHome),
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        });
        const version = result.status === 0
          ? /codex-cli\s+(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)/.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? null
          : null;
        cached = { fingerprint, version };
        this.versions.set(exe, cached);
      }
      return { path: exe, source, version: cached.version, fingerprint };
    } catch {
      return null;
    }
  }

  private walkExecutables(dir: string, depth: number, out: string[]): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(dir, entry.name);
        if (entry.isFile() && /^codex\.exe$/i.test(entry.name)) out.push(target);
        else if (entry.isDirectory() && depth < 2) this.walkExecutables(target, depth + 1, out);
      }
    } catch {
      /* Optional installation location. */
    }
  }

  candidates(): KernelCandidate[] {
    const official: string[] = [];
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Codex"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Codex"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Codex"),
    ].filter((value): value is string => Boolean(value));
    for (const root of roots) this.walkExecutables(root, 0, official);

    const seen = new Set<string>();
    const convert = (exe: string, source: string): KernelCandidate | null => {
      if (!exe) return null;
      const key = path.resolve(exe).toLowerCase();
      if (seen.has(key)) return null;
      const candidate = this.candidate(exe, source);
      if (!candidate) return null;
      seen.add(key);
      return candidate;
    };

    const explicit: KernelCandidate[] = [];
    const explicitPath = process.env.REPLICA_CODEX_BIN?.trim();
    if (explicitPath) {
      const candidate = convert(explicitPath, "手动指定");
      if (candidate) explicit.push(candidate);
    }

    const installed: KernelCandidate[] = [];
    for (const exe of official) {
      const candidate = convert(exe, "本机官方安装");
      if (candidate) installed.push(candidate);
    }

    const snapshots: KernelCandidate[] = [];
    const binaryRoot = path.join(this.root, "binaries");
    try {
      for (const entry of fs.readdirSync(binaryRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || !entry.isDirectory() || !/^[a-f0-9]{64}$/i.test(entry.name)) continue;
        const dir = path.join(binaryRoot, entry.name);
        const exe = path.join(dir, "codex.exe");
        let identity: { fingerprint?: unknown } = {};
        try { identity = JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8")); } catch { continue; }
        if (identity.fingerprint !== entry.name || !fs.existsSync(exe)) continue;
        const candidate = convert(exe, "已验证内核快照");
        if (candidate) snapshots.push(candidate);
      }
    } catch {
      /* No verified snapshot yet. */
    }

    const versionSort = (a: KernelCandidate, b: KernelCandidate) => compareKernelVersions(b.version ?? "0.0.0", a.version ?? "0.0.0");
    installed.sort(versionSort);
    snapshots.sort(versionSort);
    const bundled = convert(this.bundled, "自带内核");
    return [...explicit, ...installed, ...snapshots, ...(bundled ? [bundled] : [])];
  }

  private copyRegularFile(source: string, target: string): boolean {
    try {
      if (!fs.lstatSync(source).isFile()) return false;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return true;
    } catch {
      return false;
    }
  }

  private copyTreeNoLinks(source: string, target: string): number {
    let count = 0;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch { return 0; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        count += this.copyTreeNoLinks(sourcePath, targetPath);
      } else if (entry.isFile() && this.copyRegularFile(sourcePath, targetPath)) {
        count += 1;
      }
    }
    return count;
  }

  private copyRuntimeFiles(sourceHome: string, stage: string, includeAuth: boolean): string[] {
    const copied: string[] = [];
    for (const name of COPY_FILES) {
      if (!includeAuth && name === "auth.json") continue;
      const source = path.join(sourceHome, name);
      const target = path.join(stage, name);
      if (this.copyRegularFile(source, target)) copied.push(name);
    }
    for (const name of ["sessions", "archived_sessions", "skills"]) {
      const source = path.join(sourceHome, name);
      if (!fs.existsSync(source)) continue;
      const copiedCount = this.copyTreeNoLinks(source, path.join(stage, name));
      if (copiedCount > 0) copied.push(name);
    }
    return copied;
  }

  private sqliteFiles(home: string): string[] {
    try {
      return fs.readdirSync(home, { withFileTypes: true })
        .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && SQLITE_STATE_FILE.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async backupSqlite(sourceHome: string, stage: string, allowDatabaseCopy: boolean): Promise<string[]> {
    if (!allowDatabaseCopy) return [];
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    let backup: typeof import("node:sqlite").backup;
    try {
      ({ DatabaseSync, backup } = require("node:sqlite") as typeof import("node:sqlite"));
    } catch (error) {
      throw new Error(`当前 Node 不支持 SQLite 在线备份：${String(error)}`);
    }
    const copied: string[] = [];
    for (const name of this.sqliteFiles(sourceHome)) {
      const sourcePath = path.join(sourceHome, name);
      const targetPath = path.join(stage, name);
      let source: import("node:sqlite").DatabaseSync | null = null;
      try {
        source = new DatabaseSync(sourcePath, { readOnly: true });
        await backup(source, targetPath);
        copied.push(name);
      } finally {
        try { source?.close(); } catch { /* close errors must not hide backup errors */ }
      }
    }
    return copied;
  }

  private redirectRolloutPaths(stage: string, sourceHome: string, runtimeHome: string): void {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"));
    } catch {
      return;
    }
    const sourceRoots = [path.join(sourceHome, "sessions"), path.join(sourceHome, "archived_sessions")]
      .map((item) => path.resolve(item));
    const targetRoots = [path.join(runtimeHome, "sessions"), path.join(runtimeHome, "archived_sessions")]
      .map((item) => path.resolve(item));
    for (const name of this.sqliteFiles(stage)) {
      const dbPath = path.join(stage, name);
      let db: import("node:sqlite").DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath);
        const tableColumns = db.prepare("pragma table_info(threads)").all() as { name?: unknown }[];
        if (!tableColumns.some((column) => column.name === "rollout_path")) continue;
        const rows = db.prepare("select rollout_path from threads where rollout_path is not null").all() as { rollout_path?: unknown }[];
        const update = db.prepare("update threads set rollout_path = ? where rollout_path = ?");
        for (const row of rows) {
          if (typeof row.rollout_path !== "string") continue;
          let redirected = row.rollout_path;
          for (let i = 0; i < sourceRoots.length; i += 1) {
            const sourceRoot = sourceRoots[i];
            const targetRoot = targetRoots[i];
            const sourceVariants = [sourceRoot, sourceRoot.replace(/\\/g, "/")];
            const valueLower = redirected.toLowerCase();
            const matchingSource = sourceVariants.find((variant) => valueLower.startsWith(variant.toLowerCase()));
            if (!matchingSource) continue;
            const suffix = redirected.slice(matchingSource.length);
            const targetVariant = redirected.includes("\\") ? targetRoot : targetRoot.replace(/\\/g, "/");
            redirected = `${targetVariant}${suffix}`;
            break;
          }
          if (redirected !== row.rollout_path) update.run(redirected, row.rollout_path);
        }
      } catch {
        /* A non-thread database or old schema needs no rollout rewrite. */
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
    }
  }

  private runtimeHistoryFor(envId: string, sourceHome: string): RuntimeHistory[] {
    const record = this.readRuntimeMap()[this.runtimeKey(envId, sourceHome)];
    if (!record) return [];
    const entries = [record.lastGood, ...(record.history ?? [])].filter((item): item is RuntimeHistory => Boolean(item));
    return entries.filter((item, index, all) => all.findIndex((other) => path.resolve(other.path).toLowerCase() === path.resolve(item.path).toLowerCase()) === index)
      .filter((item) => this.isCompleteRuntime(item.path, { envId, sourceHome }));
  }

  private lastGoodFor(envId: string, sourceHome: string): RuntimeHistory | undefined {
    const record = this.readRuntimeMap()[this.runtimeKey(envId, sourceHome)];
    if (!record?.lastGood || !this.isCompleteRuntime(record.lastGood.path, { envId, sourceHome })) return undefined;
    return record.lastGood;
  }

  /**
   * Make an app-owned CODEX_HOME for a local environment. The directory is
   * keyed by environment and executable fingerprint, never by DB size/mtime.
   * Every first creation goes through a stage directory; failed stages remain
   * on disk for diagnosis and are never treated as usable runtimes.
   */
  async prepareRuntime(candidate: KernelCandidate, envId: string, sourceHome: string): Promise<string> {
    if (!candidate.fingerprint || candidate.fingerprint === "bundled") throw new Error("内核没有可靠内容指纹，拒绝初始化运行目录");
    const target = this.expectedRuntime(candidate, envId, sourceHome);
    if (this.isCompleteRuntime(target, { envId, sourceHome, fingerprint: candidate.fingerprint })) return target;
    if (fs.existsSync(target)) throw new Error(`运行目录不完整，已保留原目录：${target}`);

    const base = this.runtimeBase(envId, sourceHome);
    fs.mkdirSync(base, { recursive: true });
    const stage = `${target}.stage-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(stage, { recursive: true });

    const previous = this.lastGoodFor(envId, sourceHome);
    const previousVersion = previous?.version ?? null;
    const upgrading = !previous || compareNullableVersion(candidate.version, previousVersion) >= 0;
    const compatibleHistory = this.runtimeHistoryFor(envId, sourceHome).find((item) =>
      compareNullableVersion(item.version, candidate.version) <= 0,
    );
    const seedHome = compatibleHistory?.path ?? (upgrading && previous ? previous.path : sourceHome);
    const copied = this.copyRuntimeFiles(seedHome, stage, Boolean(previous));
    const dbFiles = await this.backupSqlite(seedHome, stage, seedHome !== sourceHome || upgrading || !previous);
    this.redirectRolloutPaths(stage, seedHome, target);
    const marker = {
      status: "prepared",
      envId,
      sourceHome: path.resolve(sourceHome),
      seedHome: path.resolve(seedHome),
      version: candidate.version,
      fingerprint: candidate.fingerprint,
      files: [...copied, ...dbFiles],
      createdAt: new Date().toISOString(),
      runtimeHome: target,
    };
    fs.writeFileSync(path.join(stage, "runtime.json"), JSON.stringify(marker, null, 2), "utf8");
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      throw new Error(`运行目录提交失败，stage 已保留：${stage}；${String(error)}`);
    }
    return target;
  }

  /** Mark a healthy runtime and persist the environment's last-good pointer. */
  async commitRuntime(candidate: KernelCandidate, envId: string, sourceHome: string, runtimeHome: string): Promise<void> {
    const expected = this.expectedRuntime(candidate, envId, sourceHome);
    if (path.resolve(expected).toLowerCase() !== path.resolve(runtimeHome).toLowerCase()) throw new Error("运行目录不是该内核候选的应用托管目录");
    if (!isKernelRuntimeHome(this.userData, runtimeHome, envId, sourceHome)) throw new Error("运行目录不是完整的应用托管目录");
    const markerPath = path.join(runtimeHome, "runtime.json");
    let marker: Record<string, unknown>;
    try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("运行目录缺少 runtime.json，不能登记为 last-good"); }
    // ⚠️ 必须接受 "complete"：prepareRuntime 对**已经完整**的运行目录会直接返回、不再走 stage
    // （见 isCompleteRuntime 短路），所以第二次启动时 marker 已经是 complete。
    // 只认 "prepared" 的话，每次重启都会走到这里抛「运行目录未准备完成」→ 所有候选内核
    // 全被判成"起不来" → 应用起来了但内核完全不可用。2026-10-01 实测踩到（同日引入的回归）。
    const status = typeof marker.status === "string" ? marker.status : "";
    if ((status !== "prepared" && status !== "complete") || marker.fingerprint !== candidate.fingerprint) {
      throw new Error(`运行目录未准备完成（status=${status}），不能登记为 last-good`);
    }
    this.writeJsonAtomic(markerPath, { ...marker, status: "complete", committedAt: new Date().toISOString() });
    const key = this.runtimeKey(envId, sourceHome);
    const map = this.readRuntimeMap();
    const item: RuntimeHistory = { path: runtimeHome, fingerprint: candidate.fingerprint, version: candidate.version, committedAt: new Date().toISOString() };
    const old = map[key];
    const history = [item, ...(old?.history ?? []).filter((entry) => path.resolve(entry.path).toLowerCase() !== path.resolve(runtimeHome).toLowerCase())].slice(0, 32);
    map[key] = { envId, sourceHome: path.resolve(sourceHome), lastGood: item, history };
    this.writeJsonAtomic(this.runtimeMapFile, map);
  }

  lastRuntimeHome(envId: string, sourceHome: string): string | undefined {
    return this.lastGoodFor(envId, sourceHome)?.path;
  }

  historyHomes(envId: string, sourceHome: string): string[] {
    return this.runtimeHistoryFor(envId, sourceHome).map((item) => item.path);
  }

  /** Cache a healthy binary and its executable companions before its installer removes it. */
  async rememberGood(candidate: KernelCandidate): Promise<void> {
    if (!candidate.fingerprint || candidate.fingerprint === "bundled") throw new Error("内核没有可靠内容指纹，拒绝缓存");
    const dir = path.join(this.root, "binaries", candidate.fingerprint);
    const identity = path.join(dir, "identity.json");
    try {
      const existing = JSON.parse(fs.readFileSync(identity, "utf8")) as { fingerprint?: string };
      if (existing.fingerprint === candidate.fingerprint && fs.existsSync(path.join(dir, "codex.exe"))) return;
    } catch { /* Cache not complete yet. */ }
    if (fs.existsSync(dir)) throw new Error(`内核快照目录不完整，已保留原目录：${dir}`);

    const stage = `${dir}.stage-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(stage, { recursive: true });
    const sourceDir = path.dirname(candidate.path);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }); } catch (error) { throw new Error(`读取内核目录失败：${String(error)}`); }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const source = path.join(sourceDir, entry.name);
      const target = path.join(stage, entry.name);
      if (entry.isFile() && this.copyRegularFile(source, target)) continue;
      if (entry.isDirectory() && /^(?:codex-path|codex-resources)$/i.test(entry.name)) {
        this.copyTreeNoLinks(source, target);
      }
    }
    for (const name of ["codex-package.json"]) {
      this.copyRegularFile(path.join(sourceDir, "..", name), path.join(stage, name));
    }
    fs.writeFileSync(path.join(stage, "identity.json"), JSON.stringify({ fingerprint: candidate.fingerprint, version: candidate.version, source: candidate.path }, null, 2), "utf8");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      fs.renameSync(stage, dir);
    } catch (error) {
      throw new Error(`内核快照提交失败，stage 已保留：${stage}；${String(error)}`);
    }
    this.writeJsonAtomic(path.join(this.root, "last-good.json"), { path: path.join(dir, "codex.exe"), version: candidate.version, fingerprint: candidate.fingerprint });
  }
}
