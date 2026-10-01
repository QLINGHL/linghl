/**
 * 用 CDP 驱动复刻版渲染进程：执行表达式 + 截图。
 *   node tools/cdp-drive.cjs --eval "<js>" --shot out.png [--wait 800]
 * 可重复 --eval / --shot，按顺序执行。
 */
const fs = require("node:fs");

const args = process.argv.slice(2);
const steps = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--eval") steps.push({ kind: "eval", value: args[++i] });
  else if (args[i] === "--shot") steps.push({ kind: "shot", value: args[++i] });
  else if (args[i] === "--wait") steps.push({ kind: "wait", value: Number(args[++i]) });
  // 任意 CDP 命令：--cdp '{"method":"Emulation.setDeviceMetricsOverride","params":{...}}'
  else if (args[i] === "--cdp") steps.push({ kind: "cdp", value: JSON.parse(args[++i]) });
}

(async () => {
  const list = await (await fetch("http://127.0.0.1:" + (process.env.FLOW_CDP_PORT || '9222') + "/json")).json();
  const page = list.find((t) => t.title === "Codex") ?? list.find((t) => t.type === "page");
  if (!page) {
    console.log("no target; got:", list.map((t) => t.title));
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
  await new Promise((r) => ws.addEventListener("open", r));

  for (const step of steps) {
    if (step.kind === "eval") {
      const res = await send("Runtime.evaluate", {
        expression: step.value,
        returnByValue: true,
        awaitPromise: true,
      });
      const out = res.result?.result?.value;
      console.log("[eval]", typeof out === "string" ? out : JSON.stringify(out ?? res.result, null, 1));
      if (res.result?.exceptionDetails) {
        console.log("[eval-exception]", JSON.stringify(res.result.exceptionDetails, null, 1));
      }
    } else if (step.kind === "cdp") {
      const res = await send(step.value.method, step.value.params ?? {});
      console.log("[cdp]", step.value.method, res.error ? JSON.stringify(res.error) : "ok");
    } else if (step.kind === "shot") {
      const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const data = res.result?.data;
      if (!data) {
        console.log("[shot] failed", JSON.stringify(res).slice(0, 300));
        continue;
      }
      fs.writeFileSync(step.value, Buffer.from(data, "base64"));
      console.log("[shot]", step.value);
    } else {
      await new Promise((r) => setTimeout(r, step.value));
    }
  }
  ws.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
