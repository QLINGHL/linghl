/**
 * 验证右上角布局控件的**四态气泡文案**（对齐官方 view-control-labels）：
 *   chat+无标签 → 新建标签页 → 点一下进分屏 → 隐藏标签页 → 点一下隐藏 → 显示标签页
 *   → 点一下回分屏 → Ctrl+Shift+F 完整视图 → 进入分屏视图
 * 同时量气泡卡片尺寸（官方 172×29 CSS px）。
 * 用法：node tools/verify-ws-tooltip.cjs
 */
const path = require("path");
const OUT = (n) => path.join(__dirname, "..", "..", n);

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.reload();
  await page.waitForTimeout(1800);

  const ctl = () => page.locator('main div.relative > button[aria-haspopup="menu"]').last();
  const tipText = async () => {
    const tip = page.locator("main kbd").first();
    if (!(await tip.count())) return null;
    const card = tip.locator("..");
    const t = (await card.innerText()).replace(/\n/g, " | ");
    const box = await card.boundingBox();
    return { text: t, w: box ? +box.width.toFixed(1) : null, h: box ? +box.height.toFixed(1) : null };
  };
  const hoverTip = async (ms = 380) => {
    const box = await ctl().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(ms);
    return tipText();
  };

  console.log("① chat 布局（无内容标签）:", JSON.stringify(await hoverTip()));
  await page.screenshot({ path: OUT("ws4-1-tip-newtab.png"), clip: { x: 1040, y: 0, width: 401, height: 170 } });

  // 点一下 = 新建标签页 → 分屏
  await ctl().click();
  await page.waitForTimeout(700);
  console.log("   点后布局:", await page.evaluate(() => document.querySelector("main").innerText.slice(0, 24)));
  await page.mouse.move(5, 650);
  await page.waitForTimeout(400);
  console.log("② 分屏视图:", JSON.stringify(await hoverTip()));
  await page.screenshot({ path: OUT("ws4-2-tip-hidetabs.png"), clip: { x: 1040, y: 0, width: 401, height: 170 } });

  // 点一下 = 隐藏标签页（回聊天布局，标签保留）
  await ctl().click();
  await page.waitForTimeout(600);
  await page.mouse.move(5, 650);
  await page.waitForTimeout(400);
  const s3 = await hoverTip();
  console.log("③ 隐藏后:", JSON.stringify(s3));

  // 点一下 = 显示标签页
  await ctl().click();
  await page.waitForTimeout(600);
  await page.mouse.move(5, 650);
  await page.waitForTimeout(400);
  console.log("④ 回到分屏，再 hover:", JSON.stringify(await hoverTip()));

  // Ctrl+Shift+F → 完整视图 → 进入分屏视图
  await page.keyboard.press("Control+Shift+F");
  await page.waitForTimeout(600);
  await page.mouse.move(5, 650);
  await page.waitForTimeout(400);
  console.log("⑤ 完整视图:", JSON.stringify(await hoverTip()));
  await page.screenshot({ path: OUT("ws4-3-tip-split.png"), clip: { x: 1040, y: 0, width: 401, height: 170 } });

  // 完整视图下点一下 = 进入分屏视图
  await ctl().click();
  await page.waitForTimeout(600);
  await page.mouse.move(5, 650);
  await page.waitForTimeout(300);
  console.log("⑥ 点后应回到分屏:", JSON.stringify(await hoverTip()));

  // 悬停久一点 → 两项目菜单（不是气泡）
  const box = await ctl().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(900);
  console.log("⑦ 停留后菜单项:", JSON.stringify(await page.locator('[role="menuitem"]').allInnerTexts()));

  await page.mouse.move(5, 650);
  await page.waitForTimeout(400);
  await browser.close();
  console.log("DONE");
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
