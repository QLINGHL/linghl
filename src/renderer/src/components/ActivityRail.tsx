import { Clock, Cpu, HelpCircle, Shell, MoreHorizontal, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import * as Pop from "@radix-ui/react-popover";
import { useStore } from "../store";
import { rpc } from "../lib/api";
import { showShortcuts } from "../lib/ui-actions";

/** 官方 HomeFill 图标（从官方 webview 资源 HomeFill-*.js 提取的原始 path，viewBox 20×20）
 *  圆润胖房子 + 底部门形缺口，与官方侧栏完全一致（lucide House 棱角造型不对） */
function HomeFill({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M9.2393 2.48C9.73892 2.35629 10.2612 2.35626 10.7608 2.48C11.3551 2.62721 11.8835 3.0064 12.6612 3.5464L15.8614 5.76906C16.4568 6.18256 16.8699 6.46183 17.1719 6.83937C17.4266 7.15787 17.6172 7.52271 17.7334 7.91359C17.8713 8.37702 17.8653 8.87508 17.8653 9.60011V13.9995C17.8653 14.4553 17.8653 14.8377 17.8399 15.1489C17.8138 15.4677 17.7577 15.7707 17.6114 16.0581C17.3878 16.4969 17.0306 16.8541 16.5918 17.0777C16.3044 17.2241 16.0015 17.2811 15.6827 17.3071C15.3714 17.3326 14.989 17.3316 14.5332 17.3316H12.5C12.1328 17.3315 11.835 17.0338 11.835 16.6665V13.1704C11.835 12.157 11.0134 11.3346 10 11.3345C8.98662 11.3345 8.16509 12.157 8.16508 13.1704V16.6665C8.16508 17.0337 7.86725 17.3315 7.50004 17.3316H5.46684C5.01112 17.3316 4.62869 17.3326 4.31742 17.3071C3.99859 17.2811 3.69571 17.2241 3.40824 17.0777C2.96953 16.8541 2.61225 16.4968 2.38871 16.0581C2.24236 15.7707 2.18625 15.4677 2.1602 15.1489C2.13476 14.8377 2.13481 14.4553 2.13481 13.9995V9.60011C2.1348 8.87505 2.12877 8.37704 2.26664 7.91359C2.38293 7.52267 2.57345 7.1579 2.82816 6.83937C3.13019 6.46179 3.54317 6.18262 4.13871 5.76906L7.33891 3.5464C8.11655 3.00637 8.64494 2.62722 9.2393 2.48Z" />
    </svg>
  );
}

const baseButton =
  "flex h-[32px] w-[32px] items-center justify-center rounded-lg transition-colors hover:bg-bghover hover:text-text";

export default function ActivityRail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState("");
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  };

  /** 选中态两套（对齐官方）：
   *  - 首页：浅灰胶囊 + 深色实心房子
   *  - 定时任务 / 自定义：反色圆形（浅色主题=深圆白图标，深色主题自动反转） */
  const item = (target: "home" | "scheduled" | "customize" | "models", label: string, icon: ReactNode) => {
    const active = view === target;
    // 选中/未选中的文字色互斥，避免 text-text 与 text-text3 同存时被 Tailwind 顺序覆盖
    const stateCls = active
      ? target === "home"
        ? "bg-bgactive text-text"
        : "bg-text text-bg"
      : "text-text3";
    return (
      <button
        className={`${baseButton} ${stateCls}`}
        onClick={() => setView(target)}
        title={label}
        aria-label={label}
        aria-current={active ? "page" : undefined}
      >
        {icon}
      </button>
    );
  };

  return (
    <div className="relative flex w-[50px] shrink-0 flex-col items-center gap-2 bg-bgsub pt-3 pb-3">
      {toast && (
        <span className="absolute left-[54px] top-3 z-50 whitespace-nowrap rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12px] text-text2 shadow-[0_8px_28px_rgba(0,0,0,0.14)]">
          {toast}
        </span>
      )}
      {item("home", "首页", <HomeFill size={17} />)}
      {item("scheduled", "定时任务", <Clock size={17} strokeWidth={2} />)}
      {item("customize", "自定义", <Shell size={17} strokeWidth={2} />)}
      {item("models", "模型", <Cpu size={17} strokeWidth={2} />)}

      <Pop.Root open={moreOpen} onOpenChange={setMoreOpen}>
        <Pop.Trigger asChild>
          <button className={baseButton} title="更多" aria-label="更多">
            <MoreHorizontal size={17} />
          </button>
        </Pop.Trigger>
        <Pop.Portal>
          <Pop.Content
            side="right"
            align="start"
            sideOffset={8}
            className="z-50 w-52 rounded-xl border border-border bg-bg p-1.5 text-[13px] shadow-[0_10px_38px_rgba(0,0,0,0.14)]"
          >
            <button
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-bghover"
              onClick={() => {
                setView("home");
                setMoreOpen(false);
              }}
            >
              项目
            </button>
            <button
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-bghover"
              onClick={() => {
                setMoreOpen(false);
                flash("Pull Requests 视图即将推出");
              }}
            >
              Pull Request
            </button>          </Pop.Content>
        </Pop.Portal>
      </Pop.Root>

      <div className="flex-1" />

      {/* 官方活动栏底部是「帮助（?）→ 设置（齿轮）」两个，都是三级色（hover 才转正文色） */}
      <button className={`${baseButton} text-text3`} onClick={() => showShortcuts()} title="帮助" aria-label="帮助">
        <HelpCircle size={17} strokeWidth={2} />
      </button>
      <button className={`${baseButton} text-text3`} onClick={() => setView("settings")} title="设置" aria-label="设置">
        <Settings size={17} />
      </button>
    </div>
  );
}