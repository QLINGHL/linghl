const { chromium } = require("playwright");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) ?? ctx.pages()[0];
  const dump = async (tag) => {
    const r = await page.evaluate(() => {
      const btn = document.querySelector('[data-app-shell-workspace-layout-toggle="main"]');
      if (!btn) return { found: false };
      const svg = btn.querySelector("svg");
      return {
        aria: btn.getAttribute("aria-label"),
        cls: btn.className,
        svgHTML: svg ? svg.innerHTML.replace(/\s+/g, " ").trim() : null,
      };
    });
    console.log("==== " + tag + " ====");
    console.log(JSON.stringify(r, null, 1));
  };
  await dump("当前状态");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
