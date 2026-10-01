import { lazy, Suspense, useEffect } from "react";
import { useStore } from "./store";
import { rpc, SR } from "./lib/api";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import HomePage from "./views/HomePage";
import ApprovalBanner from "./components/ApprovalBanner";
import ErrorBanner from "./components/ErrorBanner";
import KernelErrorBanner from "./components/KernelErrorBanner";
import LoginGate from "./components/LoginGate";
import ActivityRail from "./components/ActivityRail";
import Composer from "./components/Composer";
import { showShortcuts, zoomFont } from "./lib/ui-actions";
import { browserApi } from "./lib/api";

/**
 * 按需加载重型视图（2026-10-01 启动优化）。
 *
 * 首屏（HomePage + Sidebar + Composer）只需要 React + 少量图标；
 * 但下面这些都是静态 import 的话，浏览器必须**先解析并执行整个 bundle**
 * 才能画出第一帧 —— 而 ThreadView 一个人就拖进 react-markdown + remark/rehype
 * + KaTeX（含一堆字体与 CSS），SettingsPage/ModelsPage 又拖进一堆 Radix 组件。
 *
 * 改成 lazy 后这些被拆成独立 chunk，只有真的点进去才下载/解析。
 * 首屏因此能更快出画面 —— 这是"不要启动页"的前提：不是把等待藏起来，
 * 而是让首帧本身变快。
 *
 * ⚠️ 不要 lazy 首屏要用的东西（TitleBar/Sidebar/HomePage/Composer/ActivityRail），
 *    否则会多一次网络往返，反而更慢。
 */
const ThreadView = lazy(() => import("./components/ThreadView"));
const WorkspaceBar = lazy(() => import("./components/WorkspaceBar"));
const BrowserPane = lazy(() => import("./components/BrowserPane"));
const SearchOverlay = lazy(() => import("./components/SearchOverlay"));
const ShortcutsDialog = lazy(() => import("./components/ShortcutsDialog"));
const ScheduledPanel = lazy(() => import("./views/ScheduledPage").then((m) => ({ default: m.default })));
const ScheduledMain = lazy(() => import("./views/ScheduledPage").then((m) => ({ default: m.ScheduledMain })));
const SettingsMain = lazy(() => import("./views/SettingsPage").then((m) => ({ default: m.SettingsMain })));
const SettingsPanel = lazy(() => import("./views/SettingsPage").then((m) => ({ default: m.SettingsPanel })));
const CustomizePanel = lazy(() => import("./views/CustomizePage").then((m) => ({ default: m.CustomizePanel })));
const CustomizeMain = lazy(() => import("./views/CustomizePage").then((m) => ({ default: m.CustomizeMain })));
const ModelsPanel = lazy(() => import("./views/ModelsPage").then((m) => ({ default: m.ModelsPanel })));
const ModelsMain = lazy(() => import("./views/ModelsPage").then((m) => ({ default: m.ModelsMain })));

/**
 * 分屏时聊天区占比。与 WorkspaceBar 里的 `SPLIT_CHAT_PCT` 保持一致（40）。
 * 这里**刻意复制一份常量而不是 import** —— 一旦 import，WorkspaceBar 就被首屏
 * 静态依赖了，lazy 拆分白做。改这个值记得同步 WorkspaceBar.tsx:27。
 */
const SPLIT_CHAT_PCT = 40;

export default function App() {
  // 逐项订阅：用 `useStore()` 取整份 state 会让每个流式 delta（几十 Hz）
  // 都重渲染整棵组件树。
  const view = useStore((s) => s.view);
  const init = useStore((s) => s.init);
  const handleNotification = useStore((s) => s.handleNotification);
  const setSearchOpen = useStore((s) => s.setSearchOpen);
  const prefs = useStore((s) => s.prefs);
  /** 工作区布局：chat（只有聊天）/ split（聊天 + 内容标签分屏）/ full（完整视图） */
  const wsLayout = useStore((s) => s.wsLayout);
  const wsTabs = useStore((s) => s.wsTabs);
  const wsActiveTabId = useStore((s) => s.wsActiveTabId);
  /**
   * 两个浮层的开关（2026-10-01 启动优化）。
   * 订阅这两个布尔值是为了让浮层**按需挂载** —— 默认都是 false，
   * 所以首帧不会去解析 SearchOverlay / ShortcutsDialog 的 lazy chunk。
   * 布尔订阅的代价可以忽略（只有真的开关时才触发一次重渲染）。
   */
  const searchOpen = useStore((s) => s.searchOpen);
  const shortcutsOpen = useStore((s) => s.shortcutsOpen);
  /** 当前激活的内容标签（null = 激活的是「聊天」标签，只在完整视图下出现） */
  const activeTab =
    wsActiveTabId === null ? null : (wsTabs.find((t) => t.id === wsActiveTabId) ?? (wsLayout === "split" ? (wsTabs[0] ?? null) : null));
  const theme = prefs?.theme ?? "system";
  const fontSize = prefs?.fontSize;

  useEffect(() => {
    void init();
    const off = rpc.onNotification((n) => {
      if (n.method === "env/changed") {
        // 设置页与模型页本来就是管理接入方式的地方：在这里切环境/切接入后应留在原地看结果。
        // 无参调用会把 view 踢回首页，把 ModelsPage.applyRelay 自己传的 keepView 也冲掉。
        const cur = useStore.getState().view;
        void useStore.getState().resetForEnvSwitch(cur === "settings" || cur === "models" ? { keepView: true } : undefined);
        return;
      }
      if (n.method === "kernel/health") {
        // 健康状态广播可能早于/晚于配置问题缓存；每次都主动同步，避免启动期漏掉横幅。
        void useStore.getState().syncKernelIssue();
      }
      if (n.method === "server/ready") {
        /**
         * 内核（重）启动完成。
         *
         * 为什么这里不能无条件重载（2026-10-01 启动优化）：
         * 主进程现在会让渲染层请求**排队等内核**（main.ts 的 waitForKernel），
         * 所以 init() 挂载即发出的请求本来就会在内核就绪后成功返回 ——
         * 此时再全量重载一遍 threads/projects 纯属重复劳动，
         * 而 thread/list 在冷启动后可能要几百毫秒，白拖一次侧栏。
         *
         * 只有「启动时没拿到数据」才需要在这里补：
         *   - 首次启动时 init() 的请求还在排队中 → 它自己会成功，我们不动；
         *   - 换环境/内核崩溃重启 → init() 早已跑完、数据是旧的 → 必须重载。
         * 用 bootPhase 判断：envs 已就绪说明启动流程已经走完过一轮。
         */
        const st = useStore.getState();
        const startupAlreadyLoaded = st.bootPhase.envs;
        if (startupAlreadyLoaded) {
          // 内核重启（换环境/崩溃恢复）：登录态与列表都可能变了，全量刷新
          void st.checkAccount();
          void st.loadThreads();
          void st.reloadProjects();
        }
        // 健康态/配置诊断无论哪条路径都要同步（内核 stderr 可能稍晚）
        void st.syncKernelIssue();
        window.setTimeout(() => void useStore.getState().syncKernelIssue(), 800);
        return;
      }
      if (n.method === "account/login/completed" || n.method === "Account/login/completed") {
        void useStore.getState().checkAccount();
        void useStore.getState().loadThreads();
        // 从模型页/设置页发起的 OAuth，授权完成后把人带回首页直接可用
        const cur = useStore.getState().view;
        if (cur !== "home" && cur !== "thread") useStore.getState().setView("home");
      }
      handleNotification(n);
    });
    // 审批等待超时：主进程已按"拒绝/跳过"答复内核，界面上的横幅必须同步消失，
    // 否则会留下一个点了也没反应的死横幅
    const offTimeout = rpc.onApprovalTimeout((id) => {
      useStore.setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
    });
    // app-server 崩溃/启动失败：不复位的话 turnActive 永远为 true，
    // 输入框被永久禁用、只剩一个点了也没用的停止按钮。切环境重启走 env/changed，
    // 主进程对那条路径做了实例身份过滤，不会误触发这里。
    const offExit = rpc.onServerExit(() => {
      handleNotification({ method: "server/exited", params: {} });
      void useStore.getState().syncKernelIssue();
      useStore.setState((s) => ({
        turnActive: Object.fromEntries(Object.keys(s.turnActive).map((k) => [k, false])),
        activeTurnId: Object.fromEntries(Object.keys(s.activeTurnId).map((k) => [k, undefined])),
        activeItemId: Object.fromEntries(Object.keys(s.activeItemId).map((k) => [k, undefined])),
        turnPhase: Object.fromEntries(Object.keys(s.turnPhase).map((k) => [k, "failed"])) as typeof s.turnPhase,
        streaming: Object.fromEntries(Object.keys(s.streaming).map((k) => [k, ""])),
        streamingItemId: Object.fromEntries(Object.keys(s.streamingItemId).map((k) => [k, undefined])),
        approvals: [],
        errors: [
          ...s.errors.filter((e) => e.threadId !== ""),
          {
            id: `err_exit_${Date.now()}`,
            threadId: "",
            message: "Codex 内核已退出，正在进行的回复已中断。请检查接入方式设置后重试。",
            retrying: false,
          },
        ],
      }));
    });
    const keyboard = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // 工作区布局的带 Shift 组合必须排在下面那些不带 Shift 的判断**之前**：
      // 官方 Ctrl+Shift+B = toggleWorkspaceTabs（完整视图下切换聊天/标签页，分屏下显示/隐藏标签页），
      // 没有内容标签时退化为 stepWorkspaceLayout（新建标签页）；
      // Ctrl+Shift+F = 完整视图。不抢先拦截的话会同时命中 Ctrl+B（切侧栏）/ Ctrl+F（搜索）。
      if (mod && e.shiftKey && key === "b") {
        e.preventDefault();
        useStore.getState().wsToggleWorkspaceTabs();
      } else if (mod && e.shiftKey && key === "f") {
        e.preventDefault();
        useStore.getState().wsToggleFullView();
      } else if (mod && key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && key === "p") {
        // 与搜索浮层里「搜索文件 Ctrl+P」的标注对齐
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && key === "b") {
        e.preventDefault();
        useStore.getState().toggleSidebar();
      } else if (mod && key === "n") {
        e.preventDefault();
        useStore.getState().newChat();
      } else if (mod && !e.altKey && !e.shiftKey && key === "o") {
        // 与「文件 → 打开文件夹」「搜索浮层 → 打开文件夹 Ctrl+O」的标签对齐。
        // 必须显式排除 alt/shift：官方的「更改此聊天的项目」是 Ctrl+Alt+Shift+O，
        // 不排除的话那个组合会同时命中这里，弹出系统"选择文件夹"对话框。
        e.preventDefault();
        void (async () => {
          try {
            const p = await rpc.env.pickFolder();
            if (!p) return;
            const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
            await useStore.getState().addProject({ name, path: p });
          } catch {
            /* 选目录取消/失败时静默 */
          }
        })();
      } else if (mod && (e.key === "+" || (e.shiftKey && e.key === "="))) {
        e.preventDefault();
        zoomFont(+1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomFont(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        zoomFont(0);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useStore.getState().setView("settings");
      } else if (mod && e.key === "/") {
        // 与「帮助 → 显示键盘快捷键 Ctrl+/」的标注对齐
        e.preventDefault();
        showShortcuts();
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const thread = useStore.getState().threads[index];
        if (thread) {
          e.preventDefault();
          void useStore.getState().openThread(thread.id);
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      off();
      offTimeout();
      offExit();
      window.removeEventListener("keydown", keyboard);
    };
  }, [init, handleNotification, setSearchOpen]);

  useEffect(() => {
    const root = document.documentElement;
    const size = Number(fontSize);
    if (Number.isFinite(size) && size >= 12 && size <= 24) root.style.fontSize = `${size}px`;
    else root.style.fontSize = "14px";

    const applyTheme = (value: "system" | "light" | "dark") => {
      const resolved: "light" | "dark" = value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
      root.dataset.theme = resolved;
      // 原生窗口控件（最小化/最大化/关闭）不吃 CSS，必须通知主进程换图标色
      void rpc.setTheme(resolved).catch(() => undefined);
    };
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [theme, fontSize]);

  useEffect(() => {
    return rpc.onServerRequest((req) => {
      if (Object.values(SR).includes(req.method as never)) {
        const threadId = typeof req.params?.threadId === "string" ? req.params.threadId : null;
        useStore.setState((s) => ({
          approvals: [...s.approvals, req],
          ...(threadId
            ? {
                turnActive: { ...s.turnActive, [threadId]: true },
                turnPhase: { ...s.turnPhase, [threadId]: "waiting" },
              }
            : {}),
        }));
      }
    });
  }, []);

  /**
   * 响应式侧栏：窗口宽 < 768 时自动收起左侧栏 —— 阈值取自官方 CSS 的
   * `@media not all and (width>=768px){ --app-shell-left-panel-width: 0px }`。
   * 只写 windowNarrow，不动用户的 sidebarVisible 偏好，窗口拉宽后自动恢复。
   */
  useEffect(() => {
    const apply = () => useStore.getState().setWindowNarrow(window.innerWidth < 768);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  /** 页面里的 target=_blank / window.open → 在工作区新开一个内容标签（与官方一致） */
  useEffect(() => browserApi.onOpenUrl((url) => useStore.getState().wsNewTab({ url })), []);
  /** 模型通过 MCP 建的浏览器标签 → 一并显示到工作区里 */
  useEffect(() => browserApi.onAddTab((tab) => useStore.getState().wsAddTab(tab)), []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar />
      {/* 官方：标题栏下留 4px 背景缝，侧栏/内容作为一块卡片顶到这条缝下，
          卡片左上角是圆角（圆角缺口露出背景色）。 */}
      <div className="flex min-h-0 flex-1 bg-bgsub pt-[4px]">
        <ActivityRail />
        <div className="flex min-h-0 shrink-0 overflow-hidden rounded-tl-[10px]">
          {/* 设置/定时/Customize 都占用侧栏槽位，替换 Codex 主侧栏（对齐官方） */}
          {/* 这些面板是 lazy 的：首次切过去时短暂 null，壳（标题栏/侧栏/底部）不闪 */}
          <Suspense fallback={null}>
            {view === "scheduled" ? (
              <ScheduledPanel />
            ) : view === "customize" ? (
              <CustomizePanel />
            ) : view === "models" ? (
              <ModelsPanel />
            ) : view === "settings" ? (
              <SettingsPanel />
            ) : (
              <Sidebar />
            )}
          </Suspense>
        </div>
        <main className="relative min-w-0 flex-1 bg-bg">
          {/* 工作区：聊天是工作区里的一个窗格/标签，内容标签页（内置浏览器）与它分屏或同栏 */}
          <div className="flex h-full flex-col">
            <Suspense fallback={null}>
            {view === "home" || view === "thread" ? (
              <>
                {wsLayout !== "chat" && <WorkspaceBar />}
                <div className="relative flex min-h-0 flex-1">
                  {wsLayout === "chat" && (
                    <>
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        {view === "home" ? <HomePage /> : <ThreadView />}
                      </div>
                      <WorkspaceBar />
                    </>
                  )}
                  {wsLayout === "split" && (
                    <>
                      <div
                        style={{ flexBasis: `${SPLIT_CHAT_PCT}%` }}
                        className="flex min-h-0 min-w-0 shrink-0 flex-col"
                      >
                        {view === "home" ? <HomePage /> : <ThreadView />}
                      </div>
                      <div className="w-px shrink-0 bg-border" />
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        {activeTab && <BrowserPane tab={activeTab} />}
                      </div>
                    </>
                  )}
                  {wsLayout === "full" && (
                    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                      {activeTab && wsActiveTabId !== null ? (
                        <>
                          <BrowserPane tab={activeTab} />
                          {/* 官方在完整视图下内容标签铺满时，输入框仍然钉在工作区底部
                              （截图里浏览器页面上方浮着「选择项目 / 随心输入」那一条） */}
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-[26px] pb-5">
                            <div className="pointer-events-auto w-full max-w-[740px]">
                              <Composer variant="home" />
                            </div>
                          </div>
                        </>
                      ) : view === "home" ? (
                        <HomePage />
                      ) : (
                        <ThreadView />
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {view === "scheduled" && <ScheduledMain />}
                {view === "customize" && <CustomizeMain />}
                {view === "models" && <ModelsMain />}
                {view === "settings" && <SettingsMain />}
              </div>
            )}
            </Suspense>
          </div>
          <KernelErrorBanner />
          <ApprovalBanner />
          <ErrorBanner />
          {(view === "home" || view === "thread") && <LoginGate />}
        </main>
      </div>
      {/*
        浮层只在**真正打开时**才挂载（2026-10-01 启动优化）。
        旧写法把 <SearchOverlay/> <ShortcutsDialog/> 无条件放在 JSX 里，
        React 首次渲染就会解析 lazy() 的 import —— 于是这两个 chunk
        （含 Radix Dialog/Popover 一大坨）被打进首帧的网络与解析路径里，
        "lazy 拆分"实际白做。CDP Network 实测这两个 chunk 确实在首帧就被请求。
        两者默认都是 closed（searchOpen/shortcutsOpen = false），
        挂条件后首帧完全不碰它们，只在用户真的按 Ctrl+K / Ctrl+/ 时下载。
        用 Suspense fallback={null}：打开瞬间的空白极短，且此时用户注意力已在浮层上。
      */}
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchOverlay />
        </Suspense>
      )}
      {shortcutsOpen && (
        <Suspense fallback={null}>
          <ShortcutsDialog />
        </Suspense>
      )}
    </div>
  );
}
