/**
 * 截取 Composer（含项目条）的精确截图。
 * 走 CDP 连到自家 Electron，用 clip 按 CSS px 裁剪 —— 避开显示器缩放导致
 * 屏幕截图坐标与 CSS 坐标不一致的问题（win-capture.py 是整屏截图，换算易错）。
 *
 * 用法: node tools/shot-composer.cjs [输出文件名]
 */
const OUT = process.argv[2] || "shot-composer.png";

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];

  const box = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="消息输入框"]');
    if (!ta) return null;
    const outer = ta.closest("div.w-full");
    const r = (outer ?? ta).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) {
    console.error("找不到 Composer");
    await browser.close();
    process.exit(1);
  }
  // 键盘操作过之后按钮会带 :focus-visible 描边（橙色环），截图前先清掉，
  // 否则截出来的图会多一个用户平时看不到的焦点环
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(150);

  // 四周各留 12px，便于看清阴影
  const clip = {
    x: Math.max(0, box.x - 12),
    y: Math.max(0, box.y - 12),
    width: box.width + 24,
    height: box.height + 24,
  };
  console.log("composer box", JSON.stringify(box));
  await page.screenshot({ path: OUT, clip });
  console.log("saved", OUT);
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
