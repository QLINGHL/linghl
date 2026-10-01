import { useState } from "react";
import { Search, Plus, SlidersHorizontal, MoreHorizontal, CalendarClock } from "lucide-react";

/** 定时任务面板：占用官方侧栏槽位（切到定时任务视图时替换 Codex 主侧栏） */
export default function ScheduledPanel() {
  const [toast, setToast] = useState("");
  const flash = (s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 3000);
  };

  return (
    <aside className="flex w-[240px] shrink-0 flex-col bg-bgsub pt-1">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <h1 className="text-[15px] font-semibold text-text">定时任务</h1>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover"
          title="搜索"
          onClick={() => flash("任务搜索即将推出")}
        >
          <Search size={14} />
        </button>
      </div>

      <div className="px-2.5">
        <button
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] text-text hover:bg-bghover"
          onClick={() => flash("定时任务创建即将推出")}
        >
          <Plus size={16} className="text-text2" />
          新建任务
        </button>
      </div>

      <div className="mt-5 flex items-center justify-between px-4">
        <span className="text-[12.5px] text-text3">即将执行</span>
        <span className="flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover"
            title="筛选"
            onClick={() => flash("筛选即将推出")}
          >
            <SlidersHorizontal size={13} />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-text3 hover:bg-bghover"
            title="更多"
            onClick={() => flash("更多操作即将推出")}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
      </div>

      {toast && <p className="px-4 pt-2 text-[11.5px] text-accent">{toast}</p>}
    </aside>
  );
}


/** 定时任务主区：即使当前没有任务也提供明确的空态，不再显示空白面板。 */
export function ScheduledMain() {
  const [toast, setToast] = useState("");
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3000);
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex h-full max-w-[760px] flex-col px-8 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[22px] font-semibold text-text">定时任务</h1>
            <p className="mt-1 text-[13px] text-text3">安排 Codex 在指定时间自动运行任务。</p>
          </div>
          <button
            className="flex items-center gap-2 rounded-full bg-[var(--c-send)] px-4 py-2 text-[13px] font-medium text-[var(--c-send-text)] hover:opacity-90"
            onClick={() => flash("定时任务创建功能即将推出")}
          >
            <Plus size={15} /> 新建任务
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border">
          <CalendarClock size={30} className="text-text3" />
          <p className="mt-3 text-[14px] text-text2">暂无定时任务</p>
          <p className="mt-1 text-[12px] text-text3">创建后，任务会显示在这里并按计划执行。</p>
          {toast && <p className="mt-4 text-[12.5px] text-accent">{toast}</p>}
        </div>
      </div>
    </div>
  );
}
