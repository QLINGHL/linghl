/**
 * 改动文件卡片 hover 预览的角色分工验收（对着真实运行中的应用，走 CDP）。
 *
 * 用户口径：
 *   - **单文件卡**：鼠标浮在卡片上，0.75 秒后出预览；
 *   - **多文件卡**：整卡悬浮**不出**预览，必须移到**具体那一行**，预览贴**那一行**
 *     （行上方空间够就浮在行上方，不够就翻到行下方）。
 *
 * 用法：node tools/verify-card-hover-multi.mjs
 */
const pw = await import("./playwright-loader.mjs");
const { chromium } = pw.default ?? pw;

const browser = await chromium.connectOverCDP(process.env.REPLICA_CDP || "http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("5173") || p.url().includes("main_window"));
if (!page) throw new Error("找不到渲染进程页面");

const snap = () =>
  page.evaluate(() => {
    const card = document.querySelector("[data-probe-card]");
    const prev = document.querySelector(".flow-diff-preview");
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const previewPath = prev ? prev.querySelector(".flow-diff-preview-path")?.textContent ?? null : null;
    // 被预览的那一行 = 标记卡里路径与浮层一致的那一行（页面里别张卡也有 data-file-index，
    // 直接 querySelector 会取到别的卡的行，量出来的几何全错）
    const rows = [...(card?.querySelectorAll(".flow-changed-row") ?? [])];
    const row = rows.find((x) => x.querySelector(".flow-changed-path")?.textContent === previewPath) ?? rows[0];
    return {
      multi: (card?.querySelectorAll(".flow-changed-row").length ?? 0) > 1,
      rowCount: card?.querySelectorAll(".flow-changed-row").length ?? 0,
      hasPreview: !!prev,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      rowRect: r(row) ? { y: Math.round(r(row).y), h: Math.round(r(row).height) } : null,
      prevRect: r(prev) ? { y: Math.round(r(prev).y), h: Math.round(r(prev).height), x: Math.round(r(prev).x), w: Math.round(r(prev).width) } : null,
      previewPath,
      rowPath: row?.querySelector(".flow-changed-path")?.textContent ?? null,
      hoveredPath: card?.getAttribute("data-hovered-path") ?? null,
    };
  });

// 打开一个多文件改动的会话，把目标卡片滚进视口并**打上标记**（后续定位一律限定在这张卡内，
// 否则 locator 会取到页面里第一张卡 —— 它常在视口外几万像素处，鼠标坐标全错）
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("aside button")].find((b) => b.innerText.includes("对齐 ChatGPT 回复流程"));
  if (btn) btn.click();
});
await page.waitForTimeout(3500);
const brought = await page.evaluate(() => {
  document.querySelectorAll("[data-probe-card]").forEach((el) => el.removeAttribute("data-probe-card"));
  const cards = [...document.querySelectorAll(".flow-changed")].filter((c) => c.querySelectorAll(".flow-changed-row").length > 1);
  const card = cards[cards.length - 1];
  if (!card) return false;
  card.setAttribute("data-probe-card", "1");
  card.scrollIntoView({ block: "center" });
  return true;
});
if (!brought) throw new Error("没找到多文件改动卡片");
await page.waitForTimeout(600);
const CARD = "[data-probe-card]";

const report = { steps: [] };

// ① 整卡（落到文件行以外的区域，例如卡片头）
const headBox = await page.locator(`${CARD} .flow-changed-head`).first().boundingBox();
await page.mouse.move(20, 20);
await page.waitForTimeout(300);
await page.mouse.move(headBox.x + headBox.width * 0.45, headBox.y + headBox.height / 2);
await page.waitForTimeout(1200); // 超过 0.75s 延迟
report.steps.push({ step: "① 停在卡片头 1.2s（多文件卡不应出预览）", state: await snap() });

// ② 移到第一行：应出预览，且贴在这一行
const rowBox = await page.locator(`${CARD} .flow-changed-row`).first().boundingBox();
await page.mouse.move(rowBox.x + 80, rowBox.y + rowBox.height / 2);
await page.waitForTimeout(1200);
const onRow = await snap();
report.steps.push({ step: "② 停在第一行 1.2s（应出预览且贴这一行）", state: onRow });

// ③ 移到另一行：预览内容应换成那一行的文件
const row2 = await page.locator(`${CARD} .flow-changed-row`).nth(1).boundingBox();
await page.mouse.move(row2.x + 80, row2.y + row2.height / 2);
await page.waitForTimeout(1200);
report.steps.push({ step: "③ 停到第二行 1.2s（预览应换成这一行）", state: await snap() });

const s = (n) => report.steps.find((x) => x.step.startsWith(n))?.state;
const onHead = s("①"), row1 = s("②"), row2s = s("③");
/** 浮层不能盖住触发它的那一行：两者纵向不能重叠 */
const noOverlap = (prev, row) => !!prev && !!row && (prev.y + prev.h <= row.y + 1 || prev.y >= row.y + row.h - 1);
/** 浮层要贴着那一行（上或下相邻，允许 40px 内的间隙） */
const adjacent = (prev, row) => !!prev && !!row
  && (Math.abs(row.y - (prev.y + prev.h)) <= 40 || Math.abs(prev.y - (row.y + row.h)) <= 40);
/** 浮层在行的上方（默认期望） */
const above = (prev, row) => !!prev && !!row && prev.y + prev.h <= row.y + 2;
report.verdict = {
  "多文件卡被识别": row1?.multi === true,
  "① 整卡（卡片头）悬浮不出预览": onHead?.hasPreview === false,
  "② 停在文件行 → 出预览": row1?.hasPreview === true,
  "② 预览不盖住这一行": noOverlap(row1?.prevRect, row1?.rowRect),
  "② 预览默认浮在这一行上方": above(row1?.prevRect, row1?.rowRect),
  "② 预览贴住这一行（相邻）": adjacent(row1?.prevRect, row1?.rowRect),
  "③ 换到第二行 → 预览内容跟着换": row2s?.hasPreview === true && row2s.previewPath !== row1.previewPath,
  "③ 预览同样不盖住第二行": noOverlap(row2s?.prevRect, row2s?.rowRect),
  "③ 预览同样贴住第二行": adjacent(row2s?.prevRect, row2s?.rowRect),
};
console.log(JSON.stringify(report, null, 2));
await browser.close();


