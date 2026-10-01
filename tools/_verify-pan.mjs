/**
 * 验证图片预览的**拖拽平移**：缩小到 ~32% 后，按住左键拖动，图片应跟着移动。
 * 用法：node tools/_verify-pan.mjs
 */
import fs from "node:fs";

const PORT = process.env.FLOW_CDP_PORT || "9222";
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.title === "Codex") ?? list.find((t) => t.type === "page");
if (!page) { console.error("没找到页面"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
const ev = async (expr) => {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return res.result?.exceptionDetails ? { __throw: JSON.stringify(res.result.exceptionDetails).slice(0, 400) } : res.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });

// 打开一个带缩略图的会话
const opened = await ev(`(async () => {
  const SKIP = ['新聊天','最近','已归档的聊天','Codex','项目'];
  const rows = [...document.querySelectorAll('button')].filter(el => { const r = el.getBoundingClientRect(); return r.left < 340 && r.width > 120 && r.height >= 24 && r.height <= 60 && !SKIP.includes(el.textContent.trim()); });
  for (let i = 0; i < 40; i += 1) {
    const el = rows[i]; if (!el) continue;
    el.click();
    await new Promise(r => setTimeout(r, 1200));
    for (const h of [...document.querySelectorAll('.flow-work-header button')].filter(b => b.getAttribute('aria-expanded') === 'false')) { h.click(); await new Promise(r => setTimeout(r, 220)); }
    if (document.querySelectorAll('[data-attachment-thumb]').length >= 2) return { ok: true, label: el.textContent.trim().slice(0, 16) };
  }
  return { ok: false };
})()`);
if (!opened?.ok) { console.error("没找到带缩略图的会话"); process.exit(2); }
console.log(`会话「${opened.label}」`);

// 打开预览（挑最后一张，通常是能加载的）
await ev(`(() => { const t = [...document.querySelectorAll('[data-attachment-thumb]')]; t[t.length - 1].click(); return 1; })()`);
await sleep(1100);

// 缩小到 ~32%（点三次「缩小」，每次 ×0.8：66 → 53 → 42 → 34）
for (let i = 0; i < 3; i += 1) {
  await ev(`document.querySelector('[aria-label="缩小"]').click()`);
  await sleep(250);
}
const before = await ev(`(() => {
  const img = document.querySelector('[role="dialog"][aria-label="图片预览"] img');
  const r = img.getBoundingClientRect();
  const zoomBtn = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.getAttribute('aria-label') === '重置缩放');
  return JSON.stringify({ 缩放: zoomBtn.textContent.trim(), 位置: [Math.round(r.left), Math.round(r.top)], 中心: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] });
})()`);
console.log("拖拽前：", before);
const b = JSON.parse(before);

// 真实鼠标拖拽：按住 → 分 6 步移动 → 松开
const cx = b.中心[0], cy = b.中心[1];
const dx = -260, dy = -120;
await mouse("mousePressed", cx, cy);
for (let s = 1; s <= 6; s += 1) {
  await mouse("mouseMoved", Math.round(cx + (dx * s) / 6), Math.round(cy + (dy * s) / 6));
  await sleep(60);
}
await mouse("mouseReleased", cx + dx, cy + dy);
await sleep(600);

const after = await ev(`(() => {
  const img = document.querySelector('[role="dialog"][aria-label="图片预览"] img');
  const r = img.getBoundingClientRect();
  const zoomBtn = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.getAttribute('aria-label') === '重置缩放');
  return JSON.stringify({ 缩放: zoomBtn.textContent.trim(), 位置: [Math.round(r.left), Math.round(r.top)] });
})()`);
console.log("拖拽后：", after);
const a = JSON.parse(after);
const moved = [a.位置[0] - b.位置[0], a.位置[1] - b.位置[1]];
console.log(`位移：[${moved[0]}, ${moved[1]}]  期望约 [${dx}, ${dy}]  → ${Math.abs(moved[0] - dx) < 30 && Math.abs(moved[1] - dy) < 30 ? "✔ 拖拽生效" : "✗ 拖拽没生效"}`);

await mouse("mouseMoved", 700, 620);
await sleep(400);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
if (shot.result?.data) { fs.writeFileSync("D:/tmp/pan.png", Buffer.from(shot.result.data, "base64")); console.log("截图已存 D:/tmp/pan.png"); }
ws.close();
