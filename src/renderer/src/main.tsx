import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./global.css";

/**
 * 这里**不再有启动闪屏**（2026-10-01 决定，见 index.html 注释）。
 *
 * 之前用内联闪屏盖住首帧，本质是把"白屏"换成"更好看的白屏"，
 * 用户依旧不知道还要等多久，观感反而更差。正确做法是让首帧自己变快：
 *   - 渲染层 bundle 已按需拆分（App.tsx 的 lazy），首帧不必解析重型依赖；
 *   - 主进程让渲染层请求排队等内核（main.ts 的 waitForKernel），
 *     所以挂载即发请求能拿到数据，而不是当场失败后再等广播。
 * 现在 React 一挂载就渲染真实界面，数据后到就先显示空态/骨架。
 */

/**
 * 全局兜底：渲染期抛异常时 React 会把整棵树卸载 → 真正的一片空白。
 * 这种情况必须让用户看到原因（并指向日志），否则和白屏故障无法区分。
 * 只在**真正出错**时才注入，正常启动路径上永远不出现。
 */
/**
 * 首帧计时（诊断用，2026-10-01 第三轮）。
 *
 * "空白窗口 2~3 秒"这个体感必须能被量化，否则每次优化都只能靠猜。
 * 这里打三个点，全部落到主进程的 boot.log：
 *   - renderer:script           脚本开始执行（bundle 已下载并解析完）
 *   - renderer:first-commit     React 第一次把 DOM 提交上去
 *   - renderer:first-paint      浏览器真正画出第一帧（含 CSS 计算/布局）
 * script → first-paint 这一段就是用户看到的"窗口里什么都没有"的时长。
 *
 * 用 performance.timeOrigin 换算成绝对时间，和主进程的 boot() 同一条时间轴。
 * 失败绝不能影响启动，所以整体包在 try/catch 里、并且是 fire-and-forget。
 */
function markBoot(mark: string): void {
  try {
    // 预加载层在 window.codex 上暴露的诊断通道，缺失时静默忽略
    (window as unknown as { codex?: { bootMark?: (m: string, at: number) => void } }).codex?.bootMark?.(
      mark,
      Math.round(performance.now()),
    );
  } catch {
    /* 诊断不可用不影响启动 */
  }
}

markBoot("renderer:script");

/**
 * 只在**真的画出东西**时才上报。用 MessageChannel 宏任务而不是 requestAnimationFrame：
 * rAF 在窗口被遮挡/最小化/后台时会被**完全暂停**，用它当"已提交"信号会假阴性
 * （实测就是这么翻车的：script 点有了，commit/paint 点永远不来）。
 * MessageChannel 的回调是普通宏任务，不受可见性节流。
 */
function afterMacrotask(fn: () => void): void {
  try {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => fn();
    ch.port2.postMessage(0);
  } catch {
    setTimeout(fn, 0);
  }
}

/** 首帧一旦上报就闭嘴（script / commit / paint 三个点各只发一次） */
const sent = new Set<string>();
function markOnce(mark: string): void {
  if (sent.has(mark)) return;
  sent.add(mark);
  markBoot(mark);
}

/**
 * 让主进程把窗口显示出来（2026-10-01 第四轮）。
 *
 * 配套主进程 BrowserWindow 的 `show:false`：窗口建好但不显示，
 * 等这里发信号才 show()。于是**窗口一出现，里面已经有 React 渲染好的界面**，
 * 而不是先给用户一个纯白框、再等一两秒才填上内容 ——
 * 后者正是"窗口打开了但空白 2~3 秒"的由来。
 *
 * 时机选择：React **首次提交之后**，而不是 first-paint 之后。
 *   提交时 DOM 与样式都已就绪，窗口一显示就能画出正确内容；
 *   而 first-paint 的时机受 Chromium 对不可见窗口推迟光栅化的影响（实测可拖到 2s+），
 *   把"显示窗口"绑在它上面会让启动凭空变慢。这也是不用官方 ready-to-show 的同一理由。
 *
 * 失败绝不能影响启动：包在 try/catch 里，主进程有 8s 硬超时兜底。
 */
function requestReveal(): void {
  try {
    (window as unknown as { codex?: { reveal?: () => void } }).codex?.reveal?.();
  } catch {
    /* 主进程超时兜底 */
  }
}

try {
  // 方案 A（最准）：浏览器的 paint timing API。
  // buffered:true 让它能拿到"observing 之前就已经产生"的条目。
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "first-paint") markOnce("renderer:first-paint");
    }
  }).observe({ type: "paint", buffered: true });
  // 方案 B（兜底）：如果环境不给 paint 条目，用"提交后再过一个宏任务"近似。
  // 这只在 A 完全没消息时才兜底，A 已经报过就不重复。
  setTimeout(() => markOnce("renderer:first-paint"), 1500);
} catch {
  setTimeout(() => markOnce("renderer:first-paint"), 1500);
}

/**
 * ⚠️ 首帧测量的前提：页面必须**可见**。
 *
 * 2026-10-01 花了很久才定位到这一点：窗口被其它窗口遮挡 / 最小化 / 后台时
 * `document.visibilityState === "hidden"`，Chromium 会**主动推迟光栅化**，
 * first-paint 因此拖到 2s 之后 —— 那是**测量环境的假象**，不是应用慢。
 * （实测：用探针脚本起的实例被用户自己的窗口盖住，量出来的"空白 2~3 秒"
 *   与用户手动启动时的体感完全对不上。）
 *
 * 所以启动时把可见性一并记进日志：看到 `visible=false` 的 first-paint 数字
 * 就不必当真，也不要据此去做优化。
 */
try {
  const reportVisibility = () => {
    markBoot(`renderer:visibility ${document.visibilityState}`);
  };
  reportVisibility();
  document.addEventListener("visibilitychange", reportVisibility);
} catch {
  /* 忽略 */
}

/**
 * 长任务探针（诊断用）：first-commit → first-paint 之间若存在 >50ms 的长任务，
 * 说明主线程被 JS 占住了（而不是"浏览器绘制慢"）。反之则是合成/绘制侧的等待。
 * 这条信息决定优化方向，所以必须能测出来。
 */
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 50) continue;
      const start = Math.round(e.startTime);
      // 把时长与起点都带进 mark 名，主进程日志里一眼能看出"启动期被什么占了多久"
      markBoot(`renderer:longtask d=${Math.round(e.duration)} start=${start}`);
    }
  }).observe({ entryTypes: ["longtask"] });
} catch {
  /* 环境不支持 longtask 时忽略 */
}

function showFatalError(message: string) {
  const existing = document.getElementById("boot-fatal");
  if (existing) return;
  const el = document.createElement("div");
  el.id = "boot-fatal";
  el.setAttribute(
    "style",
    [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
      "gap:10px", "padding:40px", "text-align:center",
      "background:#fff", "color:#0d0d0d",
      "font-family:-apple-system,'Segoe UI','Microsoft YaHei',system-ui,sans-serif",
    ].join(";"),
  );
  const title = document.createElement("div");
  title.textContent = "界面出现错误";
  title.setAttribute("style", "font-size:16px;font-weight:600");
  const detail = document.createElement("div");
  detail.textContent = message;
  detail.setAttribute("style", "font-size:13px;color:#5d5d5d;max-width:600px;line-height:1.6;word-break:break-all");
  const hint = document.createElement("div");
  hint.textContent = "日志：%APPDATA%/codex-desk-replica/logs/boot.log";
  hint.setAttribute("style", "font-size:12px;color:#8f8f8f");
  el.append(title, detail, hint);
  document.body.appendChild(el);
}

window.addEventListener("error", (e) => {
  const msg = e?.error instanceof Error ? e.error.message : String(e?.message ?? "未知错误");
  console.error("[renderer] 未捕获错误:", e?.error ?? msg);
  showFatalError(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? "未知错误");
  console.error("[renderer] 未处理的 Promise 拒绝:", reason);
  // 单个请求失败不该盖住整个界面（store 内部已各自兜底），只在根节点空着时才提示
  if (!document.getElementById("root")?.hasChildNodes()) showFatalError(msg);
});

try {
  // React 19 的 root.render() 会在内部同步完成首次提交（同一次调用栈里，
  // Concurrent 的首次挂载不切时间片），所以下面这个宏任务必然落在"DOM 已提交"之后。
  // 用宏任务而非 rAF：窗口被遮挡时 rAF 会被暂停，我们会误判成"没提交"。
  afterMacrotask(() => {
    markOnce("renderer:first-commit");
    // 提交完成 → 立刻让主进程显示窗口（此时窗口里有真实内容，不会白屏）
    requestReveal();
  });
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  // 严格说来 render() 返回时提交已完成；这里再补一个点，用来和上面那个对照 ——
  // 两者都很快说明瓶颈不在这里，两者都慢说明首屏组件渲染本身重。
  markOnce("renderer:render-returned");
  // 兜底：某些情况下首次提交可能不在同一次调用栈里完成（例如 StrictMode 双调用、
  // 或首屏含有 Suspense 边界触发的一次额外渲染）。这里再补一次 reveal，
  // 保证窗口不会因为上面那个宏任务时机不对而一直不显示（主进程侧幂等）。
  afterMacrotask(() => requestReveal());
} catch (error) {
  showFatalError(error instanceof Error ? error.message : String(error));
}
