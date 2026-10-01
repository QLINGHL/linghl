// 通过 CDP 查询复刻版渲染进程 DOM：node cdp-query.cjs ["表达式"]
const EXPR =
  process.argv[2] ??
  `(() => {
    const root = document.getElementById('root');
    const first = root && root.firstElementChild;
    const row = first && first.children[1];
    return JSON.stringify({
      rootChildren: root ? [...root.children].map(c => c.className) : null,
      secondRowChildren: row ? [...row.children].map(c => ({ tag: c.tagName, cls: String(c.className).slice(0,60), w: Math.round(c.getBoundingClientRect().width) })) : null,
      html: root ? root.innerHTML.slice(0, 800) : null,
    }, null, 1);
  })()`;

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + (process.env.FLOW_CDP_PORT || '9222') + "/json")).json();
  const page = list.find((t) => t.title === "Codex") ?? list.find(t => t.type === 'page');
  if (!page) {
    console.log("no Codex page; targets:", list.map((t) => t.title));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  await new Promise((r) => (ws.addEventListener("open", r)));

  const res = await send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
  console.log(res.result?.result?.value ?? JSON.stringify(res.result, null, 1));
  ws.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
