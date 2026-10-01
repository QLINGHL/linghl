/**
 * 临时登记几个项目，验证「项目条显示项目名 + 项目面板列表」的完整效果，
 * 截图后把 desk-state 恢复原状（只动本应用自己的 desk-state.json，
 * 不碰 ~/.codex，也不碰当前环境的 codex-home）。
 */
const TEST_PROJECTS = [
  { name: "cUI", path: "/project" },
  { name: "a2asciSol", path: "D:\\a2asciSol" },
  { name: "a2asci", path: "D:\\a2asci" },
  { name: "paper", path: "D:\\paper" },
];

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  const original = await page.evaluate(async () => {
    const desk = await window.codex.getDeskState();
    return desk?.projects ?? [];
  });
  console.log("原有项目数:", original.length);

  await page.evaluate(async (list) => {
    const now = Date.now();
    await window.codex.setDeskState({
      projects: list.map((p, i) => ({ ...p, lastOpenedAt: now - i * 1000 })),
    });
  }, TEST_PROJECTS);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const box = await page.evaluate(() => {
    const ta = document.querySelector('textarea[aria-label="消息输入框"]');
    if (!ta) return null;
    const outer = ta.closest("div.w-full");
    const r = (outer ?? ta).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) {
    console.error("reload 后找不到 Composer");
    process.exit(1);
  }
  const clip = {
    x: Math.max(0, box.x - 60),
    y: Math.max(0, box.y - 320),
    width: box.width + 120,
    height: box.height + 340,
  };

  // 项目条应显示第一个项目名
  const barText = await page.locator('button[title="更改此聊天的项目"]').innerText();
  console.log("项目条文案:", JSON.stringify(barText.trim()));
  await page.screenshot({ path: "shot-bar-with-project.png", clip });

  // hover 看「移除」按钮
  await page.locator('button[title="更改此聊天的项目"]').hover();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot-bar-hover-project.png", clip });

  // 打开面板看列表
  await page.locator('button[title="更改此聊天的项目"]').click();
  await page.waitForTimeout(600);
  const items = await page.locator("text=a2asciSol").count();
  console.log("面板里能看到项目:", items >= 1);
  await page.screenshot({ path: "shot-project-menu-full.png", clip });

  // 搜索过滤
  await page.locator('input[aria-label="搜索项目"]').fill("a2");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "shot-project-search.png", clip });

  // 恢复
  await page.keyboard.press("Escape");
  await page.evaluate(async (orig) => {
    await window.codex.setDeskState({ projects: orig });
  }, original);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const restored = await page.evaluate(() => document.querySelector('button[title="更改此聊天的项目"]')?.innerText?.trim());
  console.log("恢复后项目条:", JSON.stringify(restored));
  console.log(errors.length ? "PAGE ERRORS: " + errors.join(" | ") : "无页面错误");
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
