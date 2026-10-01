/**
 * 强制布局来源定位：LayoutDuration 141ms / 只有 3 次 → 单次布局特别贵，
 * 且这正是"首帧"期间发生的。用 CDP 的 **forced reflow 追踪** 找出是谁触发的：
 *   1. Runtime.evaluate 打补丁包住 Element.prototype.getBoundingClientRect /
 *      offsetWidth / scrollHeight 等强制布局入口，记录调用栈；
 *   2. DOMDebugger / PerformanceObserver 的 layout-shift 只能看结果，看不到原因，
 *      所以必须打补丁。
 *   3. 记录 TraceEvent 的 "UpdateLayoutTree" / "Layout" 事件耗时分布。
 *
 * 目的：确认 141ms 是不是"首屏元素数太多"（可优化），
 *       还是"某处反复强制同步布局"（bug，可精准修）。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const UD = path.join(process.env.APPDATA || "", "codex-desk-replica");
const PORT = 9824;

for (const d of ["Cache", "Code Cache", "GPUCache"]) {
  try { fs.rmSync(path.join(UD, "sessionData", d), { recursive: true, force: true }); } catch { /* 占用 */ }
}
const env = { ...process.env };
for (const k of ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_NO_ASAR"]) delete env[k];
env.REPLICA_ALLOW_MULTI = "1";
env.ELECTRON_DISABLE_SANDBOX = "1";

const child = spawn(require("electron"), [".", "--no-sandbox", `--remote-debugging-port=${PORT}`], {
  cwd: ROOT, env, stdio: "ignore",
});

(async () => {
  let target = null;
  for (let i = 0; i < 1500; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) { target = p; break; }
    } catch { /* */ }
    await new Promise((r) => setTimeout(r, 10));
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
  await send("DOM.enable");
  await send("CSS.enable");

  // 装补丁：包住所有会强制同步布局的读取入口，记录耗时与调用栈（截断）
  const patched = await send("Runtime.evaluate", {
    expression: `(() => {
      if (window.__reflowProbe) return "already";
      window.__reflowProbe = { total: 0, calls: [] };
      const P = window.__reflowProbe;
      const wrap = (obj, prop) => {
        const desc = Object.getOwnPropertyDescriptor(obj, prop);
        if (!desc || !desc.get) return false;
        try {
          Object.defineProperty(obj, prop, {
            configurable: true,
            get() {
              const t = performance.now();
              const v = desc.get.call(this);
              const dt = performance.now() - t;
              // 只记"真的触发了布局"的（>=0.3ms），否则噪声太大
              if (dt >= 0.3) {
                const st = (new Error().stack || "").split("\\n").slice(2, 5).join(" | ");
                P.total += dt;
                if (P.calls.length < 40) P.calls.push({ prop, dt: +dt.toFixed(2), at: +t.toFixed(0), st: st.slice(0, 300) });
              }
              return v;
            },
          });
          return true;
        } catch { return false; }
      };
      const targets = [
        [Element.prototype, "clientWidth"], [Element.prototype, "clientHeight"],
        [Element.prototype, "offsetWidth"], [Element.prototype, "offsetHeight"],
        [Element.prototype, "scrollWidth"], [Element.prototype, "scrollHeight"],
        [Element.prototype, "offsetTop"], [Element.prototype, "offsetLeft"],
        [Range.prototype, "getBoundingClientRect"],
      ];
      let n = 0;
      for (const [o, p] of targets) if (wrap(o, p)) n++;
      // getBoundingClientRect 是方法不是 getter，单独包
      const gbcr = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        const t = performance.now();
        const v = gbcr.call(this);
        const dt = performance.now() - t;
        if (dt >= 0.3) {
          const st = (new Error().stack || "").split("\\n").slice(2, 5).join(" | ");
          P.total += dt;
          if (P.calls.length < 40) P.calls.push({ prop: "getBoundingClientRect", dt: +dt.toFixed(2), at: +t.toFixed(0), st: st.slice(0, 300) });
        }
        return v;
      };
      const gcs = getComputedStyle.bind(window);
      window.getComputedStyle = function (...a) {
        const t = performance.now();
        const v = gcs(...a);
        const dt = performance.now() - t;
        if (dt >= 0.3) {
          const st = (new Error().stack || "").split("\\n").slice(2, 5).join(" | ");
          P.total += dt;
          if (P.calls.length < 40) P.calls.push({ prop: "getComputedStyle", dt: +dt.toFixed(2), at: +t.toFixed(0), st: st.slice(0, 300) });
        }
        return v;
      };
      return "patched " + n;
    })()`,
    returnByValue: true,
  });
  console.log("补丁:", patched.result?.result?.value);

  // 收集 TraceEvent 里的 Layout / UpdateLayoutTree
  await send("Tracing.start", { categories: "disabled-by-default-devtools.timeline", transferMode: "ReturnAsStream" });

  await new Promise((r) => setTimeout(r, 5000));
  const probe = await send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__reflowProbe)`,
    returnByValue: true,
  });
  const data = JSON.parse(probe.result?.result?.value ?? "{}");
  console.log(`\n=== 强制同步布局总耗时（打补丁观测，>=0.3ms 才计）: ${(data.total ?? 0).toFixed(1)}ms ===`);
  const calls = (data.calls ?? []).sort((a, b) => b.dt - a.dt).slice(0, 15);
  for (const c of calls) {
    console.log(`  ${String(c.dt).padStart(7)}ms  +${c.at}ms  ${c.prop}`);
    console.log(`             ${c.st.replace(/\\s+/g, " ").slice(0, 220)}`);
  }

  // 统计首屏 DOM 规模（元素数直接决定布局成本）
  const dom = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      all: document.getElementsByTagName("*").length,
      root: document.getElementById("root")?.getElementsByTagName("*").length ?? 0,
      styleSheets: document.styleSheets.length,
      cssRules: [...document.styleSheets].reduce((a,s)=>{try{return a+s.cssRules.length}catch{return a}},0)
    })`,
    returnByValue: true,
  });
  console.log(`\n=== 首屏 DOM 规模 ===`);
  console.log("  " + dom.result?.result?.value);

  ws.close();
  try { child.kill(); } catch { /* */ }
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); try { child.kill(); } catch { /* */ } process.exit(1); });
