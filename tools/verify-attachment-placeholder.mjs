/**
 * 验证「附件缩略图」的加载/失败占位：确认图片取不到时是中心转圈，而不是浏览器的破图图标。
 *
 * 用法：node tools/verify-attachment-placeholder.mjs [关键词]
 *   不给关键词时自动扫侧栏，找到第一个含附件缩略图的会话并打开（一路点过去，纯只读操作）。
 *   OUT=xx.png 可改输出文件。
 * 前置：应用带 --remote-debugging-port=9222 启动（npm start -- --remote-debugging-port=9222）。
 *
 * ⚠️ 别指望"按消息预览找会话"：侧栏有一半标题来自官方生成的会话名，跟内核 preview 对不上，
 *    所以默认走扫描；关键词只用于快速跳过无关行。
 */
import fs from "node:fs";

const PORT = process.env.FLOW_CDP_PORT || "9222";
const KEYWORD = process.argv[2] || "";
const OUT = process.env.OUT || "attachment-placeholder.png";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.title === "Codex") ?? list.find((t) => t.type === "page");
if (!page) {
  console.error("没找到应用页面，当前目标：", list.map((t) => t.title));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
await new Promise((r) => ws.addEventListener("open", r));

const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 500));
  return res.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 打开目标会话：有关键词就按关键词挑行，没有就扫到第一个有缩略图的会话
const opened = await evaluate(`(async () => {
  const kw = ${JSON.stringify(KEYWORD)};
  const SKIP = ['新聊天','最近','已归档的聊天','Codex','项目'];
  const rows = () => [...document.querySelectorAll('button')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.left < 340 && r.width > 120 && r.height >= 24 && r.height <= 60 && !SKIP.includes(el.textContent.trim());
  });
  const thumbs = () => [...document.querySelectorAll('div')].filter(d => d.classList && d.classList.contains('h-[80px]'));
  const all = rows();
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (!el) continue;
    const label = el.textContent.trim().slice(0, 24);
    if (kw && !label.includes(kw)) continue;
    el.click();
    await new Promise(r => setTimeout(r, 320));
    if (thumbs().length) return { ok: true, row: i, label, thumbs: thumbs().length };
    if (kw) return { ok: false, reason: '该关键词的会话没有缩略图', label };
  }
  return { ok: false, reason: '所有会话都没有缩略图' };
})()`);
if (!opened?.ok) {
  console.error("没打开到带附件的会话：", opened);
  process.exit(2);
}
console.log(`已打开会话：${opened.label}（第 ${opened.row} 行，共 ${opened.thumbs} 个缩略图）`);
await sleep(1200);

// 2) 挑「失败图片最多」的那一条附件行（就是原图被删掉的那种），滚进视口，量尺寸 + 颜色 + 动画
const report = await evaluate(`(async () => {
  const strips = [...document.querySelectorAll('div')].filter(d => d.classList && d.classList.contains('gap-[8px]'));
  if (!strips.length) return { error: '没有缩略图行' };
  const summary = strips.map((s, i) => {
    const thumbs = [...s.children];
    const imgs = thumbs.map(t => t.querySelector('img')).filter(Boolean);
    const failed = imgs.filter(im => im.complete && im.naturalWidth === 0).length;
    return { i, thumbs: thumbs.length, imgs: imgs.length, failed };
  });
  const best = summary.slice().sort((a, b) => (b.failed - a.failed) || (b.thumbs - a.thumbs))[0];
  const strip = strips[best.i];
  strip.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 600));
  const thumbs = [...strip.children];
  const first = thumbs[0];
  const rect = first.getBoundingClientRect();
  const cs = getComputedStyle(first);
  const svg = first.querySelector('svg');
  const svgRect = svg ? svg.getBoundingClientRect() : null;
  const circle = svg ? svg.querySelector('circle') : null;
  const ccs = circle ? getComputedStyle(circle) : null;
  const sRect = strip.getBoundingClientRect();
  return {
    所有附件行: summary,
    选中的行: best.i,
    这条消息的缩略图数: thumbs.length,
    卡内img数: thumbs.map(t => t.querySelectorAll('img').length),
    卡内svg数: thumbs.map(t => t.querySelectorAll('svg').length),
    卡片尺寸: [Math.round(rect.width), Math.round(rect.height)],
    圆角: cs.borderRadius, 底色: cs.backgroundColor, 描边色: cs.borderTopColor, 描边宽: cs.borderTopWidth,
    转圈尺寸: svgRect ? [+svgRect.width.toFixed(2), +svgRect.height.toFixed(2)] : null,
    转圈描边: ccs ? ccs.stroke + ' / ' + ccs.strokeWidth : null,
    转圈动画: svg ? getComputedStyle(svg).animationName + ' ' + getComputedStyle(svg).animationDuration + ' ' + getComputedStyle(svg).animationTimingFunction : null,
    居中偏差: svgRect ? [Math.round((svgRect.left + svgRect.width/2 - (rect.left + rect.width/2))*100)/100, Math.round((svgRect.top + svgRect.height/2 - (rect.top + rect.height/2))*100)/100] : null,
    条带box: { x: Math.round(sRect.left), y: Math.round(sRect.top), width: Math.round(sRect.width), height: Math.round(sRect.height) },
  };
})()`);
console.log(JSON.stringify(report, null, 2));

// 3) 按条带区域截图（clip 用 CSS px，CDP 自己处理 DPR）
if (report?.条带box) {
  const b = report.条带box;
  const [vw, vh] = JSON.parse(await evaluate("JSON.stringify([innerWidth, innerHeight])"));
  const clip = {
    x: Math.max(0, b.x - 10),
    y: Math.max(0, b.y - 10),
    width: Math.min(b.width + 20, vw - Math.max(0, b.x - 10)),
    height: Math.min(b.height + 20, vh - Math.max(0, b.y - 10)),
    scale: 1,
  };
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip });
  if (shot.result?.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
    console.log(`截图已存：${OUT}  clip=${JSON.stringify(clip)}`);
  }
}
ws.close();
