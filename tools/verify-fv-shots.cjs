const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.OUT || path.join(__dirname, "..", ".screenshots");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) ?? ctx.pages()[0];
  const fv = () => page.locator('[data-app-shell-workspace-layout-toggle="right-panel"]');
  const lc = () => page.locator('[data-app-shell-workspace-layout-toggle="main"]');
  const shot = async (name) => {
    const bx = await lc().boundingBox();
    await page.screenshot({ path: path.join(OUT, name), clip: { x: bx.x - 320, y: bx.y - 46, width: 460, height: 120 } });
    console.log("shot", name);
  };
  await lc().click();
  await sleep(1000);
  await page.mouse.move(20, 700);
  await sleep(500);
  const label = await fv().getAttribute("aria-label");
  if (label === "退出完整视图") {
    await fv().click();
    await sleep(900);
    await page.mouse.move(20, 700);
    await sleep(400);
  }
  await shot("verify-fv-D-split-clean.png");
  await fv().click();
  await sleep(1000);
  await page.mouse.move(20, 700);
  await sleep(500);
  await shot("verify-fv-E-full-clean.png");
  console.log("done");
  await b.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
