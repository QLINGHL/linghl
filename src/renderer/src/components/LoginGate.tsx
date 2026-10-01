import { useState } from "react";
import { Cloud, ExternalLink, LoaderCircle } from "lucide-react";
import { useStore } from "../store";

/**
 * 未登录状态卡：官方登录的 OAuth 授权在默认浏览器完成，这里只是「重新登录」的入口。
 * 注意它不是"选择接入方式"的屏 —— 官方 / 自定义模型 / 本地 Codex 的切换
 * 在「模型 → Codex 隔离」的环境卡片上，那里点「官方登录」还会自动发起登录。
 */
export default function LoginGate() {
  const loggedIn = useStore((s) => s.loggedIn);
  const loginStart = useStore((s) => s.loginStart);
  const envList = useStore((s) => s.envList);
  const [loginMsg, setLoginMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const activeEnv = envList?.envs.find((e) => e.id === envList.activeId);
  if (loggedIn !== false || activeEnv?.mode === "relay") return null;

  const startLogin = async () => {
    setPending(true);
    setLoginMsg(null);
    try {
      const r = await loginStart();
      setLoginMsg(
        r.ok
          ? { ok: true, text: "授权页面已在默认浏览器打开。完成授权后，回到这里会自动进入。" }
          : { ok: false, text: `登录启动失败：${r.message ?? "未知错误"}` },
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center overflow-y-auto bg-bg px-6 py-10">
      <CloudMark />
      <h1 className="mt-5 text-[20px] text-text">登录 Codex</h1>
      <p className="mt-2 max-w-[380px] text-center text-[13px] leading-5 text-text3">
        授权在默认浏览器中完成，回到应用后会自动进入。
      </p>

      <button
        className="mt-6 flex items-center justify-center gap-2 rounded-full bg-[var(--c-send)] px-6 py-2.5 text-[13.5px] font-medium text-[var(--c-send-text)] hover:opacity-90 disabled:opacity-50"
        disabled={pending}
        onClick={() => void startLogin()}
      >
        {pending ? <LoaderCircle size={15} className="animate-spin" /> : <Cloud size={15} />}
        使用 ChatGPT 账号登录
        <ExternalLink size={13} className="opacity-60" />
      </button>

      {loginMsg ? (
        <p className={`mt-4 max-w-[390px] text-center text-[12px] leading-5 ${loginMsg.ok ? "text-text2" : "text-accent"}`}>
          {loginMsg.text}
        </p>
      ) : null}

      <p className="mt-6 text-center text-[11.5px] text-text3">
        接入方式（官方 / 自定义模型）在「模型 → Codex 隔离」里切换
      </p>
    </div>
  );
}

function CloudMark() {
  return <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden><path d="M 34.00 8.38 A 9 9 0 0 1 43.98 20.90 A 9 9 0 0 1 40.42 36.50 A 9 9 0 0 1 26.00 43.44 A 9 9 0 0 1 11.58 36.50 A 9 9 0 0 1 8.02 20.90 A 9 9 0 0 1 18.00 8.38 A 9 9 0 0 1 34.00 8.38 Z" stroke="var(--gray-250, #b9b9b9)" strokeWidth="2.6" strokeLinejoin="round" /><path d="m19.5 21.5 5.2 4.3-5.2 4.3" stroke="var(--gray-250, #b9b9b9)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M28.5 30h7.5" stroke="var(--gray-250, #b9b9b9)" strokeWidth="2.6" strokeLinecap="round" /></svg>;
}
