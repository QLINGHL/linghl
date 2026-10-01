import Composer from "../components/Composer";
import { useStore } from "../store";

/** 云朵终端标识（自绘 SVG：七段圆弧鼓包 + >_ 提示符，对应官方云朵形标） */
function MarkGlyph() {
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden>
      <path
        d="M 34.00 8.38 A 9 9 0 0 1 43.98 20.90 A 9 9 0 0 1 40.42 36.50 A 9 9 0 0 1 26.00 43.44 A 9 9 0 0 1 11.58 36.50 A 9 9 0 0 1 8.02 20.90 A 9 9 0 0 1 18.00 8.38 A 9 9 0 0 1 34.00 8.38 Z"
        stroke="var(--gray-250, #b9b9b9)"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="m19.5 21.5 5.2 4.3-5.2 4.3"
        stroke="var(--gray-250, #b9b9b9)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M28.5 30h7.5"
        stroke="var(--gray-250, #b9b9b9)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function HomePage() {
  const activeProject = useStore((s) => s.activeProject);
  /** 项目列表是否已回来：没回来时别把「哪里」当成真项目名展示，用脉冲占位 */
  const projectsLoaded = useStore((s) => s.bootPhase.projects);
  const showProjectPlaceholder = !projectsLoaded && !activeProject;
  return (
    <div className="flex h-full flex-col">
      {/* 问候块：在剩余空间中垂直居中，略偏上 */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-14">
        <MarkGlyph />
        <h1 className="mt-5 text-[28px] font-normal tracking-[0.01em] text-text">
          我们应该在
          <span className="border-b border-dashed border-text3 px-0.5">
            {activeProject
              ? activeProject.name
              : showProjectPlaceholder
                ? <span className="inline-block h-[26px] w-20 animate-pulse rounded-md bg-bghover align-middle" />
                : "哪里"}
          </span>
          中做些什么？
        </h1>
      </div>
      {/* Composer：贴近底部。左右留白按官方实测 25.7px（窄窗口下输入框不贴主区边）。
          注意本工程根字号 14px，px-6 只有 21px，所以写 px 任意值。 */}
      <div className="flex w-full justify-center px-[26px] pb-5">
        <Composer variant="home" />
      </div>
    </div>
  );
}
