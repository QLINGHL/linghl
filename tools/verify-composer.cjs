/**
 * 验证 Composer 的三个交互态并截图（供与官方截图逐张对照）：
 *   1. 项目条 hover —— 深色 tooltip + 左侧变成「移除」按钮
 *   2. 点击项目条 —— 项目搜索面板
 *   3. 点击权限按钮 —— 权限下拉面板
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

  const box = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="消息输入框"]');
    if (!ta) return null;
    const outer = ta.closest("div.w-full");
    const r = (outer ?? ta).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) {
    console.error("找不到 Composer");
    process.exit(1);
  }
  // 弹层在 Composer 上方展开，clip 要往上留足
  const clip = {
    x: Math.max(0, box.x - 60),
    y: Math.max(0, box.y - 300),
    width: box.width + 120,
    height: box.height + 320,
  };

  // 上一次运行留下的浮层会挡住点击（connectOverCDP 断开连接不会关页面），先清干净。
  // 只用 Escape + 把鼠标移到空白处：别 mouse.click(6,6) —— 那会点到原生菜单栏。
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.mouse.move(8, 420);
    await page.waitForTimeout(220);
  }
  await page.waitForTimeout(400);

  const bar = page.locator('button[title="更改此聊天的项目"]');
  console.log("项目条存在:", (await bar.count()) === 1);

  /** Radix 的 DismissableLayer 在 Escape 关闭后会残留一拍，
   *  紧接着点下一个触发按钮会被它当成"关闭上一层的点击"吃掉。
   *  所以每次关面板后都要把鼠标移开并多等一会儿。 */
  const settle = async () => {
    await page.keyboard.press("Escape");
    await page.mouse.move(8, 8);
    await page.waitForTimeout(700);
  };

  // 1. hover
  await bar.hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot-bar-hover.png", clip });

  // 2. 打开项目面板
  await bar.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot-project-menu.png", clip });
  const menuCount = await page.locator('input[aria-label="搜索项目"]').count();
  console.log("项目面板已开:", menuCount === 1);
  await settle();

  // 3. 权限面板（打不开就重试一次，抗上面的残留）
  const permBtn = page.locator('button[title="更改权限"]');
  console.log("权限按钮存在:", (await permBtn.count()) === 1);
  await permBtn.click();
  await page.waitForTimeout(500);
  if ((await page.locator("text=应如何批准").count()) === 0) {
    await page.mouse.move(8, 8);
    await page.waitForTimeout(400);
    await permBtn.click();
    await page.waitForTimeout(500);
  }
  const permOpen = (await page.locator("text=应如何批准").count()) >= 1;
  console.log("权限面板打开:", permOpen);
  await page.screenshot({ path: "shot-perm-menu.png", clip });
  await settle();

  // 4. 快捷键
  await page.keyboard.press("Control+Alt+Shift+O");
  await page.waitForTimeout(600);
  const afterKey = await page.locator('input[aria-label="搜索项目"]').count();
  console.log("快捷键 Ctrl+Alt+Shift+O 打开面板:", afterKey === 1);
  await settle();

  console.log(errors.length ? "PAGE ERRORS: " + errors.join(" | ") : "无页面错误");
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
