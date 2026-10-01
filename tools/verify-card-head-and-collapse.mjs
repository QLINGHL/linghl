/**
 * 多文件卡：卡片头 hover 行为 + 展开/收回 验收（对真实运行中的应用，走 CDP）。
 *
 * 用户口径：
 *   - 鼠标浮在**卡片头**（「Edited N files」那一行）→ 与单文件卡一致：
 *     底色变灰、副标题切成「View changes ↗」，**但不出预览**（预览只归具体文件行）；
 *   - 列表展开后要能**收回**（官方是「Collapse files ⌃」）。
 *
 * 用法：node tools/verify-card-head-and-collapse.mjs
 */
const pw = await import("./playwright-loader.mjs");
const { chromium } = pw.default ?? pw;

const browser = await chromium.connectOverCDP(process.env.REPLICA_CDP || "http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("5173") || p.url().includes("main_window"));
if (!page) throw new Error("找不到渲染进程页面");

const snap = () =>
  page.evaluate(() => {
    const card = document.querySelector("[data-probe-card]");
    const head = card?.querySelector(".flow-changed-head");
    const prev = document.querySelector(".flow-diff-preview");
    const rows = card?.querySelectorAll(".flow-changed-row").length ?? 0;
    const moreBtn = card?.querySelector(".flow-changed-more");
    return {
      hasPreview: !!prev,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      subtitle: head?.querySelector(".flow-changed-viewlink")?.textContent?.trim()
        ?? head?.querySelector(".flow-changed-total")?.textContent?.trim() ?? null,
      cardName: head?.querySelector(".flow-changed-name")?.textContent?.trim() ?? null,
      rowCount: rows,
      moreLabel: moreBtn?.textContent?.trim() ?? null,
      totalFiles: document.querySelectorAll("[data-probe-card] .flow-changed-row").length,
    };
  });

// 打开会话，锁定一张多文件卡并滚进视口
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("aside button")].find((b) => b.innerText.includes("对齐 ChatGPT 回复流程"));
  if (btn) btn.click();
});
await page.waitForTimeout(3500);
const ok = await page.evaluate(() => {
  document.querySelectorAll("[data-probe-card]").forEach((el) => el.removeAttribute("data-probe-card"));
  const cards = [...document.querySelectorAll(".flow-changed")].filter((c) => c.querySelectorAll(".flow-changed-row").length > 1);
  const card = cards[cards.length - 1];
  if (!card) return false;
  card.setAttribute("data-probe-card", "1");
  card.scrollIntoView({ block: "center" });
  return true;
});
if (!ok) throw new Error("没找到多文件改动卡片");
await page.waitForTimeout(600);

const report = { steps: [] };
const headBox = await page.locator("[data-probe-card] .flow-changed-head").first().boundingBox();

// ① 卡片头 hover
await page.mouse.move(20, 20);
await page.waitForTimeout(300);
report.steps.push({ step: "起点（卡片外）", state: await snap() });
await page.mouse.move(headBox.x + headBox.width * 0.4, headBox.y + headBox.height / 2);
await page.waitForTimeout(1200);
report.steps.push({ step: "① 停在卡片头 1.2s（应变灰 + View changes，且不出预览）", state: await snap() });

// ② 展开列表（点 Show N more files）
const moreBefore = await page.locator("[data-probe-card] .flow-changed-more").first().textContent();
await page.locator("[data-probe-card] .flow-changed-more").first().click();
await page.waitForTimeout(500);
report.steps.push({ step: "② 点击展开（行数应变多、按钮变 Collapse files）", clickedLabel: moreBefore?.trim(), state: await snap() });

// ③ 收回
await page.locator("[data-probe-card] .flow-changed-more").first().click();
await page.waitForTimeout(500);
report.steps.push({ step: "③ 点击收回（行数应变回 3、按钮变回 Show N more files）", state: await snap() });

const s = (n) => report.steps.find((x) => x.step.startsWith(n))?.state;
const start = s("起点"), onHead = s("①"), expanded = s("②"), collapsed = s("③");
report.verdict = {
  "① 卡片头 hover → 底色变灰": onHead?.cardBg === "rgb(249, 249, 249)",
  "① 卡片头 hover → 副标题变 View changes": /View changes/.test(onHead?.subtitle ?? ""),
  "① 卡片头 hover → 不出预览": onHead?.hasPreview === false,
  "① 卡片头名字仍是 Edited N files": /Edited .* files/.test(onHead?.cardName ?? ""),
  "② 初始只列 3 行": start?.rowCount === 3,
  "② 展开后行数变多": (expanded?.rowCount ?? 0) > 3,
  "② 展开后按钮变 Collapse files": /Collapse files/.test(expanded?.moreLabel ?? ""),
  "③ 收回后行数回到 3": collapsed?.rowCount === 3,
  "③ 收回后按钮变回 Show N more files": /Show .* more files/.test(collapsed?.moreLabel ?? ""),
};
console.log(JSON.stringify(report, null, 2));
await browser.close();
