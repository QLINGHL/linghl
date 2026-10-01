import { TriangleAlert, X, LoaderCircle } from "lucide-react";
import { useStore } from "../store";

/**
 * 内核错误条：error 通知是内核唯一会说明"这一轮为什么没跑起来"的通道
 * （上游 403、额度用尽、网络断开…）。不展示的话用户只会看到回复凭空消失。
 */
export default function ErrorBanner() {
  const errors = useStore((s) => s.errors);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const dismissError = useStore((s) => s.dismissError);
  // 只显示与当前会话相关的错误；切到别的会话时不要串台
  const current = errors.filter((e) => !e.threadId || e.threadId === activeThreadId);
  const top = current[current.length - 1];
  if (!top) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto fade-up flex max-w-2xl items-start gap-2.5 rounded-xl border border-border bg-bgsub px-3 py-2.5 shadow-[0_10px_34px_rgba(0,0,0,0.14)]">
        {top.retrying ? (
          <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin text-text3" />
        ) : (
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-accent" />
        )}
        <p className="min-w-0 flex-1 text-[12px] leading-5 text-text2">{top.message}</p>
        <button
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text3 hover:bg-bghover hover:text-text"
          title="关闭"
          aria-label="关闭错误提示"
          onClick={() => dismissError(top.id)}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
