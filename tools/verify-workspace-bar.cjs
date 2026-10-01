/**
 * 验证工作区内容标签页（对齐官方 threadWorkspace）：
 *  首页（chat 布局，右上角浮一个方框加号控件）
 *   → hover 展开两项菜单 → 点「新建标签页」进分屏（左聊天 / 右内置浏览器）
 *   → 再点「在完整视图中打开新标签页」进完整视图（同一条标签栏）
 *   → Ctrl+Shift+F 切回分屏 → 关标签回落 chat
 * 用法：node tools/verify-workspace-bar.cjs
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
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  const state = () =>
    page.evaluate(() => {
      const main = document.querySelector("main");
      return {
        bar: !!document.querySelector('main [aria-label="进入完整视图"], main [aria-label="退出完整视图"]'),
        pills: [...document.querySelectorAll("main button[aria-label='关闭标签页']")].length,
        hasBrowserToolbar: !!document.querySelector('input[placeholder="搜索或输入网址"]'),
        text: (main.innerText || "").replace(/\n+/g, " | ").slice(0, 160),
      };
    });

  const ctl = page.locator('button[aria-label="新建标签页"]');
  console.log("控件数量(chat 布局应为 1):", await ctl.count());
  const box = await ctl.boundingBox();
  console.log("控件 box:", JSON.stringify({ x: +box.x.toFixed(1), y: +box.y.toFixed(1), w: box.width, h: box.height }));
  await page.mouse.move(5, 500);
  await page.waitForTimeout(200);
  await page.screenshot({ path: OUT("ws2-1-home.png") });

  // hover → 菜单
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
  const menu = page.locator('[role="menu"][aria-label="新建标签页"]');
  console.log("hover 展开菜单:", await menu.count());
  await page.screenshot({ path: OUT("ws2-2-menu.png"), clip: { x: box.x - 330, y: box.y - 14, width: 380, height: 140 } });

  // 点第一项 → 分屏
  await page.locator('[role="menuitem"]').first().click();
  await page.waitForTimeout(700);
  await page.mouse.move(5, 640);
  await page.waitForTimeout(250);
  console.log("分屏:", JSON.stringify(await state()));
  await page.screenshot({ path: OUT("ws2-3-split.png") });

  // 再点第二项 → 完整视图
  const ctl2 = page.locator('button[aria-label="新建标签页"]').last();
  const box2 = await ctl2.boundingBox();
  console.log("分屏后控件数量:", await page.locator('button[aria-label="新建标签页"]').count());
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.waitForTimeout(350);
  const items = await page.locator('[role="menuitem"]').allInnerTexts();
  console.log("菜单项:", JSON.stringify(items));
  await page.locator('[role="menuitem"]').nth(1).click();
  await page.waitForTimeout(700);
  await page.mouse.move(5, 640);
  await page.waitForTimeout(250);
  console.log("完整视图:", JSON.stringify(await state()));
  await page.screenshot({ path: OUT("ws2-4-full.png") });

  // Ctrl+Shift+F → 切回分屏
  await page.keyboard.press("Control+Shift+F");
  await page.waitForTimeout(500);
  await page.mouse.move(5, 640);
  await page.waitForTimeout(200);
  console.log("Ctrl+Shift+F 后:", JSON.stringify(await state()));
  await page.screenshot({ path: OUT("ws2-5-split-again.png") });

  // 地址栏导航
  const addr = page.locator('input[placeholder="搜索或输入网址"]');
  if (await addr.count()) {
    await addr.fill("https://developers.openai.com/codex");
    await addr.press("Enter");
    await page.waitForTimeout(1500);
    console.log("webview 数量:", await page.locator("webview").count());
  }
  await page.screenshot({ path: OUT("ws2-6-browser.png") });

  // 关标签 → 回 chat 布局
  await page.locator('button[aria-label="关闭标签页"]').first().click();
  await page.waitForTimeout(400);
  await page.mouse.move(5, 640);
  await page.waitForTimeout(200);
  console.log("关标签后:", JSON.stringify(await state()));
  await page.screenshot({ path: OUT("ws2-7-closed.png") });

  await browser.close();
  console.log("DONE");
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
