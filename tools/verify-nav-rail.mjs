/**
 * 验证「用户消息导航条」（左侧刻度 → 悬停预览卡 → 点击跳转）。
 *
 * 用法：node tools/verify-nav-rail.mjs
 * 前置：应用带 --remote-debugging-port=9222 启动。
 *
 * 两个环境坑（都踩过）：
 *  1. 用 JS 合成 pointerover/click 拿不到 React 的 onPointerEnter/onClick 效果不稳
 *     → 这里改用 CDP 的真实鼠标事件（Input.dispatchMouseEvent）。
 *  2. 本环境下窗口常被遮挡 → Chromium 会**节流渲染**，CSS transition 不推进、smooth 滚动不动，
 *     于是 getComputedStyle 读到的还是旧值、scrollTop 也不变。
 *     所以：测量前先注入 `*{transition:none!important}`；滚动验证改为"拦截 scrollIntoView 看它请求了什么"。
 */
import fs from "node:fs";

const PORT = process.env.FLOW_CDP_PORT || "9222";
const OUT = process.env.OUT || "nav-rail.png";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.title === "Codex") ?? list.find((t) => t.type === "page");
if (!page) { console.error("没找到应用页面"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
const ev = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  return res.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });

// 1) 找到带导航条的会话并打开
const opened = await ev(`(async () => {
  const SKIP = ['新聊天','最近','已归档的聊天','Codex','项目'];
  const rows = [...document.querySelectorAll('button')].filter(el => { const r = el.getBoundingClientRect(); return r.left < 340 && r.width > 120 && r.height >= 24 && r.height <= 60 && !SKIP.includes(el.textContent.trim()); });
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const el = rows[i]; if (!el) continue;
    el.click();
    await new Promise(r => setTimeout(r, 1200));
    const rail = document.querySelector('nav[aria-label="用户消息"]');
    // 挑刻度多的会话（更能看出山峰形状）
    if (rail && Number(rail.dataset.railCount) >= 5) return { ok: true, label: el.textContent.trim().slice(0, 20), count: rail.dataset.railCount, active: rail.dataset.railCurrent };
  }
  return { ok: false };
})()`);
if (!opened?.ok) { console.error("没找到带导航条的会话"); process.exit(2); }
console.log(`会话「${opened.label}」 刻度数=${opened.count} 当前=${opened.active}`);

// 关掉过渡（见文件头坑 2）
await ev(`(() => { const s = document.createElement('style'); s.textContent = '*{transition:none !important}'; document.head.appendChild(s); return 1; })()`);
await sleep(300);

// 2) 刻度尺寸/颜色分级
const marks = await ev(`(() => {
  const rail = document.querySelector('nav[aria-label="用户消息"]');
  const btns = [...rail.querySelectorAll('button')];
  const r0 = rail.getBoundingClientRect();
  return {
    rail: { left: Math.round(r0.left), top: Math.round(r0.top), width: Math.round(r0.width), height: Math.round(r0.height), 居中偏差: Math.round((r0.top + r0.height / 2) - innerHeight / 2) },
    items: btns.map((b, i) => {
      const outer = b.querySelector('span'); const line = outer.querySelector('span');
      const c = getComputedStyle(outer);
      const br = b.getBoundingClientRect();
      return { i, 命中区: [Math.round(br.width), Math.round(br.height)], 中心: [Math.round(br.left + br.width / 2), Math.round(br.top + br.height / 2)], 线宽: Math.round(line.getBoundingClientRect().width), 颜色: c.color + '@' + c.opacity };
    }),
  };
})()`);
console.log("刻度：", JSON.stringify(marks.items.map((m) => `${m.线宽}px ${m.颜色}`)));
console.log("导航条位置：", JSON.stringify(marks.rail));

// 3) 真实鼠标悬停 → 预览卡；并逐个刻度看标题/正文取到了什么
const card = await ev(`(() => {
  const rail = document.querySelector('nav[aria-label="用户消息"]');
  const el = [...rail.querySelectorAll('div')].find(d => d.classList.contains('w-[320px]'));
  if (!el) return null;
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return { 尺寸: [Math.round(r.width), Math.round(r.height)], 圆角: cs.borderRadius, 标题: el.firstElementChild?.textContent.slice(0, 30), 正文: (el.children[1]?.textContent || '').slice(0, 34), 正文截断行数: el.children[1] ? getComputedStyle(el.children[1]).webkitLineClamp : null };
})()`);
console.log("预览卡：", JSON.stringify(card));

console.log("\n逐条刻度（悬停后读卡片）：");
for (let i = 0; i < marks.items.length; i += 1) {
  const m = marks.items[i];
  await mouse("mouseMoved", m.中心[0], m.中心[1]);
  await sleep(420);
  const one = await ev(`(() => {
    const rail = document.querySelector('nav[aria-label="用户消息"]');
    const el = [...rail.querySelectorAll('div')].find(d => d.classList.contains('w-[320px]'));
    return el ? { 标题: (el.firstElementChild?.textContent || '').slice(0, 24), 正文长度: (el.children[1]?.textContent || '').length } : null;
  })()`);
  const ws = await ev(`(() => { const rail = document.querySelector('nav[aria-label="用户消息"]'); return [...rail.querySelectorAll('button')].map(b => Math.round(b.querySelector('span > span').getBoundingClientRect().width)).join(','); })()`);
  console.log(`  #${i + 1}  山峰宽度=[${ws}]  ${JSON.stringify(one)}`);
}

// 4) 真实点击 → 看它请求滚到哪里（smooth 在遮挡窗口里不推进，所以拦 scrollIntoView）
//    重点验证：目标在被折叠的「Worked for …」里时，必须先展开再滚（否则点了没反应）
await ev(`(() => {
  window.__scrollCalls = [];
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) { window.__scrollCalls.push({ id: this.getAttribute('data-user-message-id') || this.className.slice(0, 20), args: args[0] ?? null }); return orig.apply(this, args); };
  window.__workBefore = [...document.querySelectorAll('.flow-work-header button')].map(b => b.getAttribute('aria-expanded'));
  return 1;
})()`);
const last = marks.items[marks.items.length - 1];
// 点最后一条（大概率是回合中途的引导消息，藏在折叠区里）
await mouse("mousePressed", last.中心[0], last.中心[1]);
await mouse("mouseReleased", last.中心[0], last.中心[1]);
await sleep(900);
const jump = await ev(`JSON.stringify({
  点击前_工作过程展开状态: window.__workBefore,
  点击后_工作过程展开状态: [...document.querySelectorAll('.flow-work-header button')].map(b => b.getAttribute('aria-expanded')),
  目标是否已渲染: !!document.querySelector('[data-user-message-id="${last.entryId ?? ""}"]'),
  滚到了: window.__scrollCalls.map(c => c.id),
  参数: window.__scrollCalls[0]?.args ?? null,
})`);
console.log("点击跳转（最后一条 / 可能的引导消息）：", jump);

// 5) 截图（含刻度 + 预览卡）
const clip = { x: Math.max(0, marks.rail.left - 10), y: Math.max(0, marks.rail.top - 30), width: 420, height: 260, scale: 2 };
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip });
if (shot.result?.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64")); console.log("截图已存：", OUT); }
ws.close();
