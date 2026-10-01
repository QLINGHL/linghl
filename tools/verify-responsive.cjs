/**
 * 验证响应式侧栏：官方阈值是 768px（窗口宽 < 768 时侧栏宽度归零）。
 * 用 CDP 的 Browser.setWindowBounds 真正改窗口尺寸（Electron 的 window.resizeTo 不可靠）。
 */
const SIZES = [480, 700, 767, 768, 900, 1365];

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  // Electron 的 CDP 没有 Browser.getWindowForTarget / setWindowBounds，
  // 改用 Emulation 改渲染视口宽度 + 手动派发 resize 来驱动应用的响应式逻辑
  const client = await page.context().newCDPSession(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  const reset = async () => {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.mouse.move(8, 300);
      await page.waitForTimeout(150);
    }
  };

  for (const w of SIZES) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: 800,
      deviceScaleFactor: 1.75,
      mobile: false,
    });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(500);
    await reset();
    const info = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      const rail = document.querySelector("aside")?.previousElementSibling;
      const ta = document.querySelector('textarea[aria-label="消息输入框"]');
      const comp = ta?.closest("div.w-full");
      return {
        innerW: innerWidth,
        railW: rail ? Math.round(rail.getBoundingClientRect().width) : null,
        sidebarW: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
        composerW: comp ? Math.round(comp.getBoundingClientRect().width) : null,
      };
    });
    console.log(
      `窗口 ${String(w).padStart(4)} → 实际 ${String(info.innerW).padStart(4)} | 活动栏 ${info.railW} | 侧栏 ${String(info.sidebarW).padStart(3)} | 输入框 ${info.composerW}`,
    );
    if (w === 480) await page.screenshot({ path: "shot-narrow-480.png" });
    if (w === 900) await page.screenshot({ path: "shot-wide-900.png" });
  }

  // 还原视口
  await client.send("Emulation.clearDeviceMetricsOverride");
  console.log(errors.length ? "PAGE ERRORS: " + errors.join(" | ") : "无页面错误");
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
