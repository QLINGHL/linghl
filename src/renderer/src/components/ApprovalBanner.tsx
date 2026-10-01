import { useState } from "react";
import { Check, X, TerminalSquare, FileDiff, ShieldQuestion, MessageCircleQuestion } from "lucide-react";
import { rpc } from "../lib/api";
import { useStore, type ApprovalRequest } from "../store";

/** 单项选择题；isSecret 时用密码框 */
interface Question {
  id: string;
  header: string;
  question: string;
  options?: { label: string; description?: string }[] | null;
  isOther?: boolean;
  isSecret?: boolean;
}

/** 模型提问请求（item/tool/requestUserInput）——不回响应会让整轮对话挂死，
 *  所以这里必须有可点的出口（选项 / 自定义输入 / 跳过）。 */
function questionsOf(req: ApprovalRequest): Question[] {
  const raw = req.params?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === "object")
    .map((q, i) => ({
      id: typeof q.id === "string" ? q.id : `q${i}`,
      header: typeof q.header === "string" ? q.header : "需要你的输入",
      question: typeof q.question === "string" ? q.question : "",
      options: Array.isArray(q.options) ? (q.options as Question["options"]) : null,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
    }));
}

export default function ApprovalBanner() {
  const approvals = useStore((s) => s.approvals);
  const top = approvals[0];
  if (!top) return null;
  return <ApprovalCard key={top.id} top={top} />;
}

function ApprovalCard({ top }: { top: ApprovalRequest }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isQuestion = top.method.includes("requestUserInput");
  const questions = isQuestion ? questionsOf(top) : [];

  const respond = async (approved: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    const response = approvalResponse(top, approved, answers);
    try {
      await rpc.approvalResponse(top.id, response);
      useStore.setState((s) => ({ approvals: s.approvals.filter((item) => item.id !== top.id) }));
    } catch (error) {
      setError("提交失败，请重试：" + String(error).replace(/^Error:\s*/, ""));
    } finally {
      setSubmitting(false);
    }
  };

  if (isQuestion) {
    return (
      <div className="absolute inset-x-0 top-2 z-30 flex justify-center px-4">
        <div className="fade-up w-full max-w-2xl rounded-2xl border border-border bg-bg p-3.5 shadow-[0_16px_50px_rgba(0,0,0,0.18)]">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-text">
            <MessageCircleQuestion size={15} className="text-text2" />
            Codex 需要你的确认
          </div>
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {questions.length === 0 && <p className="text-[12.5px] text-text2">（内核没有给出问题内容）</p>}
            {questions.map((q) => (
              <div key={q.id}>
                <p className="text-[12.5px] font-medium text-text2">{q.header}</p>
                {q.question && <p className="mt-0.5 text-[12.5px] leading-5 text-text">{q.question}</p>}
                {q.options && q.options.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {q.options.map((op) => {
                      const picked = answers[q.id] === op.label;
                      return (
                        <button
                          key={op.label}
                          title={op.description}
                          className={`rounded-full border px-2.5 py-1 text-[12px] ${picked ? "border-text3 bg-bghover text-text" : "border-border text-text2 hover:bg-bghover"}`}
                          onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: op.label }))}
                        >
                          {op.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {(q.isOther || !q.options || q.options.length === 0) && (
                  <input
                    type={q.isSecret ? "password" : "text"}
                    value={answers[q.id] ?? ""}
                    placeholder="输入你的回答…"
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    className="mt-1.5 w-full rounded-lg border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text outline-none focus:border-text3"
                  />
                )}
              </div>
            ))}
          </div>
          {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--red-500)]">{error}</p> : null}
          <fieldset disabled={submitting} className="mt-3 flex justify-end gap-2">
            <button
              className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover"
              onClick={() => void respond(false)}
            >
              跳过
            </button>
            <button
              className="flex items-center gap-1.5 rounded-full bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90"
              onClick={() => void respond(true)}
            >
              <Check size={14} /> 提交
            </button>
          </fieldset>
        </div>
      </div>
    );
  }

  const summary = summarize(top);
  return (
    <div className="absolute inset-x-0 top-2 z-30 flex justify-center px-4">
      <div className="fade-up w-full max-w-2xl rounded-2xl border border-border bg-bg p-3.5 shadow-[0_16px_50px_rgba(0,0,0,0.18)]">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-text">
          {top.method.includes("fileChange") ? <FileDiff size={15} className="text-text2" /> : top.method.includes("permissions") ? <ShieldQuestion size={15} className="text-text2" /> : <TerminalSquare size={15} className="text-text2" />}
          {summary.title}
        </div>
        {summary.detail && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bgsub p-2.5 text-[12px] leading-5 text-text2">{summary.detail}</pre>}
        {error ? <p role="alert" className="mt-2 text-[13px] text-[var(--red-500)]">{error}</p> : null}
        <fieldset disabled={submitting} className="mt-3 flex justify-end gap-2">
          <button className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-text hover:bg-bghover" onClick={() => void respond(false)}>拒绝</button>
          <button className="flex items-center gap-1.5 rounded-full bg-[var(--c-send)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--c-send-text)] hover:opacity-90" onClick={() => void respond(true)}><Check size={14} /> 批准</button>
          <button className="flex h-7 w-7 items-center justify-center rounded-full text-text3 hover:bg-bghover" title="关闭" onClick={() => void respond(false)}><X size={14} /></button>
        </fieldset>
      </div>
    </div>
  );
}

/** 构造内核期望的响应体（形状按 app-server 的 *Response schema） */
function approvalResponse(req: ApprovalRequest, approved: boolean, answers: Record<string, string>): unknown {
  if (req.method.includes("requestUserInput")) {
    if (!approved) return { answers: {} };
    // ToolRequestUserInputResponse: { answers: { [questionId]: { answers: string[] } } }
    const out: Record<string, { answers: string[] }> = {};
    for (const q of questionsOf(req)) {
      const value = (answers[q.id] ?? "").trim();
      if (value) out[q.id] = { answers: [value] };
    }
    return { answers: out };
  }
  if (req.method.includes("permissions")) {
    // PermissionsRequestApprovalResponse: { permissions, scope }
    const source = (req.params.permissions ?? {}) as Record<string, unknown>;
    return { permissions: approved ? source : {}, scope: "turn" };
  }
  // CommandExecution / FileChange: { decision: accept | decline }
  return { decision: approved ? "accept" : "decline" };
}

/** 把内核给的参数翻成用户看得懂的一句话 + 关键细节 */
function summarize(req: ApprovalRequest): { title: string; detail: string } {
  const p = req.params ?? {};
  if (req.method.includes("fileChange")) {
    // FileChangeRequestApprovalParams: { itemId, threadId, turnId, grantRoot, reason }
    const root = typeof p.grantRoot === "string" ? p.grantRoot : "";
    const reason = typeof p.reason === "string" ? p.reason : "";
    return {
      title: "允许写入这些文件？",
      detail: [root && `目录：${root}`, reason && `原因：${reason}`].filter(Boolean).join("\n") || "（内核未提供更多细节）",
    };
  }
  if (req.method.includes("permissions")) {
    // PermissionsRequestApprovalParams: { permissions, reason, cwd }
    const reason = typeof p.reason === "string" ? p.reason : "";
    return {
      title: "允许提升权限？",
      detail: [reason, JSON.stringify(p.permissions ?? {}, null, 2)].filter(Boolean).join("\n\n"),
    };
  }
  // CommandExecutionRequestApprovalParams: { command, cwd, reason, ... }
  const cmd = typeof p.command === "string" ? p.command : Array.isArray(p.command) ? (p.command as string[]).join(" ") : "";
  const cwd = typeof p.cwd === "string" ? p.cwd : "";
  const reason = typeof p.reason === "string" ? p.reason : "";
  return {
    title: "是否允许运行此命令？",
    detail: [cwd && `目录：${cwd}`, cmd && `命令：${cmd}`, reason && `原因：${reason}`].filter(Boolean).join("\n"),
  };
}
