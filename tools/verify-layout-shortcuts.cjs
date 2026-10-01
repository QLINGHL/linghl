/**
 * 验证 Ctrl+Shift+B（官方 toggleWorkspaceTabs）语义：
 *   - 无标签 → 新建标签页（进 split）
 *   - split → 隐藏标签页（layout=chat，标签保留）
 *   - chat(有标签) → 显示标签页（回 split）
 * 以及 Ctrl+Shift+F（完整视图）进/出。
 */
const { chromium } = require("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("index.html")) ?? ctx.pages()[0];

  const state = () =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-app-shell-workspace-layout-toggle="main"]');
      // 标签栏整条是否出现：有 split/full 时会有 NewTabButton / tab pill
      const tabPills = document.querySelectorAll('[aria-label="关闭标签页"]').length;
      const chatPaneHeader = [...document.querySelectorAll("div")].some((d) => d.textContent?.trim() === "聊天" && d.className.includes("truncate"));
      const btn = bar?.getBoundingClientRect();
      return {
        hasBar: !!bar,
        btnX: btn ? Math.round(btn.x) : null,
        tabPills,
        chatPaneHeader,
      };
    });

  const results = [];
  const push = (n, ok, d) => {
    results.push({ n, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${n}  ${d !== undefined ? JSON.stringify(d) : ""}`);
  };

  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  await page.mouse.move(20, 700);
  await sleep(300);

  let s = await state();
  push("起点·无标签(btn在右上角悬浮)", s.hasBar && s.tabPills === 0, s);

  // Ctrl+Shift+B → 新建标签页
  await page.keyboard.press("Control+Shift+B");
  await sleep(900);
  s = await state();
  push("B·新建标签页(出现 tab pill)", s.tabPills >= 1, { tabPills: s.tabPills });
  push("B·进入分屏(聊天窗格标题出现)", s.chatPaneHeader === true, { chatPaneHeader: s.chatPaneHeader });

  // Ctrl+Shift+B → 隐藏标签页
  await page.keyboard.press("Control+Shift+B");
  await sleep(700);
  s = await state();
  push("B·隐藏标签页(标签栏消失, 标签保留)", s.tabPills === 0, { tabPills: s.tabPills });

  // Ctrl+Shift+B → 显示标签页
  await page.keyboard.press("Control+Shift+B");
  await sleep(700);
  s = await state();
  push("B·显示标签页(回到分屏)", s.tabPills >= 1, { tabPills: s.tabPills });

  // Ctrl+Shift+F → 完整视图
  await page.keyboard.press("Control+Shift+F");
  await sleep(700);
  s = await state();
  push("F·进完整视图(标签栏在, 无聊天窗格标题)", s.hasBar === true && s.chatPaneHeader === false, { chatPaneHeader: s.chatPaneHeader });

  // Ctrl+Shift+F → 退出完整视图
  await page.keyboard.press("Control+Shift+F");
  await sleep(700);
  s = await state();
  push("F·退出完整视图(回到分屏)", s.chatPaneHeader === true, { chatPaneHeader: s.chatPaneHeader });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} PASS =====`);
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(2);
});
