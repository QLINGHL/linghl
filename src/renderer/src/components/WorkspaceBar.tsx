import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, Globe, MessageSquare } from "lucide-react";
import { useStore, type ContentTab } from "../store";

/**
 * 工作区标签栏（对齐官方 threadWorkspace）。
 *
 * 官方结构（自解包产物 + 官方截图实测）：
 *  - `chat` 布局：没有内容标签页 → 整条标签栏不出现，只在工作区**右上角**留一个控件，
 *    图标是「方框 + 加号」；有内容标签页但处于隐藏状态时图标变成「两栏」；
 *  - `split` 分屏：左段是聊天窗格标题「聊天」，右段是内容标签条（标签 + 加号），
 *    最右侧两个按钮：**布局控件**（`main` 焦点区）与**进入/退出完整视图**（`right-panel` 焦点区）；
 *  - `full` 完整视图：同一条标签栏里并排「聊天」+ 各内容标签 + 加号，激活项铺满。
 *
 * **两个按钮 hover 都只出一个黑色气泡提示**（`en` 组件 = Tooltip，带 shortcut 小块 + `delayOpen`），
 * 官方源码里**没有任何下拉菜单** —— 点按钮直接执行气泡上写的那件事。
 *
 * 气泡文案取自官方 `view-control-labels`：
 *   - 布局控件（`view-control-labels` 的 `v`）四态：
 *       无标签且 chat → 「新建标签页」；`_` 为真（= full 且 有标签）→「进入分屏视图」；
 *       chat（有标签）→「显示标签页」；其余 →「隐藏标签页」
 *   - 完整视图按钮（同文件 `y`）三态：
 *       full → 「退出完整视图」；无标签 → 「在完整视图中打开新标签页」；其余 → 「进入完整视图」
 */

/** 分屏时聊天窗格占的宽度百分比（官方截图实测约 40%） */
export const SPLIT_CHAT_PCT = 40;

/** 「新建标签页」字形：圆角方框 + 居中加号 */
function SquarePlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.6" y="3.6" width="18.8" height="16.8" rx="4.2" stroke="currentColor" strokeWidth="1.55" />
      <path d="M12 7.4v9.2M7.4 12h9.2" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 「进入完整视图」字形 —— 官方 `expand-sm` 图标（`_research/.../assets/expand-sm-*.svg`）。
 * 两个**实心 L 形角块**，分别朝右上 / 左下**向外扩张**（不是描边线条）。
 */
function ExpandIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 7C12 6.44772 12.4477 6 13 6H17C17.5523 6 18 6.44772 18 7V11C18 11.5523 17.5523 12 17 12C16.4477 12 16 11.5523 16 11V8H13C12.4477 8 12 7.55228 12 7ZM7 12C7.55228 12 8 12.4477 8 13V16H11C11.5523 16 12 16.4477 12 17C12 17.5523 11.5523 18 11 18H7C6.44772 18 6 17.5523 6 17V13C6 12.4477 6.44772 12 7 12Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * 「退出完整视图」字形 —— 官方 `collapse-sm` 图标（`_research/.../assets/collapse-sm-*.svg`）。
 * 两个**实心 L 形角块**，分别朝左下 / 右上**向内收缩**（与 expand 互为反形）。
 */
function CollapseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 14C5 13.4477 5.44772 13 6 13H10C10.5523 13 11 13.4477 11 14V18C11 18.5523 10.5523 19 10 19C9.44771 19 9 18.5523 9 18V15H6C5.44772 15 5 14.5523 5 14Z"
        fill="currentColor"
      />
      <path
        d="M14 5C14.5523 5 15 5.44772 15 6V9H18C18.5523 9 19 9.44771 19 10C19 10.5523 18.5523 11 18 11H14C13.4477 11 13 10.5523 13 10V6C13 5.44772 13.4477 5 14 5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 布局控件在「已有内容标签」时的字形：两栏 */
function SplitLayoutIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.8" y="4.4" width="18.4" height="15.2" rx="3.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 4.9v14.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

/** 菜单项「新建标签页」字形：一个纯加号（方框只在布局控件本身上） */
function PlusIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.7v16.6M3.7 12h16.6" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 隐藏态布局控件图标 —— 官方 `Hc count={o}` 实测（官方截图 `_research/off-hidden.png`
 * 的 ASCII 轮廓：框 22×19 物理 ≈ 12.6×10.9 CSS，框内数字仅 5×9 物理 ≈ 2.9×5.1 CSS）。
 *
 * 要点（之前做错的地方）：
 *  - 框**宽大于高**（约 13×11 CSS），圆角约 3px，描边细（~1px）；
 *  - 数字**要小且居中**，字高只占框高约 47%，绝不能撑满框；
 *  - 数字与框同为 text3 灰，且要关掉次像素抗锯齿（否则会出现橙/蓝彩边）。
 */
function CountBoxIcon({ count }: { count: number }) {
  const text = count > 99 ? "99+" : String(count);
  const wide = text.length > 1;
  return (
    <span className="relative inline-flex h-[11px] w-[13px] shrink-0 items-center justify-center">
      <svg width={13} height={11} viewBox="0 0 13 11" fill="none" aria-hidden className="absolute inset-0">
        <rect x="0.5" y="0.5" width="12" height="10" rx="2.6" stroke="currentColor" strokeWidth="1" />
      </svg>
      <span
        className="relative leading-none"
        style={{
          fontSize: wide ? 6.5 : 7.5,
          fontSynthesis: "none",
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          transform: "translateZ(0)",
          textShadow: "0 0 0 currentColor",
        }}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * 官方那个黑色气泡提示：官方截图实测卡片 172×29 CSS px，
 * 文案 13px 白字 + 右侧一个浅色快捷键小块（12px）。
 */
function HoverTip({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <div
      data-ws-tip="1"
      className="pointer-events-none absolute bottom-[33px] right-[-4px] z-[60] flex h-[29px] items-center gap-2 whitespace-nowrap rounded-[10px] bg-[var(--gray-1000)] pl-3 pr-1.5 shadow-[0_4px_12px_rgba(0,0,0,0.18)]"
    >
      <span className="text-[13px] leading-none text-[var(--gray-0)]">{label}</span>
      {/* eslint-disable-next-line react/no-unknown-property */}
      <kbd className="rounded-[6px] bg-[rgb(255_255_255_/_0.16)] px-2 py-[5px] font-sans text-[12px] leading-none text-[var(--gray-0)]">
        {shortcut}
      </kbd>
    </div>
  );
}

/** 标签条里的普通「+」按钮 */
function NewTabButton() {
  const wsNewTab = useStore((s) => s.wsNewTab);
  return (
    <button
      type="button"
      aria-label="新建标签页按钮"
      title="新建标签页"
      className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-text2 hover:bg-bghover hover:text-text"
      onClick={() => wsNewTab()}
    >
      <PlusIcon size={14} />
    </button>
  );
}

function TabPill({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: ContentTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`group/tab flex h-[29px] shrink-0 items-center rounded-[8px] border pl-[9px] text-[13px] ${
        active
          ? "min-w-[233px] max-w-[300px] border-[#e4e4e5] bg-bg pr-[7px] text-text"
          : "border-transparent pr-2.5 text-text3 hover:bg-bghover"
      }`}
    >
      <Globe size={14} className={`mr-[7px] shrink-0 ${active ? "text-text2" : "text-text3"}`} />
      <button type="button" className="min-w-0 flex-1 truncate text-left" title={tab.title} onClick={onSelect}>
        {tab.title}
      </button>
      {/* 官方：× 只在激活标签上常驻（非激活标签根本没有关闭按钮） */}
      {active && (
        <button
          type="button"
          aria-label="关闭标签页"
          className="ml-2 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-text3 hover:bg-bgactive hover:text-text"
          onClick={onClose}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** 完整视图下的「聊天」标签 */
function ChatTabPill({ active }: { active: boolean }) {
  const wsSelectTab = useStore((s) => s.wsSelectTab);
  return (
    <div
      className={`flex h-[32px] shrink-0 items-center rounded-[8px] border px-2.5 text-[13px] ${
        active ? "border-border bg-bg text-text" : "border-transparent text-text2 hover:bg-bghover"
      }`}
    >
      <MessageSquare size={13} className="mr-1.5 shrink-0 text-text3" />
      <button type="button" onClick={() => wsSelectTab(null)}>
        聊天
      </button>
    </div>
  );
}

/**
 * 进入 / 退出完整视图（官方 `bl` 组件，焦点区 `right-panel`）。
 *
 * 官方原文：
 * ```js
 * const a = layout === "full";              // 是否在完整视图
 * const color = a ? "secondary" : "ghost";  // ★ full 时浅灰底，否则透明
 * const icon  = a ? Cn : H;                 // ★ full → collapse(收缩) / 非full → expand(扩张)
 * <F aria-label={label} aria-pressed={a} color={color} ... />
 * ```
 * 所以这个按钮**有激活态**：进了完整视图，图标从「向外扩张」变成「向内收缩」，
 * 并且底色变成浅灰（和右边布局控件的激活态同样道理）。hover 出黑色气泡。
 */
function FullViewToggle() {
  const full = useStore((s) => s.wsLayout === "full");
  const wsToggleFullView = useStore((s) => s.wsToggleFullView);
  const [tip, setTip] = useState(false);
  const tipTimer = useRef<number | null>(null);
  const clear = () => {
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
  };
  useEffect(() => clear, []);
  return (
    <div
      className="relative"
      onPointerEnter={() => {
        clear();
        tipTimer.current = window.setTimeout(() => setTip(true), 140);
      }}
      onPointerLeave={() => {
        clear();
        setTip(false);
      }}
    >
      {tip && <HoverTip label={full ? "退出完整视图" : "进入完整视图"} shortcut="Ctrl+Shift+F" />}
      <button
        type="button"
        aria-label={full ? "退出完整视图" : "进入完整视图"}
        aria-pressed={full}
        data-app-shell-workspace-layout-toggle="right-panel"
        className={`flex h-8 w-8 items-center justify-center rounded-[8px] hover:bg-bghover hover:text-text ${
          full ? "bg-bghover text-text" : "text-text3"
        }`}
        onClick={() => wsToggleFullView()}
      >
        {full ? <CollapseIcon /> : <ExpandIcon />}
      </button>
    </div>
  );
}

/**
 * 布局控件 = 右上角那个「什么东西」，官方焦点区名 `main`。
 *
 * **官方 `Sl` 组件的三分支状态机（逐行核对后照抄，不再自己发明）**：
 * ```js
 * const c = layout !== "chat";          // 是否处于分屏/完整视图
 * const o = tabIds.length;              // 内容标签数量
 * if (!c && routeKind === "home" && o === 0) return <sl />;  // ① 聊天 + 零标签
 * if (!c && o > 0)                          return <fl />;  // ② 聊天 + 有标签（隐藏态）
 * // ③ 其余（split / full）
 * icon = c && (o > 0 || !u) ? <Icon asset={M} /> : <Hc count={o} />
 * ```
 *
 * 三个分支的真面目：
 *  - ① **聊天 + 零标签** → `sl`：图标「方框加号」，**hover 进按钮立刻弹两项目菜单**
 *        （新建标签页 / 在完整视图中打开新标签页），鼠标点击 = 第一项。
 *  - ② **聊天 + 有标签（= 标签被隐藏了）** → `fl`：图标「方框加号 + **数字徽标**」，
 *        hover 出的是「Open tabs」**标签列表**菜单 + 一条 tooltip（文案「显示标签页」）。
 *        因为标签没销毁，所以徽标上还挂着数量。
 *  - ③ **分屏 / 完整视图** → 图标变成**两栏图标**（`M`，官方截图 `_p-topright.png` 里
 *        那个"缩放式"的方框+竖线），**不再有方框加号、也不再有那两项目菜单**；
 *        hover 只出一条 tooltip（四态文案），点击 = 推进/切换布局。
 *
 * 我上一版把 ③ 也做成了「方框加号 + 两项目菜单」，完全是错的 —— 用户说的
 * 「点了之后就不该再出现那个加号在矩形里的图标，应该是缩放形式的」指的就是这条。
 */
function LayoutControl() {
  const wsNewTab = useStore((s) => s.wsNewTab);
  const wsToggleFullView = useStore((s) => s.wsToggleFullView);
  const wsStepLayout = useStore((s) => s.wsStepLayout);
  const wsSetLayout = useStore((s) => s.wsSetLayout);
  const layout = useStore((s) => s.wsLayout);
  const tabs = useStore((s) => s.wsTabs);
  const tabCount = tabs.length;
  const split = layout !== "chat";
  const full = layout === "full";

  // 官方三分支
  const isEmptyChat = !split && tabCount === 0; // ①
  const isHiddenChat = !split && tabCount > 0; // ②

  // 分支 ② 的 tooltip 文案（官方四态里的「显示标签页」）
  const splitTipLabel = full ? "进入分屏视图" : "隐藏标签页";

  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  /** 鼠标是否落在按钮上（决定点击语义；键盘激活另算） */
  const mouseOnButton = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const tipTimer = useRef<number | null>(null);

  const clearTimers = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
  };
  useEffect(() => clearTimers, []);

  // 官方 x（onPointerLeave）：延迟 100ms 关，给指针跨到菜单留出时间
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setTip(false);
    }, 100);
  };

  // 点「外部」或 Esc 也关
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 分支 ① 的两项目菜单（官方 `sl` 里那两项）
  const items: { key: string; icon: ReactNode; label: string; shortcut: string; run: () => void }[] = [
    {
      key: "new",
      icon: <PlusIcon />,
      label: "新建标签页",
      shortcut: "Ctrl+Shift+B",
      run: () => wsNewTab({ full }),
    },
    {
      key: "full",
      icon: <ExpandIcon />,
      label: full ? "退出完整视图" : "在完整视图中打开新标签页",
      shortcut: "Ctrl+Shift+F",
      run: () => (full ? wsToggleFullView() : wsNewTab({ full: true })),
    },
  ];

  // 分支 ② 的菜单：已隐藏的标签列表（官方 `fl` 的「Open tabs」）
  const hiddenItems: { key: string; icon: ReactNode; label: string; run: () => void }[] = [
    ...tabs.map((t) => ({ key: t.id, icon: <Globe size={14} />, label: t.title, run: () => wsSetLayout("split") })),
  ];

  const openMenuOnEnter = (e: React.PointerEvent) => {
    clearTimers();
    if (e.pointerType !== "mouse") return;
    mouseOnButton.current = true;
    // ① 有下拉菜单（立刻）；② 有标签列表菜单；③ 只有 tooltip
    if (isEmptyChat || isHiddenChat) setOpen(true);
    else tipTimer.current = window.setTimeout(() => setTip(true), 120);
  };

  const menuItems = isEmptyChat ? items : hiddenItems;

  return (
    <div
      ref={wrapRef}
      className="relative"
      onPointerEnter={openMenuOnEnter}
      onPointerLeave={scheduleClose}
    >
      {/* 分支 ③：只有 tooltip，没有菜单 */}
      {!isEmptyChat && !isHiddenChat && tip && (
        <HoverTip label={splitTipLabel} shortcut="Ctrl+Shift+B" />
      )}

      <button
        type="button"
        aria-label={isEmptyChat ? "新建标签页" : isHiddenChat ? "显示标签页" : splitTipLabel}
        aria-haspopup={isEmptyChat || isHiddenChat ? "menu" : undefined}
        aria-expanded={isEmptyChat || isHiddenChat ? open : undefined}
        data-app-shell-workspace-layout-toggle="main"
        className={`flex h-8 w-8 items-center justify-center rounded-[8px] hover:bg-bghover hover:text-text ${
          /* 官方 `m = layout === "split" ? "secondary" : "ghost"` —— 只有**分屏态**才有浅灰底，
             完整视图态（和聊天态）都是 ghost 无底。官方截图 1（退出完整视图）里右边这个
             两栏图标就是不带底的，只有 split 才带。 */
          layout === "split" ? "bg-bghover text-text" : "text-text3"
        }`}
        onPointerDown={(e) => {
          // 官方 P：记录这次是不是鼠标
          mouseOnButton.current = e.pointerType === "mouse";
        }}
        onClick={() => {
          if (!mouseOnButton.current) return;
          if (isEmptyChat) {
            // 官方 I：鼠标点击 = 执行默认第一项（新建标签页）
            setOpen(false);
            items[0].run();
            return;
          }
          if (isHiddenChat) {
            // 官方 fl 的 onClick = Lr：把隐藏的标签再显示出来
            setOpen(false);
            wsSetLayout("split");
            return;
          }
          // 分支 ③：推进布局 / 切换聊天与内容
          setTip(false);
          wsStepLayout();
        }}
        onKeyDown={(e) => {
          if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return;
          if (isEmptyChat || isHiddenChat) {
            e.preventDefault();
            setOpen(true);
            window.setTimeout(() => {
              const list = wrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
              if (!list?.length) return;
              (e.key === "ArrowUp" ? list[list.length - 1] : list[0]).focus();
            }, 0);
          }
        }}
      >
        {/* 官方 `g`：split/full → 两栏图标；chat 且零标签 → 方框加号；
            chat 且已有标签（隐藏态）→ 圆角方框内写数量（官方 `Hc count`，实测见 off-hidden-icon.png） */}
        {split ? <SplitLayoutIcon /> : isHiddenChat ? <CountBoxIcon count={tabCount} /> : <SquarePlusIcon size={16} />}
      </button>

      {open && (isEmptyChat || isHiddenChat) && (
        <div
          role="menu"
          aria-label={isEmptyChat ? "新建标签页" : "已打开的标签页"}
          /* 官方 contentWidth = menuWide，菜单固定 240px 宽 —— 第二项长文案会被 CSS
             截断成「在完整视图中打开…」，所以文案必须写全称才对得上截断效果 */
          className="absolute right-[-6px] top-[34px] z-50 w-[240px] rounded-[16px] bg-bg p-[5px] shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_6px_20px_rgba(0,0,0,0.10)]"
          onPointerEnter={clearTimers}
          onPointerLeave={scheduleClose}
        >
          {isHiddenChat && <div className="px-3 py-1.5 text-[12px] leading-normal text-text3">已打开的标签页</div>}
          {menuItems.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              title={it.label}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className="flex h-[34px] w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13px] text-text hover:bg-bghover focus-visible:bg-bghover focus:outline-none"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text2">{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {"shortcut" in it && <span className="shrink-0 text-[13px] text-text3">{(it as { shortcut: string }).shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 标签栏本体。`chat` 布局时整条不出现（只浮一个右上角控件），
 * 这也是官方在"还没有内容标签页（或把标签页隐藏了）"时的样子。
 */
export default function WorkspaceBar() {
  const layout = useStore((s) => s.wsLayout);
  const tabs = useStore((s) => s.wsTabs);
  const activeId = useStore((s) => s.wsActiveTabId);
  const wsSelectTab = useStore((s) => s.wsSelectTab);
  const wsCloseTab = useStore((s) => s.wsCloseTab);

  if (layout === "chat") {
    return (
      <div className="pointer-events-none absolute right-[16px] top-[12px] z-30">
        <div className="pointer-events-auto">
          <LayoutControl />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[48px] shrink-0 items-center border-b border-border bg-bg">
      {/* 分屏：左段是聊天窗格的标题（与下方聊天窗格同宽） */}
      {layout === "split" && (
        <div style={{ flexBasis: `${SPLIT_CHAT_PCT}%` }} className="shrink-0 truncate px-4 text-[13px] text-text">
          聊天
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden pl-[10px] pr-2">
        {layout === "full" && <ChatTabPill active={activeId === null} />}
        {tabs.map((t) => (
          <TabPill
            key={t.id}
            tab={t}
            active={activeId === t.id}
            onSelect={() => wsSelectTab(t.id)}
            onClose={() => wsCloseTab(t.id)}
          />
        ))}
        <NewTabButton />
      </div>      <div className="flex shrink-0 items-center gap-0.5 pr-2">
        <FullViewToggle />
        <LayoutControl />
      </div>
    </div>
  );
}
