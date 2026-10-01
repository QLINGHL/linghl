import React from 'react';
import { createRoot } from 'react-dom/client';
import ThreadView from '../src/renderer/src/components/ThreadView';
import Sidebar from '../src/renderer/src/components/Sidebar';
import ApprovalBanner from '../src/renderer/src/components/ApprovalBanner';
import KernelErrorBanner from '../src/renderer/src/components/KernelErrorBanner';
import { useStore, pushLocalUserMessage, markTurnPending } from '../src/renderer/src/store';
import { normalizeMath } from '../src/renderer/src/lib/normalizeMath';
import '../src/renderer/src/global.css';

// Isolated test transport: the production view and store receive app-server events.
// This page is not part of the packaged renderer and cannot call a real model.
let kernelRetryCalls = 0;
let kernelIssue: unknown = null;
let historyResponses: unknown[] = [];
let historyEnvRows: unknown[] = [];
let historyFailure = '';
let historyRequestParams: unknown[] = [];
window.codex = {
  request: async () => ({ data: [] }),
  envRpc: async (channel: string) => {
    if (channel === 'app:kernel-issue') return kernelIssue;
    if (channel === 'app:kernel-retry') {
      kernelRetryCalls += 1;
      kernelIssue = { level: 'info', message: 'kernel restarted', silent: true };
      return { ok: true };
    }
    if (channel === 'env:turns') return { data: historyEnvRows };
    // env:threads 现在与内核 thread/list 并行取、合并成完整列表，
    // 所以测试台必须能控制它（见 verify-recents 的合并用例）
    if (channel === 'env:threads') return { threads: envThreadRows };
    return [];
  },
  setDeskState: async () => ({}), getDeskState: async () => ({}),
} as any;
let threadId = 'replay';
let turnId = 'turn';
let calls: { method: string; params: unknown }[] = [];
let failMethod = '';
let holdMethod = '';
let held: ((value: unknown) => void) | undefined;
/** thread/list 的下一份返回内容（loadThreads 合并逻辑的测试入口） */
let threadListRows: unknown[] = [];
/** env:threads 的下一份返回内容（本地库直读，用于验证"补回被内核隐藏的会话"） */
let envThreadRows: unknown[] = [];
/**
 * 非空时，`thread/resume` 以这条消息失败。
 * 用于验证"会话用的模型接入已不存在 → 展示可读的只读说明"这条分支 ——
 * 真实场景里内核报的是 "failed to load configuration: Model provider `xxx` not found"。
 */
let resumeFailMessage = '';
function mockRequest(method: string, params: unknown) {
  calls.push({ method, params });
  if (method === 'thread/turns/list') {
    historyRequestParams.push(params);
    if (historyFailure) return Promise.reject(new Error(historyFailure));
    return Promise.resolve(historyResponses.shift() ?? { data: [] });
  }
  if (method === 'thread/list') return Promise.resolve({ data: threadListRows });
  if (method === 'thread/resume' && resumeFailMessage) return Promise.reject(new Error(resumeFailMessage));
  if (method === failMethod) return Promise.reject(new Error('Test transport failure'));
  if (method === holdMethod) return new Promise(resolve => { held = resolve; });
  return Promise.resolve({ data: [] });
}
window.codex.approvalResponse = async (id, response) => { await mockRequest('approval', { id, response }); return true; };
const replay = {
  reset(id = 'replay') {
    threadId = id;
    turnId = 'turn';
    kernelRetryCalls = 0;
    kernelIssue = null;
    historyResponses = [];
    historyEnvRows = [];
    historyFailure = '';
    historyRequestParams = [];
    useStore.setState({ activeThreadId: id, turns: {}, items: {}, turnActive: {}, activeTurnId: {}, activeItemId: {},
      turnPhase: {}, streaming: {}, streamingItemId: {}, threads: [], errors: [], prefs: null, approvals: [], envList: null,
      kernelError: null, kernelNotice: null, pendingThreadIds: [], projects: [] });
    calls = []; failMethod = ''; holdMethod = ''; held = undefined; threadListRows = []; envThreadRows = []; resumeFailMessage = ''; window.codex.request = mockRequest;
  },
  async setKernelIssue(value: unknown) {
    kernelIssue = value;
    await useStore.getState().syncKernelIssue();
  },
  kernelRetryCalls() { return kernelRetryCalls; },
  history({ pages = [], env = [], failure = '' } = {}) {
    historyResponses = [...pages];
    historyEnvRows = env;
    historyFailure = failure;
    historyRequestParams = [];
  },
  historyRequests() { return historyRequestParams; },
  setTurnId(id: string) { turnId = id; },
  async loadConfiguredHistory() {
    window.codex.request = mockRequest;
    // The app fallback uses the active environment id; the replay exposes a
    // deterministic fake environment so timeout/error cases exercise it too.
    useStore.setState({ envList: { activeId: 'replay-env', envs: [], relays: [],
      official: { home: '', exists: false, hasAuth: false, hasConfig: false, sessionCount: 0, hasSkills: false } } });
    await useStore.getState().loadItems(threadId);
  },
  pending(text: string) { pushLocalUserMessage(threadId, text); markTurnPending(threadId); },
  event(method: string, params = {}) { useStore.getState().handleNotification({ method, params: { threadId, turnId, ...params } }); },
  state() { const s = useStore.getState(); return { turns: s.turns[threadId], items: s.items[threadId], active: s.turnActive[threadId],
    turnId: s.activeTurnId[threadId], itemId: s.activeItemId[threadId], phase: s.turnPhase[threadId] }; },
  async reloadHistory(rows: unknown[]) {
    replay.history({ pages: [{ data: rows }] });
    window.codex.request = mockRequest;
    await useStore.getState().loadItems(threadId);
    window.codex.request = mockRequest;
  },
  normalizeMath,
  configure(value: Record<string, unknown>) { useStore.setState(value); },
  transport({ fail = '', hold = '' } = {}) { calls = []; failMethod = fail; holdMethod = hold; window.codex.request = mockRequest; },
  release(value = {}) { held?.(value); held = undefined; },
  calls() { return calls; },
  approvals() { return useStore.getState().approvals; },
  /**
   * 「最近」列表相关（2026-10-01 新聊天不出现在最近 的回归测试用）。
   *
   * 这一组直通 store，用来验证：
   *   ① 新建会话能立刻乐观插进 threads（不等内核 thread/list）；
   *   ② loadThreads 刷新时**不会**把还没被内核收录的乐观条目抹掉；
   *   ③ 内核收录后条目转正（pendingThreadIds 摘掉、用内核的标题）。
   */
  upsertPending(id: string, title: string, cwd?: string) {
    useStore.getState().upsertPendingThread({ id, title, cwd });
  },
  dropPending(id: string) {
    useStore.getState().dropPendingThread(id);
  },
  threads() { return useStore.getState().threads; },
  pendingIds() { return useStore.getState().pendingThreadIds; },
  projects() { return useStore.getState().projects; },
  turnActiveOf(id: string) { return Boolean(useStore.getState().turnActive[id]); },
  /** 设定下一次 thread/list 的返回内容，然后真的走一遍 loadThreads（含合并逻辑） */
  async loadThreads(rows: unknown[] = [], envRows: unknown[] = []) {
    threadListRows = rows;
    envThreadRows = envRows;
    window.codex.request = mockRequest;
    await useStore.getState().loadThreads();
  },
  /** 让 thread/resume 以指定消息失败（验证"模型接入已不存在"的只读说明） */
  resumeFailsWith(message: string) {
    resumeFailMessage = message;
    window.codex.request = mockRequest;
  },
  /** 打开某个会话（走真实的 openThread：resume → 失败翻译 → loadItems） */
  async openThread(id: string) {
    window.codex.request = mockRequest;
    await useStore.getState().openThread(id);
  },
  /** 当前会话的错误提示（ErrorBanner 读的就是它） */
  errors() { return useStore.getState().errors; },
};
(window as any).replay = replay;
replay.reset();
/**
 * `?sidebar=1` 时额外挂上侧栏，用于验证「最近」列表的渲染
 * （转圈指示器、乐观条目置顶等）。
 * 默认不挂 —— 既有 verify-flow.mjs 用 `body.innerText()` 做断言，
 * 多出侧栏文字会干扰它。
 */
const withSidebar = new URLSearchParams(location.search).get('sidebar') === '1';
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex' }}>
    {withSidebar && <Sidebar />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <ThreadView />
      <ApprovalBanner />
      <KernelErrorBanner />
    </div>
  </div>,
);
