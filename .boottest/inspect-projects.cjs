/**
 * 侧栏「项目」诊断：直接读真实 UI 的 DOM，看每个项目展开后到底有没有会话。
 *
 * 之所以要看 DOM 而不是读 store：用户看到的是渲染结果。
 * 一个项目可能 threadIds 有值、但 `owned` 过滤后为空（因为 thread/list
 * 只返回最近 50 条，项目里的老会话不在其中）—— 这种情况只有看 DOM 才能确认。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 9832;
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
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.bringToFront");

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };

  // 等侧栏就绪 + 会话加载完成
  for (let i = 0; i < 300; i++) {
    const ok = await evalJs(`Boolean(document.querySelector('aside'))`);
    if (ok) break;
    await sleep(100);
  }
  await sleep(4000); // 等 loadThreads / reloadProjects 落定

  const dump = await evalJs(`JSON.stringify((() => {
    const aside = document.querySelector('aside');
    if (!aside) return { error: 'no aside' };
    // 「项目」区块：含"项目"按钮的那个容器
    const projHeader = [...aside.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('项目'));
    const projWrap = projHeader?.parentElement?.parentElement;
    const projBtns = projWrap ? [...projWrap.querySelectorAll('button')] : [];
    // 每个项目行：文本 + 是否可展开（disabled 表示 owned.length === 0）
    const rows = [];
    const chevrons = projWrap ? [...projWrap.querySelectorAll('button[aria-label="展开项目会话"]')] : [];
    for (const c of chevrons) {
      const row = c.parentElement;
      rows.push({
        text: (row?.innerText || '').replace(/\\s+/g, ' ').trim(),
        canExpand: !c.disabled,
        title: c.getAttribute('title') || '',
      });
    }
    // 「最近」条目数
    const recents = [...aside.querySelectorAll('aside > div:last-child > div > button')];
    return {
      vis: document.visibilityState,
      projectsHeader: projHeader?.innerText.trim() || null,
      projectRows: rows,
      recentsCount: recents.length,
      recentsFirst3: recents.slice(0, 3).map(b => b.innerText.trim()),
      asideText: (aside.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    };
  })())`);

  console.log(JSON.stringify(JSON.parse(dump), null, 2));

  ws.close();
  try { child.kill(); } catch { /* */ }
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
