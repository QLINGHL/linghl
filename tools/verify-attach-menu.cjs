/**
 * 验证「+」附件菜单：hover 出 tooltip、点开后的分组结构、面板尺寸。
 * 截图用整窗口（DPR 1.75），可直接与官方截图同尺度对比。
 */
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // 清掉上一轮可能残留的浮层（只用 Escape + 移开鼠标，别点原生菜单栏）
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.mouse.move(8, 300);
    await page.waitForTimeout(200);
  }

  const btn = page.locator('button[aria-label="添加文件等内容"]');
  console.log("加号按钮存在:", (await btn.count()) === 1);

  // 1. hover → tooltip
  await btn.hover();
  await page.waitForTimeout(600);
  const tip = await page.locator("text=添加文件等内容").count();
  console.log("tooltip 出现:", tip >= 1);
  await page.screenshot({ path: "shot-attach-tooltip.png" });

  // 2. 点击 → 菜单
  await btn.click();
  await page.waitForTimeout(700);
  const filesRow = await page.locator("text=文件和文件夹").count();
  const plugGroup = await page.locator("text=插件").count();
  const projectRow = await page.locator("text=在项目中使用 Work").count();
  console.log("菜单已开:", {
    文件和文件夹: filesRow,
    在项目中使用Work: projectRow,
    插件分组: plugGroup,
  });
  await page.screenshot({ path: "shot-attach-menu.png" });

  const box = await page.evaluate(() => {
    const wrappers = [...document.querySelectorAll("[data-radix-popper-content-wrapper]")];
    const el = wrappers[wrappers.length - 1]?.firstElementChild;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
  });
  console.log("菜单面板(CSS px):", JSON.stringify(box));

  // 3. 点「在项目中使用 Work」应切到项目选择器
  await page.locator("text=在项目中使用 Work").click();
  await page.waitForTimeout(700);
  const projPanel = await page.locator('input[aria-label="搜索项目"]').count();
  console.log("切到项目面板:", projPanel === 1);
  await page.keyboard.press("Escape");
  await page.mouse.move(8, 300);
  await page.waitForTimeout(300);

  console.log(errors.length ? "PAGE ERRORS: " + errors.join(" | ") : "无页面错误");
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
