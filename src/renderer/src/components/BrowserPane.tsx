import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X, Bookmark, MoreHorizontal, SquareTerminal, Globe, Loader2 } from "lucide-react";
import { browserApi, type BrowserTabState } from "../lib/api";
import { useStore, type ContentTab } from "../store";

/**
 * 内容标签页 = 内置浏览器（**对齐官方**: 页面是主进程的 WebContentsView，
 * 渲染层只画工具条 + 把「页面区域」的矩形报给主进程）。
 *
 * 官方截图里的工具条：←→|⟳ 胶囊 + 「搜索或输入网址」+ 收藏/更多两个圆钮。
 * 新建标签不带地址时显示官方的「新标签页」选择器（工具 / 推荐）——
 * 这时候把所有原生视图 hide 掉，否则 WebContentsView 会盖住渲染层画的选择器。
 */

/** 把地址栏输入规范化：像网址就补协议，否则当搜索词 */
function normalizeAddress(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(text) && !/\s/.test(text)) return `https://${text}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

/** 官方的「新标签页」选择器：工具 / 推荐 */
function NewTabChooser({ onOpen }: { onOpen: (url: string) => void }) {
  const [hint, setHint] = useState(false);
  const suggestions = [
    { title: "ChatGPT & Codex changelog", url: "https://developers.openai.com/codex/changelog" },
    { title: "Codex 开发文档", url: "https://developers.openai.com/codex" },
  ];
  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <h3 className="mb-2 text-[13px] font-medium text-text">工具</h3>
      <div
        className="flex h-[38px] cursor-default items-center gap-2 rounded-[8px] border border-border px-2.5 hover:bg-bghover"
        title="终端（本版未接入）"
        onClick={() => setHint(true)}
      >
        <SquareTerminal size={14} className="shrink-0 text-text3" />
        <span className="text-[13px] text-text">终端</span>
        <span className="ml-auto text-[12px] text-text3">Ctrl+`</span>
        <button
          type="button"
          aria-label="终端选项"
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text3 hover:bg-bgactive hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            setHint(true);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {hint && <p className="mt-1.5 text-[11.5px] text-text3">终端面板本版还没接进来。</p>}

      <h3 className="mb-2 mt-5 text-[13px] font-medium text-text">推荐</h3>
      <div className="flex flex-wrap justify-center gap-3">
        {suggestions.map((s) => (
          <button
            key={s.url}
            type="button"
            className="flex w-[124px] flex-col items-center gap-2 rounded-[10px] px-2 py-3 hover:bg-bghover"
            onClick={() => onOpen(s.url)}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-bgsub">
              <Globe size={16} className="text-text2" />
            </span>
            <span className="line-clamp-2 text-center text-[12px] leading-4 text-text2">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function BrowserPane({ tab }: { tab: ContentTab }) {
  const wsSetTabMeta = useStore((s) => s.wsSetTabMeta);
  const [state, setState] = useState<BrowserTabState | null>(null);
  const [draft, setDraft] = useState(tab.url);
  const [editing, setEditing] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const lastRect = useRef({ x: -1, y: -1, width: -1, height: -1 });

  /* ---------------- 主进程视图：建 / 激活 / 上报矩形 / 收状态 ---------------- */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const created = await browserApi.create(tab.id);
      if (!alive) return;
      // 只有"刚建出来、还没有地址"的标签才需要按 store 里的 url 导航一次；
      // 否则来回切标签会把页面重新加载一遍
      if (!created.url && tab.url) await browserApi.navigate(tab.id, tab.url);
    })();
    const off = browserApi.onState((s) => {
      if (s.id !== tab.id) return;
      setState(s);
    });
    return () => {
      alive = false;
      off();
      // 卸载 = 这个内容窗格不显示了（切标签/回聊天布局/关工作区）
      void browserApi.activate(null).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  /** 没有地址时把原生视图藏起来 —— WebContentsView 永远盖在渲染层上面，
   *  不藏就会把「新标签页」选择器整块盖住 */
  useEffect(() => {
    void browserApi.activate(tab.url ? tab.id : null).catch(() => undefined);
  }, [tab.url, tab.id]);

  // 页面加载出真标题/真地址后回写 store，标签 pill 才会跟着变
  useEffect(() => {
    if (!state) return;
    const cur = useStore.getState().wsTabs.find((t) => t.id === tab.id);
    if (!cur) return;
    if (cur.url === state.url && (!state.title || cur.title === state.title)) return;
    wsSetTabMeta(tab.id, { url: state.url, title: state.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.url, state?.title]);

  useEffect(() => {
    if (!editing && state?.url) setDraft(state.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.url, editing]);

  /* ---------------------------- 把页面区域报给主进程 ---------------------------- */
  const reportBounds = useCallback(() => {
    const el = pageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const prev = lastRect.current;
    if (next.x === prev.x && next.y === prev.y && next.width === prev.width && next.height === prev.height) return;
    lastRect.current = next;
    void browserApi.setBounds(next).catch(() => undefined);
  }, []);

  useLayoutEffect(() => {
    reportBounds();
    const el = pageRef.current;
    const ro = new ResizeObserver(() => reportBounds());
    if (el) ro.observe(el);
    ro.observe(document.documentElement);
    window.addEventListener("resize", reportBounds);
    // 侧栏折叠之类的"只位移不变尺寸"变化 ResizeObserver 收不到，补一个低频兜底
    const timer = window.setInterval(reportBounds, 400);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reportBounds);
      window.clearInterval(timer);
    };
  }, [reportBounds, tab.id]);

  /* --------------------------------- 交互 --------------------------------- */
  const navigate = (raw: string) => {
    const next = normalizeAddress(raw);
    if (!next) return;
    setDraft(next);
    void browserApi.navigate(tab.id, next);
    wsSetTabMeta(tab.id, { url: next });
  };

  const showNative = Boolean(tab.url);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      {/* 工具条：高度按官方截图实测 ~46px */}
      <div className="flex h-[46px] shrink-0 items-center gap-2 px-3">
        <div className="flex h-7 shrink-0 items-center rounded-full border border-border px-1 text-text2">
          <button
            type="button"
            aria-label="后退"
            disabled={!state?.canGoBack}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-bghover hover:text-text disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
            onClick={() => void browserApi.back(tab.id)}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            aria-label="前进"
            disabled={!state?.canGoForward}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-bghover hover:text-text disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
            onClick={() => void browserApi.forward(tab.id)}
          >
            <ArrowRight size={14} />
          </button>
          <span className="mx-0.5 h-3.5 w-px bg-border" />
          <button
            type="button"
            aria-label={state?.loading ? "停止加载" : "重新加载"}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-bghover hover:text-text"
            onClick={() => void (state?.loading ? browserApi.stop(tab.id) : browserApi.reload(tab.id))}
          >
            {state?.loading ? <X size={13} /> : <RotateCw size={13} />}
          </button>
        </div>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border px-3">
          {state?.loading && <Loader2 size={12} className="shrink-0 animate-spin text-text3" />}
          <input
            className="w-full bg-transparent text-center text-[13px] text-text outline-none placeholder:text-text3"
            placeholder="搜索或输入网址"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigate(draft);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <button
          type="button"
          aria-label="收藏"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-text2 hover:bg-bghover hover:text-text"
        >
          <Bookmark size={13} />
        </button>
        <button
          type="button"
          aria-label="更多"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-text2 hover:bg-bghover hover:text-text"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      {state?.error && (
        <p className="mx-3 mb-1 shrink-0 rounded-[8px] bg-bgsub px-3 py-1.5 text-[12px] text-text2">
          页面加载失败：{state.error}
        </p>
      )}

      {/* 页面区域：主进程的 WebContentsView 就摆在这个矩形里（渲染层这一格是空的） */}
      <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden">
        {showNative ? null : <NewTabChooser onOpen={navigate} />}
      </div>
    </div>
  );
}
