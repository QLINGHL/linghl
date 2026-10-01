/** 用 CDP 驱动界面：打开分屏 → 地址栏输网址 → 上报页面区域矩形（供随后整屏取证）。 */
const path = require("path");
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.reload();
  await page.waitForTimeout(1800);
  await page.locator('button[aria-label="新建标签页"]').click();
  await page.waitForTimeout(900);
  const addr = page.locator('input[placeholder="搜索或输入网址"]');
  await addr.click();
  await addr.fill("https://example.com");
  await addr.press("Enter");
  await page.waitForTimeout(4000);
  const box = await page.locator('input[placeholder="搜索或输入网址"]').boundingBox();
  console.log("toolbar input box:", JSON.stringify(box));
  console.log("page area 估计: x=?", box.x);
  await page.mouse.move(8, 700);
  await page.waitForTimeout(300);
  await browser.close();
  console.log("DRIVE_DONE");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
