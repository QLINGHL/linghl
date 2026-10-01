const path = require("path");
const OUT = (n) => path.join(__dirname, "..", "..", n);
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.reload();
  await page.waitForTimeout(1700);
  const ctl = () => page.locator('main div.relative > button[aria-haspopup="menu"]').last();
  const clip = { x: 1040, y: 0, width: 401, height: 170 };
  const hover = async () => { const b = await ctl().boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(400); };
  await page.mouse.move(5, 600); await page.waitForTimeout(300);
  await hover(); await page.screenshot({ path: OUT("ws4-a-newtab.png"), clip });          // 新建标签页
  await page.mouse.move(5, 600); await page.waitForTimeout(200);
  await ctl().click(); await page.waitForTimeout(700);
  await page.mouse.move(5, 600); await page.waitForTimeout(300);
  await hover(); await page.screenshot({ path: OUT("ws4-b-hidetabs.png"), clip });        // 隐藏标签页
  await page.mouse.move(5, 600); await page.waitForTimeout(200);
  await page.keyboard.press("Control+Shift+F"); await page.waitForTimeout(600);
  await page.mouse.move(5, 600); await page.waitForTimeout(300);
  await hover(); await page.screenshot({ path: OUT("ws4-c-splitview.png"), clip });       // 进入分屏视图
  await page.mouse.move(5, 600); await page.waitForTimeout(200);
  await browser.close();
  console.log("SHOTS_OK");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
