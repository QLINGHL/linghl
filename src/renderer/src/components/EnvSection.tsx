import { useState } from "react";
import { Cpu } from "lucide-react";
import { useStore } from "../store";
import { rpc } from "../lib/api";

const btn =
  "rounded-lg border border-border px-2.5 py-1 text-[12px] text-text hover:bg-bghover disabled:opacity-40 disabled:cursor-not-allowed";
const inputBase =
  "rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-text3";

function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border rounded-2xl border border-border bg-bg">{children}</div>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-[12px] mt-[36px] text-[13px] leading-[19px] text-text2 first:mt-0">{children}</p>;
}

function Row({
  title,
  desc,
  children,
}: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-4 px-[16px] py-[12px]">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-[20px] text-text">{title}</p>
        {desc && <p className="mt-0.5 text-[12px] leading-[17px] text-text3">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * 环境设置：隔离环境与官方数据导入。
 * 模型接入（官方登录 / 自定义模型 / 本地 Codex 导入）已迁移到左侧「模型」面板。
 */
export function EnvSection() {
  const envList = useStore((s) => s.envList);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const resetForEnvSwitch = useStore((s) => s.resetForEnvSwitch);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!envList) return null;
  const official = envList.official;

  const flash = (text: string, ok = true) => {
    setMsg({ ok, text });
    window.setTimeout(() => setMsg(null), 5000);
  };
  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      flash("失败：" + String(e).replace(/^Error:\s*/, ""), false);
    } finally {
      setBusy(false);
    }
  };

  const modeText = (env: (typeof envList.envs)[number]) => {
    if (env.mode !== "relay") return "官方登录";
    const r = envList.relays.find((x) => x.id === env.relayId);
    return `${r?.origin === "local" ? "本地 Codex" : "自定义模型"} · ${r?.name ?? "?"}`;
  };

  const openModels = () => {
    const s = useStore.getState();
    s.setView("models");
    s.setModelsTab("providers");
  };

  return (
    <div className="mt-6">
      <p className="text-[12.5px] leading-5 text-text3">
        每个环境都是一份独立的 Codex 数据目录：登录、会话历史与技能互不影响。
        模型的添加与切换在左侧「模型」面板进行。
      </p>

      {/* ------------------------------------------------------------- 环境列表 */}
      <SectionLabel>环境</SectionLabel>
      <Card>
        {envList.envs.map((env) => {
          const isActive = env.id === envList.activeId;
          return (
            <Row
              key={env.id}
              title={
                <span className="inline-flex items-center gap-2">
                  <span className={isActive ? "font-medium" : ""}>{env.name}</span>
                  {env.kind === "local" && (
                    <span className="shrink-0 rounded-full bg-bgsub px-2 py-0.5 text-[10.5px] leading-[16px] text-text2">
                      复用本机目录
                    </span>
                  )}
                  {isActive && (
                    <span className="shrink-0 rounded-full bg-text px-2 py-0.5 text-[10.5px] leading-[16px] text-bg">
                      使用中
                    </span>
                  )}
                </span>
              }
              desc={modeText(env)}
            >
              <div className="flex shrink-0 items-center gap-1.5">
                {!isActive && (
                  <button
                    className={btn}
                    disabled={busy}
                    onClick={() =>
                      withBusy(async () => {
                        await rpc.env.switch(env.id);
                        await resetForEnvSwitch({ keepView: true });
                        flash(`已切换到「${env.name}」`);
                      })
                    }
                  >
                    切换
                  </button>
                )}
                {env.id !== "default" && !isActive && (
                  <button
                    className={`${btn} text-accent`}
                    disabled={busy}
                    onClick={() => {
                      // 删除会递归清掉整个 codex-home（会话/登录/技能），不可恢复，必须二次确认
                      if (
                        !window.confirm(
                          `确定删除环境「${env.name}」？\n该环境的全部会话历史、登录态与技能将被永久删除，且不可恢复。`,
                        )
                      )
                        return;
                      void withBusy(async () => {
                        await rpc.env.remove(env.id);
                        await refreshEnvs();
                        flash("环境已删除");
                      });
                    }}
                  >
                    删除
                  </button>
                )}
              </div>
            </Row>
          );
        })}
        <div className="flex items-center gap-2 px-[16px] py-[12px]">
          <input
            className={`${inputBase} max-w-[240px] flex-1`}
            placeholder="新环境名称，如：论文环境"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className={`${btn} shrink-0 whitespace-nowrap`}
            disabled={busy || !newName.trim()}
            onClick={() =>
              withBusy(async () => {
                // 这里只给"快速新建"：数据目录走应用托管。
                // 要自定义目录 / 复制登录态，去「模型 → Codex 隔离」的新建弹窗。
                await rpc.env.create({ name: newName.trim() });
                setNewName("");
                await refreshEnvs();
                flash("环境已创建（独立数据目录）");
              })
            }
          >
            创建隔离环境
          </button>
        </div>
      </Card>

      {/* ------------------------------------------------------ 官方数据导入 */}
      <SectionLabel>官方数据导入（只读）</SectionLabel>
      {(() => {
        const active = envList.envs.find((e) => e.id === envList.activeId);
        if (active?.kind === "local") {
          return (
            <Card>
              <Row
                title="当前是本地 Codex 环境"
                desc="直接复用本机 ~/.codex 原目录，登录、会话本就是官方数据，无需导入。"
              />
            </Card>
          );
        }
        return (
          <Card>
        <Row
          title="从本机 Codex 导入"
          desc={
            official.exists
              ? `检测到本机官方 Codex 目录：${official.home}（${official.sessionCount} 个会话${official.hasAuth ? "，含登录态" : "，无登录态"}）`
              : "未检测到本机官方 Codex（~/.codex 不存在）"
          }
        >
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              className={btn}
              disabled={busy || !official.hasAuth || !envList.envs.length}
              onClick={() =>
                withBusy(async () => {
                  const active = envList.envs.find((e) => e.id === envList.activeId);
                  if (!active) return;
                  const r = await rpc.env.importAuth(active.id);
                  await resetForEnvSwitch({ keepView: true });
                  flash(r.backedUp ? "已导入官方登录态（原登录已备份）" : "已导入官方登录态");
                })
              }
            >
              导入登录态
            </button>
            <button
              className={btn}
              disabled={busy || official.sessionCount === 0 || !envList.envs.length}
              onClick={() =>
                withBusy(async () => {
                  const active = envList.envs.find((e) => e.id === envList.activeId);
                  if (!active) return;
                  const r = await rpc.env.importSessions(active.id);
                  // 会话可见性取决于线程索引库能否一起带过来，别只说"导入成功"
                  flash(
                    r.count === 0
                      ? "没有新的会话文件需要导入"
                      : `已复制 ${r.count} 个会话文件` +
                          (r.importedIndex ? "" : "（未复制到线程索引库，列表里可能暂时看不到）"),
                  );
                })
              }
            >
              导入会话历史
            </button>
          </div>
        </Row>
        {(() => {
          const active = envList.envs.find((e) => e.id === envList.activeId);
          if (!active) return null;
          return (
            <Row title="技能目录共享" desc="共享官方 ~/.codex/skills 目录，只读挂载，不写回官方数据">
              <label className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-text2">
                <input
                  type="checkbox"
                  checked={active.skillsShared}
                  disabled={busy || !official.hasSkills}
                  onChange={(e) =>
                    withBusy(async () => {
                      await rpc.env.skillsShare(active.id, e.target.checked);
                      await refreshEnvs();
                      flash(e.target.checked ? "技能目录已共享官方 ~/.codex/skills" : "已停用技能共享");
                    })
                  }
                />
                {active.skillsShared ? "已开启" : "已关闭"}
              </label>
            </Row>
          );
        })()}
      </Card>
        );
      })()}

      {/* ---------------------------------------------------------- 模型入口 */}
      <button
        className="mt-5 flex w-full items-center gap-3 rounded-2xl border border-border bg-bg px-[16px] py-[14px] text-left transition-colors hover:bg-bghover"
        onClick={openModels}
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-bgsub text-text2">
          <Cpu size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] text-text">添加或切换模型</span>
          <span className="mt-0.5 block text-[12px] text-text3">
            官方登录、OpenAI 兼容接口、本机 Codex 导入——在「模型」面板管理
          </span>
        </span>
        <span className="shrink-0 text-[12px] text-text3">打开 →</span>
      </button>

      {msg && (
        <p className={`mt-3 text-[12.5px] ${msg.ok ? "text-text2" : "text-accent"}`}>{msg.text}</p>
      )}
    </div>
  );
}
