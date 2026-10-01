import { Bell, Search, SquarePen, Folder, MoreHorizontal, ChevronRight, ChevronDown, Plus, PencilLine, LoaderCircle } from "lucide-react";
import { useState } from "react";
import * as Pop from "@radix-ui/react-popover";
import { useStore } from "../store";
import { rpc, type ThreadSummary } from "../lib/api";

export default function Sidebar() {
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const windowNarrow = useStore((s) => s.windowNarrow);
  // 窗口 < 768px 自动收起（对齐官方 CSS 的媒体查询阈值），窗口拉宽后自动回来
  if (!sidebarVisible || windowNarrow) return null;
  return <SidebarInner />;
}

function SidebarInner() {
  const threads = useStore((s) => s.threads);
  const projects = useStore((s) => s.projects);
  const activeProject = useStore((s) => s.activeProject);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const openThread = useStore((s) => s.openThread);
  const newChat = useStore((s) => s.newChat);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const addProject = useStore((s) => s.addProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const envList = useStore((s) => s.envList);
  const resetForEnvSwitch = useStore((s) => s.resetForEnvSwitch);
  /** 是否展开「最近」列表：放进 store，避免组件重挂载后又折叠回去
   *  （之前用局部 useState，切视图回来就丢了，看起来像历史会话不见了） */
  const recents = useStore((s) => s.recentsExpanded);
  const setRecents = useStore((s) => s.setRecentsExpanded);
  /** 会话是否已加载完成：false 时「最近」显示骨架条，避免误报「暂无会话」 */
  const threadsLoaded = useStore((s) => s.bootPhase.threads);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  /** 每个项目独立展开：展开后列出归属这个项目的会话（归属关系来自环境目录里的全局状态） */
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [toast, setToast] = useState("");

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3000);
  };

  const openFolder = async () => {
    try {
      const path = await rpc.env.pickFolder();
      if (!path) return;
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      await addProject({ name, path });
    } catch (error) {
      flash(`打开文件夹失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-transparent bg-bgsub">
      {/*
        固定区：应用标题栏 + 「新聊天」。
        刻意**不参与滚动** —— 无论列表滚到哪，这两个都必须随手可点。
      */}
      <div className="shrink-0">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <Pop.Root open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
          <Pop.Trigger asChild>
            <button className="flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[17px] font-bold text-text hover:bg-bghover" aria-label="切换工作区">
              LINGHL <ChevronDown size={14} className="text-text3" />
            </button>
          </Pop.Trigger>
          <Pop.Portal>
            <Pop.Content side="bottom" align="start" sideOffset={6} className="z-50 w-64 rounded-xl border border-border bg-bg p-1.5 text-[13px] shadow-[0_10px_38px_rgba(0,0,0,0.14)]">
              <p className="px-2.5 pb-1 pt-1 text-[11.5px] text-text3">工作区环境</p>
              {(envList?.envs ?? []).map((env) => (
                <button
                  key={env.id}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-bghover"
                  onClick={async () => {
                    if (env.id !== envList?.activeId) {
                      try {
                        await rpc.env.switch(env.id);
                        await resetForEnvSwitch();
                      } catch (error) {
                        flash(`切换失败：${String(error).replace(/^Error:\s*/, "")}`);
                      }
                    }
                    setWorkspaceOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-text">{env.name}</span>
                  <span className="text-[11px] text-text3">
                    {env.mode === "relay"
                      ? (() => {
                          const r = (envList?.relays ?? []).find((x) => x.id === env.relayId);
                          return r?.origin === "local" ? "本地 Codex" : "自定义模型";
                        })()
                      : "官方"}
                  </span>
                  {env.id === envList?.activeId && <span className="text-accent">✓</span>}
                </button>
              ))}
              {!envList?.envs.length && <p className="px-2.5 py-2 text-[12px] text-text3">暂无环境</p>}
              <div className="my-1 h-px bg-border" />
              <button className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-text2 hover:bg-bghover" onClick={() => { setWorkspaceOpen(false); useStore.getState().openSettings("env"); }}>管理环境…</button>
            </Pop.Content>
          </Pop.Portal>
        </Pop.Root>
        <div className="flex items-center gap-1">
          <button className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover" title="查看活动" aria-label="查看活动" onClick={() => flash("暂无新活动")}><Bell size={14} /></button>
          <button className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover" title="搜索" aria-label="搜索" onClick={() => setSearchOpen(true)}><Search size={14} /></button>
        </div>
      </div>

      <div className="px-2.5">
        <button className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14.5px] text-text hover:bg-bghover" onClick={newChat}>
          <SquarePen size={16} className="text-text2" />新聊天
        </button>
      </div>
      </div>

      {/*
        ── 滚动区：「项目」与「最近」共用这一个滚动条（2026-10-01 用户反馈）──

        以前是「项目」固定高度、「最近」自己 overflow-y-auto：
        项目一多就把「最近」挤没，而且两个列表各滚各的，不是用户预期的一条。
        现在两节都放进同一个滚动容器，滚动条只有一条。

        每节标题用 `sticky top-0` 吸顶：向下滚时「项目」标题先钉住，
        滚到「最近」时后者把前者顶走、自己钉在最上面 —— 这是 sticky 的固有行为
        （sticky 元素被约束在自己的 containing block 内，也就是各自那一节的 div），
        不需要任何 JS。

        ⚠️ 吸顶元素必须有不透明背景（bg-bgsub），否则滚上去的条目会从标题下面透出来。
      */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {/* ── 项目 ── */}
        <div>
        <div className="sticky top-0 z-10 bg-bgsub">
        <div className="flex items-center justify-between px-2.5 pb-1">
          <button className="flex items-center gap-1 text-[13px] text-text2 hover:text-text" onClick={() => setProjectsExpanded((v) => !v)} aria-expanded={projectsExpanded}>
            项目
            {projectsExpanded ? <ChevronDown size={12} className="text-text3" /> : <ChevronRight size={12} className="text-text3" />}
          </button>
          <span className="flex items-center gap-0.5">
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover hover:text-text" title="更多" aria-label="项目更多" onClick={() => flash("项目更多操作即将推出")}><MoreHorizontal size={14} /></button>
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover hover:text-text" title="新建项目" aria-label="新建项目" onClick={() => void openFolder()}><Plus size={14} /></button>
          </span>
        </div>
        </div>
        {projectsExpanded && <div className="flex flex-col gap-0.5">
          {projects.map((p) => {
            const active = activeProject?.path === p.path;
            const key = p.id ?? p.path;
            const isOpen = expandedProjects[key] ?? false;
            /**
             * 这个项目下的会话。
             *
             * 优先用环境登记的归属（`threadIds`，来自内核/官方应用的
             * `thread-project-assignments`，最权威）。
             * 但**用户在本应用里手动添加的项目**（desk-state 的 projects）没有这份登记 ——
             * 环境里根本不认识它，`threadIds` 为空。这类项目以前会显示
             * "这个项目下还没有本地会话记录"，可实际上有一堆 cwd 就在这个目录下的会话
             * （实测 claudeTest 有 18 条）。所以这里用 cwd 做兜底匹配。
             *
             * 只在**没有登记数据**时才兜底，不去扩大已有登记的项目的范围 ——
             * 否则会把子目录的会话也算进来，和官方行为不一致。
             */
            const owned = p.threadIds?.length
              ? threads.filter((t) => p.threadIds?.includes(t.id))
              : threads.filter((t) => samePath(t.cwd, p.path));
            return (
              <div key={key}>
                <div className={`group flex items-center gap-0.5 rounded-lg pl-1 pr-2.5 ${active ? "bg-bghover" : "hover:bg-bghover"}`}>
                  <button
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text3 hover:text-text disabled:opacity-25"
                    disabled={owned.length === 0}
                    title={
                      owned.length
                        ? isOpen
                          ? "收起会话"
                          : `展开这个项目下的 ${owned.length} 个会话`
                        : "这个项目下还没有本地会话记录"
                    }
                    aria-label="展开项目会话"
                    onClick={() => setExpandedProjects((v) => ({ ...v, [key]: !isOpen }))}
                  >
                    <ChevronRight
                      size={12}
                      className={isOpen ? "rotate-90 transition-transform" : "transition-transform"}
                    />
                  </button>
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-[14px] text-text"
                    onClick={() => {
                      void setActiveProject(p);
                      if (owned.length > 0) setExpandedProjects((v) => ({ ...v, [key]: true }));
                    }}
                  >
                    <Folder size={15} className="shrink-0 text-text2" />
                    <span className="truncate">{p.name}</span>
                    {owned.length > 0 && (
                      <span className="shrink-0 text-[11px] text-text3">{owned.length}</span>
                    )}
                  </button>
                  <span className="hidden items-center gap-1 group-hover:flex">
                    <span
                      role="button"
                      tabIndex={-1}
                      title="更多"
                      className="text-text3 hover:text-text"
                      onClick={(e) => { e.stopPropagation(); flash("项目操作即将推出"); }}
                    ><MoreHorizontal size={14} /></span>
                    <span
                      role="button"
                      tabIndex={-1}
                      title="重命名"
                      className="text-text3 hover:text-text"
                      onClick={(e) => { e.stopPropagation(); flash("项目重命名即将推出"); }}
                    ><PencilLine size={14} /></span>
                  </span>
                </div>
                {isOpen && owned.length > 0 && (
                  <div className="ml-[26px] flex flex-col gap-0.5 border-l border-border pl-1.5">
                    {owned.map((t) => (
                      <RecentItem
                        key={t.id}
                        thread={t}
                        active={t.id === activeThreadId}
                        onClick={() => void openThread(t.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {projects.length === 0 && <p className="px-2.5 py-1.5 text-[12px] leading-5 text-text3">通过「文件 → 打开文件夹」添加项目</p>}
        </div>}
        </div>

        {/* ── 最近 ── */}
        <div className="mt-5">
          <div className="sticky top-0 z-10 bg-bgsub">
            <button className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[13px] text-text2 hover:text-text" onClick={() => setRecents(!recents)} aria-expanded={recents}>
              最近 <ChevronRight size={12} className={recents ? "rotate-90 transition-transform" : "transition-transform"} />
            </button>
          </div>
          {recents && <div className="mt-0.5 flex flex-col">
            {threads.map((t) => <RecentItem key={t.id} thread={t} active={t.id === activeThreadId} onClick={() => void openThread(t.id)} />)}
            {/* 加载中显示骨架条，而不是直接写「暂无会话」—— 后者会让人以为会话丢了 */}
            {threads.length === 0 && !threadsLoaded && <RecentSkeleton />}
            {threads.length === 0 && threadsLoaded && <p className="px-2.5 py-1.5 text-[12px] text-text3">暂无会话</p>}
          </div>}
          {toast && <p className="px-2.5 pt-2 text-[11px] text-accent">{toast}</p>}
        </div>
      </div>
    </aside>
  );
}

/** 「最近」列表的加载骨架：三条灰条脉冲，宽度递减，模仿真实条目布局 */
function RecentSkeleton() {
  const widths = ["82%", "64%", "73%"];
  return (
    <div className="flex flex-col gap-1 px-2.5 py-1" aria-hidden>
      {widths.map((w, i) => (
        <div
          key={i}
          className="h-[18px] animate-pulse rounded-md bg-bghover"
          style={{ width: w, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * 路径等价判断（用于把会话的 cwd 匹配到项目目录）。
 *
 * 必须归一化三处差异，否则永远匹配不上：
 *   1. Windows 长路径前缀 `\\?\`（内核写进 cwd 时带、项目路径不带）
 *   2. 分隔符（内核可能给 `/`，项目路径是 `\`）
 *   3. 大小写（Windows 路径不区分大小写）
 * 末尾分隔符也去掉，避免 `D:\a\` 与 `D:\a` 被当成两个目录。
 */
function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    s.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 「最近」/「项目」里的一条会话。
 *
 * 工作指示器（2026-10-01 修复）：会话正在生成回复时，行尾显示一个小转圈 ——
 * 对齐 ChatGPT 桌面版。没有它的话，用户发送后完全看不出这条会话"正在工作"，
 * 只能靠右侧聊天区的扫光去猜，侧栏里那条和已完成的会话长得一模一样。
 *
 * 数据来源是 `turnActive[threadId]`：发送瞬间就置 true（markTurnPending），
 * 不依赖内核的 turn/started 通知，所以指示器会**立刻**出现，不会延迟。
 */
function RecentItem({ thread, active, onClick }: { thread: ThreadSummary; active: boolean; onClick: () => void }) {
  const working = useStore((s) => Boolean(s.turnActive[thread.id]));
  const title = thread.name || thread.title || thread.preview || "未命名会话";
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${active ? "bg-bghover font-medium text-text" : "text-text hover:bg-bghover"}`}
      onClick={onClick}
      title={title}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {working && (
        <LoaderCircle
          size={13}
          className="shrink-0 animate-spin text-text3"
          aria-label="正在生成回复"
        />
      )}
    </button>
  );
}