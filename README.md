<div align="center">

# LINGHL

**多智能体桌面工作台**

一个桌面外壳，统一接入各类 AI Agent。
当前内置 **Codex** 内核，架构上为接入更多 Agent（Claude Code、自研 Agent 等）预留。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)

</div>

---

## 现状（先读这一段）

- **目前只接入了 Codex 一个内核。** 名字叫「多智能体」是因为架构如此设计
  （内核是候选列表、环境是隔离的、渲染层不假设具体 Agent），
  但**功能上现在就是 Codex 的桌面客户端**。
- **内置内核二进制不在本仓库里**（原因见 [内置内核](#内置内核vendor)），
  所以 clone 下来不能直接打包 —— 但**如果你本机装了官方 Codex，可以直接跑起来**。
- 项目**大量使用中文注释**，记录了大量踩坑结论（内核兼容、沙箱、启动性能等）。
  这些注释是有意保留的，不是冗余。

## 特性

**接入与隔离**

- **多环境隔离**：每个环境有独立的 `codex-home`（auth / config / sessions 互不干扰），
  可在侧栏「工作区」一键切换
- **自定义模型接入**：支持 OpenAI 兼容的第三方网关（base URL + API Key + 模型），
  内置本地 compat 层做协议适配
- **官方数据导入**：一次性复制本机 `~/.codex` 的登录态与会话，**绝不写入官方目录**

**会话**

- 项目 / 最近两级列表，会话归属来自环境的全局状态，新会话发送后**立刻**出现
- 回复流按回合分组：推理摘要、命令执行、文件改动、MCP 调用各成卡片
- Markdown + KaTeX 数学公式、代码高亮、图片预览与缩放
- 审批（approval）横幅：命令/文件越界时在界面上询问，而不是直接拒绝

**内置浏览器**

- 主进程 `WebContentsView`（对齐官方做法），可与聊天分屏或切到完整视图
- 标签页管理、地址栏导航、页面快照

**工程**

- 自定义 `linghl://` 协议替代 `file://`，吃到 HTTP 缓存与 V8 code cache
- 首帧优化：窗口显示闸门（`show:false` + 渲染层提交后显式 reveal）
- 打包产物按 hash 命名，CSS 做了 Tailwind v4 属性初始化的精准裁剪

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11（当前只在 Windows 上验证过；代码里对 macOS/Linux 有分支但未实测） |
| Node.js | ≥ 20（开发时用的是 22.x） |
| npm | ≥ 10 |
| 内核 | 官方 Codex（本机安装即可），或自备 `vendor/` 二进制 |

## 快速开始

```bash
git clone https://github.com/qlinghl/linghl.git
cd linghl
npm install
npm start
```

`npm start` 会构建并直接拉起 Electron（`tools/start-direct.cjs`）。
**首次启动不需要 `vendor/`** —— 只要本机装了官方 Codex，应用会自动找到它。

### 找不到内核怎么办

按下面顺序排查（这就是内核的实际解析顺序）：

1. 环境变量 `REPLICA_CODEX_BIN` 指向 `codex.exe` 的绝对路径 —— 优先级最高
2. `vendor/codex/bin/codex.exe`（见下节）
3. **本机官方安装**：依次扫描
   `%LOCALAPPDATA%\OpenAI\Codex\bin`、`%LOCALAPPDATA%\Programs\Codex`、
   `%ProgramFiles%\Codex`、`%ProgramFiles(x86)%\Codex`
4. PATH 里的 `codex`

### 内置内核（`vendor/`）

`vendor/` **不在本仓库里**，原因有两个：

- `vendor/codex/bin/codex.exe` 单个文件就有 **309 MB**，超过 GitHub 单文件 100 MB 硬上限
- 该二进制的版权属于其原作者，不应随本仓库分发

需要它（例如要打独立安装包）时，把官方发行版按下列布局放进去即可：

```
vendor/codex/
├── codex-package.json      # 描述 layoutVersion / version / target / entrypoint
├── bin/codex.exe           # 入口
├── codex-resources/        # 运行时资源（sandbox setup、command runner 等）
└── codex-path/             # 随包工具（rg.exe 等）
```

`codex-package.json` 的字段含义见 `src/main/kernelManager.ts`。

## 常用命令

```bash
npm start              # 构建并启动（推荐）
npm run build          # 只构建 main / preload / renderer
npm run check          # TypeScript 类型检查
npm run make           # 打 Windows 安装包（需要 vendor/）
npm run fix-integrity  # 修复 Windows 上 electron.exe 的完整性标签（见下方「已知问题」）

npm run test:transport # 传输层（13 项）
npm run test:recents   # 会话列表 / 侧栏行为（15 项）
npm run test:flow      # 回复流渲染（浏览器内跑，需要 playwright-core）
```

浏览器类测试（`test:flow`）需要 playwright。仓库已把 `playwright-core` 列为
devDependency，`npm install` 后即可用；它会调用**系统已安装的 Edge**
（`channel: 'msedge'`），不会额外下载浏览器。
若 playwright 装在别处，`tools/playwright-loader.mjs` 会给出可照做的提示。

## 数据目录

应用数据全部在 `%APPDATA%\codex-desk-replica`，与官方应用完全隔离：

```
%APPDATA%/codex-desk-replica/
├── desk-state.json        # 窗口位置、偏好设置、项目清单
├── envs.json              # 多环境配置（**含各环境的 API Key**）
├── envs/<id>/codex-home/  # 各隔离环境的 codex-home
├── codex-home/            # 默认环境的 codex-home
└── logs/                  # boot.log（启动轨迹）、timeline.jsonl（RPC 时序）
```

> ⚠️ **目录名仍是 `codex-desk-replica`，应用改名后刻意没有跟着改。**
> 里面装着已有的全部用户数据（会话、项目归属、多环境配置、API Key），
> 改名会让应用认不出旧目录。要改必须配套写迁移逻辑。

`envs.json` 里有明文 API Key —— **不要提交、不要外传**（已在 `.gitignore` 覆盖范围之外，
因为它本来就不在仓库里）。

## 项目结构

```
src/
├── main/                  # 主进程
│   ├── main.ts            #   窗口、协议、IPC、启动编排
│   ├── kernelManager.ts   #   内核候选发现 + 运行时投影（多环境）
│   ├── envManager.ts      #   多环境与自定义模型接入
│   ├── appServer.ts       #   内核 JSONL 协议客户端
│   ├── browserManager.ts  #   内置浏览器（WebContentsView）
│   └── relayCompat.ts     #   第三方网关的协议适配层
├── preload/               # contextBridge 暴露的 window.linghl API
└── renderer/              # React 渲染层
    ├── store.ts           #   全局状态（zustand）+ 事件归并
    ├── components/        #   侧栏、回复流、输入框、内置浏览器…
    └── views/             #   首页、设置、模型、定制、计划任务
tools/                     # 构建、诊断、验收脚本
docs/                      # 内核兼容性契约、回复流复用记录
```

## 已知问题

- **Windows 沙箱与完整性标签**：工作区目录若被加上 `Low Mandatory Level` 标签，
  `electron.exe` 会以低完整性运行，写不了 `%APPDATA%`。
  用 `npm run fix-integrity` 修复。代码里有自检，会退回备用数据目录而不是静默失败。
- **`npm start` 走 electron-forge 时的删除问题**：forge 的 `preStart` 会
  `fs.remove('.vite')`，在带"安全删除"拦截的环境里会中途抛错。
  所以 `npm start` 默认走 `tools/start-direct.cjs` 绕开它；
  `npm run start:forge` 保留原路径。
- **`test:flow` 有一项断言失败**（`failed turn payload exposes its cause`）：
  失败回合的错误原因没有渲染到界面上。已知问题，待修。

## 许可证

[MIT](./LICENSE) © 2026 qlinghl

本项目包含改编自 [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui)
的 MIT 授权源码，完整归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

**本项目与 OpenAI 无任何关联**，不分发其任何二进制。「Codex」「ChatGPT」等
名称与商标归其各自所有者。内置内核（`vendor/`）版权归原作者，适用其自身条款。
