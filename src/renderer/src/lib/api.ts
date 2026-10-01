/** 与 codex app-server 的类型化 RPC 客户端（浏览器侧声明，经 preload 桥接主进程） */

export interface NotificationPayload {
  method: string;
  params: Record<string, unknown>;
}
export interface ServerRequestPayload {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

declare global {
  interface Window {
    codex: {
      request: (method: string, params: unknown) => Promise<unknown>;
      approvalResponse: (id: string, response: unknown) => Promise<boolean>;
      onNotification: (cb: (n: NotificationPayload) => void) => () => void;
      onServerRequest: (cb: (r: ServerRequestPayload) => void) => () => void;
      onApprovalTimeout: (cb: (id: string) => void) => () => void;
      onServerExit: (cb: (code: number | null) => void) => () => void;
      getDeskState: () => Promise<DeskStateShape | undefined>;
      setDeskState: (patch: Record<string, unknown>) => Promise<DeskStateShape | undefined>;
      appInfo: () => Promise<{ version: string; codexHome: string; userData: string; isDev: boolean }>;
      openExternal: (url: string) => Promise<void>;
      editCommand: (cmd: string) => Promise<boolean>;
      newWindow: () => Promise<{ ok: boolean }>;
      envRpc: (channel: string, payload?: unknown) => Promise<unknown>;
      /** 内置浏览器（主进程 WebContentsView） */
      browserRpc: (channel: string, payload?: unknown) => Promise<unknown>;
      onBrowserState: (cb: (state: BrowserTabState) => void) => () => void;
      onBrowserOpenUrl: (cb: (url: string) => void) => () => void;
      onBrowserAddTab: (cb: (tab: { id: string; url: string }) => void) => () => void;
    };
  }
}

/** 主进程内置浏览器上报的标签状态 */
export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon: string | null;
  error: string | null;
}

/**
 * 内置浏览器 IPC 封装 —— 浏览器是**主进程的 WebContentsView**（对齐官方），
 * 渲染层不画页面，只报告"页面区域"的矩形 + 驱动工具条。
 */
export const browserApi = {
  list: () => window.codex.browserRpc("browser:list") as Promise<{ activeId: string | null; tabs: BrowserTabState[] }>,
  create: (id: string) => window.codex.browserRpc("browser:create", id) as Promise<BrowserTabState>,
  close: (id: string) => window.codex.browserRpc("browser:close", id) as Promise<boolean>,
  activate: (id: string | null) => window.codex.browserRpc("browser:activate", id) as Promise<boolean>,
  setBounds: (rect: { x: number; y: number; width: number; height: number }) =>
    window.codex.browserRpc("browser:set-bounds", rect) as Promise<boolean>,
  navigate: (id: string, url: string) => window.codex.browserRpc("browser:navigate", { id, url }) as Promise<boolean>,
  back: (id: string) => window.codex.browserRpc("browser:back", { id }) as Promise<boolean>,
  forward: (id: string) => window.codex.browserRpc("browser:forward", { id }) as Promise<boolean>,
  reload: (id: string) => window.codex.browserRpc("browser:reload", { id }) as Promise<boolean>,
  stop: (id: string) => window.codex.browserRpc("browser:stop", { id }) as Promise<boolean>,
  snapshot: (id: string) => window.codex.browserRpc("browser:snapshot", { id }) as Promise<string>,
  screenshot: (id: string) => window.codex.browserRpc("browser:screenshot", { id }) as Promise<string>,
  cdp: (id: string, method: string, params?: unknown) =>
    window.codex.browserRpc("browser:cdp", { id, method, params }) as Promise<unknown>,
  onState: (cb: (state: BrowserTabState) => void) => window.codex.onBrowserState(cb as (s: unknown) => void),
  onOpenUrl: (cb: (url: string) => void) => window.codex.onBrowserOpenUrl(cb),
  onAddTab: (cb: (tab: { id: string; url: string }) => void) => window.codex.onBrowserAddTab(cb),
};

// ------------------------------------------------------------- 环境管理类型

export interface EnvInfo {
  id: string;
  name: string;
  codexHome: string;
  createdAt: string;
  mode: "chatgpt" | "relay";
  relayId: string | null;
  skillsShared: boolean;
  /** local = 原地复用本机 ~/.codex（零拷贝）；isolated = 独立数据目录 */
  kind: "isolated" | "local";
  /** 数据目录是否归应用托管：false（自定义目录 / 本地 Codex）删环境时只解除登记，不删文件 */
  managed?: boolean;
}

export interface RelayInfo {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  wireApi: "responses" | "chat";
  model: string;
  /** 可选高级项：null = 不写入 config.toml，内核按内置模型目录自动判定 */
  contextWindow?: number | null;
  /** 思考等级：none | low | medium | high | xhigh | max */
  reasoningEffort?: string | null;
  managedAuth?: boolean;
  experimentalBearerToken?: string;
  /** 档案来源：local = 从本机 Codex 配置导入；manual = 手动新建 */
  origin?: "local" | "manual";
}

/** 环境目录里记录的官方项目（工作区） */
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

export interface EnvListResult {
  activeId: string;
  envs: EnvInfo[];
  relays: RelayInfo[];
  official: OfficialInfo;
}

export interface RelayUpsertPayload {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  wireApi?: "responses" | "chat";
  model?: string;
  contextWindow?: number | null;
  reasoningEffort?: string | null;
  managedAuth?: boolean;
  experimentalBearerToken?: string;
}

export interface DeskStateShape {
  projects: { name: string; path: string; lastOpenedAt: number }[];
  preferences: {
    theme: "system" | "light" | "dark";
    model: string;
    effort: string;
    permission: "read-only" | "workspace-write" | "full-access";
    notifications: boolean;
    sendShortcut: "enter" | "mod-enter";
    fontSize: number;
    pinnedThreads: string[];
    /** 常规设置扩展（对齐官方设置页） */
    shell: string;
    lang: string;
    fullView: boolean;
    bottomPanel: boolean;
    promptSuggest: boolean;
    projectsFolder: string;
  };
}

export interface ThreadSummary {
  id: string;
  name?: string | null;
  preview?: string;
  title?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  /**
   * 内核给会话列表排序用的键。⚠️ 内核返回时单位是**秒**，
   * 本地库（env:threads）是**毫秒** —— 比较前必须归一化（见 store 的 recencyOf）。
   */
  recencyAt?: number;
  /** 创建该会话时用的 model provider（本地库路径才有；内核 thread/list 不返回） */
  modelProvider?: string;
  sourceKinds?: string[];
}

export const rpc = {
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return window.codex.request(method, params ?? {}) as Promise<T>;
  },
  onNotification: (cb: (n: NotificationPayload) => void) => window.codex.onNotification(cb),
  onServerRequest: (cb: (r: ServerRequestPayload) => void) => window.codex.onServerRequest(cb),
  onApprovalTimeout: (cb: (id: string) => void) => window.codex.onApprovalTimeout(cb),
  onServerExit: (cb: (code: number | null) => void) => window.codex.onServerExit(cb),
  approvalResponse: (id: string, response: unknown) => window.codex.approvalResponse(id, response),
  deskState: {
    get: () => window.codex.getDeskState(),
    set: (patch: Record<string, unknown>) => window.codex.setDeskState(patch),
  },
  appInfo: () => window.codex.appInfo(),
  /** 最近一次内核配置问题（启动时的告警会错过广播，界面主动来取） */
  kernelIssue: () =>
    window.codex.envRpc("app:kernel-issue") as Promise<{
      level: "error" | "warn" | "info";
      message: string;
      silent?: boolean;
    } | null>,
  kernelRetry: () =>
    window.codex.envRpc("app:kernel-retry") as Promise<{ ok: boolean; message?: string }>,
  openExternal: (url: string) => window.codex.openExternal(url),
  /** 编辑菜单命令（undo/redo/cut/copy/paste/selectAll） */
  editCommand: (cmd: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") =>
    window.codex.editCommand(cmd) as Promise<boolean>,
  /** 新建应用窗口 */
  newWindow: () => window.codex.newWindow(),
  /** 把解析后的主题同步给原生窗口控件（深色下图标要转白） */
  setTheme: (theme: "light" | "dark") =>
    window.codex.envRpc("app:set-theme", theme) as Promise<{ ok: boolean }>,
  env: {
    list: () => window.codex.envRpc("env:list") as Promise<EnvListResult>,
    create: (p: { name: string; codexHome?: string; importAuthFromLocal?: boolean }) =>
      window.codex.envRpc("env:create", p) as Promise<EnvInfo>,
    /** 在文件管理器里打开该环境的数据目录 */
    openDir: (id: string) =>
      window.codex.envRpc("env:open-dir", id) as Promise<{ ok: boolean; path: string }>,
    /** 读写环境里的配置文件（仅 config.toml / AGENTS.md 白名单） */
    readFile: (id: string, name: string) =>
      window.codex.envRpc("env:read-file", { id, name }) as Promise<{
        path: string;
        exists: boolean;
        text: string;
      }>,
    writeFile: (id: string, name: string, text: string) =>
      window.codex.envRpc("env:write-file", { id, name, text }) as Promise<{
        path: string;
        backedUp: boolean;
      }>,
    /** 读该环境里官方桌面版留下的项目清单（.codex-global-state.json，只读） */
    projects: (id: string) =>
      window.codex.envRpc("env:projects", id) as Promise<{
        projects: EnvProject[];
        selectedProjectId: string | null;
      }>,
    /**
     * 不经内核直读该环境的会话清单（只读 state_5.sqlite）。
     * 内核起不来时用它兜底，保证左侧「最近 / 项目里的会话」不是空的。
     */
    threads: (id: string) =>
      window.codex.envRpc("env:threads", id) as Promise<{
        threads: {
          id: string;
          name?: string;
          preview?: string;
          cwd?: string;
          updatedAt?: number;
          createdAt?: number;
          /** 内核排序用的键（毫秒）。与 thread/list 的 recencyAt 同源，合并排序时必须用它 */
          recencyAt?: number;
          /** 创建该会话时用的 model provider —— 内核 thread/list 只返回当前 provider 的会话 */
          modelProvider?: string;
        }[];
        error?: string;
      }>,
    /** 不经内核直读某会话正文（turns + items，内核起不来时的兜底） */
    turns: (id: string, threadId: string) =>
      window.codex.envRpc("env:turns", { id, threadId }) as Promise<{ data: unknown[]; error?: string }>,
    /** 登记「本地 Codex」环境：原地复用 ~/.codex，零拷贝零导入 */
    addLocal: () => window.codex.envRpc("env:add-local") as Promise<EnvInfo>,
    switch: (id: string) => window.codex.envRpc("env:switch", id) as Promise<{ ok: boolean }>,
    remove: (id: string) => window.codex.envRpc("env:delete", id) as Promise<{ ok: boolean }>,
    setMode: (id: string, mode: "chatgpt" | "relay", relayId?: string | null) =>
      window.codex.envRpc("env:set-mode", { id, mode, relayId: relayId ?? null }) as Promise<{ ok: boolean }>,
    importAuth: (id: string) =>
      window.codex.envRpc("env:import-auth", id) as Promise<{ ok: boolean; backedUp: boolean }>,
    importSessions: (id: string) =>
      window.codex.envRpc("env:import-sessions", id) as Promise<{
        count: number;
        importedIndex: boolean;
      }>,
    skillsShare: (id: string, enabled: boolean) =>
      window.codex.envRpc("env:skills-share", { id, enabled }) as Promise<{ ok: boolean }>,
    relayUpsert: (p: RelayUpsertPayload) => window.codex.envRpc("relay:upsert", p) as Promise<RelayInfo>,
    relayDelete: (id: string) => window.codex.envRpc("relay:delete", id) as Promise<{ ok: boolean }>,
    listSkills: () =>
      window.codex.envRpc("customize:list-skills") as Promise<{ name: string; desc: string }[]>,
    pickFolder: () => window.codex.envRpc("app:pick-folder") as Promise<string | null>,
    /** 读取本机 ~/.codex/config.toml 里已配置好的自定义接口（不写官方目录） */
    importLocalConfig: () => window.codex.envRpc("env:import-local-config") as Promise<RelayInfo>,
    /** 探活：GET {baseUrl}/models，返回 HTTP 状态与模型数量 */
    relayTest: (p: { baseUrl: string; apiKey?: string; relayId?: string }) =>
      window.codex.envRpc("relay:test", p) as Promise<RelayTestResult>,
    /** 拉取可选模型列表：GET {baseUrl}/models，顺带带回服务端自报的上下文窗口 */
    relayModels: (p: { baseUrl: string; apiKey?: string; relayId?: string }) =>
      window.codex.envRpc("relay:models", p) as Promise<RelayModelsResult>,
  },
};

export interface RelayTestResult {
  ok: boolean;
  status?: number;
  models?: number;
  message?: string;
}

export interface RelayModelEntry {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutput?: number;
  supportsReasoning?: boolean;
}

export interface RelayModelsResult {
  ok: boolean;
  status?: number;
  /** 响应体是否解析出模型数组：false 时 models 为空不代表"服务端没有模型" */
  parsed: boolean;
  models: RelayModelEntry[];
  message?: string;
}

/** 协议方法名（对齐 codex app-server v2 命名，小写开头） */
export const M = {
  threadList: "thread/list",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadRead: "thread/read",
  /**
   * 会话历史用 thread/turns/list，不是 thread/items/list。
   * 内置内核 0.158.0-alpha.9 对 thread/items/list 返回 -32601
   * 「is not supported yet」；thread/read(includeTurns) 与 thread/resume
   * 也会撞上未实现的 list_turns。实测 turns/list + itemsView:"full"
   * 会返回每个 turn 的 items，是这份内核唯一可用的历史读取入口。
   */
  threadTurnsList: "thread/turns/list",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  modelList: "model/list",
  accountRead: "account/read",
  accountLoginStart: "account/login/start",
  accountLoginCancel: "account/login/cancel",
  accountLogout: "account/logout",
} as const;

/** 服务端请求方法名（审批 + 工具索要输入） */
export const SR = {
  execApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  /** 模型向用户提问：必须回 {answers}，不回会让 turn 永久挂起 */
  requestUserInput: "item/tool/requestUserInput",
} as const;

/** 内核 error 通知（turn 失败时唯一会告诉用户原因的通道） */
export interface TurnErrorNotification {
  method: "error";
  params: {
    threadId?: string;
    turnId?: string;
    willRetry?: boolean;
    error?: { message?: string; additionalDetails?: string | null; codexErrorInfo?: unknown };
  };
}
