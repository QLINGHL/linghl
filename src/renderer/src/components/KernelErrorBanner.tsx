import { useEffect, useState } from "react";
import { TriangleAlert, Info, X, LoaderCircle, RotateCw } from "lucide-react";
import { useStore } from "../store";
import { rpc } from "../lib/api";

/**
 * 内核提示条：把「只有 stderr 才知道」的问题抬到界面上。
 *
 * 三类来源：
 *   ① 内核读不懂 config.toml（静默丢整份配置/忽略若干键）→ 引导去模型设置；
 *   ② 内核启动失败（版本/数据错配，例如官方升级后旧内核读不了新 state 库）
 *      → 说明已试过哪些版本、历史仍可浏览但发消息不可用；
 *   ③ 内核已自动切换（首选内核起不来，换了另一个版本）→ 黄色提示，不是错误。
 */
export default function KernelErrorBanner() {
  const error = useStore((s) => s.kernelError);
  const notice = useStore((s) => s.kernelNotice);
  const dismiss = useStore((s) => s.dismissKernelError);
  const setView = useStore((s) => s.setView);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!error) {
      setRetrying(false);
      setRetryMessage(null);
    }
  }, [error]);

  const message = error ?? notice;
  if (!message) return null;
  const isError = Boolean(error);
  // 「内核起不来/换内核」这类不是配置问题，别给「去模型设置」这种误导按钮
  const isKernelLifecycle = /内核无法启动|内核已自动切换|内核已退出/.test(message);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryMessage(null);
    try {
      const result = await rpc.kernelRetry();
      if (!result?.ok) {
        setRetryMessage(result?.message || "内核重试失败");
        setRetrying(false);
        return;
      }
      await useStore.getState().syncKernelIssue();
      setRetrying(false);
    } catch (e) {
      setRetryMessage(String(e).replace(/^Error:\s*/, "") || "内核重试失败");
      setRetrying(false);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-4 pt-3">
      <div
        className={`pointer-events-auto flex max-w-3xl items-start gap-2.5 rounded-xl border px-3 py-2.5 shadow-[0_10px_34px_rgba(0,0,0,0.12)] ${
          isError ? "border-[var(--c-accent)]/35 bg-[var(--c-accent-soft)]" : "border-border bg-bgsub"
        }`}
      >
        {isError ? (
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-accent" />
        ) : (
          <Info size={14} className="mt-0.5 shrink-0 text-text3" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-text">
            {isKernelLifecycle ? "内核版本兼容性" : isError ? "当前环境的内核配置没有生效" : "内核提示"}
          </p>
          <p className="mt-0.5 break-words text-[11.5px] leading-4 text-text2">{message}</p>
          {retryMessage && <p className="mt-0.5 break-words text-[11px] leading-4 text-accent">{retryMessage}</p>}
        </div>
        {isError && isKernelLifecycle && (
          <button
            className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-bg px-2.5 py-1 text-[11.5px] text-text transition-colors hover:bg-bghover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? <LoaderCircle size={12} className="animate-spin" /> : <RotateCw size={12} />}
            {retrying ? "重试中" : "重试"}
          </button>
        )}
        {isError && !isKernelLifecycle && (
          <button
            className="shrink-0 rounded-lg border border-border bg-bg px-2.5 py-1 text-[11.5px] text-text transition-colors hover:bg-bghover"
            onClick={() => setView("models")}
          >
            去模型设置
          </button>
        )}
        <button
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text3 hover:bg-bghover hover:text-text"
          title="关闭"
          aria-label="关闭内核配置提示"
          onClick={dismiss}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
