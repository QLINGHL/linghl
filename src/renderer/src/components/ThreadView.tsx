import { memo, useCallback, createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { TerminalSquare, ChevronRight, ChevronDown, ChevronUp, Globe, ListTodo, Copy, Check, LoaderCircle, Pencil, FileText, TriangleAlert, Images, Wifi, ListCollapse, Diff, Undo2, Info, ArrowUpRight, ArrowDown, GitCommit } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { useStore, type ThreadItem, type Turn, type TurnPhase } from "../store";
import Composer from "./Composer";
import { normalizeMath } from "../lib/normalizeMath";
import { displayCommand, describeActivity, activityGroupSummary, activityGroupIconKind } from "../lib/activityModel";
import { parseReasoning } from "../vendor/codex-monitor/reasoning";
import { useActivityDisclosure } from "../lib/useActivityDisclosure";
import { ImagePreviewOverlay } from "./ImagePreviewOverlay";
import "../vendor/codex-webui/conversation.css";

/**
 * markdown 渲染统一走 memo 包装：react-markdown 每次渲染都会全量重解析文本，
 * 包一层 memo 后，流式时只有文本真正变化的那一块重新解析，
 * 历史消息在父组件重渲染（每个流式帧）时完全不碰 —— 这是流畅度的关键。
 */
const MarkdownMessage = memo(function MarkdownMessage({ text, className }: { text: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ a: MarkdownLink }}
        // 官方正文里的本地文件链接是 `[标题](D:/…/file.md)`：默认 urlTransform 会把这种
        // 无白名单协议的 URL 直接抹掉，导致识别不出「文件链接芯片」，所以原样透传。
        urlTransform={(url) => url}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});

/** 官方把指向**本地文件/产物**的链接渲染成「文件图标 + 蓝字、无下划线」的芯片
 *  （实测：`[修改与验收记录](D:/…/reply-flow-reuse.md)` → ▤ 修改与验收记录，蓝 #3284d4）；
 *  普通 http 链接仍是普通链接。 */
const LOCAL_FILE_HREF = /^(?:[a-zA-Z]:[\\/]|file:|\\\\|\/)/;

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const target = String(href ?? "");
  if (LOCAL_FILE_HREF.test(target)) {
    return (
      <span className="flow-file-link" title={target}>
        <FileText size={18} strokeWidth={1.7} aria-hidden="true" />
        {children}
      </span>
    );
  }
  return <a href={target} target="_blank" rel="noreferrer" className="flow-link">{children}</a>;
}

function textFromUserItem(item: ThreadItem): string {
  if (typeof item.text === "string") return item.text;
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * 用户消息：附件缩略图 + 附件前言剥离
 * 官方行为（实测 + asar 里的实现）：
 *   · item.content 里 `localImage` 段 → 消息**上方**一行方缩略图（80.6 CSS 方、间距 7.4、
 *     右对齐、超出横向滚动），不上文案；
 *   · 内核随消息注入的合成前言（"# Files mentioned by the user:" / "## <文件>: <路径>" /
 *     "Image attachment: true" …）官方**整段丢弃**，气泡里只留用户真正打的字
 *     （官方实测气泡首行 = 前言之后 "## My request:" 的下一行）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 官方只丢弃「前面带附件清单」的那类前言；带 request 标题时从最后一个标题之后取正文 */
const REQUEST_MARKER = /^#{1,6}\s*(?:my request|instructions in attached documents)/i;

function stripAttachmentPreamble(text: string): string {
  if (!/^\s*#{1,6}\s*Files mentioned by the user:/i.test(text)) return text;
  const lines = text.split("\n");
  let cut = -1;
  lines.forEach((line, index) => {
    if (REQUEST_MARKER.test(line.trim())) cut = index;
  });
  if (cut < 0) return text;
  return lines.slice(cut + 1).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/** 本地图片 → 渲染进程可用的自定义协议 URL（主进程只放行图片后缀、只读） */
function mediaUrl(filePath: string): string {
  return `replica-media://img/?p=${encodeURIComponent(filePath)}`;
}

/**
 * 取出 imageView 条目里的图片路径。
 * ⚠️ 内核**每条只带一个路径、字段名是 `path`（单数）** —— 实测 item 形如
 *   `{"type":"imageView","id":"exec-…","path":"D:\\…\\official-initial.png"}`
 * （以前这里按 vendor 的旧形状读 `imagePaths` 数组，结果永远读不到东西 →
 *  "Viewed N images" 这一行点不动、也铺不出图）。
 * vendor 里那份上游实现用的是 `imagePaths`，所以两个都兼容。
 */
function imageViewPaths(item: ThreadItem): string[] {
  const out: string[] = [];
  if (Array.isArray(item.imagePaths)) {
    out.push(...(item.imagePaths as unknown[]).map((value) => String(value ?? "")).filter(Boolean));
  }
  if (typeof item.path === "string" && item.path.trim()) out.push(item.path);
  return out;
}

function userMessageContent(item: ThreadItem): { text: string; images: string[] } {
  const content = item.content;
  if (!Array.isArray(content)) {
    const text = textFromUserItem(item);
    return { text: stripAttachmentPreamble(text), images: [] };
  }
  const images: string[] = [];
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const kind = String(record.type ?? "");
    if (kind === "localImage" || kind === "image") {
      const filePath = String(record.path ?? record.url ?? "").trim();
      if (filePath) images.push(filePath);
      continue;
    }
    if (typeof record.text === "string") texts.push(record.text);
  }
  const raw = texts.join("\n");
  const text = stripAttachmentPreamble(raw);
  // 前言剥完后如果什么都不剩（纯附件消息），退回原文以免气泡空白
  return { text: text || raw.trim(), images };
}

/**
 * 附件缩略图里的占位转圈。
 *
 * 官方实测（截图像素扫描，DPR 1.75）：外径 **11.4 CSS px**、描边约 **1.1px**、颜色近黑
 * （峰值 #1a1c1f → 实际就是 --c-text 那一档），带一个很小的缺口，**持续旋转**。
 * 官方在"图片还没加载出来"和"原图已经被删掉"两种情况下长得完全一样 —— 都是这个圈。
 */
function AttachmentSpinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" className="animate-spin text-text" aria-hidden="true">
      {/* r=5 + strokeWidth 1 → 外径 11（官方像素实测 10.9）；周长 31.4，留 2.5 的缺口 */}
      <circle cx="5.5" cy="5.5" r="5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeDasharray="28.9 2.5" />
    </svg>
  );
}

/**
 * 单个附件缩略图（官方实测 80.6 CSS 方、圆角 10、底 #fff、描边 #e4e4e5 = --c-card-border）。
 *
 * ⚠️ 关键：加载中 / 加载失败都**只显示中心那个转圈**，绝不露出浏览器的破图图标。
 * 原生 <img> 在文件不存在时会自己画一个"碎图片"的兜底图标（还贴在左上角），
 * 那是浏览器的默认降级外观，不是官方行为 —— 官方把原图删掉后依然是一个转圈，
 * 因为对它来说只是"数据还没到"。所以这里出错时直接把 <img> 卸掉，别让它有机会画图标。
 */
/** 点缩略图打开全屏预览（官方 useImageDialog）：由 ThreadView 提供，缩略图只需要"传一组路径 + 当前第几张" */
const ImagePreviewContext = createContext<((paths: string[], index: number) => void) | null>(null);

function AttachmentThumb({ filePath, paths, index = 0 }: { filePath: string; paths?: string[]; index?: number }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const openPreview = useContext(ImagePreviewContext);
  const clickable = Boolean(openPreview && paths && paths.length);
  return (
    <div
      data-attachment-thumb={filePath}
      onClick={clickable ? () => openPreview?.(paths as string[], index) : undefined}
      className={`relative h-[80px] w-[80px] shrink-0 overflow-hidden rounded-[10px] border border-[var(--c-card-border)] bg-[var(--c-bg)]${clickable ? " cursor-pointer" : ""}`}
    >
      {status !== "error" ? (
        <img
          src={mediaUrl(filePath)}
          alt=""
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          className={`h-full w-full object-cover ${status === "ready" ? "" : "opacity-0"}`}
        />
      ) : null}
      {status === "ready" ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <AttachmentSpinner />
        </div>
      )}
    </div>
  );
}

/** 附件缩略图行：官方像素实测 80 CSS 方、间距 8（= gap-2）、右对齐、可横向滚动 */
function AttachmentStrip({ paths }: { paths: string[] }) {
  return (
    <div className="mb-[19px] flex max-w-full justify-end gap-[8px] overflow-x-auto">
      {paths.map((filePath, index) => (
        <AttachmentThumb key={`${filePath}-${index}`} filePath={filePath} paths={paths} index={index} />
      ))}
    </div>
  );
}

/** 用户消息气泡：回合开场的提问、以及回合中途追加的 steering 消息共用（官方同一套样式：
 *  右对齐、浅灰底 #f3f3f4、圆角 16、最宽 70%，附件缩略图在气泡上方） */
const UserMessageBubble = memo(function UserMessageBubble({ item, fadeUp = false }: { item: ThreadItem; fadeUp?: boolean }) {
  const { text, images } = userMessageContent(item);
  if (!text && !images.length) return null;
  return (
    <div className={`group flex flex-col items-end gap-2 pt-2.5 pb-0.5${fadeUp ? " fade-up" : ""}`} data-user-message-id={String(item.id)}>
      {images.length ? <AttachmentStrip paths={images} /> : null}
      {text ? <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl bg-[var(--c-bg-raised)] px-3.5 py-2.5 text-[14px] leading-6 text-text">{text}</div> : null}
      <div className="w-full">
        <MessageActions side="right" time={item.createdAt as number} text={text} tooltip="复制消息" />
      </div>
    </div>
  );
});

// A turn keeps commentary/tool activity separate from its final answer.

const USER_TYPES = new Set(["userMessage", "user_message"]);
const ASSISTANT_TYPES = new Set(["agentMessage", "agent_message"]);
const PLAN_TYPES = new Set(["plan", "todoList", "todo_list"]);

/** todo、commentary 中间叙述、以及**回合中途追加的用户消息（steering）**都属于活动区 */
function isActivityItem(item: ThreadItem): boolean {
  const type = String(item.type ?? item.itemType ?? "");
  // 纯展示性、与"工作过程"无关的项不进活动区
  if (type === "enteredReviewMode" || type === "exitedReviewMode") return false;
  return true;
}

interface SplitTurn {
  user?: ThreadItem;
  /** 最终回复之前的全部工作项（含 commentary、todo、reasoning、工具、以及中途追加的用户消息），保持原始顺序 */
  activity: ThreadItem[];
  /** 最终助手回复；优先 phase=final_answer，避免把 commentary 当成最终答案。 */
  assistant?: ThreadItem;
  /** 除了最终回复之外、出现在回复之后的条目（少见的边角情况） */
  trailing: ThreadItem[];
  /** 全程都没有最终回复（进行中的回合 / 被中断） */
  pending: boolean;
}

function splitTurn(turn: Turn): SplitTurn {
  let assistantIdx = -1;
  // Explicit commentary is never final. A legacy unphased message may be final
  // only if no subsequent work item follows it.
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    const item = turn.items[i];
    if (ASSISTANT_TYPES.has(String(item.type ?? ""))) {
      const phase = typeof item.phase === "string" ? item.phase : "";
      const looksLikeFinal = phase === "final_answer" || (!phase && String(item.text ?? "").trim().length > 0);
      const hasLaterWork = turn.items.slice(i + 1).some(isActivityItem);
      if (phase === "final_answer" || (!phase && looksLikeFinal && !hasLaterWork)) {
        assistantIdx = i;
        break;
      }
    }
  }
  // 只有**第一条**用户消息算「本轮提问」，要提到折叠头上方；
  // 回合中途追加的用户消息（steering）官方是当活动项渲染的，不能丢。
  const firstUserIdx = turn.items.findIndex((x) => USER_TYPES.has(String(x.type ?? "")));
  const user = firstUserIdx >= 0 ? turn.items[firstUserIdx] : undefined;
  const activity: ThreadItem[] = [];
  const trailing: ThreadItem[] = [];
  turn.items.forEach((item, i) => {
    if (i === firstUserIdx) return;
    if (i === assistantIdx) return;
    if (assistantIdx >= 0 && i > assistantIdx) {
      if (isActivityItem(item)) trailing.push(item);
      return;
    }
    if (isActivityItem(item)) activity.push(item);
  });
  return {
    user,
    activity,
    trailing,
    assistant: assistantIdx >= 0 ? turn.items[assistantIdx] : undefined,
    pending: assistantIdx < 0,
  };
}

/** 内核耗时字段可能是 ms 数字，也可能是 { secs, nanos }，统一转 ms */
function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const secs = typeof o.secs === "number" ? o.secs : typeof o.seconds === "number" ? o.seconds : undefined;
    const nanos = typeof o.nanos === "number" ? o.nanos : undefined;
    if (secs != null) return Math.round(secs * 1000 + (nanos ?? 0) / 1e6);
  }
  return null;
}

/** 官方 h(r)：用时 → 「12 秒」/「1 分 05 秒」；精度不到毫秒 */
function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分钟 ${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function itemType(item: ThreadItem | undefined): string {
  return String(item?.type ?? item?.itemType ?? "");
}

const DONE_STATUS = new Set(["completed", "complete", "success", "succeeded", "failed", "error", "declined", "cancelled", "canceled", "interrupted"]);
const RUNNING_STATUS = new Set(["inprogress", "in_progress", "running", "pending", "queued"]);

/**
 * 某项是否仍在执行。命令/文件变更有明确的 status（inProgress/completed/…），
 * 直接以 status 为准；reasoning 等没有状态的项回退到 activeItemId 匹配。
 */
function itemRunning(item: ThreadItem, activeItemId?: string): boolean {
  const status = String(item.status ?? "").toLowerCase();
  if (RUNNING_STATUS.has(status)) return true;
  if (DONE_STATUS.has(status)) return false;
  return Boolean(activeItemId && item.id === activeItemId);
}

function itemFailed(item: ThreadItem): boolean {
  const status = String(item.status ?? "").toLowerCase();
  return status === "failed" || status === "error" || status === "declined" || (item.exitCode != null && Number(item.exitCode) !== 0);
}

/** live 阶段每秒刷新一次，用于折叠头「用时 X」实时计时 */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function liveActivityLabel(item: ThreadItem | undefined, phase: TurnPhase | undefined): string {
  const type = itemType(item);
  if (type === "reasoning") return "Thinking";
  if (ASSISTANT_TYPES.has(type)) return "Thinking";
  if (type === "commandExecution" || type === "command_execution") {
    const data = describeActivity(item!, true);
    return data.label + (data.detail ? ' ' + data.detail : '');
  }
  if (type === "fileChange" || type === "file_change") return "正在编辑文件";
  if (type === "webSearch" || type === "web_search") return item?.query ? `正在搜索网页 · ${String(item.query)}` : "正在搜索网页";
  if (type === "mcpToolCall" || type === "mcp_tool_call" || type === "dynamicToolCall" || type === "dynamic_tool_call") {
    const tool = String(item?.tool ?? item?.name ?? "").trim();
    return tool ? `正在调用工具 ${tool}` : "正在调用工具";
  }
  if (PLAN_TYPES.has(type)) return "正在制定计划";
  switch (phase) {
    case "thinking":
      return "Thinking";
    case "running":
      return "正在运行命令";
    case "editing":
      return "正在编辑文件";
    case "tool":
      return "正在调用工具";
    case "planning":
      return "正在制定计划";
    case "responding":
      return "Thinking";
    case "waiting":
      return "等待你的输入";
    default:
      return "Thinking";
  }
}

/** 回合刚开始、连第一个活动项都还没有时的兜底：一条扫光「正在思考」 */
function LiveStatusLine({ item, phase }: { item?: ThreadItem; phase?: TurnPhase }) {
  return (
    <div className="flow-live-status py-2 text-[14px] text-text3" role="status">
      <span className="shimmer-text">{liveActivityLabel(item, phase)}</span>
    </div>
  );
}

/** 官方 conversation.timestampSeparator.recent：「今天 11:08」居中灰色分隔线（实测 13px、#8f8f8f） */
function formatDayLabel(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now.getTime() - 86400000);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay(date, now)) return `今天 ${clock}`;
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/* 官方 timestamps-*.js 的判定原样搬过来：
     常量 1 小时 = 3600000，10 分钟 = 600000
     show =
       (第一条用户消息 && now - sentAt > 1h)
       || (上一条是助手消息 && 间隔 > (本条是用户消息 ? 1h : 10min))
   每条 turn 的候选消息 = [{role:user, turnStartedAtMs}, {role:assistant, finalAssistantStartedAtMs}]。
   本实现额外把「前面没有带助手消息的 turn」也当作第一条用户消息（官方用 breaksPreviousAdjacency 表达
   同一种"断链"，我们这份数据里表现为 Failed/中断回合不产出助手消息）。 */
const TS_HOUR = 3600000;
const TS_TEN_MINUTES = 600000;

interface TimestampMessage {
  role: "user" | "assistant";
  sentAtMs?: number;
  breaksAdjacency?: boolean;
}

function computeTimestampSeparators(turns: Turn[], nowMs: number): (number | null)[] {
  const perTurn: TimestampMessage[][] = turns.map((turn) => {
    const messages: TimestampMessage[] = [];
    const hasAssistant = turn.finalAssistantStartedAtMs != null;
    if (turn.startedAtMs != null) {
      messages.push({ role: "user", sentAtMs: turn.startedAtMs, breaksAdjacency: !hasAssistant });
    }
    if (turn.finalAssistantStartedAtMs != null) messages.push({ role: "assistant", sentAtMs: turn.finalAssistantStartedAtMs });
    return messages;
  });
  let previous: TimestampMessage | null = null;
  let seenUser = false;
  const lastIndex = turns.length - 1;
  return perTurn.map((messages, index) => {
    let result: number | null = null;
    // 官方按「加载窗口」渲染，窗口首条用户消息只要距现在超过 1 小时就补时间线；
    // 我们一次性加载整条线程，所以把**最新一条**也当成窗口起点（实测官方正是这样：
    // 最新回合 15:21 在 15:43 与 17:4x 两次截图里都带时间线）。
    const isWindowStart = index === lastIndex;
    for (const message of messages) {
      if (message.breaksAdjacency) previous = null;
      const sentAt = message.sentAtMs;
      if (result == null && sentAt != null && Number.isFinite(sentAt)) {
        const isFirstUserTurn = message.role === "user" && !seenUser;
        const gapAfterAssistant = previous?.role === "assistant" && previous.sentAtMs != null &&
          sentAt - previous.sentAtMs > (message.role === "user" ? TS_HOUR : TS_TEN_MINUTES);
        if ((isFirstUserTurn && nowMs - sentAt > TS_HOUR) || gapAfterAssistant ||
            (isWindowStart && message.role === "user")) result = sentAt;
      }
      seenUser = seenUser || message.role === "user";
      previous = message;
    }
    return result;
  });
}

function TimestampSeparator({ ms }: { ms: number }) {
  return (
    <div className="flex select-none justify-center py-3" role="separator">
      <time className="text-[13px] leading-5 font-normal text-text3" dateTime={new Date(ms).toISOString()}>
        {formatDayLabel(ms)}
      </time>
    </div>
  );
}

/**
 * 用户消息导航条（官方 thread-user-message-navigation-rail）。
 *
 * ⚠️ 三条踩过的坑（2026-10-01 用户对照官方截图纠正）：
 *  1. **刻度 = 每一条用户消息**（含"回合中途追加的引导消息"），不是每回合一条 —— 少算会让刻度数
 *     远少于官方（那条会话官方 9~10 条，第一版只出了 2 条）。
 *  2. **静默态全部等长**（官方像素实测 6.3 CSS px、浅灰 #d2d3d3），只有"当前所在那条"是深色
 *     （#767677，长度不变）。第一版把"离当前位置的距离"一直作用在宽度上，所以静默态就参差不齐 —— 错。
 *  3. **"山峰"只在鼠标进入时出现**：以鼠标那条为峰（26px、近黑），向两侧按距离依次回落
 *     （实测 6.3 → 10.3 → 14.3 → 18.3 → 14.3 → 10.3 → 6.3），用官方那条自定义缓动曲线过渡，
 *     这也是用户说的"非常流畅丝滑"。鼠标离开 → 回到静默态。
 *
 * 官方源码依据：`_Marker_` = 26×2px，线宽 = `26 × scaleX(.2308 + .7692 × progress)`；
 * `progress`：鼠标那条 1、邻 1 = .7、邻 2 = .4、邻 3 = .2（其余 0）；颜色：普通 = 描述灰 @.4，
 * 当前/鼠标 = 文字色 @.6 / 1。容器 `absolute top-1/2 left-4 -translate-y-1/2`（纵向居中、不跟消息对齐）。
 * 点击 = `scrollIntoView({behavior:'smooth', block:'start'})`，**不做任何额外高亮/背景**。
 * 未做：官方卡片的产物 chip（网页预览/文件/图像…）与「收藏此轮对话」。
 */
const MARKER_PEAK = 26; // 官方刻度最大长度（CSS px）
const MARKER_PROGRESS_BY_DISTANCE = [1, 0.7, 0.4, 0.2]; // 鼠标那条 / 邻1 / 邻2 / 邻3
/** 官方 CSS 里那条自定义缓动（linear() 采样点），"丝滑"就是它 */
const MARKER_EASING =
  "linear(0, .398 10%, .682 20%, .843 30%, .925 40%, .972 50%, 1.004 60%, 1.008 70%, 1.003 80%, 1)";

function UserMessageRail({ entries }: { entries: { id: string; turnId: string; title: string; preview: string; outputs: { kind: "file" | "image" | "commit"; label: string }[] }[] }) {
  const [current, setCurrent] = useState(0); // 静默态那条深色刻度（"当前所在"）
  const [hovered, setHovered] = useState<number | null>(null);
  // ⚠️ 整条刻度**一直可见**（静默态 = 等长的浅灰短条 + 当前那条深一点）。
  //    只有「山峰」和浮层卡片需要鼠标移上去 —— 曾经把整条 `opacity-0` 藏起来是**错的**
  //    （用户："静默状态下它是有这个东西的…你他妈给我全部隐藏了"）。
  const hideTimer = useRef<number | null>(null);
  const hoverTimer = useRef<number | null>(null);

  // 当前所在 = 视口顶上方最后一条用户消息（官方用 top+48 判定）
  useEffect(() => {
    if (entries.length < 1) return;
    const recompute = () => {
      const root = document.querySelector(".flow-scroll");
      if (!root) return;
      const top = root.getBoundingClientRect().top;
      let found = 0;
      let any = false;
      entries.forEach((entry, index) => {
        const el = root.querySelector(`[data-user-message-id="${entry.id}"]`);
        if (!el) return;
        any = true;
        if (el.getBoundingClientRect().top - top <= 48) found = index;
      });
      if (any) setCurrent(found);
    };
    recompute();
    // 消息是异步铺开的（markdown 解析、图片加载都会改高度），补两次
    const t1 = window.setTimeout(recompute, 300);
    const t2 = window.setTimeout(recompute, 1200);
    const root = document.querySelector(".flow-scroll");
    root?.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      root?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [entries]);

  if (!entries.length) return null;

  /**
   * 跳转。⚠️ 关键：**回合中途追加的引导消息藏在折叠的「Worked for …」里**，
   * 回合默认又是收起的（用户要求），所以直接 scrollIntoView 会找不到元素、点了没反应。
   * 官方行为：先展开那一轮的工作过程，再滚到目标位置。这里照做 ——
   * 找不到目标就先点开那轮的工作过程头，等 React 渲染出来再滚。
   * 另外：官方点过去就是单纯滚过去，不加任何高亮/背景。
   */
  const jump = (index: number) => {
    const root = document.querySelector(".flow-scroll");
    if (!root) return;
    const entry = entries[index];
    const find = () => root.querySelector(`[data-user-message-id="${entry.id}"]`);
    const scrollTo = (el: Element) => el.scrollIntoView({ behavior: "smooth", block: "start" });

    const target = find();
    if (target) {
      scrollTo(target);
      return;
    }
    const turnEl = root.querySelector(`[data-turn-id="${entry.turnId}"]`);
    const workHeader = turnEl?.querySelector(".flow-work-header button") as HTMLElement | null;
    if (workHeader && workHeader.getAttribute("aria-expanded") === "false") {
      workHeader.click(); // → React 展开该轮工作过程
      // 展开后要等渲染完元素才存在；markdown 解析可能更晚，所以再补一次
      window.setTimeout(() => {
        const el = find();
        if (el) scrollTo(el);
      }, 80);
      window.setTimeout(() => {
        const el = find();
        if (el) scrollTo(el);
      }, 400);
    }
  };

  return (
    <nav
      aria-label="用户消息"
      data-rail-current={current}
      data-rail-hovered={hovered ?? ""}
      data-rail-count={entries.length}
      className="absolute top-1/2 left-4 z-20 -translate-y-1/2"
      onPointerLeave={() => {
        // 只是收掉山峰/卡片；刻度本身不隐藏
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
        if (hideTimer.current) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setHovered(null), 150);
      }}
    >
      <div className="flex max-h-[min(70vh,40rem)] flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((entry, index) => {
          const distance = hovered == null ? -1 : Math.abs(index - hovered);
          const progress = distance < 0 ? 0 : MARKER_PROGRESS_BY_DISTANCE[distance] ?? 0;
          const isHovered = hovered === index;
          const isCurrent = current === index;
          const strong = isHovered || (hovered == null && isCurrent);
          const width = MARKER_PEAK * (0.2308 + 0.7692 * progress);
          return (
            <button
              key={entry.id}
              type="button"
              aria-label={`跳转到用户消息 ${index + 1}`}
              className="flex h-[10px] w-[36px] shrink-0 items-center outline-none"
              onPointerEnter={() => {
                if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
                setHovered(index);
                hoverTimer.current = window.setTimeout(() => setHovered((value) => value ?? index), 250);
              }}
              onFocus={() => setHovered(index)}
              onClick={() => jump(index)}
            >
              <span
                className="flex h-[2px] w-[26px] items-center"
                style={{
                  color: strong ? "var(--c-text)" : "var(--c-text-3)",
                  opacity: isHovered ? 1 : strong ? 0.6 : 0.4,
                  transition: `color .16s ${MARKER_EASING}, opacity .16s ${MARKER_EASING}`,
                }}
              >
                <span
                  className="h-full rounded-full"
                  style={{
                    width: 26,
                    backgroundColor: "currentColor",
                    transform: `scaleX(${(width / 26).toFixed(4)})`,
                    transformOrigin: "left",
                    transition: `transform .16s ${MARKER_EASING}`,
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>

      {/* 预览卡（官方规格：宽 320、圆角 16、标题 14px medium 单行截断、正文 14px 灰 3 行截断） */}
      {hovered != null ? (
        <div
          className="pointer-events-none absolute left-[44px] w-[320px] -translate-y-1/2 rounded-[16px] bg-[var(--c-bg)] px-3.5 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_8px_16px_-4px_rgba(0,0,0,0.12)]"
          style={{ top: hovered * 10 + 5 }}
        >
          <div className="truncate text-[14px] font-medium text-text">{entries[hovered].title || "（无内容）"}</div>
          {entries[hovered].preview ? (
            <div className="mt-1 line-clamp-3 text-[14px] leading-6 text-text2">{entries[hovered].preview}</div>
          ) : null}
          {/* 产物 chip 行：官方 `mt-2 flex items-center gap-3 text-codex-description`，超出 3 个显示 +N */}
          {entries[hovered].outputs.length ? (
            <div className="mt-2 flex min-w-0 items-center gap-[12px] text-text3">
              {entries[hovered].outputs.slice(0, 3).map((output) => (
                <span key={output.kind + output.label} className="inline-flex min-w-0 max-w-[130px] items-center gap-1.5 text-[13px]">
                  {output.kind === "file"
                    ? <FileText size={14} className="shrink-0" />
                    : output.kind === "image"
                      ? <Images size={14} className="shrink-0" />
                      : <GitCommit size={14} className="shrink-0" />}
                  <span className="truncate">{output.label}</span>
                </span>
              ))}
              {entries[hovered].outputs.length > 3 ? (
                <span className="shrink-0 text-[13px]">+{entries[hovered].outputs.length - 3}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

/**
 * 一轮的"产物"清单 —— 就是官方浮层卡片底部那一行 chip。
 * 官方类型全集见 i18n `thread.userMessageNavigation.*Output`
 * （应用预览 / 提交 / 文件 / 图像 / Google Drive / Pull Request / 审核 / 网页预览，超出显示 `+N`）。
 * 我们目前能从内核数据里推出来的只有三种：
 *   文件（fileChange 的路径，取文件名）、图像（imageGeneration / imageView）、提交（命令里含 git commit）。
 */
function turnOutputs(items: ThreadItem[]): { kind: "file" | "image" | "commit"; label: string }[] {
  const out: { kind: "file" | "image" | "commit"; label: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: "file" | "image" | "commit", label: string) => {
    const key = kind + ":" + label;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, label });
  };
  let images = 0;
  for (const item of items) {
    const type = itemType(item);
    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: string }[]) : [];
      const files = changes.map((change) => String(change?.path ?? "")).filter(Boolean);
      if (!files.length) push("file", "文件");
      else files.forEach((file) => push("file", file.split(/[\\/]/).pop() || file));
    } else if (type === "imageGeneration" || type === "imageView" || type === "image_view") {
      images += 1;
    } else if (type === "commandExecution") {
      const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
      if (/\bgit\s+commit\b/i.test(command)) push("commit", "提交");
    }
  }
  if (images) push("image", images > 1 ? `图像 ${images}` : "图像");
  return out;
}

export default function ThreadView() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const turns = useStore((s) => (s.activeThreadId ? s.turns[s.activeThreadId] : undefined));
  const items = useStore((s) => (s.activeThreadId ? s.items[s.activeThreadId] : undefined));
  const streaming = useStore((s) => (s.activeThreadId ? s.streaming[s.activeThreadId] : ""));
  const turnActive = useStore((s) => (s.activeThreadId ? s.turnActive[s.activeThreadId] : false));
  const activeTurnId = useStore((s) => (s.activeThreadId ? s.activeTurnId[s.activeThreadId] : undefined));
  const activeItemId = useStore((s) => (s.activeThreadId ? s.activeItemId[s.activeThreadId] : undefined));
  const turnPhase = useStore((s) => (s.activeThreadId ? s.turnPhase[s.activeThreadId] : undefined));
  const threads = useStore((s) => s.threads);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinBottomRef = useRef(true);
  // 全屏图片预览（官方 useImageDialog）：缩略图点开，可左右切换
  const [imagePreview, setImagePreview] = useState<{ paths: string[]; index: number } | null>(null);
  const openImagePreview = useCallback((paths: string[], index: number) => setImagePreview({ paths, index }), []);

  useEffect(() => {
    pinBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [activeThreadId]);

  // 用户主动滚动时更新 pin 状态：程序自己的贴底滚动必然落在底部附近，
  // 因此「不在底部」只可能是用户在向上翻历史 —— 此时停止跟随；滚回底部附近再恢复。
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    pinBottomRef.current = nearBottom;
    setShowJumpToBottom((prev) => (prev === !nearBottom ? prev : !nearBottom));
  };

  /** 「滚动到底部」：回到底部并恢复自动跟随 */
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinBottomRef.current = true;
    setShowJumpToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinBottomRef.current) return;
    // markdown 是异步解析渲染的，同一帧里 scrollHeight 还没涨到最终高度，
    // 立刻滚一次 + 下一帧再校准一次，流式输出才能稳定贴住底部。
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (pinBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [items?.length, streaming, activeThreadId, turnPhase, activeItemId, turns]);

  const thread = threads.find((t) => t.id === activeThreadId);
  const title = thread?.name || thread?.title || thread?.preview || "新会话";
  // 改动文件卡片里官方显示的是相对路径 → 需要工作区根（thread.cwd / environments[0].cwd）
  const threadRaw = thread as unknown as { cwd?: string; environments?: { cwd?: string }[] } | undefined;
  const workspaceRoot = threadRaw?.cwd ?? threadRaw?.environments?.[0]?.cwd ?? "";
  const grouped = useMemo(() => (turns ?? []).map((turn) => ({ turn, split: splitTurn(turn) })), [turns]);
  // 官方卡片/预览里的路径是相对「项目根」的（例 docs/x.md、src/renderer/…）。
  // 线程 cwd 往往比项目根浅一层，所以用**整条会话**所有改动文件的公共目录前缀当根。
  const threadFileRoot = useMemo(() => {
    if (!turns || !turns.length) return workspaceRoot;
    const all = turns.flatMap((turn) => collectChangedFiles(turn.items));
    return commonFileRoot(all, workspaceRoot);
  }, [turns, workspaceRoot]);
  const timestampSeparators = useMemo(() => {
    if (!turns || !turns.length) return [] as (number | null)[];
    return computeTimestampSeparators(turns, Date.now());
  }, [turns, activeThreadId]);
  const hasTurns = grouped.length > 0;
  const lastTurnId = grouped.at(-1)?.turn.id;
  const fallbackPending = Boolean(turnActive && !streaming && !hasTurns);
  // 左侧用户消息导航条的数据：**每一条用户消息一个刻度**（官方语义就是 user message navigation，
  // 中途追加的引导消息（steering）同样要出刻度 —— 第一版只按回合取第一条，刻度数远少于官方）。
  // 标题取该条用户消息（剥掉附件前言），正文取它所在回合的助手回复。
  const railEntries = useMemo(() => {
    const out: { id: string; turnId: string; title: string; preview: string; outputs: { kind: "file" | "image" | "commit"; label: string }[] }[] = [];
    for (const { turn } of grouped) {
      // 正文 = 该轮**最后一条有文字的助手消息**。
      // ⚠️ 不能用 split.assistant：它只认 phase=final_answer（或"没有后续工作项"的旧数据），
      //    实测这几轮的回复都没被认出来 → 卡片正文全空。
      const assistantItem = [...turn.items].reverse().find(
        (item) => ASSISTANT_TYPES.has(itemType(item)) && String(item.text ?? "").trim().length > 0,
      );
      const preview = String(assistantItem?.text ?? "").replace(/\s+/g, " ").trim();
      const outputs = turnOutputs(turn.items);
      for (const item of turn.items) {
        if (!USER_TYPES.has(itemType(item)) || !item.id) continue;
        out.push({
          id: String(item.id),
          turnId: String(turn.id),
          title: userMessageContent(item).text.replace(/\s+/g, " ").trim(),
          preview,
          outputs,
        });
      }
    }
    return out;
  }, [grouped]);

  return (
    <ImagePreviewContext.Provider value={openImagePreview}>
    <div className="flow-thread relative flex h-full min-h-0 flex-col" data-conversation-renderer="project-react">
      <header className="flex h-12 shrink-0 items-center justify-between px-5">
        <h1 className="truncate text-[13.5px] font-medium text-text">{title}</h1>
        <div className="flex items-center gap-1 text-text3" />
      </header>

      <UserMessageRail entries={railEntries} />

      <div ref={scrollRef} onScroll={onScroll} className="flow-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[778px] flex-col px-6 pb-10">
          {hasTurns
            ? grouped.map(({ turn, split }, index) => {
                const isLast = turn.id === lastTurnId;
                const separatorMs = timestampSeparators[index] ?? null;
                return (
                  <TurnBlock
                    key={turn.renderKey ?? turn.id}
                    turn={turn}
                    split={split}
                    isLast={isLast}
                    timestampMs={separatorMs}
                    workspaceRoot={threadFileRoot}
                    turnActive={turnActive && (turn.id === activeTurnId || (!activeTurnId && isLast))}
                    activeItemId={turn.id === activeTurnId ? activeItemId : undefined}
                    phase={turn.id === activeTurnId ? turnPhase : undefined}
                  />
                );
              })
            : (items ?? []).map((item, i) => <ItemView key={(item.renderKey as string) || item.id || i} item={item} />)}
          {fallbackPending ? <LiveStatusLine phase={turnPhase} /> : null}
        </div>
      </div>

      {/* 「滚动到底部」按钮（官方 localConversation.scrollToBottomButton）：
          往上翻离开底部时出现在 Composer 正上方居中，点一下直接回到底部并恢复跟随。
          官方实测：直径 32 CSS px 的白色圆、极淡描边 + 很轻的投影、箭头 14px 近黑、
          水平居中、圆底边距 Composer 顶边约 16px。 */}
      <div className="relative flex shrink-0 justify-center px-[26px] pb-4">
        {showJumpToBottom ? (
          <button
            type="button"
            aria-label="滚动到底部"
            title="滚动到底部"
            onClick={jumpToBottom}
            className="absolute bottom-full left-1/2 mb-4 flex h-[32px] w-[32px] -translate-x-1/2 items-center justify-center rounded-full border border-[var(--c-card-border)] bg-[var(--c-bg)] text-text shadow-[0_2px_8px_rgba(0,0,0,0.08)] transition-colors hover:bg-[var(--c-bg-hover)]"
          >
            <ArrowDown size={14} />
          </button>
        ) : null}
        <Composer variant="thread" />
      </div>
    </div>

    {imagePreview ? (
      <ImagePreviewOverlay
        paths={imagePreview.paths}
        index={imagePreview.index}
        mediaUrl={mediaUrl}
        onIndex={(next) => setImagePreview((prev) => (prev ? { ...prev, index: next } : prev))}
        onClose={() => setImagePreview(null)}
      />
    ) : null}
    </ImagePreviewContext.Provider>
  );
}

// Keep work expanded through final streaming; collapse when the turn completes.

const TurnBlock = memo(function TurnBlock({
  turn,
  split,
  turnActive,
  activeItemId,
  phase,
  timestampMs = null,
  workspaceRoot,
}: {
  turn: Turn;
  split: SplitTurn;
  isLast: boolean;
  turnActive: boolean;
  activeItemId?: string;
  phase?: TurnPhase;
  /** 官方时间分隔线的毫秒值；null = 这条回合不显示 */
  timestampMs?: number | null;
  workspaceRoot?: string;
}) {
  const isCancelled = turn.status === "interrupted" || turn.status === "failed";
  const live = turnActive && !isCancelled;
  const now = useNowTick(live);

  const finalText = String(split.assistant?.text ?? "").trim();
  const finalStarted = Boolean(split.assistant && finalText);
  // 空壳 reasoning（既无摘要也不在执行）不算可渲染活动
  const hasRenderableActivity = split.activity.some(
    (item) => itemType(item) !== "reasoning" || reasoningText(item) || itemRunning(item, activeItemId),
  );

  // Final streaming permits manual collapse; completion supplies the default.
  const shouldAllowCollapse = (finalStarted || !live) && split.activity.length > 0;
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  // ⚠️ 默认一律收起：回合只要不再"活着"（完成 / 中断 / 失败）就折叠工作过程。
  // 曾经在失败/中断时特意保持展开，结果一条失败指令会把整屏 shell 输出铺出来 ——
  // 用户明确要求「能收起的尽量都收起」，官方也是收起的（要看细节点一下就行）。
  const collapsed = shouldAllowCollapse ? (userCollapsed ?? !live) : false;

  const durationText = useMemo(() => {
    if (turn.startedAtMs != null) {
      const end = turn.finalAssistantStartedAtMs ?? (live ? now : turn.completedAtMs);
      if (end != null) return formatDuration(Math.max(0, end - turn.startedAtMs));
    }
    return formatDuration(parseDuration(turn.durationMs));
  }, [turn.durationMs, turn.startedAtMs, turn.completedAtMs, turn.finalAssistantStartedAtMs, live, now]);

  const activeItem = activeItemId ? turn.items.find((item) => item.id === activeItemId) : undefined;
  const workLabel = live && (!durationText || durationText === "0秒") ? "Working" :
    (isCancelled ? (turn.status === "interrupted" ? "You stopped after " : "Failed after ") : live ? "Working for " : "Worked for ") + (durationText || "0秒");

  return (
    <div className="flow-turn flex min-w-0 flex-col py-1" data-turn-status={live ? "working" : turn.status} data-turn-id={String(turn.id)}>
      {timestampMs != null ? <TimestampSeparator ms={timestampMs} /> : null}
      {split.user ? <ItemView item={split.user} /> : null}

      {split.activity.some((item) => itemType(item) !== "reasoning") || (!live && hasRenderableActivity) ? (
        <div className="flow-work-header mt-3 mb-2 text-[14px] text-text3">
          <button type="button" disabled={!shouldAllowCollapse} aria-expanded={shouldAllowCollapse ? !collapsed : undefined}
            onClick={() => setUserCollapsed(!collapsed)} className="inline-flex items-center gap-1 text-left">
            <span className="tabular-nums">{workLabel}</span>
            {shouldAllowCollapse ? <ChevronRight size={16} className={collapsed ? "" : "rotate-90"} /> : null}
          </button>
        </div>
      ) : null}

      {hasRenderableActivity ? (
        <>
          {!collapsed ? <ActivityBody items={split.activity} activeItemId={activeItemId} live={live} finalStarted={finalStarted} phase={phase} /> : null}
        </>
      ) : live && !finalStarted ? (
        <LiveStatusLine item={activeItem} phase={phase} />
      ) : null}

      {/* 官方挂载点：正文之后、操作按钮之前。即使回合头收起（Worked for …›）也常驻可见。
          没有最终回复的回合（失败/中断）则直接挂在活动区之后。 */}
      {split.assistant ? (
        <ItemView
          item={split.assistant}
          showActions={!live}
          afterContent={<>{turn.errorMessage ? <TurnErrorBanner message={turn.errorMessage} /> : null}<ChangedFilesCard items={turn.items} workspaceRoot={workspaceRoot} /></>}
        />
      ) : (
        <>
          {turn.errorMessage ? <TurnErrorBanner message={turn.errorMessage} /> : null}
          <ChangedFilesCard items={turn.items} workspaceRoot={workspaceRoot} />
        </>
      )}
      {split.trailing.map((item, i) => (
        <ItemView key={(item.renderKey as string) || item.id || `tr-${i}`} item={item} />
      ))}
    </div>
  );
});

// Commentary seals the preceding group. Only the current cluster has a live status.
const ActivityBody = memo(function ActivityBody({ items, activeItemId, live = false, finalStarted = false, phase }: {
  items: ThreadItem[]; activeItemId?: string; live?: boolean; finalStarted?: boolean; phase?: TurnPhase;
}) {
  const units: { key: string; items: ThreadItem[]; standalone?: ThreadItem }[] = [];
  for (const item of items) {
    if (ASSISTANT_TYPES.has(itemType(item)) || USER_TYPES.has(itemType(item)) || PLAN_TYPES.has(itemType(item)) || ["streamError", "imageView", "image_view", "contextCompaction"].includes(itemType(item))) {
      const previous = units.at(-1);
      if (["imageView", "image_view"].includes(itemType(item)) && previous?.standalone && ["imageView", "image_view"].includes(itemType(previous.standalone))) {
        // 连续多个"查看图片"合成一行；路径要跟着合并，展开时才铺得全（数量以路径为准）
        const merged = [...imageViewPaths(previous.standalone), ...imageViewPaths(item)];
        previous.standalone = {
          ...previous.standalone,
          imagePaths: merged,
          imageCount: Math.max(Number(previous.standalone.imageCount ?? 1) + 1, merged.length),
        };
      } else units.push({ key: item.id, items: [], standalone: item });
    } else {
      const last = units.at(-1);
      if (last && !last.standalone) last.items.push(item);
      else units.push({ key: item.id, items: [item] });
    }
  }
  const tail = units.at(-1);
  return <div className="flow-activity flex min-w-0 flex-col gap-4 pt-3 pb-2">
    {units.map((unit, i) => unit.standalone
      ? <ActivityRow key={unit.key} item={unit.standalone} running={live && itemRunning(unit.standalone, activeItemId)} />
      : <ActivityCluster key={unit.key} items={unit.items} activeItemId={activeItemId} active={live && i === units.length - 1} finalStarted={finalStarted} phase={phase} />)}
    {live && !finalStarted && (!tail || tail.standalone) && !activeItemId ? <LiveStatusLine phase={phase} /> : null}
  </div>;
});

function ActivityCluster({ items, activeItemId, active, finalStarted, phase }: {
  items: ThreadItem[]; activeItemId?: string; active: boolean; finalStarted: boolean; phase?: TurnPhase;
}) {
  const [expanded, setExpanded] = useActivityDisclosure("group", items[0]?.id ?? "empty");
  const tools = items.filter(item => itemType(item) !== "reasoning");
  const runningTool = active ? tools.findLast(item => itemRunning(item, activeItemId)) : undefined;
  // codex-webui displays a lone activity directly; groups are for multiple tools.
  const singleTool = tools.length === 1;
  // ⚠️ 失败**不再**作为默认展开的理由（用户要求"能收起的尽量都收起"）：
  // 默认只在"还活着"时展开，好让人看到进度；跑完/失败后一律收起，点一下再看。
  const open = singleTool || (expanded ?? active);
  const reasoningOnly = tools.length === 0;
  const runningReasoning = active ? items.findLast(item => itemType(item) === "reasoning" && itemRunning(item, activeItemId)) : undefined;
  const visibleItems = items.filter(item => itemType(item) !== "reasoning" || reasoningText(item) ||
    (active && !finalStarted && itemRunning(item, activeItemId) && !runningTool));
  if (!active && !visibleItems.length) return null;
  const summary = activityGroupSummary(tools);
  const iconKind = activityGroupIconKind(tools);
  return <div className="flow-cluster flex min-w-0 flex-col gap-1">
    {!active && !singleTool && !reasoningOnly ? <button type="button" aria-expanded={open} title={summary} onClick={() => setExpanded(!open)} className="flow-activity-trigger flow-group-summary group/hdr inline-flex min-w-0 items-center gap-1 self-start text-[14px] text-text/60">
      {iconKind === "file-changes" ? <Pencil size={16} /> : iconKind === "commands" ? <TerminalSquare size={16} /> : iconKind === "exploration" ? <FileText size={16} /> : <Globe size={16} />}<span className="flow-activity-copy">{summary}</span><ChevronRight size={16} className={open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100"} />
    </button> : null}
    {open || reasoningOnly ? <>
      {/* Preserve event order; never move reasoning behind later commands. */}
      {visibleItems.map(item => <div key={item.id} className="flow-event" data-activity-id={item.id} data-activity-type={itemType(item)}>
        <ActivityRow item={item} running={active && itemRunning(item, activeItemId)} />
      </div>)}
      {active && !finalStarted && !runningTool && !runningReasoning ? <LiveStatusLine phase={phase} /> : null}
    </> : null}
  </div>;
}

const ActivityRow = memo(function ActivityRow({ item, running }: { item: ThreadItem; running: boolean }) {
  const type = itemType(item);
  // 官方活动行统一 text-text/60（实测文字灰度 #777 = text 60% 叠加白底），不是更浅的 tertiary
  const tone = running ? "" : "text-text/60";

  // 回合中途追加的用户消息（steering）：官方当普通用户气泡渲染，右对齐、浅灰底（实测 #f3f3f4）
  if (USER_TYPES.has(type)) return <UserMessageBubble item={item} />;

  // commentary（工具调用间隙的助手叙述）在活动区内按正文渲染
  if (ASSISTANT_TYPES.has(type)) {
    const text = String(item.text ?? "");
    if (!text.trim()) return running ? <LiveStatusLine item={item} /> : null;
    return (
      <div className="py-1" style={{ contain: "content" }}>
        <MarkdownMessage text={text} className="prose-chat text-[14px] text-text" />
      </div>
    );
  }
  if (PLAN_TYPES.has(type)) return <TodoItem item={item} />;

  switch (type) {
    case "streamError":
      return <div className={"flow-stream-error flex items-center gap-2 text-[14px] " + (item.willRetry ? "text-text3" : "text-[var(--red-500)]")} role="status">
        {item.willRetry ? <Wifi size={14} /> : <TriangleAlert size={14} />}
        <span className={running ? "shimmer-text" : ""}>{String(item.message ?? "Connection interrupted")}</span>
      </div>;
    case "imageView":
    case "image_view":
      return <ImageViewRow item={item} tone={tone} running={running} />;
    case "contextCompaction":
      return <ActivityLine tone={tone} icon={<ListCollapse size={16} />} text={running ? "Compacting context" : "Context automatically compacted"} />;
    case "commandExecution":
    case "command_execution":
      return <CommandRow item={item} tone={tone} running={running} />;
    case "fileChange":
    case "file_change":
      return <FileChangeRow item={item} tone={tone} running={running} />;
    case "webSearch":
    case "web_search":
      return <WebSearchRow item={item} running={running} />;
    case "reasoning":
      return <ReasoningRow item={item} tone={tone} running={running} />;
    case "mcpToolCall":
    case "mcp_tool_call":
    case "dynamicToolCall":
    case "dynamic_tool_call":
      return <ToolCallRow item={item} running={running} />;
    case "collabAgentToolCall":
    case "subAgentActivity": {
      const data = describeActivity(item, running);
      return <ActivityLine tone={data.tone === "error" ? "text-[var(--red-500)]" : tone}
        icon={<ListTodo size={14} />} text={data.label + (data.detail ? " · " + data.detail : "")} />;
    }
    default:
      return null;
  }
});

function WebSearchRow({ item, running }: { item: ThreadItem; running: boolean }) {
  const action = item.action && typeof item.action === "object" ? item.action as Record<string, unknown> : {};
  const query = String(item.query || action.query || (Array.isArray(action.queries) ? action.queries.join("; ") : ""));
  const label = action.type === "openPage" ? (running ? "Opening " : "Opened ") + String(action.url ?? "web page")
    : action.type === "findInPage" ? (running ? "Searching in page for " : "Searched in page for ") + String(action.pattern ?? "text")
    : (running ? "Searching the web" : "Searched the web") + (query ? " for " + query : "");
  return <ActivityLine tone="text-text/60" icon={<Globe size={16} />} text={label} />;
}

function ToolCallRow({ item, running }: { item: ThreadItem; running: boolean }) {
  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const open = savedOpen ?? false;
  const tool = String(item.tool ?? item.name ?? "tool");
  const failed = itemFailed(item) || item.success === false || Boolean(item.error);
  const stopped = ["interrupted", "cancelled", "canceled"].includes(String(item.status));
  const progress = running ? String(item.progressMessage ?? "") : "";
  const value = item.error ?? item.result ?? item.contentItems;
  const details = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const args = item.arguments == null ? "" : typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2);
  const label = (failed ? "Tool failed: " : stopped ? "Stopped " : running ? "Calling " : "Called ") + tool;
  return <div className="flex min-w-0 flex-col text-[14px] text-text/60">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flow-activity-trigger group/hdr flex min-w-0 items-center gap-1 self-start text-left">
      {failed ? <TriangleAlert size={16} /> : <TerminalSquare size={16} />}
      <span className={"min-w-0 truncate " + (running ? "shimmer-text" : "")}>{label}{progress ? " · " + progress : ""}</span>
      <ChevronRight size={16} className={open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100"} />
    </button>
    {open ? <div className="flow-tool-detail mt-2 rounded-xl border border-border bg-bgsub p-3 text-text2">
      {args ? <><div className="mb-1">Arguments</div><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px]">{args}</pre></> : null}
      {details ? <><div className="mt-2 mb-1">{failed ? "Error" : "Result"}</div><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[12px]">{details}</pre></> : null}
      <div className="mt-2 text-right">{running ? "Running" : failed ? "Failed" : stopped ? "Stopped" : "Success"}</div>
    </div> : null}
  </div>;
}

/** 旋转中的小 spinner（官方 active 行左侧） */
function Spinner({ size = 13 }: { size?: number }) {
  return <LoaderCircle size={size} className="shrink-0 animate-spin text-text2" />;
}

/** 通用活动行：图标 + 文本（官方 agent-activity-item 的 row variant） */
function ActivityLine({ tone, icon, text }: { tone: string; icon: ReactNode; text: string }) {
  return (
    <div className={`flow-activity-trigger flex min-w-0 items-center gap-2 text-[14px] ${tone}`} title={text}>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{text}</span>
    </div>
  );
}

function reasoningText(item: ThreadItem): string {
  const join = (raw: unknown) =>
    Array.isArray(raw)
      ? raw.map((s) => (typeof s === "string" ? s : String((s as { text?: unknown })?.text ?? ""))).join(" ")
      : String(raw ?? "");
  return join(item.summary) || join(item.content);
}

// A reasoning summary is a single expandable line.
const ReasoningRow = memo(function ReasoningRow({ item, tone, running }: { item: ThreadItem; tone: string; running: boolean }) {
  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const open = savedOpen ?? false;
  const text = reasoningText(item);
  const parsed = parseReasoning({ summary: text });
  const preview = parsed.workingLabel ?? "";
  if (!preview && !running) return null;
  return <div className="flex min-w-0 flex-col">
    <button type="button" aria-expanded={open} onClick={() => text && setOpen(!open)}
      className="flow-activity-trigger flow-reasoning-trigger group/hdr inline-flex min-w-0 max-w-full items-center gap-1 self-start text-left text-[14px] text-text/60">
      <span className={"min-w-0 truncate " + (running ? "shimmer-text" : "")}>{preview || "Thinking"}</span>
      {text ? <ChevronRight size={16} className={"shrink-0 transition-transform duration-relaxed " + (open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100")} /> : null}
    </button>
    {open && text ? <MarkdownMessage text={text} className="prose-chat flow-reasoning-detail py-2 text-[14px] text-text/60" /> : null}
  </div>;
});

/**
 * 「查看图片」行：**可以点开看那几张图**（官方行为，用户对照指出我们原来是死的、点不动）。
 *
 * 官方实测（用户提供的截图，同倍率 DPR 1.75）：
 *   · 折叠态 = 只有图标 + "Viewed N images"，不显示箭头（hover 才出）；
 *   · 展开态 = 箭头朝下，图片在**行的下方左对齐**铺开；
 *   · 每张 79.4 CSS 方、间距 8.6 —— 与附件缩略图（81 + 7.4）同尺寸同间距，
 *     所以直接复用 AttachmentThumb（连"图没了显示转圈"的行为也一起继承）。
 * 没有任何可用路径时退化成不可点的纯文本行。
 */
const ImageViewRow = memo(function ImageViewRow({ item, tone, running }: { item: ThreadItem; tone: string; running: boolean }) {
  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const paths = imageViewPaths(item);
  const count = paths.length || Number(item.imageCount ?? 0);
  const open = savedOpen ?? false;
  const expandable = paths.length > 0;
  const label = count > 1 ? `Viewed ${count} images` : running ? "Viewing an image" : "Viewed an image";
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => expandable && setOpen(!open)}
        className={`flow-activity-trigger group/hdr inline-flex min-w-0 items-center gap-1 self-start text-left text-[14px] ${tone}`}
      >
        <Images size={16} className="shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {expandable ? (
          <ChevronRight size={16} className={"shrink-0 transition-transform duration-relaxed " + (open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100")} />
        ) : null}
      </button>
      {open && expandable ? (
        /* 官方源码（conversation-blocks）：body = 「hide-scrollbar flex max-w-full overflow-x-auto pb-1」
           → 内层「flex min-w-max gap-[8px]」，即**单行横向滚动、不换行**、间距 gap-2 = 8px。
           这里用任意值写法实现 hide-scrollbar，免得为一个工具类改全局 CSS。 */
        <div className="mt-[10px] flex max-w-full overflow-x-auto pb-[4px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max gap-[8px]">
            {paths.map((filePath, index) => <AttachmentThumb key={`${filePath}-${index}`} filePath={filePath} paths={paths} index={index} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
});

// Commands stay compact until opened; command and output share one Shell card.
const CommandRow = memo(function CommandRow({
  item,
  tone,
  running,
  embedded = false,
}: {
  item: ThreadItem;
  tone: string;
  running: boolean;
  /** 嵌在探索组内时的标记（保留给后续样式微调） */
  embedded?: boolean;
}) {
  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const cmd = displayCommand(Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? ""));
  const output = String(item.aggregatedOutput ?? item.output ?? "");
  const failed = itemFailed(item);
  const data = describeActivity(item, running);
  const stopped = ["interrupted", "cancelled", "canceled"].includes(String(item.status));
  const actionLabel = ["read", "search", "list"].includes(data.category ?? "")
    ? data.label + (data.detail ? " " + data.detail : "") : null;
  const hasBody = Boolean(output || cmd);
  // 默认收起（失败也一样！）：失败的指令曾经自动展开把整段输出铺出来，用户嫌吵。
  // 行本身仍然是红的（标题 "Command failed" + 警告图标），要看详情点一下。
  const open = savedOpen ?? false;

  const header = <>
    {failed ? <TriangleAlert size={16} className="shrink-0" /> : <TerminalSquare size={16} className="shrink-0" />}
    <span className={"min-w-0 truncate " + (running ? "shimmer-text" : "")}>
      {failed ? "Command failed" : stopped ? "Stopped command" : actionLabel ??
        (running ? "Running " : "Ran ") + (cmd.replace(/\s+/g, " ").trim() || "command")}
    </span>
    {hasBody ? <ChevronRight size={16} className={"shrink-0 transition-transform duration-relaxed " + (open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100")} /> : null}
  </>;

  return (
    <div className="flex min-w-0 flex-col">
      {hasBody ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className={`flow-activity-trigger group/hdr inline-flex min-w-0 max-w-full items-center gap-1 self-start text-start text-[14px] ${
            failed ? "text-[var(--red-500,#e02e2a)]" : "text-text/60"
          }`}
        >
          {header}
        </button>
      ) : (
        <div className={`flow-activity-trigger inline-flex min-w-0 max-w-full items-center gap-1 self-start text-[14px] ${running ? "text-text" : tone}`}>{header}</div>
      )}
      {open && hasBody ? (
        <div className="flow-shell">
          <div className="flow-shell-heading">Shell</div>
          <div className="flow-shell-command"><span aria-hidden="true">$</span><code>{cmd}</code></div>
          {output ? <div className="flow-shell-output"><pre>{output}</pre></div> : null}
          <div className="flow-shell-footer">{running ? "Running" : failed ? "Failed" : stopped ? "Stopped" : <><Check size={13} /> Success</>}</div>
        </div>
      ) : null}
    </div>
  );
});

/** 文件变更行：一行摘要 + hover 箭头，点开 diff；计数按 changes 里的文件路径（一个 item 可含多个文件） */
const FileChangeRow = memo(function FileChangeRow({ item, tone, running }: { item: ThreadItem; tone: string; running: boolean }) {
  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; diff?: string }[]) : [];
  const patch = changes.map((change) => change.diff ?? "").filter(Boolean).join("\n");
  const paths = new Set(changes.map((c) => c.path).filter(Boolean));
  const n = paths.size || changes.length || 1;
  // 被用户拒绝 / 执行失败要明确区分，不能仍显示"编辑了 N 个文件"
  const status = String(item.status ?? "").toLowerCase();
  const declined = status === "declined";
  const failed = !running && (declined || status === "failed" || status === "error");
  const stopped = ["interrupted", "cancelled", "canceled"].includes(status);
  const label = running ? "Editing files" : declined ? "File edit declined" : failed ? "File edit failed"
    : stopped ? "Stopped editing files" : n === 1 ? "Edited a file" : "Edited " + n + " files";
  const hasBody = Boolean(patch);
  // 同上：失败/被拒绝的编辑也默认收起，行文案本身已经说明状态。
  const open = savedOpen ?? false;
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => {
          setOpen(!open);
        }}
        className={`flow-activity-trigger group/hdr inline-flex min-w-0 max-w-full items-center gap-1 self-start text-start text-[14px] ${
          failed ? "text-[var(--red-500,#e02e2a)]" : running ? "text-text" : tone
        }`}
      >
        {running ? (
          <Spinner size={16} />
        ) : failed ? (
          <TriangleAlert size={16} className="shrink-0" />
        ) : (
          <span className="shrink-0"><Pencil size={16} /></span>
        )}
        <span className="truncate">{label}</span>
        {hasBody ? (
          <ChevronRight
            size={16}
            className={`shrink-0 transition-transform duration-relaxed ${open ? "rotate-90 opacity-100" : "opacity-0 group-hover/hdr:opacity-100"}`}
          />
        ) : null}
      </button>
      {open && patch ? <DiffView patch={patch} /> : null}
    </div>
  );
});

function DiffView({ patch }: { patch: string }) {
  return (
    <div className="flow-diff mt-1.5 max-h-80 overflow-auto rounded-xl border border-border font-mono text-[12px] leading-5">
      {patch.split("\n").map((line, i) => {
        const cls = line.startsWith("+")
          ? "bg-[var(--c-diff-add-bg)] text-[var(--c-diff-add-fg)]"
          : line.startsWith("-")
            ? "bg-[var(--c-diff-del-bg)] text-[var(--c-diff-del-fg)]"
            : "text-text2";
        return (
          <div key={i} className={`whitespace-pre px-3 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 平铺渲染（无 turn 分组时兜底 / 用户消息 / 最终回复 / 计划卡片）
 * ──────────────────────────────────────────────────────────────────────────── */

/** memo：流式帧只更新缓冲区对应的那个节点，历史消息绝不跟着重渲染 */
const ItemView = memo(function ItemView({ item, showActions = true, afterContent }: { item: ThreadItem; showActions?: boolean; afterContent?: ReactNode }) {
  const type = String(item.type ?? item.itemType ?? "");
  switch (type) {
    case "userMessage":
    case "user_message":
      return <UserMessageBubble item={item} fadeUp />;
    case "agentMessage":
    case "agent_message": {
      const text = (item.text as string) ?? "";
      if (!text.trim()) return null;
      // 刻意不加 fade-up：流式阶段文字已在该节点上增长，落地后再播淡入会「闪一下」。
      return (
        <div className="group py-2">
          <MarkdownMessage text={text} className="prose-chat text-[14px] text-text" />
          {/* 官方顺序：正文 → 错误横幅/改动文件卡片 → 操作按钮（复制/分叉在最下） */}
          {afterContent}
          {showActions ? <MessageActions side="left" time={item.createdAt as number} text={text} tooltip="复制回复" alwaysVisible /> : null}
        </div>
      );
    }
    case "plan":
    case "todoList":
    case "todo_list":
      return <TodoItem item={item} />;
    default:
      return null;
  }
});

/** plan 与 todoList 是两种不同的东西：
 *  - todoList：带 items 数组的真实待办清单 → 渲染勾选进度
 *  - plan：内核只给一段 text（EXPERIMENTAL），没有 items。以前硬套清单会渲染出
 *    「计划 · 0/1」这种假进度，现在按正文渲染。 */
function TodoItem({ item }: { item: ThreadItem }) {
  const raw = Array.isArray(item.items) ? item.items : [];
  const todos = raw as { text?: string; completed?: boolean; status?: string }[];
  const visible = todos.filter((todo) => todo.text);
  if (!visible.length) {
    const text = String(item.text ?? "");
    if (!text) return null;
    return (
      <div className="my-1.5 rounded-xl border border-border bg-bgsub px-3.5 py-3 text-[13px] text-text">
        <div className="mb-1.5 flex items-center gap-2 text-text2">
          <ListTodo size={14} />
          计划
        </div>
        <MarkdownMessage text={text} className="prose-chat text-[13px]" />
      </div>
    );
  }
  const done = visible.filter((todo) => todo.completed || todo.status === "completed").length;
  return (
    <div className="my-1.5 rounded-xl border border-border bg-bgsub px-3.5 py-3 text-[13px]">
      <div className="mb-1.5 flex items-center gap-2 text-text2">
        <ListTodo size={14} />
        计划 · {done}/{visible.length}
      </div>
      <ul className="flex flex-col gap-1">
        {visible.map((todo, i) => {
          const completed = todo.completed || todo.status === "completed";
          return (
            <li key={i} className="flex items-start gap-2 text-text2">
              <span className={completed ? "text-[var(--green-500)]" : "text-text3"}>{completed ? "✓" : "○"}</span>
              <span className={completed ? "line-through opacity-60" : ""}>{todo.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 消息下方操作栏（对齐官方）：
 *  - 用户消息：整条 hover 才出现「时间 + 复制」，时间在前、图标在后
 *  - 助手回复：复制图标常显，hover 才补上时间（图标在前、时间在后）
 * 操作栏始终占位（只切 opacity）—— 否则 hover 时高度突变会让整条消息上下跳。
 */
function MessageActions({
  side,
  time,
  text,
  tooltip,
  alwaysVisible = false,
}: {
  side: "left" | "right";
  time?: number;
  text: string;
  tooltip: string;
  alwaysVisible?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* 剪贴板不可用时静默 */
      });
  };

  const clock = formatClock(time);
  const fade = "opacity-0 transition-opacity group-hover:opacity-100";

  return (
    <div className={`flex h-[26px] items-center gap-1 ${side === "right" ? "justify-end" : "justify-start"}`}>
      {side === "right" && clock ? <span className={`text-[12px] text-text3 ${fade}`}>{clock}</span> : null}
      <button
        type="button"
        aria-label={tooltip}
        onClick={copy}
        className={`group/copy relative flex h-[24px] w-[24px] items-center justify-center rounded-md text-text3 transition-opacity hover:bg-bghover hover:text-text2 ${
          alwaysVisible ? "opacity-100" : fade
        }`}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 opacity-0 transition-opacity group-hover/copy:opacity-100">
          <span className="flex h-[25px] items-center whitespace-nowrap rounded-[8px] bg-[var(--gray-1000)] px-2 text-[12px] font-medium text-[var(--gray-0)] shadow-[0_4px_12px_rgba(0,0,0,0.18)]">
            {copied ? "已复制" : tooltip}
          </span>
        </span>
      </button>
      {side === "left" && clock ? <span className={`text-[12px] text-text3 ${fade}`}>{clock}</span> : null}
    </div>
  );
}

/** 消息时间：官方只显示 时:分 */
function formatClock(ms?: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 回合级「改动文件」卡片 + 回合错误横幅
 * 官方实测（UIA，物理 px ÷1.75 = CSS）：
 *   · 卡片满内容宽 736.6、1px 描边 #e3e3e4、圆角 14、白底
 *   · 头部高 65：左 20 处 24.6 大小图标块（底 #f6f6f6）→ 右侧 62 处标题（单文件=文件名、
 *     多文件=Edited N files）+ 下面 +N / -M（绿/红）；右端「Undo ↺」(67×28.6) +「View changes」药丸(96×28.6)
 *   · 文件列表行高 37，最后一行「Show N more files ⌄」
 *   · 回合错误（turn.error.message，例：429 重试超限）渲染成同宽横幅：1px 描边、
 *     ⓘ 18.3 在左 20 处、文字 14px
 * ──────────────────────────────────────────────────────────────────────────── */

interface ChangedFile {
  path: string;
  adds: number;
  dels: number;
  /** hover 预览用的 diff 行（带行号与增删类型），官方预览就是这些行 */
  lines: DiffLine[];
}

interface DiffLine {
  no: number;
  kind: "add" | "del" | "ctx";
  text: string;
}

const MAX_PREVIEW_LINES = 400;

/** 官方 hint / diff 列表：把内核给的文件内容（add）或 unified diff（update）解析成可显示的行 */
function parseDiffLines(kind: string, diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  if (!diff) return out;
  if (kind === "add") {
    diff.split("\n").slice(0, MAX_PREVIEW_LINES).forEach((text, index) => out.push({ no: index + 1, kind: "add", text }));
    return out;
  }
  if (kind === "delete") {
    diff.split("\n").slice(0, MAX_PREVIEW_LINES).forEach((text, index) => out.push({ no: index + 1, kind: "del", text }));
    return out;
  }
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split("\n")) {
    if (out.length >= MAX_PREVIEW_LINES) break;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) out.push({ no: newNo++, kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ no: oldNo++, kind: "del", text: raw.slice(1) });
    else if (raw.startsWith(" ")) {
      out.push({ no: newNo, kind: "ctx", text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    } else if (raw.trim()) out.push({ no: newNo, kind: "ctx", text: raw });
  }
  return out;
}

function countDiffLines(kind: string, diff: string): { adds: number; dels: number } {
  if (!diff) return { adds: 0, dels: 0 };
  const lines = diff.split("\n");
  if (kind === "add") return { adds: lines.filter((line, index) => line.length > 0 || index < lines.length - 1).length, dels: 0 };
  if (kind === "delete") return { adds: 0, dels: lines.length };
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) dels += 1;
  }
  return { adds, dels };
}

/** 把整个回合的 fileChange 按路径合并（官方卡片就是回合级汇总） */
function collectChangedFiles(items: ThreadItem[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const item of items) {
    const type = itemType(item);
    if (type !== "fileChange" && type !== "file_change") continue;
    const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: { type?: string }; diff?: string }[]) : [];
    for (const change of changes) {
      const filePath = String(change.path ?? "");
      if (!filePath) continue;
      const kind = String(change.kind?.type ?? "update");
      const diff = String(change.diff ?? "");
      const { adds, dels } = countDiffLines(kind, diff);
      const previous = files.get(filePath);
      if (previous) {
        previous.adds += adds;
        previous.dels += dels;
        if (previous.lines.length === 0) previous.lines = parseDiffLines(kind, diff);
      } else {
        files.set(filePath, { path: filePath, adds, dels, lines: parseDiffLines(kind, diff) });
      }
    }
  }
  return [...files.values()];
}

function displayPath(filePath: string, workspaceRoot?: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const root = (workspaceRoot ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  if (root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** 官方卡片显示的是相对「本回合工作目录」的路径（例：src/renderer/… 与 tools/…）。
 *  线程 cwd 常是仓库根，会比实际工作目录浅一层，所以多文件时取公共目录前缀更贴官方。 */
function commonFileRoot(files: ChangedFile[], fallback?: string): string | undefined {
  if (files.length < 2) return fallback;
  const dirs = files.map((file) => file.path.replace(/\\/g, "/").split("/").slice(0, -1));
  let common = dirs[0];
  for (const dir of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < dir.length && common[i] === dir[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length ? common.join("/") : fallback;
}

/** 官方 hover 态：卡片上方浮出该文件的 diff 预览（行号 + 增删标记 + 横向滚动），
 *  同时卡片副标题由「+N -M」换成「View changes ↗」。 */
const DiffPreview = memo(function DiffPreview({ file, root, style, popRef }: { file: ChangedFile; root?: string; style: CSSProperties; popRef?: RefObject<HTMLDivElement | null> }) {
  return (
    // 浮层是纯展示的：不挂任何鼠标事件（hover 判定完全归卡片）
    <div ref={popRef} className="flow-diff-preview" style={{ backgroundColor: "var(--c-bg, #fff)", ...style }}>
      <div className="flow-diff-preview-head">
        <span className="flow-diff-preview-path">{displayPath(file.path, root)}</span>
        <span className="flow-diff-preview-stats">
          <span className="flow-add">+{file.adds}</span>
          <span className="flow-del">-{file.dels}</span>
        </span>
      </div>
      <div className="flow-diff-preview-body">
        {file.lines.length ? file.lines.map((line, index) => (
          <div key={`${line.no}-${index}`} className={`flow-diff-line flow-diff-${line.kind}`}>
            <span className="flow-diff-no">{line.no}</span>
            <span className="flow-diff-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}</span>
            <span className="flow-diff-text">{line.text}</span>
          </div>
        )) : <div className="flow-diff-line flow-diff-ctx"><span className="flow-diff-text">（无 diff 内容）</span></div>}
      </div>
    </div>
  );
});

const ChangedFilesCard = memo(function ChangedFilesCard({ items, workspaceRoot }: { items: ThreadItem[]; workspaceRoot?: string }) {
  const files = useMemo(() => collectChangedFiles(items), [items]);
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  /** 指针是否在**卡片**上（决定卡片底色；浮层不算 —— 浮层是卡片的子节点，
   *  用 CSS :hover 会把「移到浮层上」也算成卡片 hover，用户要的正好相反） */
  const [cardHover, setCardHover] = useState(false);
  // 副标题「View changes ↗」只在 hover **卡片头** 时替换 `+N -M`；hover 文件行只出浮层（官方实测）
  const [headHover, setHeadHover] = useState(false);
  /**
   * 浮层锚点：显示的那一刻把卡片位置换算成**视口坐标**记下来，浮层用 fixed 定位。
   *
   * 为什么不跟着卡片走（position:absolute + bottom:100%）：回复还在流式生成时，
   * 卡片上方的内容一直在长高，卡片会被顶下去（实测一次 22px），浮层跟着一起甩。
   * 锁死位置后，流式再怎么顶卡片，浮层都钉在用户看到的地方。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ bottom: number; left: number; width: number } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  /** 这次浮层是贴在「哪一行」上的（单文件卡为 0）；shiftAnchor 靠它重新定位 */
  const previewRef = useRef<number | null>(null);
  previewRef.current = preview;
  /** 这次浮层选的方向：true = 贴在那行/卡片下方，false = 上方（滚动时保持一致，避免上下跳） */
  const anchorBelowRef = useRef(false);
  /** 最近一次指针位置：主进程重排后鼠标事件可能没到，用它兜住「到底还在不在卡片上」 */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * 交互定义（用户明确要求，2026-09-30 定稿）：
   *   ① 鼠标停在卡片上 **0.75 秒**后浮层才浮现（不是立刻；原是 1.5s，用户要求减半）；
   *   ② 鼠标一离开卡片（例如移到浮层上）→ 浮层**立刻**消失、卡片底色**立刻**复原；
   *   ③ 浮层不参与 hover 判定（指针停在浮层上不算「在卡片上」，浮层也不需要可交互）。
   * ②③ 意味着浮层不能再用 CSS `:hover` 驱动（它是卡片的子节点，会被一起算进去），
   * 所以底色改由 state 驱动的 class 控制，浮层的显隐由卡片上的定时器控制。
   */
  const PREVIEW_DELAY_MS = 750;
  /** 浮层最大高度（正文 130 + 头部约 38，见 conversation.css 的 .flow-diff-preview-body） */
  const POPOVER_MAX_H = 172;
  /** 浮层与卡片之间至少留出的呼吸距离 */
  const MIN_GAP = 10;

  const clearTimers = () => {
    if (showTimer.current != null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  const doClose = () => {
    clearTimers();
    setPreview(null);
    setHeadHover(false);
    setCardHover(false);
  };

  /**
   * 显示某个文件的 diff。浮层锚点按**触发它的那一行**算：
   *   - 鼠标停在文件行上 → 贴着那一行（不是贴着整张卡片）；
   *   - 单文件卡片没有行 → 贴着卡片。
   */
  const showPreview = (index: number) => {
    setPreview((current) => {
      if (current === index) return current;
      setAnchor(computeAnchor(index));
      return index;
    });
  };

  /**
   * 算浮层该贴哪儿（fixed 定位，bottom = 视口底到浮层下边缘的距离）。
   *
   * 规则（用户明确要求）：
   *   ① **默认浮在触发它的那一行（或卡片）上方** —— 浮层绝不能盖住那一行，
   *      否则「我浮在这一行上，浮层却把这一行盖住了」，看不到自己在看哪一条；
   *   ② 只有上方真的装不下（行贴着视口顶）才翻到下方。
   * 不再有「指针在上半部就优先下方」那种自作聪明的规则 —— 那正是盖住行的原因。
   *
   * 行用 `data-file-index` 标记，单文件卡片没有行就退回整张卡片。
   * 方向记在 anchorBelowRef 里，滚动/重排时复用，避免浮层上下跳。
   */
  const computeAnchor = (index: number, forceBelow?: boolean) => {
    const rowEl = rootRef.current?.querySelector<HTMLElement>(`[data-file-index="${index}"]`);
    const rect = (rowEl ?? rootRef.current)?.getBoundingClientRect();
    if (!rect) return { bottom: 0, left: 0, width: 0 };
    const width = rect.width;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    const GAP = 8;
    const aboveSpace = rect.top - GAP;
    const belowSpace = window.innerHeight - rect.bottom - GAP;
    // 默认上方；上面放不下且下面更宽裕时才翻到下方
    const below = forceBelow ?? (aboveSpace < POPOVER_MAX_H && belowSpace > aboveSpace);
    anchorBelowRef.current = below;
    return below
      ? { bottom: Math.max(GAP, belowSpace), left, width }
      : { bottom: Math.min(window.innerHeight - GAP, window.innerHeight - rect.top + GAP), left, width };
  };

  /**
   * 指针进卡片（冒泡到卡片这一层）：只负责「底色变灰」。
   *
   * 预览的触发点分两种，都走 `onCardEnter`：
   *   - **单文件卡**：整卡（含卡片头）悬浮 → 0.75s 后出预览（没有文件行可指，只能整卡触发）；
   *   - **多文件卡**：只有具体文件行才触发（见 onRowEnter），卡片头只变色不预览。
   */
  const onCardMouseEnter = () => {
    setCardHover(true);
    if (files.length === 1) onCardEnter(0);
  };

  /** 卡片头：单文件卡照旧触发预览；多文件卡只切到「View changes ↗」+ 变色，不出预览 */
  const onHeadEnter = () => {
    setHeadHover(true);
    setCardHover(true);
    if (files.length === 1) onCardEnter(0);
  };

  const onHeadLeave = () => {
    setHeadHover(false);
  };

  /** 具体文件行：多文件卡的预览触发点 */
  const onRowEnter = (index: number) => {
    setCardHover(true);
    onCardEnter(index);
  };

  /**
   * 指针进卡片：开始 0.75 秒计时。
   *
   * ⚠️ 多文件卡片**不能整卡悬浮就出预览**（用户明确要求）：必须移到具体那一行，
   * 那一条才有预览。所以这里只有单文件卡片（没有文件行）才把整卡 hover 当成触发点。
   */
  const onCardEnter = (index?: number) => {
    setCardHover(true);
    if (index == null && files.length > 1) return; // 多文件卡：等指针进到某一行的 onRowEnter
    const target = index ?? preview ?? 0;
    if (preview != null && preview === target) return; // 已显示同一份：不动
    if (showTimer.current != null) window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      showPreview(target);
    }, PREVIEW_DELAY_MS);
  };

  /**
   * 指针离开卡片：**立刻**复原底色、**立刻**收起浮层（没有缓冲、没有延时）。
   *
   * 这条是用户明确要求的语义，别再自作聪明加「过间隙宽限」：
   * 浮层是纯展示的，不参与 hover 判定，鼠标一离开卡片它就消失、卡片底色同时复原。
   * 代价是浮层不可交互（鼠标够不到它）—— 这是刻意的。
   */
  const onCardLeave = () => {
    clearTimers();
    setCardHover(false);
    setHeadHover(false);
    setPreview(null);
  };

  const showTimer = useRef<number | null>(null);
  useEffect(() => () => clearTimers(), []);

  /**
   * 滚动/重排：卡片滚出视口就收掉浮层；否则把浮层重新贴回**触发它的那一行**（或卡片），方向不变。
   * 「贴上再一起走」很关键：只锁位置的话，流式内容把卡片顶下去之后，
   * 浮层会孤零零挂在半空中、跟卡片脱节（实测卡片被顶下 350px）。
   */
  const shiftAnchor = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      doClose();
      return;
    }
    const index = previewRef.current;
    if (index == null) return;
    const next = computeAnchor(index, anchorBelowRef.current);
    const current = anchorRef.current;
    if (current && Math.abs(next.bottom - current.bottom) < 0.5 && Math.abs(next.left - current.left) < 0.5) return;
    setAnchor(next);
  };

  /** shiftAnchor 每次渲染都是新函数，监听器只挂一次 → 用 ref 转发到最新实现 */
  const shiftAnchorRef = useRef(shiftAnchor);
  shiftAnchorRef.current = shiftAnchor;

  useEffect(() => {
    // 跟踪指针位置：重排后「鼠标是否还在卡片里」要按几何复核
    const onPointerMove = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  useEffect(() => {
    if (preview == null) return;
    window.addEventListener("scroll", shiftAnchorRef.current, { capture: true, passive: true });
    window.addEventListener("resize", shiftAnchorRef.current);
    // 流式输出不会派发 scroll（内容变高但不滚动）→ 用 ResizeObserver 盯住卡片自身尺寸/位置变化
    const observer = new ResizeObserver(() => shiftAnchorRef.current());
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      window.removeEventListener("scroll", shiftAnchorRef.current, { capture: true });
      window.removeEventListener("resize", shiftAnchorRef.current);
      observer.disconnect();
    };
  }, [preview]);

  if (!files.length) return null;

  const root = commonFileRoot(files, workspaceRoot);
  const adds = files.reduce((sum, file) => sum + file.adds, 0);
  const dels = files.reduce((sum, file) => sum + file.dels, 0);
  const single = files.length === 1;
  const shown = showAll ? files : files.slice(0, 3);
  const rest = files.length - shown.length;
  const previewFile = preview != null ? files[preview] : undefined;
  return (
    // 卡片的 hover 底色由 cardHover 控制（不能用 CSS :hover：浮层是子节点会被算进去）
    <div
      ref={rootRef}
      className={`flow-changed${cardHover ? " flow-changed-hover" : ""}`}
      onMouseEnter={onCardMouseEnter}
      onMouseLeave={onCardLeave}
    >
      {previewFile && anchor ? <DiffPreview popRef={popRef} file={previewFile} root={root} style={{ bottom: anchor.bottom, left: anchor.left, width: anchor.width }} /> : null}
      {/* 卡片头（「Edited N files」那一行）：单文件卡 = 整卡触发预览；
          多文件卡 = 同样变色、同样切到 View changes ↗，但**不出预览**（预览只归具体文件行） */}
      <div
        className="flow-changed-head"
        onMouseEnter={onHeadEnter}
        onMouseLeave={onHeadLeave}
      >
        <span className="flow-changed-icon"><Diff size={25} strokeWidth={1.7} /></span>
        <div className="flow-changed-meta">
          <div className="flow-changed-name">
            {single ? `Edited ${displayPath(files[0].path, root).split("/").pop()}` : `Edited ${files.length} files`}
          </div>
          {headHover ? (
            <span className="flow-changed-viewlink">View changes <ArrowUpRight size={14} strokeWidth={1.7} /></span>
          ) : (
            <div className="flow-changed-total">
              <span className="flow-add">+{adds.toLocaleString("en-US")}</span>
              <span className="flow-del">-{dels.toLocaleString("en-US")}</span>
            </div>
          )}
        </div>
        <button type="button" className="flow-changed-undo" title="撤销改动">
          Undo <Undo2 size={18} strokeWidth={1.7} />
        </button>
        <button type="button" className="flow-changed-view" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Hide changes" : "View changes"}
        </button>
      </div>
      {!single ? (
        <div className="flow-changed-list">
          {shown.map((file, index) => (
            <div
              key={file.path}
              className="flow-changed-row"
              data-file-index={index}
              onMouseEnter={() => onRowEnter(index)}
            >
              <span className="flow-changed-path">{displayPath(file.path, root)}</span>
              <span className="flow-changed-row-stats">
                <span className="flow-add">+{file.adds}</span>
                <span className="flow-del">-{file.dels}</span>
              </span>
            </div>
          ))}
          {/* 官方：展开后这一行变成「Collapse files ⌃」，点一下收回只留前三个文件 */}
          {showAll && files.length > 3 ? (
            <button type="button" className="flow-changed-more" onClick={() => setShowAll(false)}>
              Collapse files <ChevronUp size={16} strokeWidth={1.7} />
            </button>
          ) : rest > 0 ? (
            <button type="button" className="flow-changed-more" onClick={() => setShowAll(true)}>
              Show {rest} more files <ChevronDown size={16} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** 回合级错误横幅（官方：ⓘ + 一行说明，满宽圆角卡） */
function TurnErrorBanner({ message }: { message: string }) {
  return (
    <div className="flow-turn-error" role="status">
      <Info size={19} strokeWidth={1.7} />
      <span>{message}</span>
    </div>
  );
}
