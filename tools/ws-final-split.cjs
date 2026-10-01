/** 收尾：把工作区留成"分屏 + 一个新标签页"（对齐官方参考截图那一屏）并截图。 */
const path = require("path");
const OUT = (n) => path.join(__dirname, "..", "..", n);
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.reload();
  await page.waitForTimeout(1800);
  await page.locator('button[aria-label="新建标签页"]').click();
  await page.waitForTimeout(800);
  await page.mouse.move(6, 660);
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT("ws2-final-split.png") });
  await browser.close();
  console.log("saved ws2-final-split.png");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
