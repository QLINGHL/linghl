/**
 * ⚠️ 必须在 forge 启动 Electron 之前把 ELECTRON_RUN_AS_NODE 删掉。
 *
 * 本机有些外壳（WorkBuddy / DSH 这类 Electron 宿主）会把它塞进子进程环境。
 * electron.exe 只要看到这个变量就退化成纯 Node 宿主：
 *   - `npm start` 打完「Launched Electron app」后**不建窗口、不报错**，直接回到提示符；
 *   - Chromium 参数被 Node 当成非法参数：`electron.exe: bad option: --no-sandbox`（exit 9）。
 * 只置空（`set X=`）没用：Electron 只检查变量**是否存在**，所以必须 delete。
 * 这段代码在 forge 加载配置时执行（早于 spawn Electron），因此对 `npm start` 始终生效。
 */
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) {
  delete process.env.ELECTRON_RUN_AS_NODE;
  console.log("[forge] 已移除继承来的 ELECTRON_RUN_AS_NODE（否则 electron.exe 会退化成纯 Node，窗口起不来）");
}

module.exports = {
  packagerConfig: {
    name: "LINGHL",
    asar: true,
    executableName: "LINGHL",
    appCopyright: "Copyright (c) 2026 qlinghl. MIT licensed.",
    // dist-renderer 是渲染层产物（见 vite.renderer.config.mts：刻意放在 .vite 之外，
    // 避免被 forge preStart 的 fs.remove('.vite') 删掉）。打包时必须显式带上。
    // vendor 是内置的 codex 内核二进制 —— **不在仓库里**（单文件 309MB，超过 GitHub
    // 上限，且版权属第三方），打包前需按 README 的说明自行获取。
    extraResource: ["vendor", "THIRD_PARTY_NOTICES.md", "dist-renderer"],
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["win32"] },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          { entry: "src/main/main.ts", config: "vite.main.config.mts", target: "main" },
          { entry: "src/preload/preload.ts", config: "vite.preload.config.mts", target: "preload" },
        ],
        renderer: [{ name: "main_window", config: "vite.renderer.config.mts" }],
      },
    },
  ],
};
