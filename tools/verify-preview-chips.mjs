/**
 * 验证：① 缩略图点开全屏预览（可左右切换、Esc 关闭）；② 导航条浮层卡片底部的产物 chip。
 * 用法：node tools/verify-preview-chips.mjs
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
const shot = async (file, clip) => {
  const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip } : {}) });
  if (res.result?.data) fs.writeFileSync(file, Buffer.from(res.result.data, "base64"));
};

// 打开一个既有附件（或 Viewed images 行）又有导航条的会话
const opened = await ev(`(async () => {
  const SKIP = ['新聊天','最近','已归档的聊天','Codex','项目'];
  const rows = [...document.querySelectorAll('button')].filter(el => { const r = el.getBoundingClientRect(); return r.left < 340 && r.width > 120 && r.height >= 24 && r.height <= 60 && !SKIP.includes(el.textContent.trim()); });
  for (let i = 0; i < 40; i += 1) {
    const el = rows[i]; if (!el) continue;
    el.click();
    await new Promise(r => setTimeout(r, 1300));
    const rail = document.querySelector('nav[aria-label="用户消息"]');
    // 展开所有折叠的工作过程，让缩略图露出来
    for (const h of [...document.querySelectorAll('.flow-work-header button')].filter(b => b.getAttribute('aria-expanded') === 'false')) { h.click(); await new Promise(r => setTimeout(r, 260)); }
    const thumbs = document.querySelectorAll('[data-attachment-thumb]');
    if (rail && thumbs.length >= 2) return { ok: true, label: el.textContent.trim().slice(0, 16), thumbs: thumbs.length, railCount: rail.dataset.railCount };
  }
  return { ok: false };
})()`);
if (!opened?.ok) { console.error("没找到同时有缩略图和导航条的会话"); process.exit(2); }
console.log(`会话「${opened.label}」缩略图 ${opened.thumbs} 个、刻度 ${opened.railCount} 条`);

// 先找到一张"文件还在"的缩略图（这轮会话里很多图被删了，点开只会是"无法加载"态）
const loadable = await ev(`(async () => {
  const thumbs = [...document.querySelectorAll('[data-attachment-thumb]')];
  for (let i = 0; i < Math.min(thumbs.length, 24); i += 1) {
    thumbs[i].click();
    await new Promise(r => setTimeout(r, 550));
    const img = document.querySelector('[role="dialog"][aria-label="图片预览"] img');
    const ok = Boolean(img && img.complete && img.naturalWidth > 0);
    document.querySelector('[aria-label="关闭"]')?.click();
    await new Promise(r => setTimeout(r, 220));
    if (ok) return { index: i, path: thumbs[i].getAttribute('data-attachment-thumb') };
  }
  return null;
})()`);
console.log("  可加载的缩略图：", JSON.stringify(loadable));
if (!loadable) console.log("  （这张会话里所有图都被删了，只能看到「无法加载此图像」态）");

// ① 点缩略图 → 全屏预览
console.log("\n① 全屏预览");
console.log("  点开前有 dialog：", await ev(`!!document.querySelector('[role="dialog"][aria-label="图片预览"]')`));
await ev(`document.querySelectorAll('[data-attachment-thumb]')[${loadable ? loadable.index : 1}].click()`);
await sleep(1000);
const info = `(() => {
  const d = document.querySelector('[role="dialog"][aria-label="图片预览"]');
  if (!d) return null;
  const cs = getComputedStyle(d);
  const img = d.querySelector('img');
  const counter = [...d.querySelectorAll('div')].find(x => /第 \\d+ 张/.test(x.textContent));
  return {
    背景: cs.backgroundColor, 层级: cs.zIndex,
    图片尺寸: img ? [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)] : null,
    图片已加载: img ? (img.complete && img.naturalWidth > 0) : null,
    计数: counter ? counter.textContent.trim() : null,
    上一张按钮: !!d.querySelector('[aria-label="上一张"]'), 下一张按钮: !!d.querySelector('[aria-label="下一张"]'), 关闭按钮: !!d.querySelector('[aria-label="关闭"]'),
  };
})()`;
console.log("  打开后：", await ev(info));
await shot(process.env.OUT || "image-preview.png");

// 下一张 → 计数应变
await ev(`document.querySelector('[aria-label="下一张"]').click()`);
await sleep(700);
console.log("  点下一张后计数：", await ev(`(() => { const d = document.querySelector('[role="dialog"][aria-label="图片预览"]'); const c = [...d.querySelectorAll('div')].find(x => /第 \\d+ 张/.test(x.textContent)); return c ? c.textContent.trim() : null; })()`));
// 方向键再切一次
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
await sleep(500);
console.log("  按 ← 后计数：", await ev(`(() => { const d = document.querySelector('[role="dialog"][aria-label="图片预览"]'); const c = [...d.querySelectorAll('div')].find(x => /第 \\d+ 张/.test(x.textContent)); return c ? c.textContent.trim() : null; })()`));
// Esc 关闭
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);
console.log("  按 Esc 后还有 dialog：", await ev(`!!document.querySelector('[role="dialog"][aria-label="图片预览"]')`));

// ② 卡片 chip
console.log("\n② 卡片产物 chip");
const railBox = JSON.parse(await ev(`(() => { const n = document.querySelector('nav[aria-label="用户消息"]'); const r = n.getBoundingClientRect(); return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]); })()`));
// 悬停每个刻度，找有 chip 的
let chipReport = null;
for (let i = 0; i < Number(opened.railCount); i += 1) {
  const pt = JSON.parse(await ev(`(() => { const b = [...document.querySelector('nav[aria-label="用户消息"]').querySelectorAll('button')][${i}]; const r = b.getBoundingClientRect(); return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]); })()`));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt[0], y: pt[1] });
  await sleep(420);
  const report = await ev(`(() => {
    const rail = document.querySelector('nav[aria-label="用户消息"]');
    const card = [...rail.querySelectorAll('div')].find(d => d.classList.contains('w-[320px]'));
    if (!card) return null;
    const rows = [...card.children];
    const chipRow = rows.find(r => r.querySelector('svg') && r !== rows[0]);
    if (!chipRow) return null;
    return { 标题: (rows[0].textContent || '').slice(0, 18), chip行文字: chipRow.textContent.trim(), chip个数: chipRow.querySelectorAll('svg').length, 颜色: getComputedStyle(chipRow).color, 间距: getComputedStyle(chipRow).gap };
  })()`);
  if (report) { chipReport = { 第几条: i + 1, ...report }; break; }
}
console.log("  含 chip 的卡片：", JSON.stringify(chipReport));
if (chipReport) await shot("nav-card-chips.png", { x: Math.max(0, railBox[0] - 30), y: Math.max(0, railBox[1] - 120), width: 420, height: 260, scale: 2 });
ws.close();
