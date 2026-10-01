import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Brush,
  Check,
  ChevronDown,
  Folder,
  Hand,
  Lightbulb,
  Paperclip,
  Plug,
  Plus,
  Search,
  Square,
  Target,
  TriangleAlert,
  X,
} from "lucide-react";
import * as Pop from "@radix-ui/react-popover";
import { M, rpc } from "../lib/api";
import { clearTurnPending, dropLocalUserMessage, markTurnPending, pushLocalUserMessage, useStore } from "../store";

/**
 * 权限档位。文案与图标对齐官方 composer.permissionsDropdown：
 * 标题一行 + 副标题一行，图标在左，选中项右侧打勾，
 * 「完全访问权限」整条用橙色（图标 + 副标题）。
 */
const PERMISSIONS = [
  {
    id: "read-only",
    title: "只读",
    desc: "可以读取文件与联网查询，但不会改动任何内容",
    tone: "plain",
  },
  {
    id: "workspace-write",
    title: "请求批准",
    desc: "编辑外部文件和使用互联网时始终询问",
    tone: "plain",
  },
  {
    id: "full-access",
    title: "完全访问权限",
    desc: "可不受限制地访问互联网和你电脑上的任何文件",
    tone: "warning",
  },
] as const;

/** 内核 model/list 拉不到时的兜底（未登录/内核未就绪） */
const FALLBACK_MODELS = [
  { id: "gpt-6-astra", title: "6 Astra" },
  { id: "gpt-6-sol", title: "6 Sol" },
];

/**
 * 思考等级的中文短标。官方胶囊写作「6 Astra 中」——名字后面的那个字就是档位。
 * 档位全集来自内核模型目录：none/minimal/low/medium/high/xhigh/max/ultra。
 */
/** 128000 → 128K、1000000 → 1M（与「模型」页同款，切模型列表里标上下文窗口） */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const EFFORT_LABEL: Record<string, string> = {
  none: "关",
  minimal: "关",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超级",
};

/** 弹层外壳：圆角 16px / 阴影抄官方 --popover-radius(--radius-2xl=1rem) 与
 *  --menu-box-shadow(0 0 0 .5px 描边 + --shadow-xl)。注意本工程根字号 14px，
 *  所以必须写 px 任意值 —— 写 rounded-2xl 会算成 14px。 */
const menuContent =
  "z-50 rounded-[16px] bg-bg p-1.5 text-[13px] shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_8px_16px_-4px_rgba(0,0,0,0.12)] outline-none";
const menuItem =
  "flex cursor-default select-none items-start gap-2.5 rounded-xl px-2 py-2 outline-none data-[highlighted]:bg-bghover";

/** memo：ThreadView 的每个流式帧都会重渲染父组件，props（variant 常量）不变时
 *  Composer 直接跳过 —— 输入框内容、焦点状态不被流式渲染打断 */
const Composer = memo(function Composer({ variant }: { variant: "home" | "thread" }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachHover, setAttachHover] = useState(false);
  const activeProject = useStore((s) => s.activeProject);
  const projects = useStore((s) => s.projects);
  const prefs = useStore((s) => s.prefs);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const turnActive = useStore((s) => (activeThreadId ? s.turnActive[activeThreadId] : false));
  const activeTurnId = useStore((s) => (activeThreadId ? s.activeTurnId[activeThreadId] : undefined));
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sendLock = useRef(false);
  const permission = prefs?.permission ?? "workspace-write";
  const envList = useStore((s) => s.envList);
  const activeEnv = envList?.envs.find((e) => e.id === envList.activeId);
  const activeRelay = envList?.relays.find((r) => r.id === activeEnv?.relayId);
  /** 自定义模型接入：具体用哪个模型在输入框右下角这个胶囊里随时切换 */
  const relayMode = activeEnv?.mode === "relay";
  const [modelPopOpen, setModelPopOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [kernelModels, setKernelModels] = useState<{ id: string; title: string }[]>([]);

  /**
   * 切换到模型库里的另一个配置：写入该环境 config.toml 并重启内核。
   * 会话线程绑定内核实例，重启后旧线程作废 —— 所以这里不 keepView，
   * 让 resetForEnvSwitch 自己把非 settings 视图带回首页。
   */
  async function applyRelay(relayId: string) {
    const envId = envList?.activeId;
    if (!envId || switchingModel) return;
    setSwitchingModel(true);
    try {
      await rpc.env.setMode(envId, "relay", relayId);
      await useStore.getState().resetForEnvSwitch();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, "切换模型失败："));
      // 内核重启偶发失败时配置其实已经写盘了：刷新列表让胶囊显示真实接入状态，
      // 否则界面停留在旧模型名上，用户重试也是对着错误状态操作
      await useStore.getState().refreshEnvs();
    } finally {
      setSwitchingModel(false);
    }
  }

  // 官方模式下用内核真实模型目录，而不是写死两个型号
  useEffect(() => {
    if (relayMode) return;
    let alive = true;
    void (async () => {
      try {
        const resp = await rpc.request<{ data?: { id?: unknown; displayName?: unknown; hidden?: unknown }[] }>(M.modelList, {});
        const rows = (resp?.data ?? [])
          .filter((x) => x && typeof x.id === "string" && x.hidden !== true)
          .map((x) => ({ id: x.id as string, title: typeof x.displayName === "string" && x.displayName ? x.displayName : (x.id as string) }));
        if (alive && rows.length) setKernelModels(rows);
      } catch {
        /* 内核未就绪时保持兜底列表 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [relayMode]);

  /** 附件菜单「插件」分组的条目（对应官方那组 Documents / PDF / Spreadsheets） */
  const [skills, setSkills] = useState<{ name: string; desc: string }[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await rpc.env.listSkills();
        if (alive && Array.isArray(list)) setSkills(list.filter((s) => s?.name).slice(0, 8));
      } catch {
        /* 拿不到就整组不渲染 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 官方快捷键 Ctrl+Alt+Shift+O：打开项目选择器
  useEffect(() => {
    if (variant !== "home") return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.altKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
        e.preventDefault();
        setProjectOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  const modelOptions = kernelModels.length ? kernelModels : FALLBACK_MODELS;
  const model = prefs?.model || modelOptions[0].id;
  const modelTitle = modelOptions.find((m) => m.id === model)?.title ?? modelOptions[0].title;
  const effortLabel = EFFORT_LABEL[prefs?.effort ?? "medium"] ?? "中";
  const perm = PERMISSIONS.find((p) => p.id === permission) ?? PERMISSIONS[1];

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects, projectQuery]);

  /**
   * 输入框自适应高度。
   *
   * ⚠️ 这段代码在**首屏**上是启动性能的关键路径，写法必须讲究（2026-10-01 实测）：
   * 旧写法 `ta.style.height = "0px"; ta.style.height = min(ta.scrollHeight, 200)+"px"`
   * 是典型的**强制同步布局**（write → read → write）：把 height 写脏之后再读
   * scrollHeight，浏览器只能当场把整篇文档重排一遍才能回答。
   * 而首屏挂载时它跑在最贵的那一刻 —— 用 CDP 打补丁量到**单次 92ms**，
   * 占掉"窗口已出现但还没画面"那段时间的一大块。
   *
   * 两处修正：
   *  1. `rows={1}` + `min-h-[40px]` 的初始态本来就是一行的高度，所以**值为空时
   *     直接跳过测量**（绝大多数启动都是这个分支），连一次布局都不会触发。
   *  2. 真需要测量时，先清空 height 再读 —— 但这仍是一次强制布局；改成用
   *     `scrollHeight` 读之前先把 style.height 置空（保留原有语义，因为不置空
   *     时 scrollHeight 会受当前 height 钳制而测不准），只是不再对空值白跑。
   *
   * 想彻底零强制布局需要换成 `field-sizing: content` 或隐藏镜像元素，
   * 但那是重写组件的行为，收益远小于上面的"空值跳过"。这里只做低风险修正。
   */
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // 空值 / 单行：初始高度已经正确，测量纯属浪费（且会触发 92ms 强制布局）
    if (!value) {
      // 从多行删到空时要收回高度，但只在当前高度不是初始值时写一次
      if (ta.style.height) ta.style.height = "";
      return;
    }
    // 有内容才需要量：先归零再读，是唯一能拿到"内容真实高度"的方式
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = value.trim().length > 0 && !sending && !turnActive;

  /** 附加菜单里尚未实现的项：给可见反馈，而不是点了没反应 */
  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3000);
  };

  /** 新建项目：走系统目录选择，再把路径登记成项目 */
  async function pickProject() {
    try {
      const picked = await rpc.env.pickFolder();
      if (!picked) return;
      const name = picked.split(/[\\/]/).filter(Boolean).pop() || picked;
      await useStore.getState().addProject({ name, path: picked });
      setProjectOpen(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, "新建项目失败："));
    }
  }

  async function send() {
    const text = value.trim();
    if (!text || sending || turnActive || sendLock.current) return;
    sendLock.current = true;
    const s = useStore.getState();
    setSending(true);
    setError("");
    setValue("");
    let threadId: string | null = s.activeThreadId;
    let pendingRenderKey: string | undefined;
    /**
     * 本次发送是否**新建**了会话（决定失败回滚时要不要撤掉侧栏那条）。
     * 放在 try 外面是为了让 catch 能读到。
     */
    let createdNewThread = false;
    try {
      // 自定义模型接入时模型由配置档案写进 config.toml，
      // 这里显式传 model 会覆盖档案配置，导致远端找不到模型而报错
      const activeEnv = s.envList?.envs.find((e) => e.id === s.envList?.activeId);
      const relayMode = activeEnv?.mode === "relay";
      if (variant === "home" || !threadId) {
        const resp = await rpc.request<{ thread?: { id?: string }; threadId?: string; id?: string }>(M.threadStart, {
          cwd: s.activeProject?.path,
          // read-only 档也要允许模型在越界时请求批准；never 会直接拒绝而非询问
          approvalPolicy:
            permission === "full-access" ? "never" : permission === "read-only" ? "on-request" : "untrusted",
          sandbox: permission === "full-access" ? "danger-full-access" : permission === "read-only" ? "read-only" : "workspace-write",
          // effort 不在 thread/start 的参数表里（内核会静默忽略），
          // 它属于 turn/start，见下方 turnStart 调用
          model: !relayMode && prefs?.model ? prefs.model : undefined,
        });
        threadId = resp?.thread?.id ?? resp?.threadId ?? resp?.id ?? null;
        if (!threadId) throw new Error("内核未返回新会话 ID");
        createdNewThread = true;
        useStore.setState({ activeThreadId: threadId });
        useStore.getState().setView("thread");
      }
      /**
       * 立刻把这条会话放进侧栏「最近」（2026-10-01 修复）。
       *
       * 必须在这里做，不能等 `thread/started` 通知或 `thread/list`：
       * 内核要等 `turn/completed` 才会把新会话列出来，中间隔着一整轮生成
       * （实测 2 分 25 秒）。这段时间里用户在「最近」里找不到自己刚发的会话，
       * 会以为"新聊天没生效"。这里用提示词首句做占位标题（对齐 ChatGPT 桌面版），
       * 内核生成真标题后由 thread/name/updated → loadThreads 覆盖。
       *
       * 条件写成"列表里还没有它"而不是"本次新建了会话"，是为了同时覆盖
       * **失败后重试**：上次发送失败会把乐观条目撤掉，重试时复用同一个
       * threadId（此时 variant 已是 thread），必须重新补进列表。
       */
      if (!useStore.getState().threads.some((t) => t.id === threadId)) {
        useStore.getState().upsertPendingThread({
          id: threadId,
          title: text,
          cwd: s.activeProject?.path,
        });
      }
      // 乐观回显：不等内核往返确认，消息立刻上屏（官方同款体感；
      // 内核的真实 userMessage 到达后 store 会按文本去重，发送失败则撤回）
      pushLocalUserMessage(threadId, text);
      pendingRenderKey = useStore.getState().turns[threadId]?.at(-1)?.renderKey;
      // 等待指示同时点亮：thread/start / turn/start 慢的窗口里会话流底部
      // 立刻出现「正在回应」扫光，而不是一片空白
      markTurnPending(threadId);
      await rpc.request(M.turnStart, {
        threadId,
        input: [{ type: "text", text }],
        effort: prefs?.effort || undefined,
        model: !relayMode && prefs?.model ? prefs.model : undefined,
        approvalPolicy: permission === "full-access" ? "never" : permission === "read-only" ? "on-request" : "untrusted",
        sandboxPolicy: { type: permission === "full-access" ? "dangerFullAccess" : permission === "read-only" ? "readOnly" : "workspaceWrite" },
      });
    } catch (e) {
      const current = useStore.getState();
      const accepted = pendingRenderKey && threadId && current.turns[threadId]?.some(turn =>
        turn.renderKey === pendingRenderKey && !turn.id.startsWith("local_turn_"));
      // A late RPC timeout cannot retract a message already accepted by the kernel.
      if (accepted && threadId) {
        if (current.turnActive[threadId]) setError("发送确认延迟，回复仍在继续。");
        return;
      }
      if (threadId) {
        dropLocalUserMessage(threadId, text);
        clearTurnPending(threadId);
        /**
         * 新建的会话如果首条消息都没发出去，内核里它是个**空会话**。
         * 留在「最近」里就是一条点进去什么都没有、标题还是那句没发出去的提示词
         * 的幽灵条目 —— 所以一并撤掉。
         * （复用已有会话的重试不撤：那本来就存在于历史里。）
         */
        if (createdNewThread) useStore.getState().dropPendingThread(threadId);
      }
      setValue(text);
      // 报错要能直接指导下一步：内核没起来时，原文是 Electron IPC 的
      // "Error invoking remote method 'codex:request': Error: app-server 未运行"，
      // 对用户等于没说。这里换成「出了什么事 + 该看哪里」。
      const raw = String(e).replace(/^Error:\s*/, "");
      const kernelDown = /app-server\s*(未运行|已停止|已退出)|app-server not running/i.test(raw);
      setError(
        kernelDown
          ? "发送失败：内核未在运行（历史会话仍可浏览）。把鼠标移到窗口顶部那条内核提示上看原因，或在项目目录执行 `node tools/test-kernel.cjs` 自查。"
          : raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "发送失败："),
      );
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  async function interrupt() {
    const threadId = useStore.getState().activeThreadId;
    if (!threadId || !activeTurnId || activeTurnId.startsWith("local_turn_")) return;
    try {
      await rpc.request(M.turnInterrupt, { threadId, turnId: activeTurnId });
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, "中断失败："));
    }
  }

  return (
    <div className="w-full max-w-[738px]">
      {/* 项目条是 Composer 容器**外面**的独立一块（用户对照官方指出：它该"在对话框上面"，
          而不是嵌进容器里当顶部凹槽）。官方 CSS 里它是 _ComposerLayoutAttachments_，
          靠自己的完整圆角 + 四周留白与输入区拉开层次。 */}
      {variant === "home" && (
        <ProjectBar
          project={activeProject}
          open={projectOpen}
          onOpenChange={(o) => {
            setProjectOpen(o);
            if (!o) setProjectQuery("");
          }}
          query={projectQuery}
          onQueryChange={setProjectQuery}
          results={filteredProjects}
          allCount={projects.length}
          onClear={() => void useStore.getState().setActiveProject(null)}
          onPick={(p) => {
            void useStore.getState().setActiveProject(p);
            setProjectOpen(false);
          }}
          onNew={() => void pickProject()}
        />
      )}

      <div className="rounded-[22px] bg-bg shadow-[var(--elev-composer)]">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => {
            // 中文/日文等输入法在组合期按 Enter 是"确认候选词"，不能当成发送
            if (e.nativeEvent.isComposing) return;
            if (e.key !== "Enter" || e.shiftKey) return;
            const modEnter = e.ctrlKey || e.metaKey;
            const shouldSend = prefs?.sendShortcut === "mod-enter" ? modEnter : !modEnter;
            if (shouldSend) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={prefs?.sendShortcut === "mod-enter" ? "随心输入（Ctrl+Enter 发送）" : "随心输入"}
          aria-label="消息输入框"
          className="block mb-[8px] min-h-[40px] max-h-[200px] w-full resize-none bg-transparent px-[18px] pt-[15px] text-[14px] leading-[18px] outline-none placeholder:text-text3"
        />
        {error && <p className="px-[18px] pt-1 text-[12px] text-accent">{error}</p>}
        <div className="flex h-[49px] items-center gap-1 px-[6px]">
          <div className="relative">
          <Pop.Root open={attachOpen} onOpenChange={setAttachOpen}>
            <Pop.Trigger asChild>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full text-text2 hover:bg-bghover"
                aria-label="添加文件等内容"
                onMouseEnter={() => setAttachHover(true)}
                onMouseLeave={() => setAttachHover(false)}
              >
                <Plus size={18} />
              </button>
            </Pop.Trigger>
            {attachHover && !attachOpen && <AttachTooltip />}
            <Pop.Portal>
              {/* 官方 composer.contextMenu：宽 = Composer 同宽、高 320 封顶可滚、圆角 16、
                  底边贴着输入框（sideOffset 3），左边缘与输入框左缘对齐（按钮距容器 6px，故 -6） */}
              <Pop.Content
                side="top"
                align="start"
                alignOffset={-6}
                sideOffset={3}
                collisionPadding={16}
                className="z-50 max-h-[320px] w-[738px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-[16px] bg-bg p-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_8px_16px_-4px_rgba(0,0,0,0.12)] outline-none"
              >
                <MenuGroup label="添加" />
                <MenuRow icon={<Paperclip size={16} />} label="文件和文件夹" onClick={() => flash("附加文件功能即将推出")} />
                <MenuRow
                  icon={<Folder size={16} />}
                  label="在项目中使用 Work"
                  desc="为新聊天选择项目"
                  onClick={() => {
                    setAttachOpen(false);
                    // Radix 关闭这个菜单时会把当前这次点击当作 dismiss，
                    // 同一帧里打开项目面板会被立刻吃掉 —— 等菜单关完再开
                    window.setTimeout(() => setProjectOpen(true), 140);
                  }}
                />
                <MenuRow icon={<Target size={16} />} label="目标" desc="设置要持续追求的目标" onClick={() => flash("目标设置功能即将推出")} />
                <MenuRow icon={<Lightbulb size={16} />} label="计划模式" desc="开启计划模式" onClick={() => flash("计划模式即将推出")} />
                <MenuRow icon={<Brush size={16} />} label="绘图" desc="绘制草图" onClick={() => flash("绘图功能即将推出")} />
                {skills.length > 0 && (
                  <>
                    <MenuGroup label="插件" />
                    {skills.map((s) => (
                      <MenuRow
                        key={s.name}
                        icon={<Plug size={16} />}
                        label={s.name}
                        desc={s.desc}
                        onClick={() => flash(`${s.name} 插件即将推出`)}
                      />
                    ))}
                  </>
                )}
              </Pop.Content>
            </Pop.Portal>
          </Pop.Root>
          </div>

          <Pop.Root>
            <Pop.Trigger asChild>
              <button
                className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] ${
                  permission === "full-access" ? "text-accent hover:bg-[var(--orange-50)]" : "text-text2 hover:bg-bghover"
                }`}
                title="更改权限"
              >
                {permission === "full-access" ? <TriangleAlert size={15} /> : <Hand size={15} />}
                {perm.id === "full-access" ? "完全访问" : perm.title}
              </button>
            </Pop.Trigger>
            <Pop.Portal>
              <Pop.Content side="top" align="start" sideOffset={10} className={`${menuContent} w-[320px] p-0`}>
                <div className="flex items-baseline justify-between px-3 pb-1.5 pt-2.5">
                  <span className="text-[13px] text-text">应如何批准 ChatGPT 操作？</span>
                  <button
                    className="text-[12px] text-[var(--blue-400)] hover:underline"
                    onClick={() => void rpc.openExternal("https://help.openai.com/en/articles/11369540")}
                  >
                    了解更多
                  </button>
                </div>
                <div className="px-1.5 pb-1.5">
                  {PERMISSIONS.map((p) => {
                    const selected = p.id === permission;
                    const warn = p.tone === "warning";
                    return (
                      <button
                        key={p.id}
                        className={`${menuItem} w-full text-left`}
                        onClick={() => void useStore.getState().setPrefs({ permission: p.id })}
                      >
                        <span className={`mt-[3px] shrink-0 ${warn ? "text-accent" : "text-text2"}`}>
                          {warn ? <TriangleAlert size={15} /> : p.id === "read-only" ? <ShieldIcon size={15} /> : <Hand size={15} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block text-[13px] ${warn ? "text-accent" : "text-text"}`}>{p.title}</span>
                          <span className={`mt-0.5 block text-[12px] leading-4 ${warn ? "text-accent" : "text-text3"}`}>
                            {p.desc}
                          </span>
                        </span>
                        {selected && <Check size={15} className="mt-[3px] shrink-0 text-text" />}
                      </button>
                    );
                  })}
                </div>
              </Pop.Content>
            </Pop.Portal>
          </Pop.Root>

          <div className="flex-1" />

          <Pop.Root open={modelPopOpen} onOpenChange={setModelPopOpen}>
            <Pop.Anchor asChild>
              <button
                className="flex h-8 max-w-[260px] items-center gap-1 rounded-full px-2.5 text-[13px] text-text2 hover:bg-bghover"
                title={relayMode ? "切换模型（来自「模型」配置库）" : undefined}
                onClick={() => setModelPopOpen(true)}
              >
                {relayMode ? (
                  <>
                    <span className="truncate">{activeRelay?.model ?? activeEnv?.name ?? "自定义模型"}</span>
                    <span className="shrink-0">{EFFORT_LABEL[activeRelay?.reasoningEffort ?? ""] ?? "自动"}</span>
                  </>
                ) : (
                  <span>
                    {modelTitle} {effortLabel}
                  </span>
                )}
                <ChevronDown size={12} className="shrink-0" />
              </button>
            </Pop.Anchor>
            <Pop.Portal>
              <Pop.Content side="top" align="end" sideOffset={10} className={`${menuContent} ${relayMode ? "w-80" : "w-48"}`}>
                {relayMode ? (
                  <>
                    <p className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-text">切换模型</p>
                    <p className="px-2.5 pb-1.5 text-[11.5px] leading-4 text-text3">
                      当前接入「{activeRelay?.name ?? "自定义模型"}」，点下面的配置即切换（写入该环境
                      config.toml 并重启内核，当前会话会结束）。
                    </p>
                    <div className="max-h-[264px] overflow-y-auto">
                      {(envList?.relays ?? []).length === 0 ? (
                        <p className="px-2.5 py-2 text-[12px] text-text3">「模型」配置库还是空的</p>
                      ) : (
                        (envList?.relays ?? []).map((r) => {
                          const on = r.id === activeEnv?.relayId;
                          return (
                            <button
                              key={r.id}
                              disabled={switchingModel}
                              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left outline-none hover:bg-bghover disabled:opacity-50"
                              onClick={() => {
                                setModelPopOpen(false);
                                void applyRelay(r.id);
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] text-text">{r.name}</span>
                                <span className="block truncate font-mono text-[11px] text-text3">
                                  {r.model} · {r.wireApi === "chat" ? "chat" : "responses"}
                                </span>
                              </span>
                              {r.contextWindow ? (
                                <span className="shrink-0 rounded-md bg-bgsub px-1.5 py-px font-mono text-[10.5px] text-text2">
                                  {fmtTokens(Number(r.contextWindow))}
                                </span>
                              ) : null}
                              {on && <Check size={14} className="shrink-0 text-text" />}
                            </button>
                          );
                        })
                      )}
                    </div>
                    <div className="my-1 border-t border-[var(--c-border)]" />
                    <button
                      className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-[13px] text-text hover:bg-bghover"
                      onClick={() => {
                        setModelPopOpen(false);
                        useStore.getState().setView("models");
                      }}
                    >
                      去「模型」里管理配置
                      <ChevronDown size={12} className="-rotate-90 text-text3" />
                    </button>
                  </>
                ) : (
                  <>
                    <p className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-text">选择模型</p>
                    {modelOptions.map((m) => (
                      <button
                        key={m.id}
                        className="flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] text-text hover:bg-bghover"
                        onClick={() => void useStore.getState().setPrefs({ model: m.id })}
                      >
                        <span className="min-w-0 truncate">{m.title}</span>
                        {m.id === model && (
                          <span className="shrink-0">
                            <Check size={14} />
                          </span>
                        )}
                      </button>
                    ))}
                  </>
                )}
              </Pop.Content>
            </Pop.Portal>
          </Pop.Root>

          {turnActive ? (
            <button
              disabled={!activeTurnId || activeTurnId.startsWith("local_turn_")}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--c-send)] text-[var(--c-send-text)]"
              title={!activeTurnId || activeTurnId.startsWith("local_turn_") ? "等待内核确认发送" : "中断"}
              aria-label="中断"
              onClick={() => void interrupt()}
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              disabled={!canSend}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                canSend ? "bg-[var(--c-send)] text-[var(--c-send-text)]" : "bg-[var(--c-send-off)] text-[var(--c-send-off-text)]"
              }`}
              onClick={() => void send()}
              title="发送"
              aria-label="发送"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {notice && <p className="mt-1.5 text-center text-[11.5px] text-text3">{notice}</p>}
    </div>
  );
});

export default Composer;

/**
 * Composer 顶部内嵌的项目条。官方形态：
 * 左右各内缩 12px 的浅灰块（圆角 12px、高 33px），紧贴输入区上方，
 * 悬停时左侧图标位置变成「移除」按钮，并弹出深色 tooltip 标出快捷键。
 */
function ProjectBar({
  project,
  open,
  onOpenChange,
  query,
  onQueryChange,
  results,
  allCount,
  onClear,
  onPick,
  onNew,
}: {
  project: { name: string; path: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (q: string) => void;
  results: { id?: string; name: string; path: string }[];
  allCount: number;
  onClear: () => void;
  onPick: (p: { name: string; path: string }) => void;
  onNew: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div className="relative mb-[2px] px-[14px]">
      <Pop.Root open={open} onOpenChange={onOpenChange}>
        <Pop.Trigger asChild>
          <button
            className="flex h-[37px] w-full items-center gap-1.5 rounded-[12px] bg-[var(--c-bg-raised)] px-3 text-[13px] text-text hover:bg-bghover"
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title="更改此聊天的项目"
            aria-label={project ? `切换项目：${project.name}` : "选择项目"}
          >
            {project && hover ? (
              <span
                role="button"
                tabIndex={-1}
                aria-label="不在项目中工作"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onClear();
                }}
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-bghover text-text3"
              >
                <X size={12} />
              </span>
            ) : (
              <Folder size={16} className="ml-1.5 shrink-0 text-text2" />
            )}
            <span className={`truncate ${project ? "" : "text-text3"}`}>{project ? project.name : "选择项目"}</span>
          </button>
        </Pop.Trigger>
        {hover && !open && <BarTooltip />}
        <Pop.Portal>
          <Pop.Content
            side="top"
            align="start"
            sideOffset={8}
            className="z-50 w-[228px] overflow-hidden rounded-[16px] bg-bg shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_8px_16px_-4px_rgba(0,0,0,0.12)] outline-none"
          >
            <div className="flex items-center gap-2 border-b border-[var(--c-border)] px-3 py-2 text-text3">
              <Search size={14} className="shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="搜索项目"
                aria-label="搜索项目"
                className="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text3"
              />
            </div>
            <div className="max-h-[220px] overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <p className="px-2 py-1.5 text-[12.5px] text-text3">{allCount === 0 ? "还没有项目" : "未找到项目"}</p>
              ) : (
                results.map((p) => {
                  const selected = p.path === project?.path;
                  return (
                    <button
                      key={p.path}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[13px] text-text outline-none hover:bg-bghover ${
                        selected ? "bg-bghover" : ""
                      }`}
                      onClick={() => onPick({ name: p.name, path: p.path })}
                    >
                      <Folder size={15} className="shrink-0 text-text2" />
                      <span className="min-w-0 truncate">{p.name}</span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-[var(--c-border)] p-1.5">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-[7px] text-left text-[13px] text-text outline-none hover:bg-bghover"
                onClick={onNew}
              >
                <Plus size={15} className="shrink-0 text-text2" />
                <span>新建项目</span>
              </button>
            </div>
          </Pop.Content>
        </Pop.Portal>
      </Pop.Root>
    </div>
  );
}

/** 深色 tooltip：文案 + 右侧快捷键（官方悬停项目条时出现） */
function BarTooltip() {
  return (
    <div className="pointer-events-none absolute -top-[30px] left-3 z-50">
      <div className="flex items-center gap-2 whitespace-nowrap rounded-lg bg-[var(--gray-1000)] px-2 py-1 text-[12px] text-[var(--gray-0)] shadow-[0_4px_12px_rgba(0,0,0,0.18)]">
        <span>更改此聊天的项目</span>
        <span className="text-[var(--gray-400)]">Ctrl+Alt+Shift+O</span>
      </div>
    </div>
  );
}

function ShieldIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.8 3 3.6v3.2c0 3.2 2.1 6 5 7.4 2.9-1.4 5-4.2 5-7.4V3.6L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 附件菜单的分组小标题（官方为「添加」与「插件」两组） */
function MenuGroup({ label }: { label: string }) {
  return <p className="px-2 pb-1 pt-2 text-[12px] font-medium text-text3 first:pt-0.5">{label}</p>;
}

/**
 * 附件菜单的一行。官方是**单行**布局：图标 → 标题（正文色）→ 说明（三级色，紧跟其后），
 * 不是「标题一行 + 说明一行」的两行式。行高 28、图标 16、圆角 8。
 */
function MenuRow({
  icon,
  label,
  desc,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  desc?: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex h-[28px] w-full items-center gap-2.5 rounded-[8px] px-2 text-left outline-none hover:bg-bghover focus-visible:bg-bghover"
      onClick={onClick}
    >
      <span className="shrink-0 text-text2">{icon}</span>
      <span className="shrink-0 text-[13px] text-text">{label}</span>
      {desc && <span className="min-w-0 truncate text-[12.5px] text-text3">{desc}</span>}
    </button>
  );
}

/** 「+」按钮的 tooltip：深色胶囊 + 右侧 @ 快捷键徽章（官方 composer.contextButton.tooltip） */
function AttachTooltip() {
  return (
    <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5">
      <div className="flex h-[25px] items-center gap-2 whitespace-nowrap rounded-[8px] bg-[var(--gray-1000)] pl-2 pr-1 text-[12px] font-medium text-[var(--gray-0)] shadow-[0_4px_12px_rgba(0,0,0,0.18)]">
        <span>添加文件等内容</span>
        <span className="flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-white/20 px-1 text-[11px]">
          @
        </span>
      </div>
    </div>
  );
}
