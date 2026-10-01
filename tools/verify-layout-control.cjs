/**
 * 验证右上角「布局控件」对齐官方 `Sl` 的**三分支状态机**：
 *
 *  ① 聊天 + 零标签  → 图标「方框加号」，hover **立刻**弹两项目菜单
 *  ② 聊天 + 有标签（隐藏态）→ 图标「方框加号 + 数字徽标」，hover 出「已打开的标签页」列表
 *  ③ 分屏 / 完整视图（有标签）→ 图标「**两栏**」（不是方框加号！），hover **只有 tooltip**、
 *     绝对不再有那两项目菜单
 *
 * 断言「③ 不该出现方框加号 / 不该出现两项目菜单」正是用户这次的要求。
 */
const { chromium } = require("playwright");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.OUT || path.join(__dirname, "..", ".screenshots");

const PROBE = () => {
  const btn = document.querySelector('[data-app-shell-workspace-layout-toggle="main"]');
  if (!btn) return { found: false };
  const svg = btn.querySelector("svg");
  let icon = "?";
  if (svg) {
    const rects = svg.querySelectorAll("rect").length;
    const paths = [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "");
    const hasPlus = paths.some((d) => d.includes("v9.2") && d.includes("h9.2"));
    const hasDivider = paths.some((d) => d === "M12 4.9v14.2");
    // 官方隐藏态：圆角方框 + 框内数字（CountBoxIcon）—— rect 但无加号/无分隔线
    if (rects >= 1 && hasPlus) icon = "square-plus";
    else if (rects >= 1 && hasDivider) icon = "split";
    else if (rects >= 1) icon = "count-box";
  }
  // 数字徽标（分支②）：框内 span 写纯数字
  const badge = [...btn.querySelectorAll("span")].find((s) => /^\d+$/.test(s.textContent?.trim() || ""));
  const menu = document.querySelector('[role="menu"]');
  const menuItems = menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.replace(/\s+/g, " ").trim()) : [];
  const menuHeading = menu ? menu.querySelector("div")?.textContent?.trim() : null;
  const tips = [...document.querySelectorAll('[data-ws-tip="1"]')].map((n) => n.textContent.replace(/\s+/g, " ").trim());
  return {
    found: true,
    icon,
    badge: badge ? badge.textContent.trim() : null,
    ariaLabel: btn.getAttribute("aria-label"),
    hasMenu: !!menu,
    menuItems,
    menuHeading,
    tips,
  };
};

(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) ?? ctx.pages()[0];

  const btn = () => page.locator('[data-app-shell-workspace-layout-toggle="main"]');
  const results = [];
  const push = (n, ok, d) => {
    results.push({ n, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${n}  ${d !== undefined ? JSON.stringify(d) : ""}`);
  };
  const hover = async () => {
    const b = await btn().boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(420);
  };
  const unhover = async () => {
    await page.mouse.move(20, 700);
    await sleep(320);
  };
  const shot = async (name) => {
    const b = await btn().boundingBox();
    await page.screenshot({
      path: path.join(OUT, name),
      clip: { x: Math.max(0, b.x - 300), y: Math.max(0, b.y - 20), width: 460, height: Math.min(913 - b.y + 10, 280) },
    });
    console.log("shot ->", name);
  };

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  await unhover();

  // ===== 分支①：聊天 + 零标签 =====
  let s = await page.evaluate(PROBE);
  push("①零标签·图标=方框加号", s.icon === "square-plus", { icon: s.icon });
  push("①零标签·无数字徽标", s.badge === null, { badge: s.badge });
  await hover();
  s = await page.evaluate(PROBE);
  push("①零标签·hover弹两项目菜单", s.hasMenu && s.menuItems.length === 2, { menuItems: s.menuItems });
  push("①零标签·无tooltip", s.tips.length === 0, { tips: s.tips });
  await shot("verify-lc-A-empty.png");

  // ===== 分支③：点一下 → 进分屏（有标签） =====
  await btn().click();
  await sleep(900);
  await unhover();
  s = await page.evaluate(PROBE);
  push("③分屏·图标=两栏(不是方框加号)", s.icon === "split", { icon: s.icon });
  push("③分屏·无数字徽标", s.badge === null, { badge: s.badge });
  await shot("verify-lc-B-split.png");

  await hover();
  s = await page.evaluate(PROBE);
  push("③分屏·hover**不弹**两项目菜单", s.hasMenu === false, { hasMenu: s.hasMenu, menuItems: s.menuItems });
  push("③分屏·hover只出tooltip", s.tips.length === 1, { tips: s.tips });
  // 久悬停也不能冒菜单
  await sleep(1200);
  s = await page.evaluate(PROBE);
  push("③分屏·久悬停仍无菜单", s.hasMenu === false, { hasMenu: s.hasMenu });

  // ===== 分支②：再点一下 → 隐藏标签（标签保留） =====
  await btn().click();
  await sleep(700);
  await unhover();
  s = await page.evaluate(PROBE);
  push("②隐藏·图标=圆角方框内数字(官方 Hc 样式)", s.icon === "count-box", { icon: s.icon });
  push("②隐藏·框内数字(=1)", s.badge === "1", { badge: s.badge });
  await shot("verify-lc-C-hidden.png");

  await hover();
  s = await page.evaluate(PROBE);
  push("②隐藏·hover出标签列表菜单", s.hasMenu === true, { heading: s.menuHeading, n: s.menuItems.length });
  push("②隐藏·菜单项=标签标题(非新建标签页)", !/新建标签页/.test(s.menuItems[0] ?? "新建标签页"), { item0: s.menuItems[0] });

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
