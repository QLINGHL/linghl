/** 查环境项目清单读取链路：env:list → env:projects，定位"还没有项目"的原因 */
(async () => {
  const pw = await import("./playwright-loader.mjs");
  const chromium = (pw.default ?? pw).chromium ?? pw.chromium;
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  const r = await page.evaluate(async () => {
    const list = await window.codex.envRpc("env:list");
    const active = list?.activeId;
    const env = list?.envs?.find((e) => e.id === active);
    let proj = null;
    let err = null;
    try {
      proj = await window.codex.envRpc("env:projects", active);
    } catch (e) {
      err = String(e);
    }
    return {
      activeId: active,
      envs: (list?.envs ?? []).map((e) => ({ id: e.id, name: e.name, kind: e.kind, mode: e.mode, home: e.codexHome })),
      projectsReturned: proj?.projects?.length ?? null,
      firstProjects: (proj?.projects ?? []).slice(0, 4).map((p) => p.name + " @ " + p.path),
      error: err,
    };
  });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
