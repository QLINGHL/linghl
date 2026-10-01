import { contextBridge, ipcRenderer } from "electron";

/** 环境管理通道白名单（渲染层只能调这些，防任意 IPC） */
const ENV_CHANNELS = new Set([
  "env:list",
  "env:create",
  "env:add-local",
  "env:open-dir",
  "env:read-file",
  "env:write-file",
  "env:projects",
  "env:threads",
  "env:turns",
  "app:kernel-issue",
  "app:kernel-retry",
  "env:switch",
  "env:delete",
  "env:set-mode",
  "env:import-auth",
  "env:import-sessions",
  "env:skills-share",
  "relay:upsert",
  "relay:delete",
  "customize:list-skills",
  "app:pick-folder",
  "env:import-local-config",
  "relay:test",
  "relay:models",
  "app:open-external",
  "app:set-theme",
]);

/** 内置浏览器通道白名单（主进程 WebContentsView 那套） */
const BROWSER_CHANNELS = new Set([
  "browser:list",
  "browser:create",
  "browser:close",
  "browser:activate",
  "browser:set-bounds",
  "browser:navigate",
  "browser:back",
  "browser:forward",
  "browser:reload",
  "browser:stop",
  "browser:cdp",
  "browser:snapshot",
  "browser:screenshot",
]);

const api = {
  request: (method: string, params: unknown) => ipcRenderer.invoke("codex:request", { method, params }),  approvalResponse: (id: string, response: unknown) =>
    ipcRenderer.invoke("codex:approval-response", { id, response }),
  onNotification: (cb: (n: { method: string; params: unknown }) => void) => {
    const handler = (_e: unknown, n: { method: string; params: unknown }) => cb(n);
    ipcRenderer.on("codex:notification", handler);
    return () => ipcRenderer.removeListener("codex:notification", handler);
  },
  onServerRequest: (cb: (req: { id: string; method: string; params: unknown }) => void) => {
    const handler = (_e: unknown, req: { id: string; method: string; params: unknown }) => cb(req);
    ipcRenderer.on("codex:server-request", handler);
    return () => ipcRenderer.removeListener("codex:server-request", handler);
  },
  /** app-server 进程退出/启动失败（code 为 null 表示启动失败）：界面必须解除回合锁定 */
  onServerExit: (cb: (code: number | null) => void) => {
    const handler = (_e: unknown, code: number | null) => cb(code);
    ipcRenderer.on("codex:exit", handler);
    return () => ipcRenderer.removeListener("codex:exit", handler);
  },
  /** 审批/提问等待超时（主进程已按"拒绝/跳过"答复内核）——界面要把横幅收掉，
   *  否则会留下一个点了也没用的死横幅 */
  onApprovalTimeout: (cb: (id: string) => void) => {
    const handler = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on("codex:approval-timeout", handler);
    return () => ipcRenderer.removeListener("codex:approval-timeout", handler);
  },
  getDeskState: () => ipcRenderer.invoke("desk-state:get"),
  setDeskState: (patch: Record<string, unknown>) => ipcRenderer.invoke("desk-state:set", patch),
  appInfo: () => ipcRenderer.invoke("app:info"),
  /**
   * 首帧诊断打点（2026-10-01 第三轮启动优化）。
   *
   * "空白窗口 2~3 秒"这个体感必须可量化，否则每次优化都只能靠猜。
   * 渲染层在脚本开始执行 / React 首次提交 / 浏览器真正画出第一帧三个时刻各打一个点，
   * 主进程把它们和 boot() 的时间轴对齐写进 boot.log。
   * 纯诊断用途，用 send（不等回复）避免给启动路径加上任何 IPC 往返。
   */
  bootMark: (mark: string, atMs: number) => {
    try {
      ipcRenderer.send("app:boot-mark", { mark, atMs });
    } catch {
      /* 诊断失败绝不影响启动 */
    }
  },
  /**
   * 通知主进程"界面已经渲染出来了，可以把窗口显示出来"（2026-10-01 第四轮）。
   *
   * 配套主进程 BrowserWindow 的 `show: false`：窗口默认不显示，
   * 等这里发信号才 show()。效果是**窗口一出现里面就有内容**，
   * 而不是先看到一个纯白框、再等一两秒才填上东西。
   *
   * 用 send（单向）而不是 invoke：这条消息在首帧关键路径上，
   * 不需要回执，多一个 IPC 往返就多一分延迟。
   * 主进程侧用 ipcMain.once 接；即使渲染层发早了/发重了也不会出错。
   */
  reveal: () => {
    try {
      ipcRenderer.send("app:reveal");
    } catch {
      /* 失败时主进程的硬超时兜底，窗口仍会出现 */
    }
  },
  openExternal: (url: string) => ipcRenderer.invoke("app:open-external", url),
  /** 编辑菜单命令（undo/redo/cut/copy/paste/selectAll），主进程白名单校验 */
  editCommand: (cmd: string) => ipcRenderer.invoke("app:edit-command", cmd),
  /** 新建应用窗口（共享同一 app-server 与数据目录） */
  newWindow: () => ipcRenderer.invoke("app:new-window"),
  envRpc: (channel: string, payload?: unknown) => {
    if (!ENV_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`不允许的环境通道: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  /** 内置浏览器：主进程 WebContentsView 的 IPC（白名单，防任意通道） */
  browserRpc: (channel: string, payload?: unknown) => {
    if (!BROWSER_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`不允许的浏览器通道: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onBrowserState: (cb: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("codex:browser-state", handler);
    return () => ipcRenderer.removeListener("codex:browser-state", handler);
  },
  /** 页面里 target=_blank / window.open → 渲染层开一个新标签 */
  onBrowserOpenUrl: (cb: (url: string) => void) => {
    const handler = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on("codex:browser-open-url", handler);
    return () => ipcRenderer.removeListener("codex:browser-open-url", handler);
  },
  /** 模型（MCP）那边新建了浏览器标签 → 渲染层把它登记进工作区 */
  onBrowserAddTab: (cb: (tab: { id: string; url: string }) => void) => {
    const handler = (_e: unknown, tab: { id: string; url: string }) => cb(tab);
    ipcRenderer.on("codex:browser-add-tab", handler);
    return () => ipcRenderer.removeListener("codex:browser-add-tab", handler);
  },
};

contextBridge.exposeInMainWorld("codex", api);

export type CodexApi = typeof api;
