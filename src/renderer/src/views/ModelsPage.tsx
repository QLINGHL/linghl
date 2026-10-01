import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Pop from "@radix-ui/react-popover";
import {
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  FileCog,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import { useStore } from "../store";
import {
  rpc,
  type EnvInfo,
  type RelayInfo,
  type RelayModelEntry,
  type RelayModelsResult,
  type RelayTestResult,
  type RelayUpsertPayload,
} from "../lib/api";

/* ------------------------------------------------------------------ 公共 */

/** 密钥脱敏显示 */
function mask(key: string): string {
  if (!key) return "（未设置）";
  if (key.length <= 10) return key.slice(0, 3) + "****";
  return key.slice(0, 6) + "****" + key.slice(-4);
}

/**
 * 常见 OpenAI 兼容服务商预设：只做一次填表加速，字段仍可随意改。
 *
 * 全部预设都用 `responses`：内置内核（0.158.0-alpha.9）已经**移除**了 chat 协议支持，
 * 写 `wire_api = "chat"` 会让内核判定整份 config.toml 非法并丢弃（回落到默认 provider，
 * 自定义模型完全不生效）。详见 tools/probe-catalog.cjs 与 WRITE-UP 记录。
 */
const PRESETS: {
  key: string;
  label: string;
  name: string;
  baseUrl: string;
  model: string;
  wireApi: "responses" | "chat";
  color: string;
}[] = [
  { key: "custom", label: "自定义", name: "", baseUrl: "", model: "", wireApi: "responses", color: "#64748b" },
  { key: "openai", label: "OpenAI", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5", wireApi: "responses", color: "#10a37f" },
  { key: "deepseek", label: "DeepSeek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", wireApi: "responses", color: "#4d6bfe" },
  { key: "zhipu", label: "智谱 GLM", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6", wireApi: "responses", color: "#3859ff" },
  { key: "moonshot", label: "Moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2", wireApi: "responses", color: "#111111" },
  { key: "siliconflow", label: "硅基流动", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", wireApi: "responses", color: "#7c3aed" },
  { key: "openrouter", label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5", wireApi: "responses", color: "#f97316" },
];

/** 本版内核只认 responses；chat 会让内核丢掉整份 config.toml（静默失效） */
const WIRE_UNSUPPORTED_HINT =
  "本版内核（0.158）已移除 chat 协议：写入后内核会判定整份 config.toml 非法并丢弃，自定义模型完全不生效。需要网关侧把 /responses 转发到 /chat/completions。";

function presetColor(name: string): string {
  const hit = PRESETS.find((p) => p.name && name.toLowerCase().includes(p.name.toLowerCase()));
  if (hit) return hit.color;
  // 名称哈希取色，保证同一配置颜色稳定
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const palette = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#14b8a6", "#ec4899"];
  return palette[h % palette.length];
}

const BLANK: RelayUpsertPayload = {
  name: "",
  baseUrl: "",
  apiKey: "",
  wireApi: "responses",
  model: "gpt-6-astra",
  contextWindow: null,
  reasoningEffort: null,
};

/* ------------------------------------------------- 高级项：猜上下文 / 猜思考等级 */

/** 128000 → 128K、1000000 → 1M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * 按模型名推测上下文窗口。绝大多数 OpenAI 兼容网关的 GET /models 只回一个 id
 * （OpenRouter 这类才回 context_length），所以拿不到真实值只能猜个量级，
 * 页面上只当占位提示用，绝不自动写进去。
 */
const CONTEXT_GUESS: { re: RegExp; tokens: number }[] = [
  { re: /^(gpt-6|gpt-5|gpt-4\.1|o3|o4|codex)/i, tokens: 400_000 },
  { re: /^(gpt-4o|gpt-4|gpt-3\.5)/i, tokens: 128_000 },
  { re: /claude/i, tokens: 200_000 },
  { re: /gemini/i, tokens: 1_000_000 },
  { re: /deepseek/i, tokens: 128_000 },
  { re: /kimi|moonshot/i, tokens: 256_000 },
  { re: /qwen|qwq/i, tokens: 131_072 },
  { re: /glm-4\.6|glm-4\.5/i, tokens: 200_000 },
  { re: /glm/i, tokens: 128_000 },
  { re: /grok/i, tokens: 256_000 },
  { re: /minimax/i, tokens: 200_000 },
  { re: /llama|mistral|mixtral/i, tokens: 131_072 },
  { re: /ernie/i, tokens: 128_000 },
];

function guessContext(model: string): number | null {
  const m = (model ?? "").trim();
  if (!m) return null;
  for (const g of CONTEXT_GUESS) if (g.re.test(m)) return g.tokens;
  return null;
}

/** 只有推理模型认 reasoning_effort；普通 chat 模型硬塞这个参数可能被网关 400 */
function guessReasoning(model: string): "yes" | "maybe" | "no" {
  const m = (model ?? "").trim();
  if (!m) return "maybe";
  if (/^(o1|o3|o4|gpt-5|gpt-6)/i.test(m)) return "yes";
  if (/reasoner|thinking|-think|qwq|(^|[-_/])r1([-_/]|$)/i.test(m)) return "yes";
  if (/deepseek|glm|qwen|kimi|claude|grok|gemini/i.test(m)) return "maybe";
  return "no";
}

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

const FIELD_CLS =
  "w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-text3";
const SELECT_CLS = `${FIELD_CLS} cursor-pointer appearance-none pr-8`;

/** 圆角字母图标块（与插件目录同构） */
/**
 * 方形图标块。两种用法各有道理，都保留：
 *  - `icon`：环境卡片用它（本地 Codex = 硬盘、隔离环境 = 容器）
 *  - `letter`：模型档案列表用它（多个档案靠首字 + 不同底色区分）
 *
 * 环境卡片**不能用 letter** —— 之前「默认环境」就被渲染成一个大写的「默」字，
 * 和旁边本地 Codex 的硬盘图标风格割裂，看起来像个没做完的占位块。
 */
function IconBlock({ color, letter, icon }: { color: string; letter?: string; icon?: React.ReactNode }) {
  return (
    <div
      className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] text-white shadow-sm"
      style={{ background: color, fontSize: letter ? 15 : undefined, fontWeight: letter ? 600 : undefined }}
    >
      {icon ?? letter}
    </div>
  );
}

/** 使用中徽标 */
function ActiveChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--green-500)]/12 px-2 py-0.5 text-[11px] font-medium text-[var(--green-600)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--green-500)]" />
      使用中
    </span>
  );
}

/** 接入方式分段选择 chip */
function ModeChip({
  label,
  icon,
  selected,
  disabled,
  title,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors ${
        selected
          ? "border-[var(--c-send)] bg-[var(--c-send)]/10 font-medium text-text"
          : "border-border bg-bg text-text2 hover:bg-bghover"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {selected && <CheckCircle2 size={12} className="text-[var(--c-send)]" />}
      {!selected && icon}
      {label}
    </button>
  );
}

/* -------------------------------------------------- 添加 / 编辑模型弹窗 */

function ProviderDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing: RelayUpsertPayload | null;
  onClose: () => void;
  onSaved: (name: string, applied: boolean) => void;
}) {
  const envList = useStore((s) => s.envList);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const resetForEnvSwitch = useStore((s) => s.resetForEnvSwitch);
  const [form, setForm] = useState<RelayUpsertPayload | null>(editing);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<RelayTestResult | null>(null);
  /** 「获取模型列表」的结果：下拉里选一个就写进模型字段 */
  const [models, setModels] = useState<RelayModelEntry[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsMsg, setModelsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [advOpen, setAdvOpen] = useState(false);

  useEffect(() => {
    setForm(editing);
    // 换档案时清掉上一份档案拉到的列表与提示，否则箭头一按全是别人的模型
    setModels([]);
    setModelsMsg(null);
    setAdvOpen(Boolean(editing?.contextWindow || editing?.reasoningEffort));
  }, [editing]);
  if (!form) return null;

  /** chat 协议在本版内核上等于"配置作废"，不让存 */
  const wireUnsupported = form.wireApi === "chat";
  const canSave = Boolean(form.name.trim() && form.baseUrl.trim()) && !busy && !wireUnsupported;

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setForm({
      ...form,
      name: form.id ? form.name : p.name,
      baseUrl: p.baseUrl || form.baseUrl,
      model: p.model || form.model,
      wireApi: p.wireApi,
      // 换了模型就作废上一个模型推出来的高级项
      contextWindow: null,
    });
    setTestResult(null);
    setModelsMsg(null);
  };

  /** 拉模型列表：走 GET {接口地址}/models，顺带把服务端自报的上下文窗口带回来 */
  const fetchModels = async () => {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      setModelsMsg({ ok: false, text: "先填接口地址" });
      return;
    }
    setFetchingModels(true);
    setModelsMsg(null);
    try {
      const r: RelayModelsResult = await rpc.env.relayModels({
        baseUrl,
        apiKey: form.apiKey?.trim() ?? "",
        relayId: form.id,
      });
      setModels(r.models);
      if (!r.ok) {
        setModelsMsg({
          ok: false,
          text: `拉取失败：${r.message ?? "未知错误"}${r.parsed ? "（仍可从返回内容里选）" : "，可以手动填模型名"}`,
        });
      } else if (r.models.length === 0) {
        setModelsMsg({ ok: false, text: "接口通了，但没返回模型列表，手动填模型名即可" });
      } else {
        const withCtx = r.models.filter((m) => m.contextWindow).length;
        setModelsMsg({
          ok: true,
          text: `拿到 ${r.models.length} 个模型${withCtx ? `，其中 ${withCtx} 个带上下文窗口信息` : ""}，点右侧箭头选择`,
        });
      }
    } catch (e) {
      setModelsMsg({ ok: false, text: `拉取失败：${String(e).replace(/^Error:\s*/, "")}` });
    } finally {
      setFetchingModels(false);
    }
  };

  /** 选中某个模型：服务端报过窗口大小就直接填进高级项 */
  const pickModel = (m: RelayModelEntry) => {
    setForm({ ...form, model: m.id, contextWindow: m.contextWindow ?? form.contextWindow ?? null });
  };

  const ctxGuess = guessContext(form.model ?? "");
  const reasoningOdds = guessReasoning(form.model ?? "");

  const runTest = async () => {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      setTestResult({ ok: false, message: "先填接口地址" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await rpc.env.relayTest({ baseUrl, apiKey: form.apiKey?.trim() ?? "", relayId: form.id });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, message: String(e).replace(/^Error:\s*/, "") });
    } finally {
      setTesting(false);
    }
  };

  const save = async (apply: boolean) => {
    setBusy(true);
    try {
      const payload: RelayUpsertPayload = {
        ...form,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
        model: (form.model ?? "").trim() || "gpt-6-astra",
      };
      const relay = await rpc.env.relayUpsert(payload);
      await refreshEnvs();
      if (apply && envList) {
        await rpc.env.setMode(envList.activeId, "relay", relay.id);
        await resetForEnvSwitch({ keepView: true });
      }
      onSaved(relay.name, apply);
      onClose();
    } catch (e) {
      setTestResult({ ok: false, message: String(e).replace(/^Error:\s*/, "") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[540px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg p-6 shadow-[0_24px_64px_rgba(0,0,0,0.22)] focus:outline-none">
        <div className="flex items-start justify-between">
          <div>
            <Dialog.Title className="text-[16px] font-semibold text-text">
              {form.id ? "编辑模型" : "添加模型"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12.5px] leading-5 text-text3">
              接入任意 OpenAI 兼容接口。接入后会像 CC Switch 一样把 model_provider、base_url 写进当前环境的
              config.toml，Codex 即路由到该模型。
            </Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full text-text3 hover:bg-bghover"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </Dialog.Close>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {/* 预设 */}
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-text2">常用服务预设</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 text-[12px] text-text2 transition-colors hover:bg-bghover"
                  onClick={() => applyPreset(p.key)}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 名称 + 协议（协议从分段按钮改成下拉列表） */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-text2">名称</span>
              <input
                className={FIELD_CLS}
                placeholder="如：DeepSeek 日常"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-text2">协议</span>
              <div className="relative">
                <select
                  className={SELECT_CLS}
                  value={form.wireApi === "chat" ? "chat" : "responses"}
                  onChange={(e) => setForm({ ...form, wireApi: e.target.value === "chat" ? "chat" : "responses" })}
                >
                  <option style={{ background: "var(--c-bg)", color: "var(--c-text)" }} value="responses">
                    responses · 本版内核唯一支持
                  </option>
                  <option style={{ background: "var(--c-bg)", color: "var(--c-text)" }} value="chat">
                    chat · 已废弃（会被内核丢弃）
                  </option>
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text3"
                />
              </div>
            </label>
          </div>

          {wireUnsupported && (
            <div className="flex items-start gap-2 rounded-xl border border-[var(--c-accent)]/35 bg-[var(--c-accent-soft)] px-3 py-2">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-accent" />
              <p className="text-[11.5px] leading-4 text-text2">{WIRE_UNSUPPORTED_HINT}</p>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-medium text-text2">接口地址（Base URL）</span>
            <input
              className={FIELD_CLS}
              placeholder="https://example.com/v1"
              value={form.baseUrl}
              onChange={(e) => {
                setForm({ ...form, baseUrl: e.target.value });
                setTestResult(null);
                // 地址换了，之前那份模型列表就不作数了
                setModels([]);
                setModelsMsg(null);
              }}
            />
            <span className="mt-1 block text-[11px] leading-4 text-text3">
              OpenAI 兼容地址，通常以 /v1 结尾；下面「获取模型列表」会请求 {"{地址}"}/models
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-medium text-text2">API Key</span>
            <input
              className={FIELD_CLS}
              type="password"
              placeholder={form.id ? "（保持不变）" : "sk-…"}
              value={form.apiKey ?? ""}
              onChange={(e) => {
                setForm({ ...form, apiKey: e.target.value });
                setTestResult(null);
              }}
            />
            {form.id && (
              <span className="mt-1 block text-[11px] leading-4 text-text3">留空表示保持原来的密钥不变</span>
            )}
          </label>

          {/* 模型：可手填，也可拉列表下拉选 */}
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-text2">模型</span>
              <button
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-text3 transition-colors hover:bg-bghover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
                disabled={fetchingModels || !form.baseUrl.trim()}
                title={form.baseUrl.trim() ? "GET {接口地址}/models" : "先填接口地址"}
                onClick={() => void fetchModels()}
              >
                {fetchingModels ? <LoaderCircle size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                获取模型列表
              </button>
            </div>

            <div className="flex items-stretch rounded-lg border border-border bg-bg focus-within:border-text3">
              <input
                className="min-w-0 flex-1 rounded-lg bg-transparent px-2.5 py-1.5 text-[13px] text-text outline-none"
                placeholder="如：deepseek-chat；拿到列表后点右侧箭头选"
                value={form.model ?? ""}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild disabled={models.length === 0}>
                  <button
                    className="flex w-8 shrink-0 items-center justify-center rounded-r-lg text-text3 transition-colors hover:bg-bghover disabled:opacity-35 disabled:hover:bg-transparent"
                    title={models.length ? `从 ${models.length} 个模型中选择` : "先点「获取模型列表」"}
                    aria-label="选择模型"
                  >
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-[60] max-h-[260px] w-[340px] overflow-y-auto rounded-xl border border-border bg-bg p-1 shadow-[0_12px_32px_rgba(0,0,0,0.18)]"
                  >
                    {models.map((m) => (
                      <DropdownMenu.Item
                        key={m.id}
                        onSelect={() => pickModel(m)}
                        className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[12.5px] text-text outline-none data-[highlighted]:bg-bghover"
                      >
                        <span className="min-w-0 truncate">{m.id}</span>
                        {m.contextWindow ? (
                          <span className="shrink-0 font-mono text-[10.5px] text-text3">{fmtTokens(m.contextWindow)}</span>
                        ) : null}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>

            {modelsMsg ? (
              <span className={`mt-1 block text-[11px] leading-4 ${modelsMsg.ok ? "text-text3" : "text-accent"}`}>
                {modelsMsg.text}
              </span>
            ) : (
              <span className="mt-1 block text-[11px] leading-4 text-text3">
                点「获取模型列表」从服务端拉可选模型，也可以直接手填任意模型名
              </span>
            )}
          </div>

          {/* 高级设置（可选）：留空即自动，不写入 config.toml */}
          <div className="rounded-xl border border-border">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-text2 transition-colors hover:text-text"
              onClick={() => setAdvOpen((v) => !v)}
            >
              <ChevronRight size={13} className={`shrink-0 transition-transform ${advOpen ? "rotate-90" : ""}`} />
              <SlidersHorizontal size={13} className="shrink-0" />
              高级设置（可选）
              <span className="ml-auto shrink-0 text-[11px] text-text3">
                上下文 {form.contextWindow ? fmtTokens(Number(form.contextWindow)) : "自动"} · 思考{" "}
                {form.reasoningEffort || "自动"}
              </span>
            </button>

            {advOpen && (
              <div className="border-t border-border px-3 py-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-[12.5px] font-medium text-text2">最大上下文（tokens）</span>
                    <input
                      className={FIELD_CLS}
                      inputMode="numeric"
                      placeholder={ctxGuess ? `留空自动 · 按名字约 ${fmtTokens(ctxGuess)}` : "留空自动"}
                      value={form.contextWindow ?? ""}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/[^\d]/g, "");
                        setForm({ ...form, contextWindow: digits ? Number(digits) : null });
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[12.5px] font-medium text-text2">思考等级</span>
                    <div className="relative">
                      <select
                        className={SELECT_CLS}
                        value={form.reasoningEffort ?? ""}
                        onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value || null })}
                      >
                        <option style={{ background: "var(--c-bg)", color: "var(--c-text)" }} value="">
                          自动（不写入）
                        </option>
                        {EFFORT_OPTIONS.map((lv) => (
                          <option key={lv} style={{ background: "var(--c-bg)", color: "var(--c-text)" }} value={lv}>
                            {lv}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={14}
                        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text3"
                      />
                    </div>
                  </label>
                </div>

                <p className="mt-2 text-[11px] leading-4 text-text3">
                  内核只认得它自带的模型目录，第三方模型名在它眼里是「未知模型」、走的是兜底元数据，
                  上下文窗口就不是真的，会直接影响它什么时候开始压缩历史。填了就写进 config.toml 的
                  <code className="mx-1 rounded bg-bgsub px-1 font-mono text-[10.5px]">model_context_window</code>
                  和
                  <code className="mx-1 rounded bg-bgsub px-1 font-mono text-[10.5px]">model_reasoning_effort</code>
                  ，留空则一个字节都不写。
                </p>
                {ctxGuess && !form.contextWindow ? (
                  <button
                    className="mt-1.5 rounded-md border border-border px-2 py-0.5 text-[11px] text-text2 transition-colors hover:bg-bghover hover:text-text"
                    onClick={() => setForm({ ...form, contextWindow: ctxGuess })}
                  >
                    按名字取 {fmtTokens(ctxGuess)} 填进去
                  </button>
                ) : null}
                <p className={`mt-1.5 text-[11px] leading-4 ${reasoningOdds === "no" ? "text-accent" : "text-text3"}`}>
                  {reasoningOdds === "yes"
                    ? "这个模型名看着是推理模型，可以放心选思考等级。"
                    : reasoningOdds === "maybe"
                      ? "不确定它认不认思考等级：多数第三方 chat 接口收到不认识的 reasoning_effort 会直接 400，拿不准就留「自动」。"
                      : "这个模型名看着不是推理模型，选思考等级很可能被网关拒（400），建议留「自动」。"}
                </p>
              </div>
            )}
          </div>

          {/* 测试连接 */}
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-text hover:bg-bghover disabled:opacity-40"
              disabled={testing || !form.baseUrl.trim()}
              onClick={() => void runTest()}
            >
              {testing ? <LoaderCircle size={13} className="animate-spin" /> : <PlugZap size={13} />}
              测试连接
            </button>
            {testResult && (
              <span
                className={`flex items-center gap-1 text-[12px] ${
                  testResult.ok ? "text-[var(--green-600)]" : "text-accent"
                }`}
              >
                {testResult.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {testResult.ok
                  ? `连通（HTTP ${testResult.status}${testResult.models != null ? ` · ${testResult.models} 个模型` : ""}）`
                  : `不通：${testResult.message ?? "未知错误"}`}
              </span>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Dialog.Close asChild>
            <button className="rounded-lg border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover">
              取消
            </button>
          </Dialog.Close>
          <button
            className="rounded-lg border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover disabled:opacity-40"
            disabled={!canSave}
            onClick={() => void save(false)}
          >
            仅保存
          </button>
          <button
            className="rounded-lg bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90 disabled:opacity-40"
            disabled={!canSave}
            onClick={() => void save(true)}
          >
            {form.id ? "保存并接入" : "添加并接入"}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/* ------------------------------------------------- 新建环境弹窗（Codex 隔离） */

function NewEnvDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  /** 留空 = 用应用托管目录；填了就把它当这个环境的数据目录（adopt 已有目录也走这里） */
  const [customHome, setCustomHome] = useState("");
  const [importAuth, setImportAuth] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async () => {
    try {
      const p = await rpc.env.pickFolder();
      if (p) setCustomHome(p);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await rpc.env.create({
        name: name.trim(),
        codexHome: customHome.trim() || undefined,
        importAuthFromLocal: importAuth,
      });
      await useStore.getState().refreshEnvs();
      onCreated(name.trim());
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg p-6 shadow-[0_24px_64px_rgba(0,0,0,0.22)] focus:outline-none">
        <Dialog.Title className="text-[16px] font-semibold text-text">新建隔离环境</Dialog.Title>
        <Dialog.Description className="mt-1 text-[12.5px] leading-5 text-text3">
          每个环境都是一份独立的 Codex 数据目录（相当于一个 CODEX_HOME）：登录、会话历史、记忆与技能互不影响。
        </Dialog.Description>

        <div className="mt-5 flex flex-col gap-4">
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-medium text-text2">名称</span>
            <input
              autoFocus
              className={FIELD_CLS}
              placeholder="环境名称，如：论文环境"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !busy) void create();
              }}
            />
          </label>

          <div>
            <span className="mb-1 block text-[12.5px] font-medium text-text2">数据目录（Codex Home）</span>
            <div className="flex items-stretch gap-2">
              <input
                className={`${FIELD_CLS} flex-1 font-mono text-[12px]`}
                placeholder="留空 = 应用托管目录（推荐）"
                value={customHome}
                onChange={(e) => setCustomHome(e.target.value)}
              />
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] text-text transition-colors hover:bg-bghover"
                onClick={() => void pick()}
              >
                <FolderOpen size={13} />
                选择文件夹
              </button>
              {customHome && (
                <button
                  className="shrink-0 rounded-lg border border-border px-2.5 text-[12px] text-text3 transition-colors hover:bg-bghover hover:text-text"
                  title="改回应用托管目录"
                  onClick={() => setCustomHome("")}
                >
                  清除
                </button>
              )}
            </div>
            <span className="mt-1 block text-[11px] leading-4 text-text3">
              {customHome
                ? "将直接使用该目录作为这个环境的数据目录；目录已有内容会原样沿用，删除环境时只解除登记、不会删除该目录里的任何文件。"
                : "留空时数据放在应用的托管目录下（%APPDATA%\\codex-desk-replica\\envs\\<环境 ID>\\codex-home），删除环境会一并清理。"}
            </span>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={importAuth}
              onChange={(e) => setImportAuth(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-[12.5px] text-text">复制本机 Codex 的登录态</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-text3">
                从 ~/.codex/auth.json 复制一份到这个环境，省掉重新登录；只读复制，不会改动本机原文件。
              </span>
            </span>
          </label>

          {error && <p className="text-[12px] text-accent">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close asChild>
            <button className="rounded-lg border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover">
              取消
            </button>
          </Dialog.Close>
          <button
            className="rounded-lg bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90 disabled:opacity-40"
            disabled={!name.trim() || busy}
            onClick={() => void create()}
          >
            创建
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/* ----------------------------------------------------------- 环境配置文件编辑 */

const ENV_FILES = ["config.toml", "AGENTS.md"] as const;

/**
 * 直接编辑某个环境的配置文件（白名单：config.toml / AGENTS.md）。
 * 保存前主进程会先备份成 .bak-manual-edit，保存后会自动重启内核让新配置生效。
 */
function EnvFileDialog({
  env,
  onClose,
  onSaved,
}: {
  env: EnvInfo;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [file, setFile] = useState<(typeof ENV_FILES)[number]>("config.toml");
  const [text, setText] = useState("");
  const [path, setPath] = useState("");
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const r = await rpc.env.readFile(env.id, file);
        if (!alive) return;
        setText(r.text);
        setPath(r.path);
        setExists(r.exists);
      } catch (e) {
        if (alive) setError(String(e).replace(/^Error:\s*/, ""));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [env.id, file]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await rpc.env.writeFile(env.id, file, text);
      setExists(true);
      onSaved(
        r.backedUp
          ? `已保存 ${file}（原文件备份为 ${file}.bak-manual-edit）`
          : `已创建 ${file}`,
      );
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const relayWarning = file === "config.toml" && env.mode === "relay";

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-80px)] w-[680px] max-w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-bg p-6 shadow-[0_24px_64px_rgba(0,0,0,0.22)] focus:outline-none">
        <div className="flex items-start justify-between">
          <div>
            <Dialog.Title className="text-[16px] font-semibold text-text">配置文件 · {env.name}</Dialog.Title>
            <Dialog.Description className="mt-1 font-mono text-[11px] leading-4 text-text3">
              {path || env.codexHome}
            </Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full text-text3 hover:bg-bghover"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </Dialog.Close>
        </div>

        <div className="mt-3 flex items-center gap-1.5">
          {ENV_FILES.map((f) => (
            <button
              key={f}
              className={`rounded-full border px-2.5 py-1 font-mono text-[11.5px] transition-colors ${
                f === file
                  ? "border-[var(--c-send)] bg-[var(--c-send)]/10 text-text"
                  : "border-border text-text2 hover:bg-bghover"
              }`}
              onClick={() => setFile(f)}
            >
              {f}
            </button>
          ))}
          <span className="ml-1 text-[11px] text-text3">
            {exists ? "已存在" : "文件尚不存在，保存后会新建"}
          </span>
        </div>

        {relayWarning && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-[var(--c-accent)]/35 bg-[var(--c-accent-soft)] px-3 py-2">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-[11.5px] leading-4 text-text2">
              这个环境当前接入的是自定义模型，本应用在切换 / 编辑模型时会
              <span className="font-medium text-text">重新生成</span>
              这份 config.toml，手改的内容会被覆盖。如果只是想调模型，去「模型」里改档案更稳妥。
            </p>
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1">
          {loading ? (
            <div className="flex h-[320px] items-center justify-center text-[12.5px] text-text3">
              <LoaderCircle size={14} className="mr-2 animate-spin" />
              读取中…
            </div>
          ) : (
            <textarea
              className="h-[320px] w-full resize-none rounded-xl border border-border bg-bg p-3 font-mono text-[12px] leading-5 text-text outline-none focus:border-text3"
              spellCheck={false}
              value={text}
              placeholder={file === "AGENTS.md" ? "# 给这个环境里的 Codex 的项目/全局指令" : ""}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </div>

        {error && <p className="mt-2 text-[12px] text-accent">{error}</p>}

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[11px] leading-4 text-text3">
            保存时会先留一份 {file}.bak-manual-edit；使用中的环境保存后会自动重启内核。
          </span>
          <div className="flex shrink-0 gap-2">
            <Dialog.Close asChild>
              <button className="rounded-lg border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover">
                取消
              </button>
            </Dialog.Close>
            <button
              className="rounded-lg bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90 disabled:opacity-40"
              disabled={loading || busy}
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/* ------------------------------------------------------------- 左栏面板 */

/** 模型面板：占用官方侧栏槽位（与 Customize 同构）。
 *  以前这里还有一张「当前接入」小卡片 —— 接入状态现在在 Codex 隔离的环境卡片上就有，
 *  侧栏再放一份纯属冗余，已删。 */
export function ModelsPanel() {
  const tab = useStore((s) => s.modelsTab);
  const setTab = useStore((s) => s.setModelsTab);

  return (
    <aside className="flex w-[240px] shrink-0 flex-col bg-bgsub pt-1">
      <div className="px-4 pb-2 pt-3">
        <h1 className="text-[15px] font-semibold text-text">模型</h1>
      </div>

      <nav className="flex flex-col gap-0.5 px-2.5">
        <button
          onClick={() => setTab("providers")}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] ${
            tab === "providers" ? "bg-bghover font-medium text-text" : "text-text2 hover:bg-bghover"
          }`}
        >
          <Cpu size={16} className={tab === "providers" ? "text-text" : "text-text3"} />
          模型
        </button>
        <button
          onClick={() => setTab("envs")}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] ${
            tab === "envs" ? "bg-bghover font-medium text-text" : "text-text2 hover:bg-bghover"
          }`}
        >
          <Boxes size={16} className={tab === "envs" ? "text-text" : "text-text3"} />
          Codex 隔离
        </button>
      </nav>
    </aside>
  );
}

/* --------------------------------------------------------------- 主区 */

export function ModelsMain() {
  const tab = useStore((s) => s.modelsTab);
  const setTab = useStore((s) => s.setModelsTab);
  const envList = useStore((s) => s.envList);
  const refreshEnvs = useStore((s) => s.refreshEnvs);
  const resetForEnvSwitch = useStore((s) => s.resetForEnvSwitch);
  const loginStart = useStore((s) => s.loginStart);
  const modelsIntent = useStore((s) => s.modelsIntent);
  const setModelsIntent = useStore((s) => s.setModelsIntent);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RelayUpsertPayload | null>(null);
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  /** 正在编辑配置文件的环境（config.toml / AGENTS.md） */
  const [fileEnv, setFileEnv] = useState<EnvInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const flash = (text: string, ok = true) => {
    setToast({ ok, text });
    window.setTimeout(() => setToast(null), 5000);
  };

  // 登录门「使用自定义模型」跳转：直接打开添加弹窗
  useEffect(() => {
    if (modelsIntent !== "new-provider") return;
    setEditing({ ...BLANK });
    setDialogOpen(true);
    setModelsIntent(null);
  }, [modelsIntent, setModelsIntent]);

  const active = envList?.envs.find((e) => e.id === envList.activeId);
  const activeRelay = envList?.relays.find((r) => r.id === active?.relayId);
  const manualRelays = useMemo(() => envList?.relays.filter((r) => r.origin !== "local") ?? [], [envList]);
  const localRelays = useMemo(() => envList?.relays.filter((r) => r.origin === "local") ?? [], [envList]);
  const official = envList?.official;
  /** 本机 ~/.codex 是否已登记为环境 */
  const hasLocalEnv = (envList?.envs ?? []).some((e) => e.kind === "local");

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

  /** 把当前环境切到某个模型配置（CC Switch 式：写 config.toml 路由） */
  const applyRelay = (relayId: string, label: string) =>
    withBusy(async () => {
      if (!envList || !active) return;
      await rpc.env.setMode(active.id, "relay", relayId);
      await resetForEnvSwitch({ keepView: true });
      flash(`已接入「${label}」— 模型在首页输入框右下角也能随时切换`);
    });

  /**
   * 切回官方登录：留在本页，**当场发起 ChatGPT OAuth** —— 授权页直接在默认浏览器打开，
   * 不需要再跳到首页多点一次。授权完成后 account/login/completed 通知会自动带回首页。
   */
  const applyChatgpt = () =>
    withBusy(async () => {
      if (!envList || !active) return;
      await rpc.env.setMode(active.id, "chatgpt");
      await resetForEnvSwitch({ keepView: true });
      const r = await loginStart();
      flash(
        r.ok
          ? "授权页面已在浏览器打开 — 完成授权后会自动进入 Codex"
          : `已切换为官方登录，但打开授权页失败：${r.message ?? "未知原因"}（也可以回首页手动登录）`,
      );
    });

  /** 登记本地 Codex 环境：原地复用 ~/.codex，零拷贝零导入 */
  const addLocalEnv = () =>
    withBusy(async () => {
      const env = await rpc.env.addLocal();
      await refreshEnvs();
      flash(`已添加「${env.name}」— 直接复用 ${env.codexHome}，未复制任何文件`);
    });

  /** 老档案写着已被内核移除的 chat 协议：一键改回 responses（其它字段原样保留） */
  const fixWireApi = (r: RelayInfo) =>
    withBusy(async () => {
      await rpc.env.relayUpsert({
        id: r.id,
        name: r.name,
        baseUrl: r.baseUrl,
        apiKey: "",
        wireApi: "responses",
        model: r.model,
        contextWindow: r.contextWindow ?? null,
        reasoningEffort: r.reasoningEffort ?? null,
        managedAuth: r.managedAuth,
        experimentalBearerToken: r.experimentalBearerToken,
      });
      await refreshEnvs();
      flash(`已把「${r.name}」的协议改为 responses（chat 已不被本版内核支持）`);
    });

  const deleteRelay = (id: string, name: string) =>
    withBusy(async () => {
      await rpc.env.relayDelete(id);
      await refreshEnvs();
      flash(`已删除「${name}」`);
    });

  const switchEnv = (id: string, name: string) =>
    withBusy(async () => {
      await rpc.env.switch(id);
      await resetForEnvSwitch({ keepView: true });
      flash(`已切换到「${name}」`);
    });

  const removeEnv = (env: EnvInfo) => {
    // 只有落在应用托管目录里的环境才会被整目录删除；自定义目录与本地 Codex 都只解除登记
    const keepsFiles = env.kind === "local" || env.managed === false;
    const msg = keepsFiles
      ? `从列表移除「${env.name}」？\n只解除登记，磁盘上的数据（${env.codexHome}）不会被删除。`
      : `确定删除环境「${env.name}」？\n该环境的全部会话历史、登录态与技能将被永久删除，且不可恢复。`;
    if (!window.confirm(msg)) return;
    void withBusy(async () => {
      await rpc.env.remove(env.id);
      await refreshEnvs();
      flash(keepsFiles ? "已从列表移除（磁盘上的文件未动）" : "环境已删除");
    });
  };

  /** 在文件管理器里打开数据目录 */
  const openEnvDir = (env: EnvInfo) =>
    withBusy(async () => {
      await rpc.env.openDir(env.id);
    });

  const modeText = (env: { mode: string; relayId: string | null }) => {
    if (env.mode !== "relay") return "官方登录";
    const r = envList?.relays.find((x) => x.id === env.relayId);
    // 只说接入方式，不报模型名 —— 具体用哪个模型在首页输入框右下角看/换
    return r?.origin === "local" ? "本地 Codex" : "自定义模型";
  };

  /* ------------------------------------------------------------ 渲染 */

  const cardCls = (selected: boolean) =>
    `group rounded-2xl border transition-all ${
      selected
        ? "border-[var(--c-send)]/55 bg-[var(--c-send)]/[0.04] shadow-[0_0_0_1px_var(--c-send)]/20"
        : "border-border bg-bg hover:border-text3/60 hover:shadow-[0_2px_12px_rgba(0,0,0,0.05)]"
    }`;

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto max-w-[760px] px-8 py-8">
        {/* -------------------------------------------------------- 模型 tab */}
        {tab === "providers" ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-[22px] font-semibold text-text">模型</h1>
                <p className="mt-1 text-[13px] leading-5 text-text3">
                  自己配置的模型库：在这里添加、编辑、删除 OpenAI 兼容接口。
                  <br />
                  环境接上模型后，在首页输入框右下角点模型名即可切换 —— 各环境互不影响。
                </p>
              </div>
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--c-send)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90"
                onClick={() => {
                  setEditing({ ...BLANK });
                  setDialogOpen(true);
                }}
              >
                <Plus size={14} />
                添加模型
              </button>
            </div>

            {/* 模型配置列表 */}
            <div className="mt-4 flex flex-col gap-2.5">
              {[...manualRelays, ...localRelays].map((r) => {
                const isLocal = r.origin === "local";
                // 「模型」tab 只是配置库：不再反映"哪个在用"（那是 Codex 隔离页的事，
                // 之前这里既有「使用中」徽标又有「接入」按钮，用户明确要求撤掉）
                return (
                  <div key={r.id} className={`${cardCls(false)} flex items-center gap-3.5 p-4`}>
                    <IconBlock
                      color={isLocal ? "#475569" : presetColor(r.name)}
                      letter={isLocal ? "" : r.name.slice(0, 1).toUpperCase()}
                      icon={isLocal ? <HardDrive size={15} /> : undefined}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13.5px] font-medium text-text">
                        <span className="truncate">{r.name}</span>
                        {isLocal && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bgsub px-2 py-0.5 text-[10.5px] text-text2">
                            <HardDrive size={9.5} />
                            本机 Codex
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-text3">
                        <span
                          className={`rounded-md px-1.5 py-px font-mono text-[10.5px] ${
                            r.wireApi === "chat"
                              ? "bg-[var(--c-accent-soft)] text-accent"
                              : "bg-bgsub text-text2"
                          }`}
                        >
                          {r.wireApi === "chat" ? "chat（已废弃）" : "responses"}
                        </span>
                        <span className="truncate">{r.model}</span>
                        {r.contextWindow ? (
                          <span className="shrink-0 rounded-md bg-bgsub px-1.5 py-px font-mono text-[10.5px] text-text2">
                            {fmtTokens(Number(r.contextWindow))}
                          </span>
                        ) : null}
                        {r.reasoningEffort ? (
                          <span className="shrink-0 rounded-md bg-bgsub px-1.5 py-px font-mono text-[10.5px] text-text2">
                            {r.reasoningEffort}
                          </span>
                        ) : null}
                        <span className="text-text3/60">·</span>
                        <span className="truncate">{mask(r.apiKey)}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-text3/80">{r.baseUrl}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {r.wireApi === "chat" && (
                        <button
                          className="flex items-center gap-1 rounded-full border border-[var(--c-accent)]/40 px-2.5 py-1 text-[12px] text-accent transition-colors hover:bg-[var(--c-accent-soft)]"
                          disabled={busy}
                          title={WIRE_UNSUPPORTED_HINT}
                          onClick={() => void fixWireApi(r)}
                        >
                          <TriangleAlert size={11} />
                          改为 responses
                        </button>
                      )}
                      {!isLocal && (
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-full text-text3 opacity-0 transition-opacity hover:bg-bghover hover:text-text group-hover:opacity-100"
                          title="编辑"
                          onClick={() => {
                            setEditing({
                              id: r.id,
                              name: r.name,
                              baseUrl: r.baseUrl,
                              apiKey: "",
                              wireApi: r.wireApi,
                              model: r.model,
                              contextWindow: r.contextWindow ?? null,
                              reasoningEffort: r.reasoningEffort ?? null,
                            });
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      <button
                        className="flex h-7 w-7 items-center justify-center rounded-full text-text3 opacity-0 transition-opacity hover:bg-bghover hover:text-accent group-hover:opacity-100"
                        title="删除"
                        disabled={busy}
                        onClick={() => void deleteRelay(r.id, r.name)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* 空状态 */}
              {manualRelays.length === 0 && localRelays.length === 0 && (
                <button
                  className="flex flex-col items-center rounded-2xl border border-dashed border-border py-10 transition-colors hover:bg-bghover/40"
                  onClick={() => {
                    setEditing({ ...BLANK });
                    setDialogOpen(true);
                  }}
                >
                  <Plus size={22} className="text-text3" />
                  <p className="mt-2 text-[13px] font-medium text-text2">添加你的第一个模型</p>
                  <p className="mt-1 text-[12px] text-text3">填入 OpenAI 兼容接口地址与 API Key，接入后写入环境配置即刻生效</p>
                </button>
              )}
            </div>

            <p className="mt-4 text-[11.5px] text-text3">
              某个环境用哪个模型、官方登录 / 本地 Codex，都在「Codex 隔离」的环境卡片上选择与切换；本页只管理模型配置本身。
            </p>
          </>
        ) : (
          /* --------------------------------------------------- Codex 隔离 tab */
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-[22px] font-semibold text-text">Codex 隔离</h1>
                <p className="mt-1 text-[13px] leading-5 text-text3">
                  「本地 Codex」直接复用本机 ~/.codex 原目录（登录、会话、配置零拷贝）；
                  <br />
                  「隔离环境」使用独立数据目录，与本地完全隔离。接入方式：官方登录 / 自己配置的模型。
                </p>
              </div>
              <button
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--c-send)] px-4 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90"
                onClick={() => setNewEnvOpen(true)}
              >
                <Plus size={14} />
                新建隔离环境
              </button>
            </div>

            <div className="mt-6 flex flex-col gap-2.5">
              {(envList?.envs ?? []).map((env) => {
                const isActive = env.id === envList?.activeId;
                const isLocal = env.kind === "local";
                const envRelay = envList?.relays.find((x) => x.id === env.relayId);
                const envKind: "chatgpt" | "manual" | "local" =
                  env.mode === "relay" ? (envRelay?.origin === "local" ? "local" : "manual") : "chatgpt";
                return (
                  <div key={env.id} className={`${cardCls(isActive)} p-4`}>
                    <div className="flex items-center gap-3.5">
                      <IconBlock
                        color={isLocal ? "#475569" : isActive ? "linear-gradient(135deg,#0b84ff,#6c5cff)" : "#8494a8"}
                        icon={isLocal ? <HardDrive size={15} /> : <Boxes size={15} />}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-[13.5px] font-medium text-text">
                          <span className="truncate">{env.name}</span>
                          {isLocal && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bgsub px-2 py-0.5 text-[10.5px] text-text2">
                              <HardDrive size={9.5} />
                              复用本机目录
                            </span>
                          )}
                          {!isLocal && env.managed === false && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bgsub px-2 py-0.5 text-[10.5px] text-text2">
                              <FolderOpen size={9.5} />
                              自定义目录
                            </span>
                          )}
                          {/* 应用托管的隔离环境以前完全没有标签，和本地 Codex 那张卡
                              的信息密度差一截，看起来像"缺了点什么" */}
                          {!isLocal && env.managed !== false && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bgsub px-2 py-0.5 text-[10.5px] text-text2">
                              <Boxes size={9.5} />
                              独立数据目录
                            </span>
                          )}
                          {isActive && <ActiveChip />}
                        </p>
                        <p className="mt-0.5 truncate text-[12px] text-text3">{modeText(env)}</p>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-text3/80">{env.codexHome}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-full text-text3 transition-colors hover:bg-bghover hover:text-text"
                          title="在文件管理器里打开数据目录"
                          onClick={() => void openEnvDir(env)}
                        >
                          <FolderOpen size={13} />
                        </button>
                        <button
                          className="flex h-7 w-7 items-center justify-center rounded-full text-text3 transition-colors hover:bg-bghover hover:text-text"
                          title="编辑配置文件（config.toml / AGENTS.md）"
                          onClick={() => setFileEnv(env)}
                        >
                          <FileCog size={13} />
                        </button>
                        {!isActive && (
                          <button
                            className="rounded-full border border-border px-3 py-1 text-[12px] text-text opacity-0 transition-opacity hover:bg-bghover group-hover:opacity-100"
                            disabled={busy}
                            onClick={() => void switchEnv(env.id, env.name)}
                          >
                            切换
                          </button>
                        )}
                        {!isActive && (
                          <button
                            className="flex h-7 w-7 items-center justify-center rounded-full text-text3 opacity-0 transition-opacity hover:bg-bghover hover:text-accent group-hover:opacity-100"
                            title={isLocal ? "从列表移除（不删除本机文件）" : "删除"}
                            disabled={busy}
                            onClick={() => removeEnv(env)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 使用中环境：接入方式（官方登录 / 自定义模型） */}
                    {isActive && (
                      <div className="mt-3.5 border-t border-border pt-3">
                        <p className="mb-2 text-[11px] text-text3">接入方式 · 选择这个环境的 Codex 连接什么</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <ModeChip
                            label="官方登录"
                            icon={<Cloud size={11} />}
                            selected={envKind === "chatgpt"}
                            disabled={busy}
                            onClick={() => void applyChatgpt()}
                          />
                          {/* 「自定义模型」就是接入方式本身：点了直接接入，不弹任何选择；
                              chip 上不报模型名 —— 用哪个模型看/换都在首页输入框右下角。 */}
                          <ModeChip
                            label="自定义模型"
                            icon={<Cpu size={11} />}
                            selected={envKind === "manual"}
                            disabled={busy}
                            title={
                              envKind === "manual"
                                ? "已接入自定义模型；换模型在首页输入框右下角点模型名"
                                : "接入自己配置的模型（上次用过的优先；模型库为空时会先打开新建）"
                            }
                            onClick={() => {
                              if (busy || envKind === "manual") return;
                              const relays = envList?.relays ?? [];
                              // 上次在这个环境用过的档案优先（切回官方登录也会记住），否则用库里的第一个
                              const remembered = env.relayId ? relays.find((r) => r.id === env.relayId) : undefined;
                              const target = remembered ?? relays[0];
                              if (target) {
                                void applyRelay(target.id, target.name);
                                return;
                              }
                              // 模型库还是空的：直接开新建弹窗，建好即接入
                              setEditing(null);
                              setDialogOpen(true);
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 检测到本机 Codex 且尚未登记：一键原地复用 */}
              {official?.exists && !hasLocalEnv && (
                <button
                  className="flex items-center gap-3.5 rounded-2xl border border-dashed border-border p-4 text-left transition-colors hover:bg-bghover/40"
                  disabled={busy}
                  onClick={() => void addLocalEnv()}
                >
                  <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-bgsub text-text2">
                    <HardDrive size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-text">添加本地 Codex（自动检测到 {official.home}）</span>
                    <span className="mt-0.5 block text-[12px] text-text3">
                      原地复用本机原目录，登录、会话、配置零拷贝零导入；接入模型时写入该目录 config.toml（自动备份原件）
                    </span>
                  </span>
                  <Plus size={15} className="shrink-0 text-text3" />
                </button>
              )}
            </div>

            <p className="mt-4 text-[11.5px] text-text3">
              环境数据的深度管理（登录态 / 会话历史导入、技能共享）在「设置 → 编码 → 环境」。
            </p>
          </>
        )}

        {toast && (
          <p className={`mt-4 text-[12.5px] ${toast.ok ? "text-text2" : "text-accent"}`}>{toast.text}</p>
        )}
      </div>

      {/* 弹窗 */}
      <Dialog.Root
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) {
            setDialogOpen(false);
            setEditing(null);
          }
        }}
      >
        <ProviderDialog
          editing={editing}
          onClose={() => {
            setDialogOpen(false);
            setEditing(null);
          }}
          onSaved={(name, applied) =>
            flash(
              applied
                ? `已接入「${name}」— 配置已写入当前环境 config.toml，新会话将路由到该模型`
                : `「${name}」已保存`,
            )
          }
        />
      </Dialog.Root>
      <Dialog.Root open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <NewEnvDialog
          onClose={() => setNewEnvOpen(false)}
          onCreated={(name) => flash(`环境「${name}」已创建（独立数据目录）`)}
        />
      </Dialog.Root>
      <Dialog.Root open={Boolean(fileEnv)} onOpenChange={(o) => !o && setFileEnv(null)}>
        {fileEnv && (
          <EnvFileDialog env={fileEnv} onClose={() => setFileEnv(null)} onSaved={(msg) => flash(msg)} />
        )}
      </Dialog.Root>
    </div>
  );
}
