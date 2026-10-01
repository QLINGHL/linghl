/**
 * 验证侧栏滚动改造（2026-10-01 用户反馈）：
 *   ① 「项目」与「最近」**共用一条**滚动条（以前是两个各自滚 / 项目固定高度）
 *   ② 两节标题**吸顶**：向下滚时「项目」标题先钉住，
 *      继续滚到「最近」时后者把前者顶走、自己钉在最上面
 *   ③ 头部与「新聊天」不参与滚动（任何滚动位置都能点）
 *
 * 用真实 DOM 测量，不靠"看起来对"：
 *   - 统计 aside 内真正可滚动的元素个数（scrollHeight > clientHeight 且 overflow 允许滚动）
 *   - 把滚动容器滚到不同位置，读两个标题的 getBoundingClientRect().top
 *     与容器的 top 比较：吸顶时两者应相等（±1px）
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 9841;
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1";
env.ELECTRON_DISABLE_SANDBOX = "1";

const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 2000; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) { target = p; break; }
    } catch { /* */ }
    await sleep(10);
  }
  if (!target) { console.log("no target"); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable");
  await send("Page.bringToFront");

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };

  for (let i = 0; i < 300; i++) { if (await evalJs(`Boolean(document.querySelector('aside'))`)) break; await sleep(100); }
  await sleep(4000);

  const out = await evalJs(`(() => {
    const aside = document.querySelector('aside');
    if (!aside) return JSON.stringify({ error: 'no aside' });

    const scrollable = (el) => {
      const cs = getComputedStyle(el);
      const canScrollY = /(auto|scroll)/.test(cs.overflowY);
      return canScrollY && el.scrollHeight > el.clientHeight + 1;
    };
    const all = [aside, ...aside.querySelectorAll('*')];
    const scrollers = all.filter(scrollable);

    // 找到承载「项目」和「最近」的那个滚动容器
    const scroller = scrollers.find(el => el.innerText.includes('项目') && el.innerText.includes('最近')) ?? scrollers[0];
    if (!scroller) return JSON.stringify({ error: 'no scroller', scrollerCount: scrollers.length });

    const headerOf = (label) => {
      // 标题按钮（文本以 label 开头）
      return [...scroller.querySelectorAll('button')].find(b => b.innerText.trim().startsWith(label));
    };
    const projBtn = headerOf('项目');
    const recBtn = headerOf('最近');
    const newChatBtn = [...aside.querySelectorAll('button')].find(b => b.innerText.trim() === '新聊天');

    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const containerTop = () => scroller.getBoundingClientRect().top;

    const sample = (label) => {
      const p = rect(projBtn), r = rect(recBtn);
      return {
        label,
        scrollTop: Math.round(scroller.scrollTop),
        containerTop: Math.round(containerTop()),
        projTop: p ? Math.round(p.top) : null,
        recTop: r ? Math.round(r.top) : null,
        projVisible: p ? p.bottom > containerTop() : false,
        newChatTop: (() => { const n = rect(newChatBtn); return n ? Math.round(n.top) : null; })(),
      };
    };

    const samples = [];
    scroller.scrollTop = 0;
    samples.push(sample('scrollTop=0'));

    // 滚一小段：项目标题应仍钉在容器顶部
    scroller.scrollTop = 120;
    samples.push(sample('scrollTop=120'));

    // 滚到底部：最近标题应钉在容器顶部，项目标题应被顶出可视区
    scroller.scrollTop = scroller.scrollHeight;
    samples.push(sample('scrollTop=max'));

    // 新聊天按钮在滚动前后位置是否不变（= 不参与滚动）
    scroller.scrollTop = 0;
    const newChatAt0 = rect(newChatBtn)?.top;
    scroller.scrollTop = 300;
    const newChatAt300 = rect(newChatBtn)?.top;
    scroller.scrollTop = 0;

    return JSON.stringify({
      scrollerCount: scrollers.length,
      scrollerTag: scroller.className,
      canScroll: scroller.scrollHeight > scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      samples,
      newChatFixed: newChatAt0 === newChatAt300,
      newChatTop: Math.round(newChatAt0),
    }, null, 2);
  })()`);

  const d = JSON.parse(out);
  console.log(JSON.stringify(d, null, 2));

  console.log("\n================ 判定 ================");
  if (d.error) { console.log("❌ " + d.error); process.exit(1); }
  const oneScroller = d.scrollerCount === 1;
  const [s0, s1, s2] = d.samples;
  // 滚到 120 时，项目标题应贴住容器顶
  const projSticky = Math.abs(s1.projTop - s1.containerTop) <= 2;
  // 滚到底时，最近标题应贴住容器顶，且项目标题已被顶出（不可见）
  const recSticky = Math.abs(s2.recTop - s2.containerTop) <= 2;
  const projPushedAway = !s2.projVisible;

  console.log(`共用一条滚动条:      ${oneScroller ? "✅" : "❌"} (检测到 ${d.scrollerCount} 个可滚动元素)`);
  console.log(`项目标题吸顶:        ${projSticky ? "✅" : "❌"} (top=${s1.projTop} vs 容器 ${s1.containerTop})`);
  console.log(`最近标题吸顶:        ${recSticky ? "✅" : "❌"} (top=${s2.recTop} vs 容器 ${s2.containerTop})`);
  console.log(`滚到底时项目标题被顶走: ${projPushedAway ? "✅" : "❌"}`);
  console.log(`新聊天不参与滚动:    ${d.newChatFixed ? "✅" : "❌"}`);

  const ok = oneScroller && projSticky && recSticky && projPushedAway && d.newChatFixed;
  console.log(ok ? "\n全部通过" : "\n存在未通过项");
  ws.close(); try { child.kill(); } catch { /* */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
