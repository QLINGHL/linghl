import { create } from "zustand";
import { saveTurnTiming, savedTurnTiming } from "./lib/turnTiming";
import {
  rpc,
  M,
  type ThreadSummary,
  type DeskStateShape,
  type EnvListResult,
  type EnvProject,
} from "./lib/api";

export type View = "home" | "thread" | "scheduled" | "settings" | "customize" | "models";

/** 设置页二级分区（与 SettingsPage 导航一致）；"env" = 环境 / 接入方式 */
export type SettingsSectionId =
  | "general"
  | "import"
  | "appearance"
  | "voice"
  | "dub"
  | "personalize"
  | "mini"
  | "shortcuts"
  | "plugins"
  | "computer-use"
  | "snapshots"
  | "browser"
  | "hooks"
  | "connect"
  | "git"
  | "env"
  | "worktrees"
  | "archived";

/** 进入设置页后要执行的动作：new = 自动打开「新建服务商档案」表单 */
export type SettingsIntent = "relay-new" | null;

export interface ThreadItem {
  id: string;
  type: string;
  [k: string]: unknown;
}

/**
 * 一个回合（turn）= 「用户消息 → 活动区 → 最终助手回复」。
 * 对齐官方 threadWorkspace / local-conversation-thread-turn-entries：
 * 活动区（工具行/推理/命令…）在回合完成后会被折叠成一行摘要，
 * 所以渲染必须按 turn 分组，而不是把所有 item 拉平成一条长列表。
 */
export type TurnPhase =
  | "thinking"
  | "running"
  | "editing"
  | "tool"
  | "planning"
  | "responding"
  | "waiting"
  | "complete"
  | "failed";

export interface Turn {
  id: string;
  renderKey?: string;
  items: ThreadItem[];
  startedAtMs?: number;
  completedAtMs?: number;
  /** Final answer start freezes completed work time, independently of turn completion. */
  finalAssistantStartedAtMs?: number;
  /** 内核 turn.status：completed / interrupted / failed… */
  status?: string;
  /** turn.error.message（例如 "exceeded retry limit, last status: 429 …"）——官方渲染成一条提示横幅 */
  errorMessage?: string;
  /** 直接取内核算好的耗时（优先），否则用 completedAt - startedAt 兜底 */
  durationMs?: number;
  /** 当前回合正在展示的活动项；只用于实时状态，不影响历史数据。 */
  activeItemId?: string;
  /** 内核没有发出完整活动项时的实时阶段兜底。 */
  phase?: TurnPhase;
}

export interface ApprovalRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** 内核 error 通知 → 界面提示。不清掉的话 turn 失败是完全静默的。 */
export interface TurnError {
  id: string;
  threadId: string;
  message: string;
  retrying: boolean;
}

/**
 * 工作区内容标签页（对齐官方 threadWorkspace）。
 *
 * 官方一个标签 = 一个**内容页面**（内置浏览器 / 终端 / Artifact…），聊天本身也是工作区里的
 * 一个标签。本复刻版做内置浏览器：`url` 为空时显示官方的「新标签页」选择页（工具 / 推荐）。
 * 布局三态：`chat`（只有聊天）/ `split`（聊天在左、内容标签在右）/ `full`（同一条标签栏里
 * 聊天与内容并列，激活项铺满）。
 */
export interface ContentTab {
  id: string;
  url: string;
  title: string;
}

/** 新标签页选择器里的「终端」等工具项 */
export const WS_TAB_DEFAULT_TITLE = "新标签页";

interface AppState {
  view: View;
  viewHistory: View[];
  viewHistoryIndex: number;
  activeThreadId: string | null;
  threads: ThreadSummary[];
  /**
   * 本地乐观插入、内核还没确认的会话 id（2026-10-01 修复"新聊天不出现在最近"）。
   *
   * 背景：`thread/list` 在 `thread/start` 之后 130ms 就被调用，而那时新会话
   * 还没落进内核的 state DB（也没有名字），列表里根本没有它；
   * 下一次刷新要等到 `turn/completed` —— 实测能差 2 分 25 秒。
   * 于是用户发送后盯着"最近"看，整段生成过程里都找不到自己这条会话。
   *
   * 解法：thread/start 一返回就把会话**乐观插进 threads 列表**，
   * 并把 id 记在这里。loadThreads 刷新时对这批 id 做"保底合并"：
   * 内核返回了就转正（从本集合移除、用内核数据），没返回就继续保留本地那条，
   * 避免刷新把用户刚发的会话抹掉。
   */
  pendingThreadIds: string[];
  items: Record<string, ThreadItem[]>;
  /** 按回合分组的视图（对齐官方）：历史来自 thread/turns/list，实时来自 turn 事件 */
  turns: Record<string, Turn[]>;
  /** 当前最终回复的流式文本（只保留当前 agentMessage，避免工具/思考文本串进答案）。 */
  streaming: Record<string, string>;
  streamingItemId: Record<string, string | undefined>;
  turnActive: Record<string, boolean>;
  activeTurnId: Record<string, string | undefined>;
  activeItemId: Record<string, string | undefined>;
  turnPhase: Record<string, TurnPhase | undefined>;
  approvals: ApprovalRequest[];
  errors: TurnError[];
  /**
   * 内核级别的配置故障（config.toml 被内核丢弃、回落默认）。
   * 这类问题内核不报错也不退出，只在 stderr 里说一句，所以必须由主进程捞出来展示。
   */
  kernelError: string | null;
  /** 同一通道的温和告警（例如内核忽略了 config.toml 里几个不认识的键），配置仍生效 */
  kernelNotice: string | null;
  /**
   * 侧栏「项目」列表 = 自己加的（desk-state）+ 当前环境目录里记录的官方项目（只读合并）。
   * 带 id / threadIds 的条目来自环境，展开后能列出该项目的会话。
   */
  projects: { id?: string; name: string; path: string; threadIds?: string[] }[];
  /** 当前环境（codex-home）里记录的原始项目清单 */
  envProjects: EnvProject[];
  prefs: DeskStateShape["preferences"] | null;
  activeProject: { name: string; path: string } | null;
  searchOpen: boolean;
  /** 「键盘快捷键」弹层：活动栏底部帮助按钮 / Ctrl+/ / 帮助菜单 共用同一个 */
  shortcutsOpen: boolean;
  sidebarVisible: boolean;
  /**
   * 窗口宽度 < 768 时为 true —— 官方 CSS 的 `@media not all and (width>=768px)`
   * 会把侧栏宽度归零（`--app-shell-left-panel-width: 0px`）。
   * 与用户的 sidebarVisible 偏好**分开存**，窗口拉宽后自动恢复，不覆盖用户的选择。
   */
  windowNarrow: boolean;
  recentsExpanded: boolean;
  /**
   * 工作区内容标签页与布局（对齐官方 threadWorkspace）。
   * layout: `chat` = 只有聊天（默认）；`split` = 聊天 + 内容标签左右分屏；`full` = 完整视图（同一标签栏）。
   * 不变量：wsTabs 为空 ⟺ layout === "chat"。
   */
  wsTabs: ContentTab[];
  /** 激活的内容标签；完整视图下为 null 表示激活的是「聊天」标签 */
  wsActiveTabId: string | null;
  wsLayout: "chat" | "split" | "full";
  /** 完整视图下「上次选中的内容标签」：官方 focusPreviousTab 靠它找回上一个标签 */
  wsLastContentTabId: string | null;
  loggedIn: boolean | null;
  envList: EnvListResult | null;
  /**
   * 启动阶段的"首屏数据是否已回来"。
   *
   * 存在的意义（2026-10-01 启动诊断）：init() 原来是串行链，最长的那一步
   * （checkAccount 走网络刷新 token，实测 15~21s）会把整条链卡住，
   * 而它后面还有 loadThreads —— 于是侧栏在几十秒里都是空的。
   * 现在改成并行 + 分级就绪：envs/projects/threads 一到就分别置位，
   * 界面据此渲染骨架，而不是靠"全部完成"这一个开关。
   */
  bootPhase: {
    /** 环境列表（env:list）是否已回来 —— 侧栏/项目/线程都依赖它 */
    envs: boolean;
    /** 会话列表是否已回来（或已确认拿不到） */
    threads: boolean;
    /** 项目列表是否已回来（或已确认拿不到） */
    projects: boolean;
  };
  customizeTab: "plugins" | "skills";
  modelsTab: "providers" | "envs";
  /** 模型面板意图：new-provider = 登录门跳转后直接打开「添加模型」弹窗 */
  modelsIntent: "new-provider" | null;
  settingsSection: SettingsSectionId;
  settingsIntent: SettingsIntent;
  // 动作
  setView: (v: View) => void;
  openSettings: (section?: SettingsSectionId, intent?: SettingsIntent) => void;
  setSettingsSection: (s: SettingsSectionId) => void;
  consumeSettingsIntent: () => void;
  goBack: () => void;
  goForward: () => void;
  openThread: (id: string) => Promise<void>;
  newChat: () => void;
  /**
   * 把刚由 thread/start 建出来的会话**立刻**放进「最近」列表（乐观插入）。
   *
   * 为什么不等 thread/list：实测内核要等 `turn/completed` 才会把新会话列出来，
   * 中间隔着一整轮生成（见过 2 分 25 秒）。用户发送后找不到自己这条会话，
   * 会以为"新聊天没生效"。
   */
  upsertPendingThread: (thread: { id: string; title: string; cwd?: string }) => void;
  /**
   * 撤掉乐观插入的会话（发送失败时用）。
   *
   * 新建会话的首条消息发送失败时，内核里那个 thread 是**空的**：
   * 留在「最近」里会变成一条点进去什么都没有的幽灵会话，
   * 标题还是用户那句没发出去的提示词。所以失败时一并撤掉。
   */
  dropPendingThread: (id: string) => void;
  /** 新建内容标签页；full = 官方「在完整视图中打开新标签页」 */
  wsNewTab: (opts?: { full?: boolean; url?: string }) => void;
  /** 选中标签；id = null 表示选「聊天」标签（完整视图下才有意义） */
  wsSelectTab: (id: string | null) => void;
  wsCloseTab: (id: string) => void;
  wsSetLayout: (layout: "chat" | "split" | "full") => void;
  wsToggleFullView: () => void;
  /** Ctrl+Shift+B（官方 stepWorkspaceLayout）：无标签时这一步就是「新建标签页」 */
  wsStepLayout: () => void;
  /** 官方 `toggleWorkspaceTabs`（Ctrl+Shift+B）：无标签→新建；full→切换聊天/标签；split↔chat→隐藏/显示 */
  wsToggleWorkspaceTabs: () => void;
  /** 内置浏览器地址栏导航 */
  wsSetTabUrl: (id: string, url: string) => void;
  /** 同步标签页的 url / 标题（页面加载后主进程会上报真实标题） */
  wsSetTabMeta: (id: string, meta: { url?: string; title?: string }) => void;
  /** 模型（MCP）那边开的浏览器标签：登记进工作区并显示出来 */
  wsAddTab: (tab: { id: string; url?: string }) => void;
  loadThreads: () => Promise<void>;
  loadItems: (threadId: string) => Promise<void>;
  handleNotification: (n: { method: string; params: Record<string, unknown> }) => void;
  init: () => Promise<void>;
  checkAccount: (opts?: { refresh?: boolean }) => Promise<void>;
  loginStart: () => Promise<{ ok: boolean; message?: string }>;
  setSearchOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setWindowNarrow: (narrow: boolean) => void;
  setPrefs: (patch: Partial<DeskStateShape["preferences"]>) => Promise<void>;
  addProject: (p: { name: string; path: string }) => Promise<void>;
  setActiveProject: (p: { name: string; path: string } | null) => Promise<void>;
  /** 重新合并「自己的项目 + 当前环境的项目」 */
  reloadProjects: () => Promise<void>;
  /** 主动拉一次内核配置问题（启动时的那条广播界面收不到） */
  syncKernelIssue: () => Promise<void>;
  refreshEnvs: () => Promise<void>;
  resetForEnvSwitch: (opts?: { keepView?: boolean }) => Promise<void>;
  setCustomizeTab: (t: "plugins" | "skills") => void;
  setModelsTab: (t: "providers" | "envs") => void;
  setModelsIntent: (i: "new-provider" | null) => void;
  setRecentsExpanded: (v: boolean) => void;
  dismissError: (id: string) => void;
  dismissKernelError: () => void;
}

let initInFlight: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asThreadItem(value: unknown): ThreadItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") return null;
  return value as ThreadItem;
}

/**
 * 流式事件缓冲：app-server 不只会发送 agentMessage delta，还会发送推理摘要、
 * 命令输出和计划 delta。它们必须按 threadId + turnId + itemId 分开，不能像旧版
 * 那样只按 threadId 累加，否则上一条工具/思考文本会串进最终答案。
 */
type DeltaKind = "agent" | "reasoning" | "reasoningText" | "command" | "plan";
interface DeltaBuffer {
  threadId: string;
  turnId?: string;
  itemId: string;
  kind: DeltaKind;
  text: string;
  summaryIndex?: number;
}
const deltaBuffers = new Map<string, DeltaBuffer>();
let deltaFlushScheduled = false;

function deltaKey(threadId: string, itemId: string, kind: DeltaKind, summaryIndex?: number): string {
  return `${threadId}\u0000${itemId}\u0000${kind}\u0000${summaryIndex ?? ""}`;
}

function appendSummaryDelta(raw: unknown, text: string, index = 0): unknown {
  if (!text) return raw;
  if (Array.isArray(raw)) {
    const next = raw.map((part) =>
      typeof part === "string" ? part : isRecord(part) ? { ...part } : part,
    ) as unknown[];
    const current = next[index];
    if (typeof current === "string") next[index] = current + text;
    else if (isRecord(current)) next[index] = { ...current, text: `${String(current.text ?? "")}${text}` };
    else next[index] = text;
    return next;
  }
  return `${typeof raw === "string" ? raw : ""}${text}`;
}

/** 在 items 与 turns 两份索引中同时更新同一个 item，保持历史/实时视图一致。 */
function patchThreadItem(
  st: AppState,
  threadId: string,
  turnId: string | undefined,
  itemId: string,
  patch: Record<string, unknown>,
  fallbackType: string,
): { items: Record<string, ThreadItem[]>; turns: Record<string, Turn[]> } {
  const items = { ...st.items };
  const turns = { ...st.turns };
  const list = [...(items[threadId] ?? [])];
  const turnList = [...(turns[threadId] ?? [])];
  let canonical: ThreadItem | undefined;
  let renderKey: string | undefined;
  let createdAt: number | undefined;
  let itemIndex = list.findIndex((item) => item.id === itemId || item.renderKey === itemId);
  if (itemIndex >= 0) {
    canonical = list[itemIndex];
    renderKey = String(canonical.renderKey ?? canonical.id);
    createdAt = typeof canonical.createdAt === "number" ? canonical.createdAt : undefined;
  } else {
    for (const turn of turnList) {
      const found = turn.items.find((item) => item.id === itemId || item.renderKey === itemId);
      if (found) {
        canonical = found;
        renderKey = String(found.renderKey ?? found.id);
        createdAt = typeof found.createdAt === "number" ? found.createdAt : undefined;
        break;
      }
    }
  }
  const nextItem: ThreadItem = {
    ...(canonical ?? { id: itemId, type: fallbackType }),
    ...patch,
    renderKey: renderKey ?? itemId,
    ...(createdAt != null ? { createdAt } : {}),
  };
  if (itemIndex >= 0) list[itemIndex] = nextItem;
  else list.push(nextItem);

  let targetTurn = -1;
  if (turnId) targetTurn = turnList.findIndex((turn) => turn.id === turnId);
  if (targetTurn < 0) {
    targetTurn = turnList.findIndex((turn) => turn.items.some((item) => item.id === itemId || item.renderKey === itemId));
  }
  if (targetTurn < 0 && !turnId && turnList.length > 0) targetTurn = turnList.length - 1;
  if (targetTurn < 0) {
    turnList.push({ id: turnId ?? `turn_${Date.now()}`, items: [nextItem], startedAtMs: Date.now(), status: "running" });
  } else {
    const nextTurnItems = [...turnList[targetTurn].items];
    const index = nextTurnItems.findIndex((item) => item.id === itemId || item.renderKey === itemId);
    if (index >= 0) nextTurnItems[index] = nextItem;
    else nextTurnItems.push(nextItem);
    turnList[targetTurn] = { ...turnList[targetTurn], items: nextTurnItems };
  }
  items[threadId] = list;
  turns[threadId] = turnList;
  return { items, turns };
}

/** 将流式 delta 在一帧内合并提交；完成事件前显式调用，保证尾部不丢字。 */
function flushDeltaBuffersNow(): void {
  deltaFlushScheduled = false;
  if (deltaBuffers.size === 0) return;
  const pending = [...deltaBuffers.values()];
  deltaBuffers.clear();
  useStore.setState((st) => {
    let next: Partial<AppState> = {};
    const streaming = { ...st.streaming };
    const streamingItemId = { ...st.streamingItemId };
    let items = st.items;
    let turns = st.turns;
    for (const buffer of pending) {
      if (buffer.kind === "agent") {
        const currentItem = streamingItemId[buffer.threadId];
        if (currentItem !== buffer.itemId) {
          const previous = (items[buffer.threadId] ?? []).find(item => item.id === buffer.itemId);
          streaming[buffer.threadId] = String(previous?.text ?? "");
          streamingItemId[buffer.threadId] = buffer.itemId;
        }
        streaming[buffer.threadId] = (streaming[buffer.threadId] ?? "") + buffer.text;
        // 同步落地到 item：item/started 若先到，item 上已带 phase（commentary/final_answer），
        // splitTurn 才能在流式阶段就把中间叙述和最终回复放到正确位置；
        // item/started 没到（旧内核）时也创建占位，避免最终回复无处渲染、活动区无法折叠。
        const patchedAgent = patchThreadItem(
          { ...st, ...next, items, turns } as AppState,
          buffer.threadId,
          buffer.turnId,
          buffer.itemId,
          { type: "agentMessage", text: streaming[buffer.threadId], _streaming: true },
          "agentMessage",
        );
        items = patchedAgent.items;
        turns = patchedAgent.turns;
        const turnList = turns[buffer.threadId];
        const index = turnList.findIndex(turn => turn.items.some(item => item.id === buffer.itemId));
        const entry = turnList[index];
        const agent = entry?.items.find(item => item.id === buffer.itemId);
        if (entry && agent?.phase === "final_answer" && String(agent.text ?? "").trim() && entry.finalAssistantStartedAtMs == null) {
          turnList[index] = { ...entry, finalAssistantStartedAtMs: Date.now() };
          saveTurnTiming(buffer.threadId, turnList[index]);
        }
        continue;
      }
      const existing = (turns[buffer.threadId] ?? []).flatMap((turn) => turn.items).find((item) => item.id === buffer.itemId);
      const patch: Record<string, unknown> =
        buffer.kind === "reasoning"
          ? { summary: appendSummaryDelta(existing?.summary, buffer.text, buffer.summaryIndex ?? 0) }
          : buffer.kind === "reasoningText"
            // 推理正文（item/reasoning/textDelta）：只在没有 summary 时作为兜底展示，
            // 渲染层 reasoningText() 优先读 summary，与官方一致。
            ? { content: `${typeof existing?.content === "string" ? existing.content : ""}${buffer.text}` }
            : buffer.kind === "command"
              ? { aggregatedOutput: `${String(existing?.aggregatedOutput ?? existing?.output ?? "")}${buffer.text}` }
              : { text: `${String(existing?.text ?? "")}${buffer.text}` };
      const patched = patchThreadItem(
        { ...st, ...next, items, turns } as AppState,
        buffer.threadId,
        buffer.turnId,
        buffer.itemId,
        patch,
        buffer.kind === "reasoning" || buffer.kind === "reasoningText" ? "reasoning" : buffer.kind === "command" ? "commandExecution" : "plan",
      );
      items = patched.items;
      turns = patched.turns;
    }
    next = { ...next, streaming, streamingItemId, items, turns };
    return next;
  });
}

function queueDelta(buffer: DeltaBuffer): void {
  const key = deltaKey(buffer.threadId, buffer.itemId, buffer.kind, buffer.summaryIndex);
  const previous = deltaBuffers.get(key);
  deltaBuffers.set(key, previous ? { ...previous, text: previous.text + buffer.text } : buffer);
  if (!deltaFlushScheduled) {
    deltaFlushScheduled = true;
    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => window.setTimeout(cb, 16);
    schedule(() => flushDeltaBuffersNow());
  }
}

// ---------------------------------------------------------------------------
// 用户消息的乐观回显：内核从接受输入到回发 item/started(userMessage) 有一段
// 往返（网络差时要几秒），这段时间里界面什么都不显示，「发送后没反应」的
// 感知延迟主要来自这里。发送瞬间先上屏一条本地占位，内核的真实 userMessage
// 到达时按文本去重替换 —— 官方桌面版同样是你一点发送消息立刻出现。
// ---------------------------------------------------------------------------

function userItemText(item: ThreadItem): string {
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function isLocalUserItem(item: ThreadItem): boolean {
  return typeof item.id === "string" && item.id.startsWith("local_");
}

/** 内核给的时间可能是 ISO 字符串、秒或毫秒时间戳，统一成毫秒；取不到返回 0 */
function parseTime(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw < 1e12 ? Math.round(raw * 1000) : raw;
  if (typeof raw === "string" && raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 内核给的耗时字段可能是 ms 或 { secs, nanos } 之类的对象，统一转成 ms 数字 */
function parseDuration(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw < 1e6 ? raw : raw;
  if (isRecord(raw)) {
    const secs = typeof raw.secs === "number" ? raw.secs : typeof raw.seconds === "number" ? raw.seconds : undefined;
    const nanos = typeof raw.nanos === "number" ? raw.nanos : undefined;
    if (secs != null) return Math.round(secs * 1000 + (nanos ?? 0) / 1e6);
  }
  return undefined;
}

/** 发送瞬间把用户消息立刻放进会话流（本地占位，内核确认后原地升级为真实项） */
export function pushLocalUserMessage(threadId: string, text: string): void {
  if (!threadId || !text) return;
  useStore.setState((st) => {
    const list = [...(st.items[threadId] ?? [])];
    // 连发同文本时不重复叠占位
    if (list.some((x) => isLocalUserItem(x) && userItemText(x) === text)) return st;
    const key = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // renderKey 是本条消息的稳定渲染身份：内核确认后用真实 id，但 renderKey 不变，
    // React 才能复用同一个 DOM 节点（否则 key 变化 → 重挂载 → 淡入动画重放 = 页面"跳一下"）。
    list.push({
      id: key,
      renderKey: key,
      createdAt: Date.now(),
      type: "userMessage",
      text,
      content: [{ type: "text", text }],
    });
    // 本地占位也要立刻建一个 turn：如果等内核 turn/started 才建，
    // 用户消息会先以「无分组」形态出现，随后再被塞进 turn，视觉上就是跳一下。
    const turnList = [...(st.turns[threadId] ?? [])];
    const lastTurn = turnList[turnList.length - 1];
    const placeholder = list[list.length - 1];
    if (lastTurn && lastTurn.status === "running" && lastTurn.items.length === 0) {
      turnList[turnList.length - 1] = { ...lastTurn, items: [placeholder] };
    } else {
      turnList.push({ id: `local_turn_${key}`, renderKey: `local_turn_${key}`, items: [placeholder], startedAtMs: Date.now(), status: "running" });
    }
    return { items: { ...st.items, [threadId]: list }, turns: { ...st.turns, [threadId]: turnList },
      activeTurnId: { ...st.activeTurnId, [threadId]: turnList.at(-1)?.id } };
  });
}

/** 发送失败时撤掉还没被内核确认的占位；turn 内的占位也必须一并撤掉。 */
export function dropLocalUserMessage(threadId: string, text: string): void {
  if (!threadId || !text) return;
  useStore.setState((st) => {
    const list = st.items[threadId];
    if (!list?.some((x) => isLocalUserItem(x) && userItemText(x) === text)) return st;
    const removedIds = new Set(list.filter((x) => isLocalUserItem(x) && userItemText(x) === text).map((x) => x.id));
    const nextItems = list.filter((x) => !removedIds.has(x.id));
    const nextTurns = (st.turns[threadId] ?? [])
      .map((turn) => ({ ...turn, items: turn.items.filter((item) => !removedIds.has(item.id) && !removedIds.has(String(item.renderKey ?? ""))) }))
      .filter((turn) => turn.items.length > 0 || !turn.id.startsWith("local_turn_"));
    return {
      items: { ...st.items, [threadId]: nextItems },
      turns: { ...st.turns, [threadId]: nextTurns },
      turnActive: { ...st.turnActive, [threadId]: false },
      activeTurnId: { ...st.activeTurnId, [threadId]: undefined },
      activeItemId: { ...st.activeItemId, [threadId]: undefined },
      turnPhase: { ...st.turnPhase, [threadId]: undefined },
      streaming: { ...st.streaming, [threadId]: "" },
      streamingItemId: { ...st.streamingItemId, [threadId]: undefined },
    };
  });
}

/**
 * 发送瞬间点亮等待态，不等内核 turn/started 通知 —— thread/start 慢的窗口
 * （最坏 5s+）也要有「正在回应」盖着，而不是让用户干瞪自己的消息。
 * turn/started 会幂等地再置一次 true；turn/start RPC 失败时由 Composer 撤回。
 */
export function markTurnPending(threadId: string): void {
  if (!threadId) return;
  useStore.setState((st) => ({
    turnActive: { ...st.turnActive, [threadId]: true },
    turnPhase: { ...st.turnPhase, [threadId]: "thinking" },
  }));
}

/** turn/start RPC 本身失败时撤回等待态（这种失败不会有 turn/completed 兜底） */
export function clearTurnPending(threadId: string): void {
  if (!threadId) return;
  useStore.setState((st) => ({
    turnActive: { ...st.turnActive, [threadId]: false },
    activeTurnId: { ...st.activeTurnId, [threadId]: undefined },
    activeItemId: { ...st.activeItemId, [threadId]: undefined },
    turnPhase: { ...st.turnPhase, [threadId]: undefined },
    streaming: { ...st.streaming, [threadId]: "" },
    streamingItemId: { ...st.streamingItemId, [threadId]: undefined },
  }));
}


/**
 * 把 `thread/resume` 的失败翻译成用户能看懂、且知道下一步该做什么的说明。
 *
 * ── 为什么需要（2026-10-01）──────────────────────────────────────────────
 * 内核的 `thread/list` **只返回 model_provider 等于当前 provider 的会话**，
 * 所以本应用会把被它隐藏的历史（早期 provider 建的）从本地库补回列表
 * （见 loadThreads 的 mergeThreadLists）。
 *
 * 这些会话**历史可读** —— `thread/turns/list` 仍能返回全部回合，正文照常渲染。
 * 但 `thread/resume` 和 `turn/start` 会失败，因为 config.toml 里已经**没有**
 * 它们当年用的那个 model provider 了。原始报错是：
 *     failed to load configuration: Model provider `stringai` not found
 * 对用户等于没说 —— 他会以为"这个会话坏了"。
 *
 * 返回 null 表示不是我们认识的失败，交回原逻辑静默处理（不打扰用户）。
 */
function describeResumeFailure(raw: string): string | null {
  if (!raw) return null;
  const m = raw.match(/Model provider\s+[`"']?([\w.-]+)[`"']?/i);
  if (!m) return null;
  const provider = m[1];
  return (
    `这个会话是用「${provider}」这个模型接入创建的，当前配置里已经没有它了。` +
    `历史记录可以正常查看，但不能继续对话。` +
    `想接着聊：到「设置 → 模型」把「${provider}」加回来，或直接新建一个聊天。`
  );
}

function itemType(item: ThreadItem | undefined): string {
  return String(item?.type ?? item?.itemType ?? "");
}

function phaseForItem(item: ThreadItem | undefined): TurnPhase {
  switch (itemType(item)) {
    case "reasoning":
      return "thinking";
    case "commandExecution":
    case "command_execution":
    case "webSearch":
    case "web_search":
      return "running";
    case "fileChange":
    case "file_change":
      return "editing";
    case "mcpToolCall":
    case "mcp_tool_call":
    case "dynamicToolCall":
    case "dynamic_tool_call":
      return "tool";
    case "plan":
    case "todoList":
    case "todo_list":
      return "planning";
    case "agentMessage":
    case "agent_message":
      return "responding";
    default:
      return "running";
  }
}

function isItemComplete(item: ThreadItem | undefined): boolean {
  const status = String(item?.status ?? "").toLowerCase();
  return ["completed", "complete", "success", "succeeded", "failed", "error", "declined", "interrupted", "cancelled", "canceled"].includes(status) || item?.completed === true;
}

function notificationTurnId(params: Record<string, unknown>): string | undefined {
  // v2 sends turn.id; a few older builds also leave a stale top-level turnId.
  // Prefer the authoritative nested object so history fallback cannot attach to
  // the previous turn when both fields are present.
  const turn = isRecord(params.turn) ? params.turn : null;
  if (typeof turn?.id === "string") return turn.id;
  return typeof params.turnId === "string" ? params.turnId : undefined;
}

function notificationThreadId(params: Record<string, unknown>, activeThreadId: string | null): string {
  return typeof params.threadId === "string" ? params.threadId : activeThreadId ?? "";
}

function removeLocalTurnIfEmpty(turns: Turn[]): Turn[] {
  return turns.filter((turn) => !(turn.id.startsWith("local_turn_") && turn.items.length === 0));
}

function mergeRawHistoryRows(primary: unknown[], secondary: unknown[]): unknown[] {
  const merged = [...primary];
  const seen = new Set(
    primary
      .map((row) => (isRecord(row) && typeof row.id === "string" ? row.id : null))
      .filter((id): id is string => id !== null),
  );
  for (const row of secondary) {
    const id = isRecord(row) && typeof row.id === "string" ? row.id : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(row);
  }
  return merged;
}

function mapHistoryTurns(threadId: string, rawTurns: unknown[]): Turn[] {
  const turns = rawTurns.map((rawTurn, ti) => {
    const row = isRecord(rawTurn) ? rawTurn : {};
    const items = (Array.isArray(row.items) ? row.items : [])
      .map((item) => {
        const parsed = asThreadItem(item);
        return parsed ? ({ ...parsed, renderKey: parsed.id } as ThreadItem) : null;
      })
      .filter((item): item is ThreadItem => item !== null);
    const startedAtMs = parseTime(row.startedAtMs) || parseTime(row.turnStartedAtMs) || parseTime(row.startedAt) || parseTime(row.createdAt) || undefined;
    const completedAtMs = parseTime(row.completedAtMs) || parseTime(row.turnCompletedAtMs) || parseTime(row.completedAt) || parseTime(row.finishedAtMs) || undefined;
    const turnId = typeof row.id === "string" ? row.id : `turn_${ti}`;
    const savedTiming = savedTurnTiming(threadId, turnId);
    const rawError = isRecord(row.error) ? row.error : null;
    return {
      id: turnId,
      items,
      startedAtMs: startedAtMs ?? savedTiming.startedAtMs,
      completedAtMs: completedAtMs ?? savedTiming.completedAtMs,
      finalAssistantStartedAtMs: parseTime(row.finalAssistantStartedAtMs) || savedTiming.finalAssistantStartedAtMs ||
        parseTime(items.find((item) => item.phase === "final_answer")?.startedAtMs) ||
        parseTime(items.find((item) => item.phase === "final_answer")?.createdAt) || undefined,
      status: typeof row.status === "string" ? row.status : undefined,
      errorMessage: rawError && typeof rawError.message === "string" ? rawError.message : undefined,
      durationMs: parseDuration(row.durationMs),
    } as Turn;
  });
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.createdAt == null && turn.startedAtMs != null) item.createdAt = turn.startedAtMs;
    }
  }
  return turns;
}

function mergeHistoryState(st: AppState, threadId: string, historyTurns: Turn[]): Partial<AppState> {
  const currentTurns = st.turns[threadId] ?? [];
  const currentItems = st.items[threadId] ?? [];
  // 空响应不能擦掉已显示的历史：旧内核会对未物化会话返回空/错误。
  if (!historyTurns.length && (currentTurns.length > 0 || currentItems.length > 0)) return st;
  const live = Boolean(
    st.turnActive[threadId] ||
    st.activeTurnId[threadId] ||
    st.activeItemId[threadId] ||
    st.streamingItemId[threadId] ||
    st.streaming[threadId] ||
    currentTurns.some((turn) => turn.status === "running" || turn.status === "inProgress"),
  );
  if (!live) {
    return {
      items: { ...st.items, [threadId]: historyTurns.flatMap((turn) => turn.items) },
      turns: { ...st.turns, [threadId]: historyTurns },
      streaming: { ...st.streaming, [threadId]: "" },
      streamingItemId: { ...st.streamingItemId, [threadId]: undefined },
    };
  }
  // 历史响应可能晚于实时事件；围绕 live turn 合并，而不是覆盖其实时 item/stream。
  if (!currentTurns.length) return st;
  const liveById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const snapshotIds = new Set(historyTurns.map((turn) => turn.id));
  const mergedTurns = historyTurns.map((historyTurn) => {
    const current = liveById.get(historyTurn.id);
    if (!current) return historyTurn;
    const currentByItem = new Map(current.items.map((item) => [item.id, item]));
    const mergedItems = historyTurn.items.map((item) => {
      const currentItem = currentByItem.get(item.id);
      return currentItem ? { ...item, ...currentItem, renderKey: currentItem.renderKey ?? item.renderKey } : item;
    });
    const seen = new Set(mergedItems.map((item) => item.id));
    mergedItems.push(...current.items.filter((item) => !seen.has(item.id)));
    // History timestamps are authoritative after a reload. Keep only the
    // live status/error fields from the in-flight turn so a late snapshot
    // cannot mark the current work completed, but do not lose corrected timing.
    return {
      ...current,
      ...historyTurn,
      items: mergedItems,
      status: current.status ?? historyTurn.status,
      errorMessage: current.errorMessage ?? historyTurn.errorMessage,
    };
  });
  mergedTurns.push(...currentTurns.filter((turn) => !snapshotIds.has(turn.id)));
  return {
    items: { ...st.items, [threadId]: mergedTurns.flatMap((turn) => turn.items) },
    turns: { ...st.turns, [threadId]: mergedTurns },
    streaming: st.streaming,
    streamingItemId: st.streamingItemId,
  };
}

export const useStore = create<AppState>((set, get) => ({
  view: "home",
  viewHistory: ["home"],
  viewHistoryIndex: 0,
  activeThreadId: null,
  threads: [],
  pendingThreadIds: [],
  items: {},
  turns: {},
  streaming: {},
  streamingItemId: {},
  turnActive: {},
  activeTurnId: {},
  activeItemId: {},
  turnPhase: {},
  approvals: [],
  errors: [],
  kernelError: null,
  kernelNotice: null,
  projects: [],
  envProjects: [],
  prefs: null,
  activeProject: null,
  searchOpen: false,
  shortcutsOpen: false,
  sidebarVisible: true,
  windowNarrow: false,
  // 默认展开：折叠着启动会让人以为历史会话丢了
  recentsExpanded: true,
  wsTabs: [],
  wsActiveTabId: null,
  wsLayout: "chat",
  wsLastContentTabId: null,
  loggedIn: null,
  envList: null,
  bootPhase: { envs: false, threads: false, projects: false },
  customizeTab: "plugins",
  modelsTab: "providers",
  modelsIntent: null,
  settingsSection: "general",
  settingsIntent: null,

  setView: (v) =>
    set((s) => {
      if (s.view === v) return s;
      const history = s.viewHistory.slice(0, s.viewHistoryIndex + 1);
      history.push(v);
      return { view: v, viewHistory: history, viewHistoryIndex: history.length - 1 };
    }),

  openSettings: (section, intent) =>
    set((s) => {
      const history: View[] =
        s.view === "settings" ? s.viewHistory : [...s.viewHistory.slice(0, s.viewHistoryIndex + 1), "settings"];
      return {
        view: "settings" as View,
        viewHistory: history,
        viewHistoryIndex: history.length - 1,
        settingsSection: section ?? s.settingsSection,
        settingsIntent: intent ?? null,
      };
    }),

  setSettingsSection: (section) => set({ settingsSection: section, settingsIntent: null }),
  consumeSettingsIntent: () => set({ settingsIntent: null }),

  goBack: () =>
    set((s) => {
      if (s.viewHistoryIndex <= 0) return s;
      const index = s.viewHistoryIndex - 1;
      return { view: s.viewHistory[index], viewHistoryIndex: index };
    }),

  goForward: () =>
    set((s) => {
      if (s.viewHistoryIndex >= s.viewHistory.length - 1) return s;
      const index = s.viewHistoryIndex + 1;
      return { view: s.viewHistory[index], viewHistoryIndex: index };
    }),

  newChat: () => {
    set({ activeThreadId: null });
    get().setView("home");
  },

  /**
   * 乐观插入新会话到「最近」（2026-10-01 修复）。
   *
   * 时机：`thread/start` 一返回就调用 —— 此时内核已经有了会话 id，
   * 但 `thread/list` 还列不出来（没落库、也没生成标题）。
   *
   * 标题取用户提示词的前一段（和 ChatGPT 桌面版一致：发送后立刻用首句占位，
   * 等内核生成真标题后由 thread/name/updated → loadThreads 覆盖）。
   *
   * 幂等：同一个 id 重复调用只更新标题，不会插出两条。
   * 放在列表**最前**：它是最新的会话。
   */
  upsertPendingThread: ({ id, title, cwd }) => {
    if (!id) return;
    set((st) => {
      const trimmed = title.replace(/\s+/g, " ").trim();
      const rest = st.threads.filter((t) => t.id !== id);
      const entry: ThreadSummary = {
        id,
        // name 留空：让侧栏回落到 preview（用户首句），而不是显示"未命名会话"。
        // 内核生成真标题后 thread/name/updated 会带 name 回来。
        name: null,
        preview: trimmed.slice(0, 120),
        cwd,
        updatedAt: Date.now(),
      };
      /**
       * 同时把它挂到 cwd 匹配的项目下（用户说的是"出现在那个项目**或者**最近"）。
       *
       * 侧栏「项目」下展开的会话是从 `project.threadIds` 过滤出来的，而那份数据
       * 来自环境的全局状态文件 —— 新会话在 `reloadProjects` 之前不会进去。
       * 新会话的 cwd 就是 activeProject.path，所以这里能确定它属于哪个项目。
       * （重名路径以第一个匹配为准，和 reloadProjects 的合并规则一致。）
       */
      const projects = cwd
        ? st.projects.map((p) =>
            p.path === cwd && !p.threadIds?.includes(id)
              ? { ...p, threadIds: [...(p.threadIds ?? []), id] }
              : p,
          )
        : st.projects;
      return {
        threads: [entry, ...rest],
        projects,
        pendingThreadIds: st.pendingThreadIds.includes(id) ? st.pendingThreadIds : [...st.pendingThreadIds, id],
      };
    });
  },

  dropPendingThread: (id) => {
    if (!id) return;
    set((st) =>
      st.pendingThreadIds.includes(id)
        ? {
            threads: st.threads.filter((t) => t.id !== id),
            // 项目里的归属也要一并撤掉，否则项目下会留一个展开后什么都没有的空壳
            projects: st.projects.map((p) =>
              p.threadIds?.includes(id) ? { ...p, threadIds: p.threadIds.filter((x) => x !== id) } : p,
            ),
            pendingThreadIds: st.pendingThreadIds.filter((x) => x !== id),
          }
        : st,
    );
  },

  /* ------------------------------------------------------------------
   * 工作区内容标签页（对齐官方 threadWorkspace）
   * ------------------------------------------------------------------ */

  wsNewTab: (opts) => {
    const s = get();
    const id = `ws_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const tab: ContentTab = { id, url: opts?.url ?? "", title: WS_TAB_DEFAULT_TITLE };
    // 官方「新建标签页」默认落到分屏视图（分屏不可用时才回落完整视图）；
    // 「在完整视图中打开新标签页」显式落到完整视图。已经处于完整视图时保持不动。
    const layout: "split" | "full" = s.wsLayout === "full" ? "full" : opts?.full ? "full" : "split";
    set({ wsTabs: [...s.wsTabs, tab], wsActiveTabId: id, wsLayout: layout });
  },

  wsSelectTab: (id) =>
    set((s) => (id === null ? { wsActiveTabId: null } : { wsActiveTabId: id, wsLastContentTabId: id })),

  wsCloseTab: (id) => {
    const s = get();
    const idx = s.wsTabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rest = s.wsTabs.filter((t) => t.id !== id);
    // 主进程那边的 WebContentsView 也要一起销毁（不留孤儿进程）
    void window.codex.browserRpc("browser:close", id).catch(() => undefined);
    // 关掉最后一个内容标签就回落到只有聊天（官方 layout=chat 时标签栏整条消失）
    if (rest.length === 0) {
      set({ wsTabs: [], wsActiveTabId: null, wsLayout: "chat" });
      return;
    }
    const nextActive = s.wsActiveTabId === id ? rest[Math.min(idx, rest.length - 1)].id : s.wsActiveTabId;
    set({ wsTabs: rest, wsActiveTabId: nextActive });
  },

  wsSetLayout: (layout) => {
    const s = get();
    // "chat" 永远允许（= 把标签页藏起来，标签本身保留）；分屏/完整视图得有内容标签
    if (layout !== "chat" && s.wsTabs.length === 0) return;
    set({ wsLayout: layout });
  },

  wsToggleFullView: () => {
    const s = get();
    if (s.wsLayout === "full") {
      set({ wsLayout: s.wsTabs.length > 0 ? "split" : "chat" });
      return;
    }
    set({ wsLayout: "full", ...(s.wsActiveTabId === null && s.wsTabs.length > 0 && s.wsLayout === "split" ? { wsActiveTabId: s.wsTabs[0].id } : {}) });
  },

  /**
   * 官方 `toggleWorkspaceTabs`（`Ctrl+Shift+B`，也是布局控件按钮干的事）：
   *   - 没有内容标签 → 新建标签页（官方 `oe` 里 `tabIds$` 为空就 fallthrough 到新建）
   *   - 完整视图下 → 在「聊天」与上一个内容标签之间切换（`focusChat` / `focusPreviousTab`，布局不变）
   *   - 分屏下 → 隐藏标签页（回 chat，标签保留，可再「显示标签页」）
   *   - 聊天态但有标签（= 已隐藏）→ 显示标签页（回 split）
   */
  wsToggleWorkspaceTabs: () => {
    const s = get();
    if (s.wsTabs.length === 0) {
      get().wsNewTab();
      return;
    }
    if (s.wsLayout === "full") {
      if (s.wsActiveTabId === null) {
        // 聊天 → 上一个内容标签（没有记忆就用第一条）
        const remembered =
          s.wsLastContentTabId && s.wsTabs.some((t) => t.id === s.wsLastContentTabId) ? s.wsLastContentTabId : s.wsTabs[0]?.id ?? null;
        if (remembered) set({ wsActiveTabId: remembered });
        return;
      }
      set({ wsActiveTabId: null });
      return;
    }
    // split → 隐藏；chat（有标签）→ 显示
    set({ wsLayout: s.wsLayout === "chat" ? "split" : "chat" });
  },

  wsStepLayout: () => {
    const s = get();
    // 官方 stepWorkspaceLayout 的四态（也是右上角控件气泡上的文案）：
    //   没有内容标签 → 新建标签页；完整视图 → 进入分屏视图；聊天视图 → 显示标签页；分屏视图 → 隐藏标签页
    if (s.wsTabs.length === 0) {
      get().wsNewTab();
      return;
    }
    if (s.wsLayout === "full" || s.wsLayout === "chat") {
      set({ wsLayout: "split" });
      return;
    }
    // 隐藏标签页 = 保留标签、只是把工作区收回聊天（再点一下就是「显示标签页」）
    set({ wsLayout: "chat" });
  },

  wsSetTabUrl: (id, url) =>
    set((s) => ({ wsTabs: s.wsTabs.map((t) => (t.id === id ? { ...t, url } : t)) })),

  wsSetTabMeta: (id, meta) =>
    set((s) => ({
      wsTabs: s.wsTabs.map((t) =>
        t.id === id ? { ...t, url: meta.url ?? t.url, title: meta.title ? meta.title : t.title } : t,
      ),
    })),

  wsAddTab: (tab) => {
    const s = get();
    const exists = s.wsTabs.some((t) => t.id === tab.id);
    if (exists) {
      set({
        wsTabs: tab.url ? s.wsTabs.map((t) => (t.id === tab.id ? { ...t, url: tab.url! } : t)) : s.wsTabs,
        wsActiveTabId: tab.id,
      });
      return;
    }
    // 聊天布局下模型开了浏览器 → 自动进分屏，否则标签页看不见
    set({
      wsTabs: [...s.wsTabs, { id: tab.id, url: tab.url ?? "", title: "新标签页" }],
      wsActiveTabId: tab.id,
      wsLayout: s.wsLayout === "chat" ? "split" : s.wsLayout,
    });
  },

  loadThreads: async () => {
    /**
     * 兜底 / 补全：不经内核，直接读所选环境里的会话清单。
     *
     * ⚠️ 2026-10-01 起**不再只在失败时调用**，而是与内核 thread/list **并行**取，
     * 原因见下面 `mergeThreadLists` 的注释（内核会按 provider 过滤掉大量历史会话）。
     * 开销实测约 30ms（读 state_*.sqlite，不是那个 50MB 的 thread_history），
     * 且与内核请求并发，所以不落在关键路径上。
     */
    const loadFromEnv = async (): Promise<ThreadSummary[]> => {
      const envId = get().envList?.activeId;
      if (!envId) return [];
      try {
        const r = await rpc.env.threads(envId);
        if (r.error) console.warn("env:threads 读取失败", r.error);
        return (r.threads ?? []).map((t) => ({
          id: t.id,
          name: t.name ?? null,
          preview: t.preview,
          cwd: t.cwd,
          updatedAt: t.updatedAt,
          // 排序键与 provider 必须带过来：前者用于与内核列表正确交错，
          // 后者用于判断某条会话是否被内核隐藏（见 mergeThreadLists）
          recencyAt: t.recencyAt,
          modelProvider: t.modelProvider,
        }));
      } catch (e) {
        console.warn("env:threads 不可用", e);
        return [];
      }
    };
    /**
     * 合并内核返回的列表与本地乐观插入的会话（2026-10-01 修复）。
     *
     * 不能直接 `set({ threads: rows })`：新会话在 `thread/start` 之后、
     * `turn/completed` 之前**不在** thread/list 里，整段生成过程中每次刷新
     * 都会把用户刚发的那条抹掉 —— 表现就是"最近里找不到我刚开的会话"。
     *
     * 规则：
     *   - 内核返回了某个 pending id → 转正（用内核数据，摘掉 pending 标记）；
     *   - 内核没返回 → 保留本地那条，继续置顶；
     *   - 已转正的条目一律以内核数据为准（标题/时间更新）。
     *
     * 另外做一次**标题回填**：内核刚收录一条新会话时，它可能还没有标题
     * （既无 name 也无 preview —— 实测内核不会推 thread/name/updated，
     * 标题要么靠 thread/list 带回来、要么一直没有）。若此时直接用内核行，
     * 侧栏会从我们那句提示词预览退回「未命名会话」，比乐观阶段**更难认**。
     * 所以内核行缺标题时，继承本地那条的 preview。
     */
    const merge = (rows: ThreadSummary[]): ThreadSummary[] => {
      const st = get();
      const byId = new Map(rows.map((t) => [t.id, t]));
      const stillPending: string[] = [];
      const kept: ThreadSummary[] = [];
      for (const id of st.pendingThreadIds) {
        if (byId.has(id)) continue; // 内核已收录，交给内核数据
        const local = st.threads.find((t) => t.id === id);
        if (local) {
          kept.push(local);
          stillPending.push(id);
        }
      }
      set({ pendingThreadIds: stillPending });
      const enriched = rows.map((row) => {
        if (row.name || row.title || row.preview) return row;
        const local = st.threads.find((t) => t.id === row.id);
        const fallback = local?.preview || local?.name || local?.title;
        return fallback ? { ...row, preview: fallback } : row;
      });
      // 乐观条目置顶（它们是最新的，且内核还没给出正确排序位置）
      return [...kept, ...enriched];
    };

    /**
     * 内核列表 + 本地库列表 → 一份完整清单（2026-10-01 修复"项目里的会话没了"）。
     *
     * ── 问题（实测）──────────────────────────────────────────────────────
     * 内核的 `thread/list` **按当前 model_provider 过滤**：只返回
     * `model_provider` 等于 config.toml 里当前 provider 的会话。
     * 本机实测（96 条未归档会话）：
     *     返回 33 条，全部 model_provider = replica_relay（当前 provider）
     *     隐藏 63 条，provider = custom(46) / probe(10) / stringai(9)
     * 于是「最近」少了一大截；**项目下更是空得一条不剩** ——
     * 项目里登记的会话恰好都是早期 provider 建的（stringai / custom）。
     * 用户看到的就是"这个项目里边的各种会话记录没了"。
     *
     * 而 `env:threads` 是应用自己直读 state_*.sqlite，**不做**这个过滤，
     * 实测能拿到全部 96 条（约 30ms）。两份并行取、按 id 合并即可。
     *
     * ── 合并规则 ─────────────────────────────────────────────────────────
     *   同一 id 以**内核数据为准**（它有实时状态、模型信息等），
     *   内核没返回的用本地库那条补上。
     *
     * ── 排序（易错点）────────────────────────────────────────────────────
     *   必须用 `recencyAt`，**不是** `updatedAt`：实测内核的返回顺序严格等于
     *   `recency_at_ms` 降序，而按 `updated_at_ms` 排会得到不同顺序 ——
     *   用错键会让列表顺序整体错乱（表现为"顺序乱跳"的回归）。
     *   且两个来源单位不同（内核是**秒**、本地库是**毫秒**），比较前必须归一化。
     */
    const mergeThreadLists = (kernelRows: ThreadSummary[], envRows: ThreadSummary[]): ThreadSummary[] => {
      const byId = new Map<string, ThreadSummary>();
      for (const r of envRows) byId.set(r.id, r);
      for (const r of kernelRows) byId.set(r.id, r); // 内核优先
      return [...byId.values()].sort((a, b) => recencyOf(b) - recencyOf(a));
    };

    /**
     * 归一化排序键到毫秒。
     * 内核的 recencyAt 是秒（如 1790835228），本地库的是毫秒（1790835228127），
     * 直接相减会让秒级值看起来"小 1000 倍"而全部沉底 —— 必须区分。
     */
    function recencyOf(t: ThreadSummary): number {
      const v = t.recencyAt ?? t.updatedAt;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return 0;
      return v < 1e12 ? Math.round(v * 1000) : v;
    }

    // 两份数据并行取：互不依赖，合并后总耗时 ≈ max(内核, 本地库) 而不是两者之和
    const kernelPromise = rpc
      .request<{ data?: ThreadSummary[] }>(M.threadList, {
        limit: 50,
        useStateDbOnly: true,
        archived: false,
      })
      .then((resp) => (Array.isArray(resp?.data) ? resp.data.filter((t) => typeof t?.id === "string") : []))
      .catch((e) => {
        console.warn("thread/list 失败", e);
        return null; // null = 内核不可用，退化为纯本地库
      });
    const envPromise = loadFromEnv().catch(() => [] as ThreadSummary[]);

    const [kernelRows, envRows] = await Promise.all([kernelPromise, envPromise]);
    const rows = kernelRows === null ? envRows : mergeThreadLists(kernelRows, envRows);
    if (kernelRows === null) {
      console.warn(`内核不可用，已用环境兜底加载 ${rows.length} 条会话`);
    } else if (envRows.length > kernelRows.length) {
      // 本地库比内核返回的多，说明内核过滤掉了会话（通常是 model_provider 不匹配）。
      // 这不是错误，是内核的既定行为，记一条便于事后排查"会话去哪了"。
      console.warn(
        `thread/list 只返回 ${kernelRows.length} 条，本地库有 ${envRows.length} 条，` +
          `已合并补全 ${rows.length - kernelRows.length} 条被内核隐藏的会话`,
      );
    }
    set({ threads: merge(rows) });
  },

  loadItems: async (threadId: string) => {
    /** 兜底：不经内核，直接读该环境里这个会话的正文（内核起不来时点开会话不能是空白） */
    const loadTurnsFromEnv = async (): Promise<unknown[]> => {
      const envId = get().envList?.activeId;
      if (!envId) return [];
      try {
        const r = await rpc.env.turns(envId, threadId);
        if (r.error) console.warn("env:turns 兜底读取失败", r.error);
        return r.data ?? [];
      } catch (e) {
        console.warn("env:turns 兜底不可用", e);
        return [];
      }
    };
    /** thread/turns/list 的页游标在不同内核版本中可能被截断，最多保护性读取 100 页。 */
    let partialKernelRows: unknown[] = [];
    const loadKernelTurns = async (): Promise<unknown[]> => {
      const rawTurns: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const params: Record<string, unknown> = {
          threadId,
          limit: 50,
          sortDirection: "asc",
          itemsView: "full",
          ...(cursor ? { cursor } : {}),
        };
        let resp: { data?: unknown[]; nextCursor?: unknown };
        try {
          resp = await rpc.request<{ data?: unknown[]; nextCursor?: unknown }>(M.threadTurnsList, params);
        } catch (error) {
          partialKernelRows = rawTurns;
          throw error;
        }
        const pageRows = Array.isArray(resp?.data) ? resp.data : [];
        rawTurns.push(...pageRows);
        const next = typeof resp?.nextCursor === "string" && resp.nextCursor ? resp.nextCursor : undefined;
        if (!next || seenCursors.has(next) || pageRows.length === 0) break;
        seenCursors.add(next);
        cursor = next;
      }
      return rawTurns;
    };

    let rawTurns: unknown[] = [];
    let kernelFailure: unknown = null;
    try {
      rawTurns = await loadKernelTurns();
    } catch (e) {
      kernelFailure = e;
      rawTurns = partialKernelRows;
    }

    // -32601/not supported、未物化会话及中英文超时都可能来自不同版本内核；
    // 不再用错误文本决定是否回退，任何失败或空结果都尝试环境只读投影。
    if (kernelFailure || rawTurns.length === 0) {
      const fromEnv = await loadTurnsFromEnv();
      if (fromEnv.length) {
        console.warn(
          kernelFailure
            ? `内核历史读取失败，已用环境兜底加载 ${fromEnv.length} 个回合`
            : `thread/turns/list 返回空，已用环境兜底加载 ${fromEnv.length} 个回合`,
        );
        rawTurns = mergeRawHistoryRows(rawTurns, fromEnv);
      }
      if (kernelFailure) {
        const text = String(kernelFailure);
        if (!/not materialized|not supported|unsupported|method not found|app-server|未运行|已退出|ECONNREFUSED|time(?:d out|out)|超时|请求超时/i.test(text)) {
          console.warn("thread/turns/list 失败", kernelFailure);
        }
      }
    }

    const historyTurns = mapHistoryTurns(threadId, rawTurns);
    set((s) => mergeHistoryState(s, threadId, historyTurns));
  },

  openThread: async (id: string) => {
    if (!id) return;
    set({ activeThreadId: id });
    get().setView("thread");
    // 先 resume 再拉历史：resume 可能触发内核重放通知，先拿历史会和重放产生竞态。
    // excludeTurns 让内核不要尝试装配 turns——这份内核的 list_turns 未实现，
    // 不传它 resume 会整体失败。
    let resumeFailure = "";
    try {
      await rpc.request(M.threadResume, { threadId: id, excludeTurns: true });
    } catch (e) {
      // 已加载/内核不支持 resumes 时不阻塞浏览（历史走 turns/list）。
      // 但要**区分**"正常的不可 resume"和"这个会话用的模型接入已不存在" ——
      // 后者必须告诉用户，否则他点开历史、发消息、只收到一句英文报错，无从理解。
      resumeFailure = String(e);
    }
    const notice = describeResumeFailure(resumeFailure);
    set((st) => {
      // 先清掉上一次留下的同类提示，避免切来切去堆一堆
      const cleaned = st.errors.filter((x) => x.id !== `readonly:${id}`);
      if (!notice) return { errors: cleaned };
      return { errors: [...cleaned, { id: `readonly:${id}`, threadId: id, message: notice, retrying: false }] };
    });
    await get().loadItems(id);
  },

  handleNotification: (n) => {
    const { method, params } = n;
    if (method === "server/exited") {
      flushDeltaBuffersNow();
      for (const [id, active] of Object.entries(get().turnActive)) {
        if (active) get().handleNotification({ method: "error", params: { threadId: id, turnId: get().activeTurnId[id],
          error: { message: "Codex 内核已退出，正在进行的回复已中断。" }, willRetry: false } });
      }
      set({ approvals: [] });
      return;
    }
    const explicitThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    const threadId = notificationThreadId(params, get().activeThreadId);
    const turnId = notificationTurnId(params);
    // Late deltas cannot reactivate a finished turn or steal the current status.
    if (threadId && turnId && (method.startsWith("item/") || method === "turn/plan/updated")) {
      const existingTurn = get().turns[threadId]?.find((turn) => turn.id === turnId);
      if (existingTurn && ["completed", "interrupted", "failed"].includes(existingTurn.status ?? "")) return;
    }
    if (threadId && (method === "item/started" || method.endsWith("Delta") || method.endsWith("/delta"))) {
      const activeId = turnId ?? get().activeTurnId[threadId];
      const retry = get().turns[threadId]?.find((turn) => turn.id === activeId)?.items.find((item) =>
        item.type === "streamError" && item.status === "inProgress");
      if (retry) set((st) => patchThreadItem(st, threadId, activeId, retry.id, { status: "completed" }, "streamError"));
    }

      if (method === "kernel/config-error") {
        const message = typeof params?.message === "string" ? params.message : null;
        if (!message || params?.level === "info" || params?.level === "silent") {
          set({ kernelError: null, kernelNotice: null });
          return;
        }
        set(params?.level === "warn" ? { kernelNotice: message, kernelError: null } : { kernelError: message, kernelNotice: null });
        return;
      }

      if (method === "error") {
      const err = isRecord(params?.error) ? params.error : {};
      const raw = typeof err.message === "string" ? err.message : "";
      const detail = typeof err.additionalDetails === "string" ? err.additionalDetails : "";
      const message = detail || raw || "内核返回了未知错误";
      const retrying = params?.willRetry === true;
      const activeId = turnId ?? get().activeTurnId[threadId];
      if (threadId && activeId && get().turns[threadId]?.some((turn) => turn.id === activeId)) {
        flushDeltaBuffersNow();
        set((st) => {
          const errorId = 'stream_error_' + activeId;
          const patched = patchThreadItem(st, threadId, activeId, errorId, {
            type: "streamError", message, willRetry: retrying,
            status: retrying ? "inProgress" : "failed",
          }, "streamError");
          if (!retrying) patched.turns[threadId] = patched.turns[threadId].map((turn) =>
            turn.id === activeId ? { ...turn, status: "failed", completedAtMs: Date.now(),
              items: turn.items.map(item => isItemComplete(item) ? item : { ...item, status: "failed" }) } : turn);
          if (!retrying) {
            patched.items[threadId] = patched.turns[threadId].flatMap(turn => turn.items);
            const failedTurn = patched.turns[threadId].find(turn => turn.id === activeId);
            if (failedTurn) saveTurnTiming(threadId, failedTurn);
          }
          const isCurrent = !st.activeTurnId[threadId] || st.activeTurnId[threadId] === activeId;
          return { ...patched, ...(isCurrent ? {
            activeItemId: { ...st.activeItemId, [threadId]: errorId },
            turnPhase: { ...st.turnPhase, [threadId]: retrying ? "thinking" : "failed" },
            turnActive: retrying ? st.turnActive : { ...st.turnActive, [threadId]: false },
          } : {}) };
        });
        return;
      }
      set((st) => ({
        errors: [
          ...st.errors.filter((e) => e.threadId !== threadId),
          { id: `err_${Date.now()}`, threadId, message: retrying ? `重试中：${message}` : message, retrying },
        ],
        ...(threadId
          ? {
              turnPhase: { ...st.turnPhase, [threadId]: retrying ? "thinking" : "failed" },
              turnActive: retrying ? st.turnActive : { ...st.turnActive, [threadId]: false },
            }
          : {}),
      }));
      return;
    }

    if (method === "thread/started") {
      const thread = isRecord(params?.thread) ? params.thread : null;
      const newId = typeof thread?.id === "string" ? thread.id : explicitThreadId;
      if (!newId) return;
      set({ activeThreadId: newId });
      get().setView("thread");
      void get().loadThreads();
      return;
    }

    if (method === "thread/name/updated") {
      void get().loadThreads();
      return;
    }

    if (method === "turn/started") {
      if (!threadId) return;
      const turn = isRecord(params?.turn) ? params.turn : null;
      const startedAtMs = parseTime(turn?.startedAtMs) || parseTime(turn?.startedAt) || parseTime(turn?.createdAt) || Date.now();
      const id = turnId ?? `turn_${startedAtMs}`;
      set((st) => {
        const list = [...(st.turns[threadId] ?? [])];
        let index = list.findIndex((entry) => entry.id === id);
        if (index < 0) {
          // 发送瞬间创建的 local_turn 必须升级成真实 turn，不能留下一个永远 running 的幽灵回合。
          index = list.findIndex((entry) => entry.id.startsWith("local_turn_") && entry.status === "running");
          if (index >= 0) list[index] = { ...list[index], id };
          else {
            list.push({ id, items: [], startedAtMs, status: "running" });
            index = list.length - 1;
          }
        }
        list[index] = {
          ...list[index],
          startedAtMs: list[index].startedAtMs ?? startedAtMs,
          status: typeof turn?.status === "string" ? turn.status : "running",
          phase: "thinking",
        };
        return {
          turns: { ...st.turns, [threadId]: removeLocalTurnIfEmpty(list) },
          turnActive: { ...st.turnActive, [threadId]: true },
          activeTurnId: { ...st.activeTurnId, [threadId]: id },
          activeItemId: { ...st.activeItemId, [threadId]: undefined },
          turnPhase: { ...st.turnPhase, [threadId]: "thinking" },
          // 新回合开始：清掉上一回合可能残留的流式缓冲（上回合没发 turn/completed 时会串文本）
          streaming: { ...st.streaming, [threadId]: "" },
          streamingItemId: { ...st.streamingItemId, [threadId]: undefined },
        };
      });
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const rawItem = asThreadItem(params?.item);
      if (!threadId || !rawItem) return;
      if (method === "item/completed") flushDeltaBuffersNow();
      const isUserMsg = itemType(rawItem) === "userMessage" || itemType(rawItem) === "user_message";
      set((st) => {
        const completedStream = itemType(rawItem) === "agentMessage" || itemType(rawItem) === "agent_message"
          ? (st.streamingItemId[threadId] === rawItem.id ? st.streaming[threadId] ?? "" : "")
          : "";
        const effectiveRawItem: ThreadItem = {
          ...rawItem,
          status: rawItem.status ?? (method === "item/started" ? "inProgress" : "completed"),
          ...(completedStream && !String(rawItem.text ?? "") ? { text: completedStream } : {}),
        };
        const list = [...(st.items[threadId] ?? [])];
        let canonical: ThreadItem = effectiveRawItem;
        let localIdx = -1;
        if (isUserMsg) {
          const text = userItemText(effectiveRawItem);
          if (text) localIdx = list.findIndex((item) => isLocalUserItem(item) && userItemText(item) === text);
        }
        if (localIdx >= 0) {
          const local = list[localIdx];
          canonical = {
            ...effectiveRawItem,
            renderKey: local.renderKey ?? local.id,
            createdAt: local.createdAt ?? Date.now(),
          };
          list[localIdx] = canonical;
        } else {
          const existingIdx = list.findIndex((item) => item.id === effectiveRawItem.id);
          if (existingIdx >= 0) {
            const existing = list[existingIdx];
            canonical = { ...existing, ...effectiveRawItem };
            // Completion snapshots may omit the data already streamed by deltas.
            for (const field of ["summary", "content", "aggregatedOutput", "output"]) {
              const value = canonical[field];
              if ((value == null || value === "" || (Array.isArray(value) && value.length === 0)) && existing[field] != null) {
                canonical[field] = existing[field];
              }
            }
            // 内核完成事件偶尔不带 text（文本只走过 delta）：流式期间已累积在 item 上，不能被空串覆盖
            if (
              !String(canonical.text ?? "").trim() &&
              String(existing.text ?? "").trim() &&
              (itemType(effectiveRawItem) === "agentMessage" || itemType(effectiveRawItem) === "agent_message")
            ) {
              canonical = { ...canonical, text: existing.text };
            }
            // 落地后去掉流式标记
            if ("_streaming" in canonical) {
              const { _streaming: _drop, ...rest } = canonical as ThreadItem & { _streaming?: unknown };
              canonical = rest as ThreadItem;
            }
            list[existingIdx] = canonical;
          } else {
            canonical = { ...effectiveRawItem, renderKey: effectiveRawItem.id,
              createdAt: parseTime(params.startedAtMs) || parseTime(rawItem.startedAtMs) || parseTime(rawItem.createdAt) || Date.now() };
            list.push(canonical);
          }
        }

        const turnList = [...(st.turns[threadId] ?? [])];
        const effectiveTurnId = turnId ?? st.activeTurnId[threadId];
        let targetTurn = effectiveTurnId ? turnList.findIndex((turn) => turn.id === effectiveTurnId) : -1;
        // 用户项可能先被放进乐观回合；按 renderKey 找到它后就地迁移到真实 turn。
        if (targetTurn < 0) {
          targetTurn = turnList.findIndex((turn) => turn.items.some((item) => item.renderKey === canonical.renderKey || item.id === canonical.id));
        }
        if (targetTurn < 0) {
          turnList.push({ id: effectiveTurnId ?? `turn_${canonical.createdAt ?? Date.now()}`, items: [], startedAtMs: canonical.createdAt as number, status: "running" });
          targetTurn = turnList.length - 1;
        }
        let itemIdx = turnList[targetTurn].items.findIndex((item) => item.renderKey === canonical.renderKey || item.id === canonical.id);
        if (itemIdx < 0) turnList[targetTurn] = { ...turnList[targetTurn], items: [...turnList[targetTurn].items, canonical] };
        else {
          const turnItems = [...turnList[targetTurn].items];
          turnItems[itemIdx] = canonical;
          turnList[targetTurn] = { ...turnList[targetTurn], items: turnItems };
        }
        if (localIdx >= 0) {
          const key = String(canonical.renderKey ?? canonical.id);
          for (let i = 0; i < turnList.length; i += 1) {
            if (i === targetTurn) continue;
            turnList[i] = {
              ...turnList[i],
              items: turnList[i].items.filter((item) => String(item.renderKey ?? item.id) !== key),
            };
          }
        }

        if (canonical.phase === "final_answer" && String(canonical.text ?? "").trim() && turnList[targetTurn].finalAssistantStartedAtMs == null) {
          turnList[targetTurn] = { ...turnList[targetTurn], finalAssistantStartedAtMs: Date.now() };
          saveTurnTiming(threadId, turnList[targetTurn]);
        }
        const nextStreaming = { ...st.streaming };
        const nextStreamingItemId = { ...st.streamingItemId };
        const nextActiveItemId = { ...st.activeItemId };
        const nextPhase = { ...st.turnPhase };
        if (method === "item/completed" && (itemType(effectiveRawItem) === "agentMessage" || itemType(effectiveRawItem) === "agent_message")) {
          if (nextStreamingItemId[threadId] === effectiveRawItem.id || nextStreamingItemId[threadId] == null) {
            nextStreaming[threadId] = "";
            nextStreamingItemId[threadId] = undefined;
          }
        }
        if (method === "item/started") {
          if (isUserMsg) {
            nextActiveItemId[threadId] = undefined;
            nextPhase[threadId] = st.turnPhase[threadId] ?? "thinking";
          } else {
            nextActiveItemId[threadId] = effectiveRawItem.id;
            nextPhase[threadId] = phaseForItem(effectiveRawItem);
          }
        } else if (nextActiveItemId[threadId] === effectiveRawItem.id) {
          nextActiveItemId[threadId] = undefined;
          nextPhase[threadId] = itemType(effectiveRawItem) === "agentMessage" || itemType(effectiveRawItem) === "agent_message" ? "responding" : "thinking";
        }
        return {
          items: { ...st.items, [threadId]: list },
          turns: { ...st.turns, [threadId]: removeLocalTurnIfEmpty(turnList) },
          streaming: nextStreaming,
          streamingItemId: nextStreamingItemId,
          turnActive: method === "item/started" ? { ...st.turnActive, [threadId]: true } : st.turnActive,
          activeTurnId: method === "item/started" && effectiveTurnId ? { ...st.activeTurnId, [threadId]: effectiveTurnId } : st.activeTurnId,
          activeItemId: nextActiveItemId,
          turnPhase: nextPhase,
        };
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.delta !== "string" || !params.delta) return;
      queueDelta({ threadId, turnId, itemId: params.itemId, kind: "agent", text: params.delta });
      set((st) => ({
        turnActive: { ...st.turnActive, [threadId]: true },
        activeItemId: { ...st.activeItemId, [threadId]: params.itemId as string },
        turnPhase: { ...st.turnPhase, [threadId]: "responding" },
      }));
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.delta !== "string" || !params.delta) return;
      queueDelta({ threadId, turnId, itemId: params.itemId, kind: "reasoning", text: params.delta, summaryIndex: typeof params.summaryIndex === "number" ? params.summaryIndex : 0 });
      set((st) => ({
        turnActive: { ...st.turnActive, [threadId]: true },
        activeItemId: { ...st.activeItemId, [threadId]: params.itemId as string },
        turnPhase: { ...st.turnPhase, [threadId]: "thinking" },
      }));
      return;
    }

    if (method === "item/reasoning/textDelta") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.delta !== "string" || !params.delta) return;
      queueDelta({ threadId, turnId, itemId: params.itemId, kind: "reasoningText", text: params.delta });
      set((st) => ({
        turnActive: { ...st.turnActive, [threadId]: true },
        activeItemId: { ...st.activeItemId, [threadId]: params.itemId as string },
        turnPhase: { ...st.turnPhase, [threadId]: "thinking" },
      }));
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.delta !== "string" || !params.delta) return;
      queueDelta({ threadId, turnId, itemId: params.itemId, kind: "command", text: params.delta });
      return;
    }

    // 回合级计划更新（turn/plan/updated）：plan 可能是数组或 { steps: [...] }，
    // 每项 { step, status: pending|inProgress|completed }。优先更新当前回合已有的
    // plan/todoList item，没有再建合成项，避免与 item 级计划卡片重复。
    if (method === "turn/plan/updated") {
      if (!threadId || !turnId) return;
      const rawPlan = params?.plan;
      const rawSteps = Array.isArray(rawPlan) ? rawPlan : isRecord(rawPlan) && Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
      const todoItems = rawSteps
        .map((step) => (isRecord(step) ? { text: String(step.step ?? step.text ?? ""), status: String(step.status ?? "pending") } : null))
        .filter((step): step is { text: string; status: string } => step !== null && Boolean(step.text));
      if (!todoItems.length) return;
      set((st) => {
        const turnList = [...(st.turns[threadId] ?? [])];
        const turnIndex = turnList.findIndex((turn) => turn.id === turnId);
        if (turnIndex < 0) return st;
        const turnItems = [...turnList[turnIndex].items];
        let planItemId = turnItems.find((item) => ["plan", "todoList", "todo_list"].includes(itemType(item)))?.id;
        if (!planItemId) planItemId = `plan_${turnId}`;
        const hasActiveStep = todoItems.some((step) => step.status !== "completed");
        const patched = patchThreadItem(
          { ...st, turns: { ...st.turns, [threadId]: turnList } },
          threadId,
          turnId,
          planItemId,
          { type: "todoList", items: todoItems, status: hasActiveStep ? "inProgress" : "completed" },
          "todoList",
        );
        return {
          items: patched.items,
          turns: patched.turns,
          turnActive: { ...st.turnActive, [threadId]: true },
          activeTurnId: { ...st.activeTurnId, [threadId]: turnId },
          turnPhase: { ...st.turnPhase, [threadId]: "planning" },
        };
      });
      return;
    }

    if (method === "item/plan/delta") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.delta !== "string" || !params.delta) return;
      queueDelta({ threadId, turnId, itemId: params.itemId, kind: "plan", text: params.delta });
      return;
    }

    if (method === "item/fileChange/patchUpdated") {
      if (!threadId || typeof params?.itemId !== "string" || !Array.isArray(params?.changes)) return;
      const current = useStore.getState();
      const patched = patchThreadItem(current, threadId, turnId, params.itemId, { changes: params.changes }, "fileChange");
      set({ items: patched.items, turns: patched.turns, activeItemId: { ...current.activeItemId, [threadId]: params.itemId }, turnPhase: { ...current.turnPhase, [threadId]: "editing" } });
      return;
    }

    if (method === "item/mcpToolCall/progress") {
      if (!threadId || typeof params?.itemId !== "string" || typeof params?.message !== "string") return;
      const current = useStore.getState();
      const patched = patchThreadItem(current, threadId, turnId, params.itemId, { progressMessage: params.message }, "mcpToolCall");
      set({ items: patched.items, turns: patched.turns, activeItemId: { ...current.activeItemId, [threadId]: params.itemId }, turnPhase: { ...current.turnPhase, [threadId]: "tool" } });
      return;
    }

    if (method === "thread/status/changed") {
      if (!threadId) return;
      // v2 协议：params.status 是 { type: "idle" | "active", activeFlags?: string[] }，
      // 旧实现把它 String() 成 "[object Object]"，导致 idle/waiting 永远匹配不到。
      const rawStatus = params?.status;
      const statusType = isRecord(rawStatus) ? String(rawStatus.type ?? "") : String(rawStatus ?? "");
      const flags = isRecord(rawStatus) && Array.isArray(rawStatus.activeFlags) ? rawStatus.activeFlags.map((f) => String(f)) : [];
      const lc = statusType.toLowerCase();
      const waiting = flags.some((f) => /waiting|approval/i.test(f)) || /waiting|input/.test(lc);
      if (waiting) {
        set((st) => ({ turnPhase: { ...st.turnPhase, [threadId]: "waiting" } }));
      } else if (lc === "idle" || /completed|ready/.test(lc)) {
        // Thread status has no turn id. Only turn/completed can finalize live work.
        if (!get().activeTurnId[threadId]) set((st) => ({ turnActive: { ...st.turnActive, [threadId]: false }, turnPhase: { ...st.turnPhase, [threadId]: "complete" } }));
      }
      return;
    }

    if (method === "turn/completed") {
      if (!threadId) return;
      flushDeltaBuffersNow();
      const turn = isRecord(params?.turn) ? params.turn : null;
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      const succeeded = status === "completed";
      const completedAtMs = parseTime(turn?.completedAtMs) || parseTime(turn?.completedAt) || parseTime(turn?.finishedAtMs) || Date.now();
      set((st) => {
        const list = [...(st.turns[threadId] ?? [])];
        const activeId = turnId ?? st.activeTurnId[threadId];
        let index = activeId ? list.findIndex((entry) => entry.id === activeId) : -1;
        if (index < 0 && !turnId) index = list.length - 1;
        if (index >= 0) {
          const entry = list[index];
          const durationMs = parseDuration(turn?.durationMs) ?? (entry.startedAtMs != null ? Math.max(0, completedAtMs - entry.startedAtMs) : undefined);
          list[index] = { ...entry, status, completedAtMs, durationMs, phase: succeeded ? "complete" : "failed", activeItemId: undefined,
            items: entry.items.map((item) => isItemComplete(item) ? item : { ...item, status: succeeded ? "completed" : status }) };
          const failure = isRecord(turn?.error) ? turn.error : null;
          if (status === "failed" && failure && !list[index].items.some(item => item.type === "streamError")) {
            list[index].items.push({ id: "stream_error_" + entry.id, type: "streamError", status: "failed", willRetry: false,
              message: String(failure.additionalDetails || failure.message || "本轮回复失败") });
          }
          saveTurnTiming(threadId, list[index]);
        }
        // A late completion must not stop a newer turn in the same thread.
        if (turnId && st.activeTurnId[threadId] && st.activeTurnId[threadId] !== turnId) {
          return { turns: { ...st.turns, [threadId]: list } };
        }
        return {
          turns: { ...st.turns, [threadId]: removeLocalTurnIfEmpty(list) },
          items: { ...st.items, [threadId]: list.flatMap((entry) => entry.items) },
          turnActive: { ...st.turnActive, [threadId]: false },
          activeTurnId: { ...st.activeTurnId, [threadId]: undefined },
          activeItemId: { ...st.activeItemId, [threadId]: undefined },
          turnPhase: { ...st.turnPhase, [threadId]: succeeded ? "complete" : "failed" },
          streaming: { ...st.streaming, [threadId]: "" },
          streamingItemId: { ...st.streamingItemId, [threadId]: undefined },
          errors: succeeded ? st.errors.filter((e) => e.threadId !== threadId) : st.errors,
        };
      });
      void get().loadThreads();
      return;
    }

    // 上下文压缩完成：内核会把压缩点写成 contextCompaction item，重新拉历史即可看到；
    // loadItems 对进行中的回合有 live merge 保护，不会冲掉当前流式内容。
    if (method === "thread/compacted") {
      if (!threadId) return;
      void get().loadItems(threadId);
      return;
    }
  },

  /**
   * 启动初始化。
   *
   * 旧实现是一条串行链（2026-10-01 前的版本）：
   *   deskState.get → refreshEnvs → reloadProjects → checkAccount → loadThreads → syncKernelIssue
   * 每一步都 await 前一步，而 checkAccount（account/read）会走网络刷新 token，
   * 实测 15~21s（timeline.jsonl 里有两次 21177ms）—— 它后面的 loadThreads 只能干等，
   * 侧栏因此长时间空白。
   *
   * 现在分三级：
   *   ① 关键路径（deskState）：拿到偏好/上次项目，用于首屏主题与项目名 —— 快，本地文件。
   *   ② 并行扇出：envs → (projects ‖ threads) ‖ 登录态检查。
   *      threads/projects 都依赖 envs（要 activeId 才能读本地库），但它们彼此**不依赖**，
   *      所以 envs 一到就并发两路，谁先回来谁先渲染。
   *   ③ checkAccount 不再阻塞任何人：它只影响"是否弹登录门"，
   *      所以放进后台，完成后单独 set 一次 loggedIn。
   *
   * 关键约束：init() 必须在 rpc 通道可用后尽快返回，
   * 让界面先画出骨架——而不是等所有数据到齐才渲染。
   */
  init: async () => {
    if (initInFlight) return initInFlight;
    initInFlight = (async () => {
      // ① 关键路径：偏好设置（本地 desk-state.json，毫秒级）
      try {
        const desk = await rpc.deskState.get();
        if (desk) {
          set({
            prefs: desk.preferences,
            activeProject: desk.projects.length
              ? (() => {
                  const latest = [...desk.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
                  return { name: latest.name, path: latest.path };
                })()
              : null,
          });
        }
      } catch (e) {
        console.warn("读取桌面状态失败", e);
      }

      // ③ 登录态检查：**不 await**。它只决定要不要弹登录门，
      //    而 account/read 在网络不顺时会拖到 20s+，绝不能占关键路径。
      void get()
        .checkAccount()
        .finally(() => {
          // 登录态回来后如果发现未登录，LoginGate 会自己出现；这里只需保证
          // 它不会因为"还没检查完"而误判成"已登录"。
        });

      // ② 环境列表：projects/threads 都依赖它，先单独拿（也是本地 RPC，快）
      await get().refreshEnvs();
      set((s) => ({ bootPhase: { ...s.bootPhase, envs: true } }));

      // ②b envs 到手后，projects 与 threads 互不依赖 → 并发。
      //     注意：这里刻意**不 await 全部**再返回，而是各自 finally 置位，
      //     这样先回来的一路可以先渲染（侧栏会先出会话、项目名稍后补上）。
      void get()
        .reloadProjects()
        .catch((e) => console.warn("项目列表加载失败", e))
        .finally(() => set((s) => ({ bootPhase: { ...s.bootPhase, projects: true } })));
      void get()
        .loadThreads()
        .catch((e) => console.warn("会话列表加载失败", e))
        .finally(() => set((s) => ({ bootPhase: { ...s.bootPhase, threads: true } })));

      // 内核配置告警：启动期广播渲染层收不到，补一次（不阻塞首屏）
      void get()
        .syncKernelIssue()
        .catch(() => undefined);
    })();
    try {
      await initInFlight;
    } finally {
      initInFlight = null;
    }
  },

  /**
   * 查登录态。**启动阶段不要刷新 token**：
   * account/read 默认会联网刷新，实测 15~21s（走代理时更久）。
   * 启动时先读缓存态（refreshToken: false，毫秒级），
   * 只有用户主动点"登录"或从设置页进入时才需要真刷新。
   */
  checkAccount: async ({ refresh = false }: { refresh?: boolean } = {}) => {
    try {
      const r = await rpc.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>(M.accountRead, {
        refreshToken: refresh,
      });
      set({ loggedIn: !!r?.account });
    } catch {
      // 自定义模型模式下 account/read 可能无 ChatGPT 账号，不视为错误
      set({ loggedIn: false });
    }
  },

  loginStart: async () => {
    try {
      const r = await rpc.request<{ authUrl?: string }>(M.accountLoginStart, {
        type: "chatgpt",
        codexStreamlinedLogin: true,
        useHostedLoginSuccessPage: true,
        appBrand: "codex",
      });
      if (r?.authUrl) {
        await rpc.openExternal(r.authUrl);
        return { ok: true as const };
      }
      return { ok: false as const, message: "内核未返回授权链接" };
    } catch (e) {
      return { ok: false as const, message: String(e).replace(/^Error:\s*/, "") };
    }
  },

  setSearchOpen: (open) => set({ searchOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setWindowNarrow: (narrow) => set({ windowNarrow: narrow }),

  setPrefs: async (patch) => {
    const previous = get().prefs;
    const next = { ...(previous ?? ({} as DeskStateShape["preferences"])), ...patch };
    set({ prefs: next as DeskStateShape["preferences"] });
    try {
      await rpc.deskState.set({ preferences: next });
    } catch (e) {
      set({ prefs: previous });
      console.warn("保存偏好设置失败", e);
    }
  },

  /**
   * 合并项目列表：自己加的（desk-state）在前，当前环境里记录的官方项目按路径去重后跟在后。
   * 两边路径相同时以自己那条为准（用户在本应用里的操作优先级更高）。
   */
  reloadProjects: async () => {
    let own: { id?: string; name: string; path: string; threadIds?: string[] }[] = [];
    try {
      const desk = await rpc.deskState.get();
      own = (desk?.projects ?? []).map((p) => ({ name: p.name, path: p.path }));
    } catch {
      /* 读不到就用空列表 */
    }
    let imported: EnvProject[] = [];
    let selectedProjectId: string | null = null;
    const env = get().envList?.envs.find((e) => e.id === get().envList?.activeId);
    if (env) {
      try {
        const r = await rpc.env.projects(env.id);
        imported = r.projects;
        selectedProjectId = r.selectedProjectId;
      } catch {
        /* 环境里没有全局状态文件时静默 */
      }
    }
    const seen = new Set(own.map((p) => p.path.toLowerCase()));
    const merged = [
      ...own,
      ...imported
        .filter((p) => !seen.has(p.path.toLowerCase()))
        .map((p) => ({ id: p.id, name: p.name, path: p.path, threadIds: p.threadIds })),
    ];
    // 自己没选过项目时，跟随环境里记录的那个（或第一个）
    const current = get().activeProject;
    const fallback =
      merged.find((p) => p.id && p.id === selectedProjectId) ?? merged[0] ?? null;
    set({
      projects: merged,
      envProjects: imported,
      activeProject: current && merged.some((p) => p.path === current.path)
        ? current
        : fallback && { name: fallback.name, path: fallback.path },
    });
  },

  syncKernelIssue: async () => {
    try {
      const issue = await rpc.kernelIssue();
      if (!issue) {
        set({ kernelError: null, kernelNotice: null });
        return;
      }
      if (issue.silent || issue.level === "info") {
        set({ kernelError: null, kernelNotice: null });
      } else {
        set(issue.level === "warn" ? { kernelNotice: issue.message, kernelError: null } : { kernelError: issue.message, kernelNotice: null });
      }
    } catch {
      /* 拿不到就算了，不影响主流程 */
    }
  },

  addProject: async (p) => {
    const current = get().projects;
    const next = [...current.filter((x) => x.path !== p.path), p];
    set({ projects: next, activeProject: p });
    try {
      const desk = await rpc.deskState.get();
      const stored = [...(desk?.projects ?? []).filter((x) => x.path !== p.path), { ...p, lastOpenedAt: Date.now() }];
      await rpc.deskState.set({ projects: stored });
    } catch (e) {
      console.warn("保存项目失败", e);
    }
  },

  setActiveProject: async (p) => {
    set({ activeProject: p });
    if (!p) return;
    try {
      const desk = await rpc.deskState.get();
      const projects = (desk?.projects ?? []).map((project) =>
        project.path === p.path ? { ...project, lastOpenedAt: Date.now() } : project,
      );
      await rpc.deskState.set({ projects });
    } catch (e) {
      console.warn("更新当前项目失败", e);
    }
  },

  refreshEnvs: async () => {
    try {
      const list = await rpc.env.list();
      set({ envList: list });
    } catch (e) {
      console.warn("env/list 失败", e);
    }
  },

  resetForEnvSwitch: async (opts) => {
    // 换环境/接入方式 = 会话全部作废：帧缓冲里就算有未提交 delta 也一并作废
    deltaBuffers.clear();
    set({
      activeThreadId: null,
      threads: [],
      items: {},
      turns: {},
      streaming: {},
      streamingItemId: {},
      turnActive: {},
      activeTurnId: {},
      activeItemId: {},
      turnPhase: {},
      approvals: [],
      errors: [],
      // 标签页记的是上个环境的会话，换环境后一律作废
      wsTabs: [],
      wsActiveTabId: null,
      wsLayout: "chat",
      wsLastContentTabId: null,
    });
    // 设置页里改接入方式时不要把人踢回首页；其余视图（线程内容已失效）回首页
    const keepView = opts?.keepView ?? get().view === "settings";
    if (!keepView) set({ view: "home", viewHistory: ["home"], viewHistoryIndex: 0 });
    await get().refreshEnvs();
    // 换了环境就换了项目清单（项目是记在环境目录里的）
    await get().reloadProjects();
    await get().checkAccount();
    await get().loadThreads();
    await get().syncKernelIssue();
  },

  setCustomizeTab: (t) => set({ customizeTab: t }),

  setModelsTab: (t) => set({ modelsTab: t }),

  setModelsIntent: (i) => set({ modelsIntent: i }),

  setRecentsExpanded: (v) => set({ recentsExpanded: v }),

  dismissError: (id) => set((s) => ({ errors: s.errors.filter((e) => e.id !== id) })),

  dismissKernelError: () => set({ kernelError: null, kernelNotice: null }),
}));
