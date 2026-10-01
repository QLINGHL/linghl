const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..");
const PORT = 9842;
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE","ELECTRON_NO_ATTACH_CONSOLE","ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1"; env.ELECTRON_DISABLE_SANDBOX = "1";
const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: "ignore" });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  let t = null;
  for (let i = 0; i < 2000; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(x => x.type === "page"); if (p) { t = p; break; } } catch {}
    await sleep(10);
  }
  if (!t) { console.log("no target"); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise(r => ws.addEventListener("open", r));
  await send("Runtime.enable"); await send("Page.enable"); await send("Page.bringToFront");
  const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  for (let i = 0; i < 300; i++) { if (await evalJs(`Boolean(document.querySelector('aside'))`)) break; await sleep(100); }
  await sleep(4500);
  // 展开一个项目，让列表更有内容
  await evalJs(`(() => { const a=document.querySelector('aside'); const b=[...a.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith('claudeTest')); if(b) b.click(); return true; })()`);
  await sleep(800);

  const out = path.join(__dirname, "shots");
  fs.mkdirSync(out, { recursive: true });
  for (const [name, top] of [["01-top", 0], ["02-mid", 600], ["03-bottom", 99999]]) {
    await evalJs(`(() => { const a=document.querySelector('aside'); const s=[a,...a.querySelectorAll('*')].find(el=>{const cs=getComputedStyle(el);return /(auto|scroll)/.test(cs.overflowY)&&el.scrollHeight>el.clientHeight+1;}); if(s) s.scrollTop=${top}; return true; })()`);
    await sleep(350);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 300, height: 760, scale: 1 } });
    fs.writeFileSync(path.join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
    console.log("saved", name);
  }
  ws.close(); try { child.kill(); } catch {}
  process.exit(0);
})().catch(e => { console.error("err:", e.message); try { child.kill(); } catch {} process.exit(1); });
