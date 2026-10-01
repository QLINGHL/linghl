/**
 * 截整个应用窗口（不带 clip），输出与用户截图同尺度（DPR 1.75 → 约 2522×1598），
 * 这样可以和官方完整截图做**同像素尺度**的对比，不再依赖缩放倍率假设。
 */
const OUT = process.argv[2] || "shot-window.png";

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  // 清掉键盘操作留下的焦点环，避免截图里出现用户平时看不到的描边
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  console.log("viewport", JSON.stringify(info));
  await page.screenshot({ path: OUT });
  console.log("saved", OUT);
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
