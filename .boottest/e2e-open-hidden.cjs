/**
 * 端到端验证：从项目里点开一条**被内核隐藏**的会话（provider 已不存在），
 * 正文能否正常渲染出来。
 *
 * 为什么必须单独验这一步：
 *   内核的 thread/list 按 provider 过滤，项目里的会话几乎都是早期 provider 建的。
 *   把列表补全之后，用户下一步就是点开它们 —— 而 `thread/resume` 对这些会话
 *   会**失败**（"failed to load configuration: Model provider `stringai`..."）。
 *   如果正文也加载不出来，那"把会话补回列表"反而更糟（能看到点不开）。
 *
 * 已验证过的事实：thread/turns/list 对这些会话仍能返回回合数据（实测 3 个回合），
 * openThread 也 catch 了 resume 失败。本脚本确认整条链路在真实 UI 里成立。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 9839;
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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };

  for (let i = 0; i < 300; i++) { if (await evalJs(`Boolean(document.querySelector('aside'))`)) break; await sleep(100); }
  await sleep(4000); // 等 loadThreads 合并完成

  // 1. 点开「paper」项目（它有 6 条会话，都是早期 provider 建的）
  const clickedProject = await evalJs(`(() => {
    const aside = document.querySelector('aside');
    const btn = [...aside.querySelectorAll('button')].find(b => b.innerText.trim().startsWith('paper'));
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked';
  })()`);
  console.log("点击 paper 项目:", clickedProject);
  await sleep(600);

  // 2. 取该项目下第一条会话并点开
  const firstItem = await evalJs(`(() => {
    const aside = document.querySelector('aside');
    // 项目展开后的会话列表：带左边框缩进的那个容器
    const wrap = [...aside.querySelectorAll('div')].find(d => d.className.includes('ml-[26px]'));
    if (!wrap) return null;
    const btns = [...wrap.querySelectorAll('button')];
    if (!btns.length) return null;
    return JSON.stringify({ title: btns[0].innerText.trim(), index: 0 });
  })()`);
  if (!firstItem) { console.log("❌ 项目下没有渲染出会话"); try { child.kill(); } catch {} process.exit(1); }
  const t = JSON.parse(firstItem);
  console.log("准备点开:", t.title);

  await evalJs(`(() => {
    const aside = document.querySelector('aside');
    const wrap = [...aside.querySelectorAll('div')].find(d => d.className.includes('ml-[26px]'));
    wrap.querySelectorAll('button')[0].click();
    return true;
  })()`);

  // 3. 等正文渲染（主区域出现内容，而不是空态/骨架）
  let textLen = 0, loaded = false;
  for (let i = 0; i < 150; i++) {
    const s = await evalJs(`(() => {
      const main = document.querySelector('main');
      if (!main) return JSON.stringify({ len: 0, txt: '' });
      const txt = (main.innerText || '').replace(/\\s+/g, ' ').trim();
      return JSON.stringify({ len: txt.length, txt: txt.slice(0, 120) });
    })()`);
    const d = JSON.parse(s);
    textLen = d.len;
    // 有实质内容就算加载成功（空态只有寥寥几个字）
    if (d.len > 150) { loaded = true; console.log("正文片段:", d.txt); break; }
    await sleep(150);
  }

  // 4. 检查是否出现模型接入已不存在的说明横幅
  const banner = await evalJs(`(() => {
    const t = (document.body.innerText || "");
    return t.includes("当前配置里已经没有它") || t.includes("不能继续对话");
  })()`);

  console.log("\n================ 结果 ================");
  console.log(`项目会话可点开:      ${loaded ? "✅ 是" : "❌ 否"}`);
  console.log(`主区域文本长度:      ${textLen}`);
  console.log(`只读原因提示已展示:  ${banner ? "✅ 是" : "❌ 否"}`);
  process.exit(loaded && banner ? 0 : 1);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
