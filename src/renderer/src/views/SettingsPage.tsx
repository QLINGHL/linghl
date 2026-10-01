import { useMemo, useState } from "react";
import type { SettingsSectionId } from "../store";
import {
  Search,
  Settings,
  Download,
  Sun,
  Mic,
  SquareTerminal,
  SlidersHorizontal,
  Gamepad2,
  Keyboard,
  Puzzle,
  MousePointerClick,
  Camera,
  Globe,
  Webhook,
  Cable,
  GitBranch,
  FolderGit2,
  GitFork,
  Archive,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "../store";
import { rpc, type DeskStateShape } from "../lib/api";
import { EnvSection } from "../components/EnvSection";

/** 官方设置扩展字段（deskState 合并缺省，读取处再兜底） */
type ExtraPrefs = {
  shell?: string;
  lang?: string;
  fullView?: boolean;
  bottomPanel?: boolean;
  promptSuggest?: boolean;
  projectsFolder?: string;
};
type Prefs = DeskStateShape["preferences"] & ExtraPrefs;

/** 分区 id 与 store 中的 SettingsSectionId 保持一致（登录门会直接跳到 env） */
type SectionId = SettingsSectionId;

interface NavItem {
  id: SectionId;
  label: string;
  icon: LucideIcon;
}
interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * 导航项与官方设置一致。
 * 实测官方（1440×912 @DPI1.75 截图）：常规/外观/语音/配置 的图标分别是
 * 齿轮 / 太阳 / 麦克风 / 盾牌终端——早前版本的 用户头像 / 调色板 / 配音 是错的。
 */
const NAV: NavGroup[] = [
  {
    group: "个人",
    items: [
      { id: "general", label: "常规", icon: Settings },
      { id: "import", label: "导入", icon: Download },
      { id: "appearance", label: "外观", icon: Sun },
      { id: "voice", label: "语音", icon: Mic },
      { id: "dub", label: "配置", icon: SquareTerminal },
      { id: "personalize", label: "个性化", icon: SlidersHorizontal },
      { id: "mini", label: "Mini 与虚拟宠物", icon: Gamepad2 },
      { id: "shortcuts", label: "键盘快捷键", icon: Keyboard },
    ],
  },
  {
    group: "集成",
    items: [
      { id: "plugins", label: "插件", icon: Puzzle },
      { id: "computer-use", label: "电脑操控", icon: MousePointerClick },
      { id: "snapshots", label: "应用快照", icon: Camera },
      { id: "browser", label: "浏览器", icon: Globe },
    ],
  },
  {
    group: "编码",
    items: [
      { id: "hooks", label: "钩子", icon: Webhook },
      { id: "connect", label: "连接", icon: Cable },
      { id: "git", label: "Git", icon: GitBranch },
      { id: "env", label: "环境", icon: FolderGit2 },
      { id: "worktrees", label: "Worktrees", icon: GitFork },
    ],
  },
  {
    group: "已归档",
    items: [{ id: "archived", label: "已归档的聊天", icon: Archive }],
  },
];

/** 官方蓝色开关 */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors ${
        on ? "bg-[#0891ff]" : "bg-[var(--c-switch-off)]"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
          on ? "left-[18px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

const sel =
  "rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none";

/* 说明：本应用根字号 = 14px（随"字号"偏好变），Tailwind 的 rem 类会被 ×0.875，
   所以对齐官方尺寸的地方一律用 px 任意值，别用 h-9/mt-4 这类 rem 类。 */
function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-[16px] py-[12px]">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-[20px] text-text">{title}</p>
        {desc && <p className="text-[12px] leading-[16px] text-text3">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-[17px] mt-[48px] text-[13px] leading-[19px] text-text2">{children}</p>;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border rounded-2xl border border-border bg-bg">
      {children}
    </div>
  );
}

/** 常规页（对齐官方：权限两开关 + 常规分区行） */
function GeneralPage({ prefs }: { prefs: Prefs }) {
  const setPrefs = useStore((s) => s.setPrefs);
  const permission = prefs.permission ?? "workspace-write";
  const projectsFolder = prefs.projectsFolder ?? "";
  const shell = prefs.shell ?? "powershell";
  const lang = prefs.lang ?? "auto";
  return (
    <>
      <h1 className="text-[22px] font-semibold text-text">常规</h1>

      <SectionLabel>权限</SectionLabel>
      <Card>
        <Row
          title="默认权限"
          desc="默认情况下，Codex 可以读取和编辑其工作空间中的文件。需要时，它可以请求额外访问权限"
        >
          <Toggle
            on={permission !== "read-only"}
            onChange={(v) =>
              void setPrefs({ permission: v ? "workspace-write" : "read-only" } as never)
            }
          />
        </Row>
        <Row
          title="完整访问权限"
          desc={
            <>
              当 Codex 请求许可被批准运行时，它无需你的批准即可编辑你电脑上的任何文件，并运行可访问网络的命令。这会显著增加数据丢失、泄露或意外行为的风险。{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => void rpc.openExternal("https://developers.openai.com/codex/security").catch(() => undefined)}
              >
                了解更多
              </button>
            </>
          }
        >
          <Toggle
            on={permission === "full-access"}
            onChange={(v) =>
              void setPrefs({ permission: v ? "full-access" : "workspace-write" } as never)
            }
          />
        </Row>
      </Card>

      <SectionLabel>常规</SectionLabel>
      <Card>
        <Row title="无项目任务文件夹" desc="在项目外启动的任务默认存储数据的位置。">
          <div className="flex items-center gap-2">
            <span className="max-w-[220px] truncate text-[12px] text-text3">
              {projectsFolder || "未设置"}
            </span>
            <button
              className="rounded-lg border border-border px-2.5 py-1 text-[12px] text-text hover:bg-bghover"
              onClick={async () => {
                try {
                  const dir = await rpc.env.pickFolder();
                  if (dir) void setPrefs({ projectsFolder: dir } as never);
                } catch {
                  /* 通道未就绪时忽略 */
                }
              }}
            >
              更改
            </button>
          </div>
        </Row>
        <Row title="默认文件打开位置" desc="默认打开文件和文件夹的位置">
          <span className="text-[12px] text-text3">未找到目标</span>
        </Row>
        <Row title="集成终端 Shell" desc="选择在集成终端中打开的 Shell。">
          <select
            className={sel}
            value={shell}
            onChange={(e) => void setPrefs({ shell: e.target.value } as never)}
          >
            <option value="powershell">PowerShell</option>
            <option value="cmd">命令提示符</option>
            <option value="gitbash">Git Bash</option>
          </select>
        </Row>
        <Row title="语言" desc="应用界面语言">
          <select
            className={sel}
            value={lang}
            onChange={(e) => void setPrefs({ lang: e.target.value } as never)}
          >
            <option value="auto">自动检测</option>
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Row title="默认使用完整视图" desc="开始新任务时，在同一标签栏中显示聊天和内容">
          <Toggle
            on={prefs.fullView ?? false}
            onChange={(v) => void setPrefs({ fullView: v } as never)}
          />
        </Row>
        <Row title="底部面板" desc="在应用标题栏中显示底部面板控件">
          <Toggle
            on={prefs.bottomPanel ?? false}
            onChange={(v) => void setPrefs({ bottomPanel: v } as never)}
          />
        </Row>
        <Row title="提示词建议" desc="通过搜索项目文件和已连接的应用，建议下一步操作">
          <Toggle
            on={prefs.promptSuggest ?? false}
            onChange={(v) => void setPrefs({ promptSuggest: v } as never)}
          />
        </Row>
      </Card>
    </>
  );
}

/** 外观页（主题 + 字号，从旧设置行迁移而来） */
function AppearancePage({ prefs }: { prefs: Prefs }) {
  const setPrefs = useStore((s) => s.setPrefs);
  return (
    <>
      <h1 className="text-[22px] font-semibold text-text">外观</h1>
      <SectionLabel>主题</SectionLabel>
      <Card>
        <Row title="主题" desc="跟随系统、浅色或深色">
          <select
            className={sel}
            value={prefs.theme}
            onChange={(e) => {
              const theme = e.target.value as "system" | "light" | "dark";
              void setPrefs({ theme });
            }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Row>
        <Row title="字号" desc="聊天与界面文字大小">
          <input
            type="number"
            min={12}
            max={24}
            value={prefs.fontSize}
            className={`${sel} w-20`}
            onChange={(e) => {
              // 空值/越界值不落库：Number("") === 0，持久化后根字号会永远回落 14
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 12 && n <= 24) void setPrefs({ fontSize: n });
            }}
          />
        </Row>
      </Card>
    </>
  );
}

/** 键盘快捷键页 */
function ShortcutsPage({ prefs }: { prefs: Prefs }) {
  const setPrefs = useStore((s) => s.setPrefs);
  return (
    <>
      <h1 className="text-[22px] font-semibold text-text">键盘快捷键</h1>
      <SectionLabel>发送</SectionLabel>
      <Card>
        <Row title="发送快捷方式" desc="选择发送消息使用的按键组合">
          <select
            className={sel}
            value={prefs.sendShortcut}
            onChange={(e) =>
              void setPrefs({ sendShortcut: e.target.value as "enter" | "mod-enter" })
            }
          >
            <option value="enter">Enter 发送</option>
            <option value="mod-enter">Ctrl+Enter 发送</option>
          </select>
        </Row>
      </Card>
    </>
  );
}

/** 未实现分区的诚实空态（官方同款布局，可见反馈而非死按钮） */
function StubPage({ label }: { label: string }) {
  return (
    <>
      <h1 className="text-[22px] font-semibold text-text">{label}</h1>
      <div className="mt-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
        <Settings2 size={28} className="text-text3" />
        <p className="mt-3 text-[13.5px] text-text2">此设置分区即将推出</p>
        <p className="mt-1 text-[12px] text-text3">当前版本尚未实现该分区的功能</p>
      </div>
    </>
  );
}

/**
 * 设置导航面板：占官方**侧栏槽位**（切到设置视图时替换 Codex 主侧栏），
 * 而不是在主区里再开一栏——否则会出现「侧栏 + 设置导航」两根柱子。
 * 实测官方：面板宽 ≈238、内容左右内边距 8、选中行高 30、搜索框高 36。
 */
export function SettingsPanel() {
  const section = useStore((s) => s.settingsSection);
  const setSection = useStore((s) => s.setSettingsSection);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    if (!query.trim()) return NAV;
    const q = query.trim().toLowerCase();
    return NAV.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <aside className="flex w-[240px] shrink-0 flex-col bg-bgsub">
      <h1 className="px-[16px] pt-[14px] text-[16px] font-semibold leading-[19px] text-text">设置</h1>

      <div className="mt-[18px] px-[8px]">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-[13px] top-1/2 -translate-y-1/2 text-text3"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索"
            className="h-[36px] w-full rounded-[10px] bg-bghover pl-[32px] pr-[10px] text-[13px] text-text outline-none placeholder:text-text3"
          />
        </div>
      </div>

      <nav className="mt-[30px] flex-1 overflow-y-auto px-[8px] pb-[16px]">
        {groups.map((g) => (
          <div key={g.group} className="mt-[8px] first:mt-0">
            <p className="flex h-[30px] items-center px-[10px] text-[12.5px] text-text3">{g.group}</p>
            {g.items.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  className={`flex h-[30px] w-full items-center gap-[10px] rounded-lg px-[10px] text-[13px] ${
                    active ? "bg-bghover font-medium text-text" : "text-text2 hover:bg-bghover"
                  }`}
                >
                  <Icon size={15} className={active ? "text-text" : "text-text3"} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** 设置内容区：官方是**居中约 727px 的窄列**，顶部留白很大（≈75px） */
export function SettingsMain() {
  const prefsRaw = useStore((s) => s.prefs);
  const section = useStore((s) => s.settingsSection);
  const current = NAV.flatMap((g) => g.items).find((i) => i.id === section);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[775px] px-[24px] pt-[72px] pb-[64px]">
        {!prefsRaw ? (
          <>
            <h1 className="text-[22px] font-semibold text-text">设置</h1>
            <EnvSection />
          </>
        ) : section === "general" ? (
          <GeneralPage prefs={prefsRaw as Prefs} />
        ) : section === "appearance" ? (
          <AppearancePage prefs={prefsRaw as Prefs} />
        ) : section === "shortcuts" ? (
          <ShortcutsPage prefs={prefsRaw as Prefs} />
        ) : section === "env" ? (
          <>
            <h1 className="text-[22px] font-semibold text-text">环境</h1>
            <EnvSection />
          </>
        ) : (
          <StubPage label={current?.label ?? "设置"} />
        )}
      </div>
    </div>
  );
}
