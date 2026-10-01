/**
 * 验证「进入/退出完整视图」按钮对齐官方 `bl`：
 *  - 非完整视图：无底，图标 = expand（向外两个 L 角）
 *  - 完整视图：浅灰底（激活态），图标 = collapse（向内两个 L 角），气泡文案 = 退出完整视图
 * 对照官方截图。
 */
const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.OUT || path.join(__dirname, "..", ".screenshots");

const PROBE = () => {
  const btn = document.querySelector('[data-app-shell-workspace-layout-toggle="right-panel"]');
  if (!btn) return { found: false };
  const svg = btn.querySelector("svg");
  const paths = svg ? [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "") : [];
  // expand: 路径以 "M12 7" 开头；collapse: 以 "M5 14" 开头
  let icon = "?";
  if (paths.some((d) => d.startsWith("M12 7C12 6.44772"))) icon = "expand";
  else if (paths.some((d) => d.startsWith("M5 14C5 13.4477"))) icon = "collapse";
  const tip = document.querySelector('[data-ws-tip="1"]');
  return {
    found: true,
    icon,
    ariaLabel: btn.getAttribute("aria-label"),
    ariaPressed: btn.getAttribute("aria-pressed"),
    bgActive: btn.className.includes("bg-bghover"),
    tipLabel: tip ? tip.textContent.replace(/\s+/g, " ").trim() : null,
  };
};

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) ?? ctx.pages()[0];

  const fv = () => page.locator('[data-app-shell-workspace-layout-toggle="right-panel"]');
  const lc = () => page.locator('[data-app-shell-workspace-layout-toggle="main"]');
  const results = [];
  const push = (n, ok, d) => {
    results.push({ n, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${n}  ${d !== undefined ? JSON.stringify(d) : ""}`);
  };
  const hoverEl = async (loc) => {
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(420);
  };
  const unhover = async () => {
    await page.mouse.move(20, 700);
    await sleep(320);
  };
  const shot = async (name) => {
    const b = await lc().boundingBox();
    await page.screenshot({
      path: path.join(OUT, name),
      clip: { x: Math.max(0, b.x - 340), y: Math.max(0, b.y - 60), width: 500, height: 300 },
    });
    console.log("shot ->", name);
  };

  const bgActive = () =>
    page.evaluate(() => {
      const btn = document.querySelector('[data-app-shell-workspace-layout-toggle="right-panel"]');
      if (!btn) return null;
      // 注意：className 里恒有 "hover:bg-bghover"，includes() 会误匹配。
      // 用 classList 精确找无前缀的 bg-bghover（= 真正的激活态底色）。
      return [...btn.classList].some((c) => c === "bg-bghover");
    });

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  await unhover();

  // 官方在 chat 布局（零标签）下只显示布局控件，完整视图按钮只在有标签的标签栏里出现。
  // 所以先点布局控件新建一个标签 → 进入分屏态，才有这两个按钮。
  await lc().click();
  await sleep(1000);
  await unhover();

  let s = await page.evaluate(PROBE);
  push("分屏·图标=expand", s.icon === "expand", { icon: s.icon });
  push("分屏·无激活底(移开鼠标后)", (await bgActive()) === false, { bgActive: await bgActive() });
  push("分屏·aria=进入完整视图", s.ariaLabel === "进入完整视图", { ariaLabel: s.ariaLabel });

  // 悬停看气泡
  await hoverEl(fv());
  s = await page.evaluate(PROBE);
  push("分屏·hover气泡=进入完整视图", /进入完整视图/.test(s.tipLabel ?? ""), { tipLabel: s.tipLabel });
  await shot("verify-fv-A-enter.png");
  await unhover();

  // 进完整视图
  await fv().click();
  await sleep(900);
  await unhover();
  s = await page.evaluate(PROBE);
  push("完整视图·图标=collapse", s.icon === "collapse", { icon: s.icon });
  push("完整视图·有激活底(移开鼠标后仍在)", (await bgActive()) === true, { bgActive: await bgActive() });
  push("完整视图·aria-pressed=true", s.ariaPressed === "true", { ariaPressed: s.ariaPressed });
  push("完整视图·aria=退出完整视图", s.ariaLabel === "退出完整视图", { ariaLabel: s.ariaLabel });
  await shot("verify-fv-B-full.png");

  await hoverEl(fv());
  s = await page.evaluate(PROBE);
  push("完整视图·hover气泡=退出完整视图", /退出完整视图/.test(s.tipLabel ?? ""), { tipLabel: s.tipLabel });
  await shot("verify-fv-C-full-hover.png");
  await unhover();

  // 退出完整视图
  await fv().click();
  await sleep(800);
  await unhover();
  s = await page.evaluate(PROBE);
  push("退出后·图标=expand", s.icon === "expand", { icon: s.icon });
  push("退出后·无激活底(移开鼠标后)", (await bgActive()) === false, { bgActive: await bgActive() });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} PASS =====`);
  const fails = results.filter((r) => !r.ok);
  if (fails.length) console.log("FAILED:", fails.map((f) => f.n).join(" | "));
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
