import { useEffect, useMemo, useState } from "react";
import {
  Search,
  Puzzle,
  Package,
  RefreshCw,
  Plus,
  ChevronDown,
  ExternalLink,
  Check,
  MoreHorizontal,
} from "lucide-react";
import { useStore } from "../store";
import { rpc } from "../lib/api";

interface CatalogItem {
  name: string;
  desc: string;
  url: string;
  color: string;
  letter: string;
}

/** 主区搜索框的 id：侧栏那个放大镜按钮要靠它把焦点交过去 */
const CUSTOMIZE_SEARCH_ID = "customize-search-input";

/** 插件目录（与官方 Customize → 插件 同构；安装依赖官方账号，当前给可见反馈） */
const CATALOG: { section: string; items: CatalogItem[] }[] = [
  {
    section: "Featured",
    items: [{ name: "Computer Use", desc: "Control Windows apps", url: "https://openai.com", color: "#7c5cff", letter: "C" }],
  },
  {
    section: "Communication",
    items: [{ name: "Slack", desc: "Read and manage Slack", url: "https://slack.com", color: "#4a154b", letter: "S" }],
  },
  {
    section: "Creativity",
    items: [
      { name: "Remotion", desc: "Make videos agentically", url: "https://remotion.dev", color: "#0b84ff", letter: "R" },
      { name: "Hyperframes by HeyGen", desc: "Write HTML render video", url: "https://heygen.com", color: "#12b76a", letter: "H" },
      { name: "Figma", desc: "Figma design-to-code workflows", url: "https://figma.com", color: "#f24e1e", letter: "F" },
      { name: "Canva", desc: "Create review edit designs", url: "https://canva.com", color: "#00c4cc", letter: "C" },
      { name: "Product Design", desc: "Explore and prototype ideas", url: "https://openai.com", color: "#8b5cf6", letter: "P" },
      { name: "Higgsfield", desc: "Every image and video model", url: "https://higgsfield.ai", color: "#f59e0b", letter: "H" },
    ],
  },
  {
    section: "Data & Analytics",
    items: [
      { name: "Mixpanel Headless", desc: "Analyze Mixpanel data with Python", url: "https://mixpanel.com", color: "#6c5ce7", letter: "M" },
      { name: "PostHog", desc: "Analyze your product data", url: "https://posthog.com", color: "#f54e00", letter: "P" },
    ],
  },
];

function IconBlock({ color, letter, size = 30 }: { color: string; letter: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.45 }}
    >
      {letter}
    </div>
  );
}

/** Customize 侧栏面板：占用官方侧栏槽位 */
export function CustomizePanel() {
  const tab = useStore((s) => s.customizeTab);
  const setTab = useStore((s) => s.setCustomizeTab);
  const activeEnvId = useStore((s) => s.envList?.activeId);
  const [skills, setSkills] = useState<{ name: string; desc: string }[]>([]);

  useEffect(() => {
    rpc.env
      .listSkills()
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [activeEnvId]);

  return (
    <aside className="flex w-[240px] shrink-0 flex-col bg-bgsub pt-1">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1 className="text-[15px] font-semibold text-text">Customize</h1>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover"
          title="搜索"
          aria-label="搜索"
          onClick={() => document.getElementById(CUSTOMIZE_SEARCH_ID)?.focus()}
        >
          <Search size={14} />
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-2.5">
        <button
          onClick={() => setTab("plugins")}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] ${
            tab === "plugins" ? "bg-bghover font-medium text-text" : "text-text2 hover:bg-bghover"
          }`}
        >
          <Puzzle size={16} className={tab === "plugins" ? "text-text" : "text-text3"} />
          插件
        </button>
        <button
          onClick={() => setTab("skills")}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] ${
            tab === "skills" ? "bg-bghover font-medium text-text" : "text-text2 hover:bg-bghover"
          }`}
        >
          <Package size={16} className={tab === "skills" ? "text-text" : "text-text3"} />
          技能
        </button>
      </nav>

      <p className="mt-5 px-4 pb-1 text-[12.5px] text-text3">已安装</p>
      <div className="flex flex-col gap-0.5 px-2.5">
        {tab === "skills" ? (
          skills.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] text-text3">暂无已安装技能</p>
          ) : (
            skills.map((s) => (
              <div key={s.name} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[14px] text-text2">
                <Package size={15} className="text-text3" />
                <span className="truncate">{s.name}</span>
              </div>
            ))
          )
        ) : (
          <p className="px-2.5 py-1.5 text-[12px] text-text3">暂无已安装插件</p>
        )}
      </div>
    </aside>
  );
}

/** Customize 主区：插件目录 / 技能列表 */
export function CustomizeMain() {
  const tab = useStore((s) => s.customizeTab);
  const activeEnvId = useStore((s) => s.envList?.activeId);
  const [query, setQuery] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [toast, setToast] = useState("");
  const [skills, setSkills] = useState<{ name: string; desc: string }[]>([]);

  const flash = (s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 3500);
  };

  const loadSkills = async () => {
    try {
      setSkills(await rpc.env.listSkills());
    } catch {
      setSkills([]);
    }
  };

  // 依赖 activeEnvId：切换隔离环境后技能目录随之变化，必须重新读取
  useEffect(() => {
    void loadSkills();
  }, [activeEnvId]);

  const refresh = () => {
    setSpinning(true);
    void loadSkills().finally(() => {
      window.setTimeout(() => setSpinning(false), 600);
    });
  };

  const q = query.trim().toLowerCase();
  const filteredCatalog = useMemo(
    () =>
      CATALOG.map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => !q || i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q),
        ),
      })).filter((g) => g.items.length > 0),
    [q],
  );
  const filteredSkills = useMemo(
    () => skills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)),
    [skills, q],
  );

  const headerBtn = "flex h-8 w-8 items-center justify-center rounded-full text-text2 hover:bg-bghover";

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[760px] px-8 py-8">
        {/* 头部 */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold text-text">{tab === "plugins" ? "插件" : "技能"}</h1>
            <p className="mt-1 text-[13px] text-text3">
              {tab === "plugins" ? "连接插件，让 Codex 在你的各类工具中协同工作" : "通过任务专用技能扩展 Codex"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-text3" />
              <input
                id={CUSTOMIZE_SEARCH_ID}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === "plugins" ? "搜索插件" : "搜索技能"}
                className="w-44 rounded-full border border-border bg-bg py-1.5 pl-8 pr-3 text-[13px] text-text outline-none placeholder:text-text3 focus:border-text3"
              />
            </div>
            <button className={headerBtn} title="刷新" onClick={refresh}>
              <RefreshCw size={14} className={spinning ? "animate-spin" : ""} />
            </button>
            <button
              className={headerBtn}
              title="添加"
              onClick={() => flash("插件安装需要官方账号登录，当前版本暂不可用")}
            >
              <Plus size={14} />
            </button>
            <button
              className="flex items-center gap-1 rounded-full bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90"
              onClick={() => flash("插件安装需要官方账号登录，当前版本暂不可用")}
            >
              添加
              <ChevronDown size={12} />
            </button>
          </div>
        </div>

        {tab === "plugins" ? (
          <>
            <div className="mt-5 flex items-center gap-1.5">
              <button
                className="rounded-full bg-bghover px-3.5 py-1.5 text-[13px] font-medium text-text"
                onClick={() => setQuery("")}
              >
                公开
              </button>
              <button
                className="rounded-full px-3.5 py-1.5 text-[13px] text-text2 hover:bg-bghover"
                onClick={() => flash("个人插件需要登录账号后上传，当前版本暂不可用")}
              >
                个人
              </button>
            </div>

            {filteredCatalog.length === 0 && (
              <p className="mt-10 text-center text-[13px] text-text3">没有匹配「{query}」的插件</p>
            )}
            {filteredCatalog.map((group) => (
              <div key={group.section} className="mt-7">
                <h2 className="text-[15px] font-semibold text-text">{group.section}</h2>
                <div className={`mt-2 grid gap-x-10 ${group.section === "Featured" ? "grid-cols-1" : "grid-cols-2"}`}>
                  {group.items.map((item) => (
                    <div key={item.name} className="flex items-center gap-3 py-3">
                      <IconBlock color={item.color} letter={item.letter} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1 text-[13.5px] font-medium text-text">
                          <button
                            className="truncate hover:underline"
                            onClick={() => void rpc.openExternal(item.url).catch(() => undefined)}
                            title="打开官网"
                          >
                            {item.name}
                          </button>
                          <ExternalLink size={11} className="shrink-0 text-text3" />
                        </p>
                        <p className="truncate text-[12px] text-text3">{item.desc}</p>
                      </div>
                      {group.section === "Featured" ? (
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-full text-text3 hover:bg-bghover"
                          title="更多"
                          onClick={() => flash("插件详情即将推出")}
                        >
                          <MoreHorizontal size={15} />
                        </button>
                      ) : (
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-full text-text2 hover:bg-bghover"
                          title="安装"
                          onClick={() => flash("插件安装需要官方账号登录，当前版本暂不可用")}
                        >
                          <Plus size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-1.5">
              <button
                className="rounded-full bg-bghover px-3.5 py-1.5 text-[13px] font-medium text-text"
                onClick={() => setQuery("")}
              >
                系统
              </button>
            </div>

            <h2 className="mt-7 text-[15px] font-semibold text-text">已安装</h2>
            {filteredSkills.length === 0 ? (
              <div className="mt-3 flex flex-col items-center rounded-2xl border border-dashed border-border py-12">
                <Package size={26} className="text-text3" />
                <p className="mt-3 text-[13.5px] text-text2">暂无已安装技能</p>
                <p className="mt-1 text-[12px] text-text3">
                  技能来自当前环境的 skills 目录，可在「设置 → 编码 → 环境」中共享官方技能目录
                </p>
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-x-10">
                {filteredSkills.map((s) => (
                  <div key={s.name} className="flex items-center gap-3 py-3">
                    <IconBlock color="#0b84ff" letter={s.name.slice(0, 1).toUpperCase()} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-text">{s.name}</p>
                      <p className="truncate text-[12px] text-text3">{s.desc}</p>
                    </div>
                    <Check size={15} className="shrink-0 text-text3" />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {toast && <p className="mt-6 text-[12.5px] text-accent">{toast}</p>}
      </div>
    </div>
  );
}
