/**
 * 真实端到端验证：新聊天发送后，「最近」列表是否**立刻**出现该会话并带转圈。
 *
 * 走的是真实 UI（在输入框里打字 + 点发送按钮），不是直接调 store ——
 * 这样能验证 Composer.send() 里那行 upsertPendingThread 真的被走到。
 *
 * ⚠️ 会真实调用一次内核（消耗一次模型请求）。为把开销压到最小：
 * 只发一个极短提示词，并且**验证完立刻关掉应用**，不等 turn 完成 ——
 * 因为本修复要验的恰恰是"发送瞬间"的表现。
 *
 * 用法：node .boottest/e2e-recents.cjs
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const UD = path.join(process.env.APPDATA || "", "codex-desk-replica");
const PORT = 9831;
// 用唯一串，避免和已有会话标题撞车导致误判
const PROMPT = `zzq-recents-${Date.now().toString(36)}`;

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
    } catch { /* 还没起来 */ }
    await sleep(10);
  }
  if (!target) { console.log("未找到页面 target"); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };

  // 1. 等界面就绪（侧栏 + 输入框都出现）
  for (let i = 0; i < 200; i++) {
    const ready = await evalJs(`Boolean(document.querySelector('aside') && document.querySelector('textarea'))`);
    if (ready) break;
    await sleep(100);
  }
  const booted = await evalJs(`JSON.stringify({
    aside: Boolean(document.querySelector('aside')),
    textarea: Boolean(document.querySelector('textarea')),
    sendBtn: Boolean(document.querySelector('[aria-label="发送"]')),
    recents: document.querySelector('aside')?.innerText?.includes('最近') ?? false,
    vis: document.visibilityState
  })`);
  console.log("界面就绪状态:", booted);

  const before = await evalJs(`JSON.stringify({
    items: [...document.querySelectorAll('aside button')].map(b => b.innerText.trim()).filter(Boolean)
  })`);
  console.log("发送前侧栏条目数:", JSON.parse(before).items.length);

  // 2. 确保处于「新聊天」状态（点侧栏的新聊天按钮）
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('aside button')].find(b => b.innerText.trim() === '新聊天');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  await sleep(300);

  // 3. 在输入框里真实打字（用 Input.insertText，触发 React 的 onChange）
  await evalJs(`document.querySelector('textarea').focus()`);
  await send("Input.insertText", { text: PROMPT });
  await sleep(200);
  const typed = await evalJs(`document.querySelector('textarea').value`);
  console.log("输入框内容:", JSON.stringify(typed));

  // 4. 点发送
  const clicked = await evalJs(`(() => {
    const b = document.querySelector('[aria-label="发送"]');
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  console.log("发送按钮:", clicked);

  // 5. 立刻轮询侧栏，看新会话何时出现（这是本修复的核心指标）
  //
  // 精确定位「最近」区域：aside 的最后一个 div 是「最近」容器，
  // 它内部的 div 才是条目列表（避开「项目」下的同名条目造成误判）。
  const RECENTS_ITEMS = `[...document.querySelectorAll('aside > div:last-child > div > button')]`;
  let appearedAt = null;
  let spinnerSeen = false;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const s = await evalJs(`JSON.stringify({
      hasPrompt: ${RECENTS_ITEMS}.some(b => b.innerText.includes(${JSON.stringify(PROMPT)})),
      spinners: document.querySelectorAll('aside [aria-label="正在生成回复"]').length
    })`);
    const d = JSON.parse(s);
    if (d.hasPrompt && appearedAt === null) appearedAt = Date.now() - t0;
    if (d.spinners > 0) spinnerSeen = true;
    if (appearedAt !== null && spinnerSeen) break;
    await sleep(100);
  }

  const after = await evalJs(`JSON.stringify({
    recents: ${RECENTS_ITEMS}.map(b => b.innerText.trim()).filter(Boolean),
    spinners: document.querySelectorAll('aside [aria-label="正在生成回复"]').length
  })`);
  const parsed = JSON.parse(after);

  console.log("\n================ 结果 ================");
  console.log(`提示词: ${PROMPT}`);
  console.log(`新会话出现在「最近」耗时: ${appearedAt === null ? "❌ 未出现（>12s）" : appearedAt + "ms"}`);
  console.log(`工作指示器（转圈）出现:   ${spinnerSeen ? "✅ 是" : "❌ 否"}`);
  console.log(`当前侧栏转圈数量:         ${parsed.spinners}`);
  console.log(`「最近」列表前 5 条: ${JSON.stringify(parsed.recents.slice(0, 5))}`);

  ws.close();
  try { child.kill(); } catch { /* */ }
  process.exit(appearedAt !== null && spinnerSeen ? 0 : 1);
})().catch((e) => {
  console.error("err:", e.message);
  try { child.kill(); } catch { /* */ }
  process.exit(1);
});
