(async () => {
/**
 * 卡片 hover 预览的行为验收（对着真实运行中的应用跑，走 CDP）。
 *
 * 验收点（用户明确要求的语义，延迟 0.75 秒）：
 *   ① 鼠标停在卡片上 **不立刻** 出浮层 —— 约 0.75 秒后才出现；
 *   ② 鼠标从卡片移到浮层上 → 浮层 **立刻** 消失、卡片底色 **立刻** 复原；
 *   ③ 指针停在浮层上不会让它重新出现（浮层不参与 hover 判定）。
 *
 * 用法：node tools/verify-card-hover.mjs
 */
const pw = await import("./playwright-loader.mjs");
const { chromium } = pw.default ?? pw;

const cdp = process.env.REPLICA_CDP || "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes("5173") || p.url().includes("main_window"));
if (!page) throw new Error("找不到渲染进程页面");

const state = () =>
  page.evaluate(() => {
    const card = document.querySelector(".flow-changed");
    const prev = document.querySelector(".flow-diff-preview");
    return {
      hasCard: !!card,
      hasPreview: !!prev,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      previewH: prev ? Math.round(prev.getBoundingClientRect().height) : 0,
      previewLines: document.querySelectorAll(".flow-diff-preview .flow-diff-line").length,
    };
  });

// 先确保打开一个有改动卡片的会话
const opened = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("aside button")].find((b) => b.innerText.includes("对齐 ChatGPT 回复流程"));
  if (btn) { btn.click(); return "opened"; }
  return "already";
});
await page.waitForTimeout(3500);

/** 把一张**单文件**改动卡片滚进视口并打标记（多文件卡的行为另有 verify-card-hover-multi） */
async function bringCardIntoView() {
  const ok = await page.evaluate(() => {
    document.querySelectorAll("[data-probe-card]").forEach((el) => el.removeAttribute("data-probe-card"));
    const cards = [...document.querySelectorAll(".flow-changed")];
    const card = [...cards].reverse().find((c) => c.querySelectorAll(".flow-changed-row").length === 0) ?? cards[0];
    if (!card) return false;
    card.setAttribute("data-probe-card", "1");
    card.scrollIntoView({ block: "center" });
    return true;
  });
  if (!ok) throw new Error("当前会话里没有改动文件卡片（flow-changed）");
  await page.waitForTimeout(500); // 等滚动稳定
  const box = await page.locator("[data-probe-card]").boundingBox();
  if (!box) throw new Error("拿不到卡片位置");
  return box;
}

const CARD = "[data-probe-card]";
const cardBox = await bringCardIntoView();
const report = { opened, cardBox, steps: [] };

// 起点：鼠标挪到卡片外（左上角标题栏区域），确保不是从「已在卡片上」开始
await page.mouse.move(20, 20);
await page.waitForTimeout(400);
report.steps.push({ step: "起点（鼠标在卡片外）", state: await state() });

// ① 进入卡片，立刻采样：应该还没有浮层
const cx = cardBox.x + cardBox.width / 2;
const cy = cardBox.y + cardBox.height / 2;
await page.mouse.move(cx, cy, { steps: 5 });
const t0 = Date.now();
await page.waitForTimeout(250);
report.steps.push({ step: "进入卡片 +250ms（应无浮层、底色已变灰）", elapsed: Date.now() - t0, state: await state() });

// 中段再采一次（仍应无浮层：延迟是 750ms）
await page.waitForTimeout(300);
report.steps.push({ step: "进入卡片 +550ms（应仍无浮层）", elapsed: Date.now() - t0, state: await state() });

// ② 等过 0.75 秒：浮层应出现
await page.waitForTimeout(500);
report.steps.push({ step: "进入卡片 +1050ms（浮层应已出现）", elapsed: Date.now() - t0, state: await state() });

// ② 移到浮层上：先一步跨到卡片与浮层之间的间隙（真正的「离开卡片」），
//    再进入浮层区域。两步都必须立刻反馈。
const prevBox = await page.locator(".flow-diff-preview").boundingBox();
const cardBoxNow = await page.locator(CARD).first().boundingBox();
const gapY = (prevBox.y + prevBox.height + cardBoxNow.y) / 2; // 间隙正中
await page.mouse.move(prevBox.x + prevBox.width / 2, gapY); // 一步（不插值）
await page.waitForTimeout(100);
report.steps.push({ step: "跨到卡片外间隙 +100ms（浮层应已消失、底色回白）", state: await state(), where: { gapY, cardTop: cardBoxNow.y, prevBottom: prevBox.y + prevBox.height } });
await page.waitForTimeout(700);
report.steps.push({ step: "停在间隙 +800ms（保持消失）", state: await state() });

// ②b 再进入浮层内部
await page.mouse.move(prevBox.x + prevBox.width / 2, prevBox.y + 20);
await page.waitForTimeout(150);
report.steps.push({ step: "停在浮层内部 +150ms（仍然不生出来）", state: await state() });

// ④ 回到卡片：再等 0.75 秒应重新出现（确认延迟依然生效）
await page.mouse.move(cx, cy, { steps: 5 });
await page.waitForTimeout(250);
report.steps.push({ step: "回到卡片 +250ms（应无浮层）", state: await state() });
await page.waitForTimeout(700);
report.steps.push({ step: "回到卡片 +950ms（浮层应再次出现）", state: await state() });

const s = (name) => report.steps.find((x) => x.step.startsWith(name))?.state;
report.verdict = {
  "① 250ms 时无浮层（不是立刻出现）": s("进入卡片 +250ms")?.hasPreview === false,
  "① 550ms 时仍无浮层（延迟 ≈0.75s）": s("进入卡片 +550ms")?.hasPreview === false,
  "① 1050ms 时浮层出现": s("进入卡片 +1050ms")?.hasPreview === true,
  "② 离开卡片立刻消失": s("跨到卡片外间隙 +100ms")?.hasPreview === false,
  "② 离开卡片底色立刻复原": s("跨到卡片外间隙 +100ms")?.cardBg === "rgb(255, 255, 255)",
  "③ 停在浮层上也不生出来": s("停在浮层内部 +150ms")?.hasPreview === false,
  "④ 回到卡片后再次延迟出现": s("回到卡片 +250ms")?.hasPreview === false && s("回到卡片 +950ms")?.hasPreview === true,
};
console.log(JSON.stringify(report, null, 2));
await browser.close();

})().catch((e) => { console.error(e); process.exit(1); });

