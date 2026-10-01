import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { app } from "electron";
import { relayCompatBaseUrl, setRelayCompatUpstream } from "./relayCompat";
import { isKernelRuntimeHome } from "./kernelManager";

/** 内置浏览器 MCP server 在 config.toml 里的登记名（对齐官方把浏览能力挂成 MCP 的做法） */
export const BROWSER_MCP_MARKER = "[mcp_servers.replica_browser]";

/**
 * 环境管理器：多隔离环境 + 自定义模型接入（自研实现）。
 *
 * - 每个环境拥有独立 codex-home（CODEX_HOME），互不共享登录/会话/记忆/技能
 * - 接入方式二选一：chatgpt（官方 OAuth 登录）| relay（OpenAI 兼容自定义模型，供应商档案）
 * - relay 模式按供应商档案生成该环境自己的 config.toml（model_providers + env_key），
 *   API Key 通过进程环境变量在启动时注入，不落入 config 文件
 * - 可从本机官方 Codex（~/.codex）一次性导入登录态 / 会话历史，技能目录可做 junction 共享
 */

export interface RelayProfile {
  id: string;
  name: string;
  baseUrl: string;
  /** 保存在本机 envs.json（与官方 auth.json 同级敏感度）；UI 一律脱敏显示 */
  apiKey: string;
  wireApi: "responses" | "chat";
  model: string;
  /**
   * 可选高级项（null/undefined = 不写入，交给内核按内置模型目录判定）：
   * 内核的 models-manager 只认得它自带的模型 slug，第三方模型名会落到
   * fallback 元数据上，上下文窗口就不是真的 → 需要显式告诉它。
   */
  contextWindow?: number | null;
  /** 思考等级：none | low | medium | high | xhigh | max */
  reasoningEffort?: string | null;
  /** 本地代理/网关自己负责鉴权时，不注入 API Key，而写入受管 Bearer 标记。 */
  managedAuth?: boolean;
  experimentalBearerToken?: string;
  /** 档案来源：local = 从本机 Codex 配置导入；manual = 手动新建/编辑 */
  origin?: "local" | "manual";
}

export interface EnvProfile {
  id: string;
  name: string;
  codexHome: string;
  createdAt: string;
  mode: "chatgpt" | "relay";
  relayId: string | null;
  skillsShared: boolean;
  /** local = 复用本机 ~/.codex 作为只读源；isolated = 独立数据目录 */
  kind: "isolated" | "local";
  /** local 环境的应用托管运行目录；官方 ~/.codex 只作为只读导入源。 */
  runtimeHome?: string;
}

/** 该环境目录里记录的项目（来自官方桌面版的全局状态文件） */
export interface EnvProject {
  id: string;
  name: string;
  path: string;
  createdAt?: number;
  /** 归属这个项目的会话 id */
  threadIds: string[];
}

export interface OfficialInfo {
  home: string;
  exists: boolean;
  hasAuth: boolean;
  /** 本机 Codex 是否带有自定义模型配置（config.toml） */
  hasConfig: boolean;
  sessionCount: number;
  hasSkills: boolean;
}

interface Registry {
  activeId: string;
  envs: EnvProfile[];
  relays: RelayProfile[];
}

const RELAY_ENV_KEY = "REPLICA_RELAY_API_KEY";
const PROVIDER_ID = "replica_relay";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

/** TOML 基本字符串（JSON.stringify 的转义规则与 TOML 基本字符串兼容常用场景） */
function tomlStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * 判断一份 relay config.toml 是否已带「第三方网关工具兼容修正」。
 * 缺任一项即视为旧版本应用生成的配置，需要重新生成（见 syncRelayConfig）。
 * expectedBaseUrl 非空时还要校验 base_url 是否指向「工具兼容层」——
 * 否则旧配置（直连上游）会被误判为已兼容，reasoning 报错依旧。
 */
function isRelayConfigCompatible(text: string, expectedBaseUrl?: string | null): boolean {
  const hasSwitches =
    /^\s*web_search\s*=\s*"disabled"/m.test(text) && /^\s*multi_agent\s*=\s*false/m.test(text);
  if (!hasSwitches) return false;
  if (expectedBaseUrl) return text.includes(`base_url = ${tomlStr(expectedBaseUrl)}`);
  return true;
}

export class EnvManager {
  /** 应用自己的数据目录（%APPDATA%/codex-desk-replica）：这一片区域都算"托管" */
  private userData: string;
  /** 隔离环境的生成目录：<userData>/envs/<id>/codex-home */
  private root: string;
  private file: string;
  private reg: Registry;
  /** 内核使用的应用托管运行目录；本地环境的官方目录只作为首次快照源。 */
  private runtimeHomes = new Map<string, string>();

  constructor(userDataDir: string) {
    this.userData = userDataDir;
    this.root = path.join(userDataDir, "envs");
    this.file = path.join(userDataDir, "envs.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.reg = this.load();
    this.restoreRuntimeHomes();
  }

  // ---------------------------------------------------------------- 注册表

  private load(): Registry {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<Registry>;
      if (raw && Array.isArray(raw.envs)) {
        return {
          activeId: typeof raw.activeId === "string" ? raw.activeId : "",
          // 旧登记表没有 kind 字段，统一补成 isolated
          envs: raw.envs
            .filter((env): env is EnvProfile => Boolean(env && typeof env.id === "string" && typeof env.codexHome === "string"))
            .map((env) => ({ ...env, kind: env.kind === "local" ? "local" : "isolated" })),
          relays: Array.isArray(raw.relays)
            ? raw.relays.filter((relay): relay is RelayProfile => Boolean(relay && typeof relay.id === "string" && typeof relay.baseUrl === "string"))
            : [],
        };
      }
    } catch {
      /* 首次运行或注册表损坏时使用默认值 */
    }
    return { activeId: "", envs: [], relays: [] };
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.reg, null, 2), "utf-8");
  }

  /** 首次迁移：把现有 userData/codex-home 登记为默认环境 */
  ensureDefault(defaultCodexHome: string): void {
    if (this.reg.envs.length === 0) {
      const env: EnvProfile = {
        id: "default",
        name: "默认环境",
        codexHome: defaultCodexHome,
        createdAt: new Date().toISOString(),
        mode: "chatgpt",
        relayId: null,
        skillsShared: false,
        kind: "isolated",
      };
      this.reg.envs.push(env);
      this.reg.activeId = env.id;
      this.save();
    }
    if (!this.reg.envs.some((e) => e.id === this.reg.activeId)) {
      this.reg.activeId = this.reg.envs[0].id;
      this.save();
    }
  }

  list(): Registry {
    return this.reg;
  }

  activeId(): string {
    return this.reg.activeId;
  }

  activeEnv(): EnvProfile {
    return this.reg.envs.find((e) => e.id === this.reg.activeId) ?? this.reg.envs[0];
  }

  envById(id: string): EnvProfile | undefined {
    return this.reg.envs.find((e) => e.id === id);
  }

  private persistedRuntimeHomes(env: EnvProfile): string[] {
    if (env.kind !== "local") return [];
    try {
      const map = JSON.parse(fs.readFileSync(path.join(this.userData, "kernel-runtime", "runtime-map.json"), "utf8")) as Record<string, unknown>;
      const values: string[] = [];
      for (const value of Object.values(map)) {
        if (!value || typeof value !== "object") continue;
        const record = value as { envId?: unknown; sourceHome?: unknown; lastGood?: { path?: unknown }; history?: { path?: unknown }[] };
        if (record.envId !== env.id || typeof record.sourceHome !== "string" || !this.samePath(record.sourceHome, env.codexHome)) continue;
        const records = [record.lastGood, ...(Array.isArray(record.history) ? record.history : [])];
        for (const item of records) {
          if (item && typeof item.path === "string" && isKernelRuntimeHome(this.userData, item.path, env.id, env.codexHome)) values.push(item.path);
        }
      }
      return values.filter((home, index) => values.findIndex((value) => this.samePath(value, home)) === index);
    } catch {
      return [];
    }
  }

  private restoreRuntimeHomes(): void {
    for (const env of this.reg.envs) {
      if (env.kind !== "local") continue;
      const home = this.persistedRuntimeHomes(env)[0];
      if (home) {
        this.runtimeHomes.set(env.id, home);
        env.runtimeHome = home;
      } else {
        delete env.runtimeHome;
      }
    }
  }

  setRuntimeHome(id: string, runtimeHome: string): void {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    if (env.kind === "local") {
      // prepareRuntime creates a complete app-owned directory before the
      // kernel health check; commitRuntime persists last-good only after the
      // check succeeds. Both transient and committed homes are safe writers.
      if (!isKernelRuntimeHome(this.userData, runtimeHome, env.id, env.codexHome)) {
        throw new Error("本地环境只能使用完整的应用托管运行目录");
      }
      env.runtimeHome = path.resolve(runtimeHome);
    } else if (!this.samePath(runtimeHome, env.codexHome)) {
      throw new Error("隔离环境的运行目录与登记目录不一致");
    }
    this.runtimeHomes.set(id, path.resolve(runtimeHome));
  }

  runtimeHomeFor(id: string): string | undefined {
    const env = this.envById(id);
    if (!env) return undefined;
    const home = this.runtimeHomes.get(id);
    if (home && (env.kind !== "local" || isKernelRuntimeHome(this.userData, home, env.id, env.codexHome))) return home;
    this.runtimeHomes.delete(id);
    delete env.runtimeHome;
    return undefined;
  }

  private dataHome(id: string): string {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    return this.runtimeHomeFor(id) ?? env.codexHome;
  }

  private writeHome(id: string): string {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    if (env.kind === "local") {
      const runtime = this.runtimeHomeFor(id);
      if (!runtime) throw new Error("本地环境尚未初始化运行目录，请先启动该环境");
      return runtime;
    }
    this.assertWritableHome(env.codexHome);
    return env.codexHome;
  }

  private assertWritableHome(home: string): void {
    const resolved = path.resolve(home);
    const official = this.officialHome();
    const sources = [official, ...this.reg.envs.filter((env) => env.kind === "local").map((env) => env.codexHome)];
    for (const source of sources) {
      if (this.samePath(resolved, source) || this.isInside(source, resolved)) throw new Error("官方 Codex 目录是只读源，禁止写入");
      try {
        if (fs.existsSync(resolved) && fs.existsSync(source)) {
          const realHome = fs.realpathSync(resolved), realSource = fs.realpathSync(source);
          if (this.samePath(realHome, realSource) || this.isInside(realSource, realHome)) throw new Error("运行目录链接指向只读源，禁止写入");
        }
      } catch (error) {
        if (error instanceof Error && /禁止写入/.test(error.message)) throw error;
      }
    }
  }

  private assertWritableFile(home: string, name: string): string {
    this.assertWritableHome(home);
    const file = path.join(home, name);
    const relative = path.relative(home, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("写入路径不属于运行目录");
    let current = path.resolve(home);
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("写入路径不能包含软链或 junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return file;
  }

  /** 当前运行目录优先，随后是已验证版本历史和官方只读源。 */
  private dataHomes(id: string): string[] {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    const homes = [this.runtimeHomeFor(id), ...this.persistedRuntimeHomes(env), env.codexHome]
      .filter((home): home is string => Boolean(home));
    return homes.filter((home, index) => homes.findIndex((value) => this.samePath(value, home)) === index);
  }

  // ---------------------------------------------------------------- 环境

  /**
   * 新建隔离环境。
   *
   * codexHome 不传 → 落在应用自己的托管目录 `<userData>/envs/<id>/codex-home`（删环境时整目录清理）；
   * 传了自定义目录 → 直接把它当这个环境的数据目录（**删除环境时只解除登记，绝不动磁盘上的文件**）。
   *
   * importAuthFromLocal = true 时，顺手把本机 ~/.codex 的登录态复制一份过来，省一次重新登录。
   */
  createEnv(opts: { name: string; codexHome?: string; importAuthFromLocal?: boolean }): EnvProfile {
    const id = newId("env");
    const custom = (opts.codexHome ?? "").trim();
    let envHome: string;
    if (custom) {
      envHome = path.resolve(custom);
      if (this.isInside(this.userData, envHome) || this.samePath(this.userData, envHome)) {
        throw new Error("这个目录属于本应用的托管区域，留空让应用自动分配即可");
      }
      if (this.samePath(envHome, this.officialHome())) {
        throw new Error("这是本机官方 Codex 的目录，请用「本地 Codex」原地复用，而不是新建环境");
      }
      if (this.reg.envs.some((e) => this.samePath(e.codexHome, envHome))) {
        throw new Error("这个目录已经被另一个环境占用了");
      }
      fs.mkdirSync(envHome, { recursive: true });
    } else {
      envHome = path.join(this.root, id, "codex-home");
      fs.mkdirSync(envHome, { recursive: true });
    }
    const env: EnvProfile = {
      id,
      name: opts.name.trim() || `环境 ${this.reg.envs.length + 1}`,
      codexHome: envHome,
      createdAt: new Date().toISOString(),
      mode: "chatgpt",
      relayId: null,
      skillsShared: false,
      kind: "isolated",
    };
    this.reg.envs.push(env);
    this.save();
    if (opts.importAuthFromLocal) {
      // 复制失败（本机没登录过）不该让"建环境"整个失败，交给上层提示即可
      try {
        this.importOfficialAuth(env.id);
      } catch {
        /* 无官方 auth.json 时忽略 */
      }
    }
    return env;
  }

  private samePath(a: string, b: string): boolean {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }

  /** p 是否落在 dir 里面（自身不算） */
  private isInside(dir: string, p: string): boolean {
    const rel = path.relative(dir, p);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  /**
   * 数据目录是否归本应用托管（只有托管的才允许整目录删除）。
   * 注意默认环境在 <userData>/codex-home，不在 <userData>/envs 下，
   * 所以判定要按 userData 而不是按 envs 目录，否则默认环境会被误标成"自定义目录"。
   */
  isManagedHome(env: EnvProfile): boolean {
    return this.isInside(this.userData, env.codexHome);
  }

  /** 该环境 codex-home 下允许在界面里编辑的文件（白名单，挡掉 auth.json 这类密钥文件） */
  private static readonly EDITABLE_FILES = new Set(["config.toml", "AGENTS.md"]);

  private editablePath(id: string, name: string): { env: EnvProfile; file: string } {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    if (!EnvManager.EDITABLE_FILES.has(name)) throw new Error(`不支持编辑 ${name}`);
    return { env, file: path.join(env.codexHome, name) };
  }

  readEnvFile(id: string, name: string): { path: string; exists: boolean; text: string } {
    const { env } = this.editablePath(id, name);
    const file = path.join(this.dataHome(env.id), name);
    const exists = fs.existsSync(file);
    return { path: file, exists, text: exists ? fs.readFileSync(file, "utf-8") : "" };
  }

  writeEnvFile(id: string, name: string, text: string): { path: string; backedUp: boolean } {
    const { env } = this.editablePath(id, name);
    const home = this.writeHome(env.id);
    const file = this.assertWritableFile(home, name);
    this.assertWritableFile(home, `${name}.bak-manual-edit`);
    let backedUp = false;
    // 手改前先留一份副本；用独立后缀，避免覆盖"接入模型前的原始 config"那份备份
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.bak-manual-edit`);
        backedUp = true;
      } catch {
        /* 备份失败不阻塞写入 */
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf-8");
    return { path: file, backedUp };
  }

  /**
   * 登记「本地 Codex」环境：把本机 ~/.codex 作为只读源，不在官方目录写入。
   * 内核运行时会使用应用自己的快照目录；本目录已登记过时幂等返回。
   */
  addLocalEnv(): EnvProfile {
    const home = this.officialHome();
    if (!fs.existsSync(home)) throw new Error("未检测到本机 Codex（~/.codex 不存在）");
    const existing = this.reg.envs.find((e) => e.kind === "local");
    if (existing) return existing;
    const env: EnvProfile = {
      id: "local",
      name: "本地 Codex",
      codexHome: home,
      createdAt: new Date().toISOString(),
      mode: "chatgpt",
      relayId: null,
      skillsShared: false,
      kind: "local",
    };
    this.reg.envs.push(env);
    this.save();
    return env;
  }

  deleteEnv(id: string): void {
    if (id === "default") throw new Error("默认环境不可删除");
    if (id === this.reg.activeId) throw new Error("不能删除使用中的环境，请先切换");
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    // 本地 Codex（~/.codex）与自定义目录都只解除登记，绝不删除磁盘上的任何文件。
    // 只有落在应用托管区域里的才整目录清理——否则删一个"自定义目录"环境
    // 会把用户自己选的文件夹（甚至它们的父目录）一起 rm -rf 掉。
    if (env.kind === "local" || !this.isManagedHome(env)) {
      this.reg.envs = this.reg.envs.filter((e) => e.id !== id);
      this.save();
      return;
    }
    try {
      fs.rmSync(path.dirname(env.codexHome), { recursive: true, force: true });
    } catch {
      /* 目录清理失败不阻塞登记删除 */
    }
    this.reg.envs = this.reg.envs.filter((e) => e.id !== id);
    this.save();
  }

  setActive(id: string): void {
    if (!this.envById(id)) throw new Error("环境不存在");
    this.reg.activeId = id;
    this.save();
  }

  // ---------------------------------------------------------------- 接入方式

  /** 计算某环境启动 app-server 时的附加环境变量 */
  spawnEnvFor(env: EnvProfile): Record<string, string> {
    if (env.mode === "relay") {
      const relay = this.reg.relays.find((r) => r.id === env.relayId);
      if (relay && !relay.managedAuth && relay.apiKey) return { [RELAY_ENV_KEY]: relay.apiKey };
    }
    return {};
  }

  /** 设置环境的模型接入方式：官方登录或自定义模型档案 */
  setEnvMode(id: string, mode: "chatgpt" | "relay", relayId: string | null): void {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    if (mode === "relay") {
      const relay = this.reg.relays.find((r) => r.id === relayId);
      if (!relay) throw new Error("请先选择一个模型配置");
      env.mode = "relay";
      env.relayId = relay.id;
      const home = env.kind === "local" ? this.runtimeHomeFor(env.id) : this.writeHome(env.id);
      if (home) this.writeRelayConfig(home, relay, env.kind === "local");
    } else {
      env.mode = "chatgpt";
      // 保留 env.relayId 作为"这个环境上次用的自定义模型档案"：
      // 「自定义模型」chip 再点一下就能原样切回，不用重新挑档案。
      // 只影响记忆，mode = "chatgpt" 时所有展示与生效逻辑都看 mode 本身。
      if (env.kind === "local") {
        const runtime = this.runtimeHomeFor(env.id);
        if (runtime) {
          this.restoreLocalConfig(runtime);
          this.cleanRelayAuth(this.assertWritableFile(runtime, "auth.json"));
        }
      } else {
        const home = this.writeHome(env.id);
        const cfg = this.assertWritableFile(home, "config.toml");
        try {
          fs.rmSync(cfg, { force: true });
        } catch {
          /* ignore */
        }
        this.cleanRelayAuth(this.assertWritableFile(home, "auth.json"));
      }
    }
    this.save();
  }

  /** 本地环境切回官方登录时，还原接入模型前备份的用户原始 config.toml */
  private restoreLocalConfig(envHome: string): void {
    const cfg = this.assertWritableFile(envHome, "config.toml");
    const bak = this.assertWritableFile(envHome, "config.toml.bak-codex-replica");
    try {
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, cfg);
        fs.rmSync(bak, { force: true });
      }
    } catch {
      /* 还原失败不阻塞切换 */
    }
  }

  /** 移除我们注入的 OPENAI_API_KEY：无官方 tokens 时整文件删除，有则只删键 */
  private cleanRelayAuth(authPath: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !("OPENAI_API_KEY" in raw)) return;
      if ("tokens" in raw) {
        delete raw.OPENAI_API_KEY;
        fs.writeFileSync(authPath, JSON.stringify(raw), "utf-8");
      } else {
        fs.rmSync(authPath, { force: true });
      }
    } catch {
      /* 无 auth.json 或内容不可解析：无需清理 */
    }
  }

  private writeRelayConfig(envHome: string, relay: RelayProfile, isLocal = false): void {
    this.assertWritableHome(envHome);
    // 本地环境：写入前先备份用户的原始 config.toml（一次性），切回官方登录时还原
    const cfgPath = this.assertWritableFile(envHome, "config.toml");
    if (isLocal) {
      // Kept for older callers; new local environments pass an app-owned runtime path.
      const bak = this.assertWritableFile(envHome, "config.toml.bak-codex-replica");
      try {
        if (fs.existsSync(cfgPath) && !fs.existsSync(bak)) fs.copyFileSync(cfgPath, bak);
      } catch {
        /* 备份失败不阻塞接入 */
      }
    }
    // 自定义模型统一走本机「工具兼容层」：内核必定回传 reasoning 条目，
    // 而第三方网关必定不认它（整份请求体 400）。兼容层剥掉后再转发给真实上游，
    // 出口网络仍走系统代理。详见 relayCompat.ts。
    const compatBaseUrl = relayCompatBaseUrl();
    if (compatBaseUrl) setRelayCompatUpstream(relay.baseUrl);
    const kernelBaseUrl = compatBaseUrl ?? relay.baseUrl;
    const lines = [
      "# 由本应用环境管理器生成（OpenAI 兼容自定义模型接入）",
      `model_provider = ${tomlStr(PROVIDER_ID)}`,
      `model = ${tomlStr(relay.model || "gpt-6-astra")}`,
      // 高级项：留空即不写入，内核走自己的默认/内置目录判定
      ...(typeof relay.contextWindow === "number" && relay.contextWindow > 0
        ? [`model_context_window = ${Math.round(relay.contextWindow)}`]
        : []),
      ...(relay.reasoningEffort ? [`model_reasoning_effort = ${tomlStr(relay.reasoningEffort)}`] : []),
      // 兼容性修正（2026-09-29 实测）：内核 0.158 会往 responses 请求体里塞两种
      // 第三方 OpenAI 兼容网关不认识的工具类型，网关直接 400 拒绝**整份请求体**，
      // 表现为「发任何消息都报 Invalid JSON / unknown variant」，一条都发不出去：
      //   ① {"type":"namespace","name":"multi_agent_v1"}  ← 由 features.multi_agent 产生
      //      网关期望的 tool.type 只有 function / web_search_preview / code_interpreter / mcp
      //   ② {"type":"web_search"}  ← 新名字，网关只认旧的 web_search_preview
      // 关掉 multi_agent 与联网搜索后，请求体只剩标准 function 工具，实测 400 → 200。
      'web_search = "disabled"',
      "",
      `[model_providers.${PROVIDER_ID}]`,
      `name = ${tomlStr(relay.name)}`,
      `base_url = ${tomlStr(kernelBaseUrl)}`,
      `wire_api = ${tomlStr(relay.wireApi)}`,
      ...(relay.managedAuth
        ? [
            "requires_openai_auth = true",
            `experimental_bearer_token = ${tomlStr(relay.experimentalBearerToken || "PROXY_MANAGED")}`,
          ]
        : [`env_key = ${tomlStr(RELAY_ENV_KEY)}`]),
      "",
      "[features]",
      "multi_agent = false",
      "",
      // 内置浏览器：把工作区里的 WebContentsView 浏览器以 MCP 工具暴露给模型。
      // 官方是 `mcp_servers.cua_repl` → `@oai/browser-desktop/service`（再配 node REPL 发 CDP）；
      // 这里换成我们自己的小 MCP server，模型侧的能力面（navigate/snapshot/click/type/screenshot）
      // 与官方 Browser Use 基本对齐。
      // command 用 electron.exe + ELECTRON_RUN_AS_NODE，等价于纯 node（官方也是这么起的）。
      BROWSER_MCP_MARKER,
      `command = ${tomlStr(process.execPath)}`,
      `args = ${JSON.stringify([path.join(app.getAppPath(), "tools", "browser-mcp.cjs")])}`,
      'env = { ELECTRON_RUN_AS_NODE = "1", REPLICA_BROWSER_BRIDGE = "auto" }',
      "",
    ];
    fs.writeFileSync(cfgPath, lines.join("\n"), "utf-8");

    // 直连自定义接口的旧内核兼容写法；受管鉴权模式不写入任何密钥。
    // 本地环境（复用官方 ~/.codex）绝不碰用户的 auth.json：密钥走进程环境变量注入。
    if (!isLocal && !relay.managedAuth && relay.apiKey) {
      try {
        const authPath = this.assertWritableFile(envHome, "auth.json");
        let auth: Record<string, unknown> = {};
        try {
          auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
        } catch {
          /* 无既有登录态 */
        }
        auth.OPENAI_API_KEY = relay.apiKey;
        fs.writeFileSync(authPath, JSON.stringify(auth), "utf-8");
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 内核启动前的配置自愈：relay（自定义模型）环境补上「第三方网关工具兼容修正」。
   *
   * 背景（2026-09-29 实测）：内核 0.158 会往 responses 请求体里塞两种第三方
   * OpenAI 兼容网关不认识的工具类型 —— `namespace`（multi_agent_v1）与 `web_search`
   * （网关只认旧的 `web_search_preview`），网关直接 400 拒绝**整份请求体**，
   * 用户表现为「发任何消息都报 Invalid JSON / unknown variant，一条都发不出去」。
   * 老版本应用写下的 config.toml 缺这两个开关，这里在 spawn 内核之前补齐。
   *
   * 只补不改：已有兼容修正的文件直接跳过，避免覆盖用户在「编辑配置」里的手改。
   */
  syncRelayConfig(env: EnvProfile): void {
    if (env.mode !== "relay" || !env.relayId) return;
    const relay = this.reg.relays.find((r) => r.id === env.relayId);
    if (!relay) return;
    // 无论本次是否需要重写配置，都要把上游地址告诉常驻的兼容层 ——
    // 否则命中下面的「已兼容直接返回」分支时，兼容层不知道转发到哪（会 503）。
    setRelayCompatUpstream(relay.baseUrl);
    const registered = this.envById(env.id);
    if (!registered) throw new Error("环境不存在");
    if (registered.kind === "local" && !isKernelRuntimeHome(this.userData, env.codexHome, registered.id, registered.codexHome)) {
      throw new Error("本地模型配置必须显式传入托管 runtimeEnv，禁止写入只读源");
    }
    const runtime = registered.kind === "local" ? env.codexHome : this.writeHome(registered.id);
    const cfgPath = this.assertWritableFile(runtime, "config.toml");
    try {
      const current = fs.readFileSync(cfgPath, "utf-8");
      // 除了工具兼容修正，还要确认内置浏览器的 MCP 登记在（老配置里没有这段，
      // 不重新生成的话模型永远拿不到 browser_* 工具）
      if (isRelayConfigCompatible(current, relayCompatBaseUrl()) && current.includes(BROWSER_MCP_MARKER)) return;
    } catch {
      /* 文件不存在 → 下面直接生成 */
    }
    try {
      this.writeRelayConfig(runtime, relay, registered.kind === "local");
    } catch (error) {
      console.error("[env] relay 配置自愈失败（内核将沿用现有 config.toml）:", error);
    }
  }

  // ---------------------------------------------------------------- 模型配置档案

  upsertRelay(p: Partial<RelayProfile> & { name: string; baseUrl: string }): RelayProfile {
    let relay = this.reg.relays.find((r) => r.id === p.id);
    if (relay) {
      relay.name = p.name;
      relay.baseUrl = p.baseUrl;
      relay.apiKey = p.apiKey || relay.apiKey;
      relay.wireApi = p.wireApi ?? relay.wireApi;
      relay.model = p.model ?? relay.model;
      relay.managedAuth = p.managedAuth ?? relay.managedAuth;
      relay.experimentalBearerToken = p.experimentalBearerToken ?? relay.experimentalBearerToken;
      // 高级项允许被显式清空（null = 回归自动），所以不能用 ?? 兜底传播 undefined
      if (p.contextWindow !== undefined) relay.contextWindow = p.contextWindow;
      if (p.reasoningEffort !== undefined) relay.reasoningEffort = p.reasoningEffort;
      // 编辑不改变档案来源：本地导入的档案手动改过之后仍标记为 local
      if (p.origin) relay.origin = p.origin;
    } else {
      relay = {
        id: newId("relay"),
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey ?? "",
        wireApi: p.wireApi ?? "responses",
        model: p.model ?? "gpt-6-astra",
        contextWindow: p.contextWindow ?? null,
        reasoningEffort: p.reasoningEffort ?? null,
        managedAuth: Boolean(p.managedAuth),
        experimentalBearerToken: p.experimentalBearerToken,
        origin: p.origin ?? "manual",
      };
      this.reg.relays.push(relay);
    }
    this.save();
    // 非当前本地环境也刷新已提交 runtime；未初始化时仅保存档案。
    for (const env of this.reg.envs) {
      if (env.mode === "relay" && env.relayId === relay.id) {
        const home = env.kind === "local" ? this.runtimeHomeFor(env.id) : this.writeHome(env.id);
        if (home) this.writeRelayConfig(home, relay, env.kind === "local");
      }
    }
    return relay;
  }

  /**
   * 从本机 ~/.codex/config.toml 读取当前激活的自定义接口配置。
   * 只读一份快照存进本应用的服务商档案，绝不写回官方目录。
   */
  importLocalCodexConfig(): RelayProfile {
    const configPath = path.join(this.officialHome(), "config.toml");
    if (!fs.existsSync(configPath)) throw new Error("未找到 ~/.codex/config.toml");
    const text = fs.readFileSync(configPath, "utf-8");
    const readString = (block: string, key: string): string | undefined => {
      const match = new RegExp(String.raw`^\s*${key}\s*=\s*(?:"([^"]*)"|'([^']*)')`, "m").exec(block);
      return match?.[1] ?? match?.[2];
    };
    // 数字项在 TOML 里通常不带引号（model_context_window = 128000），readString 抓不到
    const readNumber = (block: string, key: string): number | null => {
      const match = new RegExp(String.raw`^\s*${key}\s*=\s*(\d[\d_]*)`, "m").exec(block);
      return match ? Number(match[1].replace(/_/g, "")) || null : null;
    };
    const providerId = readString(text, "model_provider") || "custom";
    const escapedProvider = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 注意：这里不能带 m 标志。带 m 时 $ 会匹配任意行尾，惰性量词会在 provider 段第一行就停下，
    // 结果 block 只剩 "name = ..."，base_url 永远读不到。
    const providerMatch = new RegExp(String.raw`\[model_providers\.${escapedProvider}\]\s*([\s\S]*?)(?=\n\s*\[|$)`).exec(text);
    const block = providerMatch?.[1] ?? text;
    const baseUrl = readString(block, "base_url");
    if (!baseUrl) throw new Error("~/.codex/config.toml 中没有 base_url");
    const relay: RelayProfile = {
      id: "",
      name: readString(block, "name") || "本机 Codex 配置",
      // 尾斜杠会让内核拼接 URL 时出现双斜杠（base_url//responses）
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: "",
      wireApi: readString(block, "wire_api") === "chat" ? "chat" : "responses",
      model: readString(text, "model") || "gpt-6-astra",
      contextWindow: readNumber(text, "model_context_window"),
      reasoningEffort: readString(text, "model_reasoning_effort") ?? null,
      managedAuth: readString(block, "experimental_bearer_token") !== undefined || readString(block, "requires_openai_auth") === "true",
      experimentalBearerToken: readString(block, "experimental_bearer_token") || "PROXY_MANAGED",
      origin: "local",
    };
    // 同一个 base_url + 托管鉴权特征的档案视为同一个，避免反复导入生成重复项
    const existing = this.reg.relays.find((r) => r.managedAuth && r.baseUrl === relay.baseUrl) ?? this.reg.relays.find((r) => r.name === relay.name);
    if (existing) relay.id = existing.id;
    return this.upsertRelay(relay);
  }

  deleteRelay(id: string): void {
    const used = this.reg.envs.some((e) => e.mode === "relay" && e.relayId === id);
    if (used) throw new Error("有环境正在使用该配置，请先切换为官方登录");
    this.reg.relays = this.reg.relays.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * 读该环境 codex-home 里的项目清单。
   *
   * 官方桌面版把"项目（工作区）"存在 `<codex-home>/.codex-global-state.json`：
   *   local-projects: { <uuid>: { name, rootPaths: [路径], createdAt } }
   *   project-order: [<uuid>...]                       —— 侧栏顺序
   *   selected-project: { projectId }
   *   thread-project-assignments: { <threadId>: { projectId } }  —— 会话归属
   * 复刻版自己的项目列表在 desk-state.json 里，两边本来完全不通，
   * 所以"本地 Codex 有会话记录但项目是空的"。这里只读合并过来。
   *
   * ⚠️ 只读：这个文件是官方应用的状态文件，绝不写入。
   */
  readEnvProjects(id: string): { projects: EnvProject[]; selectedProjectId: string | null } {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    const empty = { projects: [] as EnvProject[], selectedProjectId: null };
    const file = this.dataHomes(env.id).map((home) => path.join(home, ".codex-global-state.json")).find((candidate) => fs.existsSync(candidate));
    if (!file) return empty;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      return empty; // 文件损坏/半写状态：当作没有，不影响别的功能
    }
    const local = (raw["local-projects"] ?? {}) as Record<
      string,
      { name?: unknown; rootPaths?: unknown; createdAt?: unknown }
    >;
    const order = Array.isArray(raw["project-order"]) ? (raw["project-order"] as unknown[]).map(String) : [];
    const assign = (raw["thread-project-assignments"] ?? {}) as Record<string, { projectId?: unknown }>;

    const threadIdsByProject = new Map<string, string[]>();
    for (const [threadId, value] of Object.entries(assign)) {
      const pid = value?.projectId;
      if (typeof pid !== "string") continue;
      const list = threadIdsByProject.get(pid) ?? [];
      list.push(threadId);
      threadIdsByProject.set(pid, list);
    }

    // 按 project-order 排；order 里没提到的（新加的/历史遗留）补在后面
    const ordered = [...order.filter((pid) => pid in local), ...Object.keys(local).filter((pid) => !order.includes(pid))];
    const projects: EnvProject[] = [];
    for (const pid of ordered) {
      const p = local[pid];
      const roots = Array.isArray(p?.rootPaths) ? (p.rootPaths as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const root = roots[0];
      if (!root) continue; // 没有根路径的项目（纯远程？）在本地侧栏里没法用，跳过
      projects.push({
        id: pid,
        name: (typeof p.name === "string" && p.name.trim()) || path.basename(root),
        path: root,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : undefined,
        threadIds: threadIdsByProject.get(pid) ?? [],
      });
    }
    const sel = raw["selected-project"] as { projectId?: unknown } | undefined;
    return { projects, selectedProjectId: typeof sel?.projectId === "string" ? sel.projectId : null };
  }

  private sqliteColumns(db: import("node:sqlite").DatabaseSync, table: "threads" | "thread_turns" | "thread_items"): Set<string> {
    const rows = db.prepare(`pragma table_info(${table})`).all() as { name?: unknown }[];
    return new Set(rows.filter((row) => typeof row.name === "string").map((row) => String(row.name)));
  }

  /**
   * 直接读该环境的会话清单（**不经过内核**，只读 state_*.sqlite）。
   *
   * 为什么要有这条路（2026-09-30）：内核起不来时（本机实测：自带内核 0.158 读不了
   * 官方新版迁移过的 state db，会 `failed to initialize sqlite state runtime` 直接退出），
   * 复刻版原来只能显示空列表 —— 用户看到的是「左侧对话和项目里的会话都没加载」。
   * 会话清单本来就存在这个 sqlite 里，所以内核不可用时用 node:sqlite 只读兜底，
   * 至少让历史会话先呈现出来（发消息仍然需要内核）。
   *
   * ⚠️ 只读：绝不写这个库（官方应用正在用它）。
   */
  readEnvThreads(id: string, limit = 300): { id: string; name?: string; preview?: string; cwd?: string; updatedAt?: number; createdAt?: number; recencyAt?: number; modelProvider?: string }[] {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    const dbFiles = this.dataHomes(env.id).flatMap((home) => {
      try {
        return fs.readdirSync(home, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
          .map((entry) => path.join(home, entry.name));
      } catch {
        return [];
      }
    });
    if (!dbFiles.length) return [];
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"));
    } catch {
      return [];
    }
    type ThreadRow = { id: string; name?: string; preview?: string; cwd?: string; updatedAt?: number; createdAt?: number; recencyAt?: number; modelProvider?: string };
    const merged = new Map<string, ThreadRow>();
    for (const dbFile of dbFiles) {
      let db: import("node:sqlite").DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbFile, { readOnly: true });
        const columns = this.sqliteColumns(db, "threads");
        if (!columns.has("id")) continue;
        const select = ["id", "name", "title", "preview", "first_user_message", "cwd", "created_at_ms", "updated_at_ms", "recency_at_ms", "model_provider"]
          .map((name) => columns.has(name) ? `"${name}"` : `null as "${name}"`).join(", ");
        const order = ["recency_at_ms", "updated_at_ms", "created_at_ms"]
          .filter((name) => columns.has(name)).map((name) => `"${name}" desc`).join(", ");
        const where = columns.has("archived") ? `where coalesce("archived", 0) = 0` : "";
        const rows = db.prepare(
          `select ${select} from threads ${where}${order ? ` order by ${order}` : ""} limit ?`,
        ).all(limit) as Record<string, unknown>[];
        for (const r of rows) {
          const thread: ThreadRow = {
            id: String(r.id),
            name: String(r.name ?? r.title ?? r.first_user_message ?? r.preview ?? "").trim() || undefined,
            preview: typeof r.preview === "string" ? r.preview : undefined,
            cwd: typeof r.cwd === "string" ? r.cwd.replace(/^\\\\\?\\/, "") : undefined,
            updatedAt: Number(r.updated_at_ms ?? r.created_at_ms ?? 0) || undefined,
            createdAt: Number(r.created_at_ms ?? 0) || undefined,
            // recency_at_ms 是内核给会话列表排序用的键（**不是** updated_at_ms）。
            // 渲染层要把「本地库读到的会话」和「内核 thread/list 的会话」合并排序，
            // 必须用同一个键，否则两边顺序对不上、条目会错位。
            recencyAt: Number(r.recency_at_ms ?? 0) || undefined,
            // 记下创建这条会话时用的模型 provider。内核的 thread/list 只返回
            // **当前 provider** 的会话，靠这个字段才能判断某条会话为什么被内核隐藏。
            modelProvider: typeof r.model_provider === "string" ? r.model_provider : undefined,
          };
          if (!merged.has(thread.id)) merged.set(thread.id, thread);
        }
      } catch (error) {
        console.warn(`[env:threads] 读 ${dbFile} 失败：`, String(error).slice(0, 200));
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
    }
    return [...merged.values()]
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
      .slice(0, limit);
  }

  /**
   * 直接读某个会话的完整正文（turns + items），**不经过内核**。
   *
   * 数据源：`thread_history_1.sqlite` —— 官方把每个会话的回合与条目都投影进去了
   * （thread_turns / thread_items，共 7000+ 条实测），`item_json` 就是 app 协议里的
   * item 结构（type/id/content/text/changes…），所以能直接喂给渲染层。
   *
   * 为什么需要（2026-09-30）：内核起不来时点开会话是**全空白**的，
   * 侧栏有会话但正文没有内容，用户看到的就是「点开什么都看不到」。
   *
   * ⚠️ 只读；时间戳在该库里是**秒**，返回给渲染层统一换算成毫秒。
   */
  readEnvTurns(id: string, threadId: string, limit = 200): unknown[] {
    const env = this.envById(id);
    if (!env) throw new Error("环境不存在");
    if (!threadId) return [];
    const files = this.dataHomes(env.id).flatMap((home) => {
      try {
        return fs.readdirSync(home, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^thread_history_\d+\.sqlite$/i.test(entry.name))
          .map((entry) => path.join(home, entry.name));
      } catch {
        return [];
      }
    });
    const merged = new Map<string, Record<string, unknown>>();
    for (const file of files) {
      for (const turn of this.readTurnsFromDatabase(file, threadId, limit)) {
        if (typeof turn.id !== "string" || !turn.id) continue;
        const existing = merged.get(turn.id);
        if (!existing) {
          merged.set(turn.id, turn);
          continue;
        }
        const items = Array.isArray(existing.items) ? existing.items : [];
        const secondaryItems = Array.isArray(turn.items) ? turn.items : [];
        const known = new Set(items.map((item) => typeof item === "object" && item ? (item as { id?: unknown }).id : undefined));
        existing.items = [...items, ...secondaryItems.filter((item) => {
          const itemId = typeof item === "object" && item ? (item as { id?: unknown }).id : undefined;
          return itemId !== undefined && !known.has(itemId);
        })];
      }
    }
    return [...merged.values()].sort((a, b) => Number(a.startedAtMs ?? 0) - Number(b.startedAtMs ?? 0)).slice(0, limit);
  }

  private readTurnsFromDatabase(dbFile: string, threadId: string, limit: number): Record<string, unknown>[] {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite"));
    } catch {
      return [];
    }
    let db: import("node:sqlite").DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const secToMs = (v: unknown): number | undefined => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return undefined;
        return n > 1e12 ? n : Math.round(n * 1000); // 兼容秒/毫秒两种写法
      };
      const turnColumns = this.sqliteColumns(db, "thread_turns");
      if (!turnColumns.has("thread_id") || !turnColumns.has("turn_id")) return [];
      const turnSelect = ["turn_id", "status", "error_json", "started_at", "started_at_ms", "completed_at", "completed_at_ms", "duration_ms", "rollout_ordinal"]
        .map((name) => turnColumns.has(name) ? `"${name}"` : `null as "${name}"`).join(", ");
      const turnOrder = ["rollout_ordinal", "started_at", "started_at_ms"].filter((name) => turnColumns.has(name))
        .map((name) => `"${name}" asc`).join(", ");
      const turnRows = db.prepare(
        `select ${turnSelect} from thread_turns where thread_id = ?${turnOrder ? ` order by ${turnOrder}` : ""} limit ?`,
      ).all(threadId, limit) as Record<string, unknown>[];
      if (!turnRows.length) return [];
      const itemColumns = this.sqliteColumns(db, "thread_items");
      let itemRows: Record<string, unknown>[] = [];
      if (itemColumns.has("thread_id") && itemColumns.has("turn_id") && itemColumns.has("item_json")) {
        const itemSelect = ["turn_id", "item_id", "item_type", "item_json", "rollout_ordinal", "created_at_ms", "started_at_ms", "completed_at_ms"]
          .map((name) => itemColumns.has(name) ? `"${name}"` : `null as "${name}"`).join(", ");
        const itemOrder = ["rollout_ordinal", "created_at_ms"].filter((name) => itemColumns.has(name))
          .map((name) => `"${name}" asc`).join(", ");
        itemRows = db.prepare(
          `select ${itemSelect} from thread_items where thread_id = ?${itemOrder ? ` order by ${itemOrder}` : ""}`,
        ).all(threadId) as Record<string, unknown>[];
      }

      const byTurn = new Map<string, Record<string, unknown>[]>();
      for (const row of itemRows) {
        const key = String(row.turn_id ?? "");
        if (!key) continue;
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(String(row.item_json ?? "{}")) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        // id 一律以库里的列为准（item_json 里多数也有，但保证一定有）
        if (typeof parsed.id !== "string") parsed.id = String(row.item_id ?? "");
        if (typeof parsed.type !== "string" && typeof row.item_type === "string") parsed.type = row.item_type;
        const created = secToMs(row.created_at_ms);
        if (parsed.createdAt == null && created != null) parsed.createdAt = created;
        const started = secToMs(row.started_at_ms);
        if (parsed.startedAtMs == null && started != null) parsed.startedAtMs = started;
        const completed = secToMs(row.completed_at_ms);
        if (parsed.completedAtMs == null && completed != null) parsed.completedAtMs = completed;
        if (typeof parsed.status !== "string") {
          parsed.status = completed != null ? "completed" : "inProgress";
        }
        const list = byTurn.get(key) ?? [];
        list.push(parsed);
        byTurn.set(key, list);
      }

      return turnRows.map((turn) => {
        const turnId = String(turn.turn_id ?? "");
        let errorMessage: string | undefined;
        if (typeof turn.error_json === "string" && turn.error_json) {
          try {
            const parsed = JSON.parse(turn.error_json) as { message?: unknown };
            if (typeof parsed.message === "string") errorMessage = parsed.message;
          } catch {
            /* 忽略坏 JSON */
          }
        }
        const durationMs = Number(turn.duration_ms);
        return {
          id: turnId,
          items: byTurn.get(turnId) ?? [],
          startedAtMs: turn.started_at_ms != null ? Number(turn.started_at_ms) || undefined : secToMs(turn.started_at),
          completedAtMs: turn.completed_at_ms != null ? Number(turn.completed_at_ms) || undefined : secToMs(turn.completed_at),
          status: typeof turn.status === "string" ? turn.status : undefined,
          error: errorMessage ? { message: errorMessage } : undefined,
          durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
        };
      });
    } catch (error) {
      console.warn(`[env:turns] 读 ${dbFile} 失败：`, String(error).slice(0, 200));
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- 官方数据导入
  private officialHome(): string {
    return path.join(os.homedir(), ".codex");
  }

  detectOfficial(): OfficialInfo {
    const home = this.officialHome();
    const exists = fs.existsSync(home);
    let sessionCount = 0;
    if (exists) {
      const sessionsDir = path.join(home, "sessions");
      sessionCount = this.countJsonl(sessionsDir, 5000);
    }
    return {
      home,
      exists,
      hasAuth: exists && fs.existsSync(path.join(home, "auth.json")),
      hasConfig: exists && fs.existsSync(path.join(home, "config.toml")),
      sessionCount,
      hasSkills: exists && fs.existsSync(path.join(home, "skills")),
    };
  }

  private countJsonl(dir: string, cap: number): number {
    let n = 0;
    const walk = (d: string) => {
      if (n >= cap) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (n >= cap) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith(".jsonl")) n += 1;
      }
    };
    walk(dir);
    return n;
  }

  /** 一次性复制官方登录态到目标环境（官方 refresh token 轮换，不做实时共享） */
  importOfficialAuth(envId: string): { ok: boolean; backedUp: boolean } {
    const src = path.join(this.officialHome(), "auth.json");
    if (!fs.existsSync(src)) throw new Error("官方目录没有 auth.json");
    const env = this.envById(envId);
    if (!env) throw new Error("环境不存在");
    const dst = path.join(env.codexHome, "auth.json");
    let backedUp = false;
    if (fs.existsSync(dst)) {
      fs.copyFileSync(dst, `${dst}.bak-${Date.now()}`);
      backedUp = true;
    }
    fs.copyFileSync(src, dst);
    return { ok: true, backedUp };
  }

  /** 只读导入官方会话历史（rollout 文件树 + 线程索引库），已有同名文件跳过 */
  importOfficialSessions(envId: string): { count: number; importedIndex: boolean } {
    const official = this.officialHome();
    const srcRoot = path.join(official, "sessions");
    if (!fs.existsSync(srcRoot)) throw new Error("官方目录没有 sessions");
    const env = this.envById(envId);
    if (!env) throw new Error("环境不存在");
    const dstRoot = path.join(env.codexHome, "sessions");
    let count = 0;
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const s = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(s, r);
        } else if (e.isFile() && e.name.endsWith(".jsonl")) {
          const d = path.join(dstRoot, r);
          if (!fs.existsSync(d)) {
            fs.mkdirSync(path.dirname(d), { recursive: true });
            fs.copyFileSync(s, d);
            count += 1;
          }
        }
      }
    };
    walk(srcRoot, "");
    // 会话索引文件
    const idxSrc = path.join(official, "session_index.jsonl");
    const idxDst = path.join(env.codexHome, "session_index.jsonl");
    if (fs.existsSync(idxSrc) && !fs.existsSync(idxDst)) {
      fs.copyFileSync(idxSrc, idxDst);
    }
    // 线程索引库：thread/list 从 state DB 读取，只拷 rollout 文件列表里看不见。
    // 仅当目标环境还没有自己的索引库时才复制（绝不覆盖环境已有会话）。
    let importedIndex = false;
    const dbFiles = ["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"];
    const dstDb = path.join(env.codexHome, "state_5.sqlite");
    if (!fs.existsSync(dstDb)) {
      for (const f of dbFiles) {
        const s = path.join(official, f);
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(env.codexHome, f));
      }
      importedIndex = fs.existsSync(dstDb);
    }
    return { count, importedIndex };
  }

  /** 技能目录共享：junction 链到官方 ~/.codex/skills（Windows 免管理员权限） */
  setSkillsShare(envId: string, enabled: boolean): { ok: boolean } {
    const officialSkills = path.join(this.officialHome(), "skills");
    const env = this.envById(envId);
    if (!env) throw new Error("环境不存在");
    const envSkills = path.join(env.codexHome, "skills");
    if (enabled) {
      fs.mkdirSync(officialSkills, { recursive: true });
      if (this.isLink(envSkills)) {
        return { ok: true };
      }
      if (fs.existsSync(envSkills)) {
        const empty = fs.readdirSync(envSkills).length === 0;
        if (!empty) throw new Error("该环境已有自己的技能目录且非空，无法改为共享");
        fs.rmdirSync(envSkills);
      }
      fs.symlinkSync(officialSkills, envSkills, "junction");
      env.skillsShared = true;
    } else {
      // Windows 上目录 junction 用 rmdir 更能保证成功（unlink 对部分 junction 会 EPERM）
      if (this.isLink(envSkills)) {
        try {
          fs.unlinkSync(envSkills);
        } catch {
          fs.rmdirSync(envSkills);
        }
      }
      env.skillsShared = false;
    }
    this.save();
    return { ok: true };
  }

  private isLink(p: string): boolean {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }
}
