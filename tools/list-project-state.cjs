/** 只读打印本应用 desk-state 里的项目清单（用于排查误加的项目） */
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  const desk = await page.evaluate(async () => {
    const d = await window.codex.getDeskState();
    return { projects: d?.projects ?? [], activeProject: d?.activeProject ?? null };
  });
  console.log("desk-state 里的项目:");
  desk.projects.forEach((p, i) => console.log(`  [${i}] ${p.name}  ${p.path}  lastOpenedAt=${p.lastOpenedAt}`));
  console.log("总数:", desk.projects.length);
  const ui = await page.evaluate(() => document.querySelector('button[title="更改此聊天的项目"]')?.innerText?.trim() ?? null);
  console.log("界面上项目条显示:", JSON.stringify(ui));
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
