# 内核兼容性契约（Codex 升级不许再让用户发现"不兼容"）

> 起因：2026-09-30 官方桌面应用自动把内核升到 **0.159.2**。复刻版自带的是
> **0.158.0-alpha.9**。最初把故障归因于“旧内核读不了新版迁移库”，但隔离复现证明：
> 两套内核在干净目录和数据库副本上都能完成握手；真实失败发生在直接把桌面版内核指向
> 官方 `~/.codex` 时，曾出现 `拒绝访问` 与 `failed to initialize sqlite state runtime`，
> 还存在官方进程与复刻版共享 SQLite 写者的历史冲突。因此现在不再让复刻版内核直接写官方目录。

## 一、分层承诺（哪些能自动扛住，哪些必须改代码）

| 层面 | 承诺 | 机制 |
|---|---|---|
| 内核二进制落后 | **自动兼容，无需发版** | 启动时枚举本机所有 codex 内核（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`、`Programs\Codex`、`ProgramFiles\Codex`），跑 `--version` 取版本，**按版本从新到旧排序逐个试**，第一个 `initialize` 成功的就用它；自带内核只作最后兜底。官方自己会升级，我们跟随。 |
| state 库被新版迁移或被官方进程占用 | **自动兼容** | 本地环境首次从官方目录做 SQLite online backup 到 `<userData>/kernel-runtime/environments/`，内核只写应用托管快照；历史读取也优先使用该快照。官方 `~/.codex` 永远只读。 |
| 后端 JSON-RPC 协议新增 | **自动兼容** | 只依赖稳定方法（`initialize` / `thread/list` / `thread/turns/list` / `thread/start` / `turn/start` / `turn/interrupt` / `account/read` / `model/list`）；返回里多出来的字段天然忽略；没实现的方法捕获后降级。 |
| 后端协议**破坏性变更** | ⚠️ 需要改代码，但**必须可见** | 未知错误进 `kernel/health` 与 `logs/timeline.jsonl`，界面横幅直接显示「内核无法启动（已试 N 个版本…）」，同时保留历史浏览。**绝不允许再出现"静默变空列表"。** |

## 二、代码必须满足的四条硬约束

1. **永远不优先用自带内核**：`kernelCandidates()` 必须把本机官方安装排在前、自带排在后；
   只有官方装了但全跑不起来时才回退自带。
2. **启动必须逐试**：`startServerWithFallback()` 按候选顺序逐个 `initialize`，
   失败的记录原因（`kernel/attempt-failed`）后继续；成功即用它并记 `kernel/health`。
3. **历史读取零内核依赖**：`envManager.readEnvThreads` / `readEnvTurns` / `readEnvProjects`
   只读文件（`node:sqlite` readOnly），优先读已建立的运行快照；任何时候都不许把「看历史」挂在内核可用性上。
4. **兼容性状态必须可见**：`app:kernel-issue` 要返回当前内核版本/来源；
   内核起不来或发生切换时给 `warn`/`error` 横幅；不允许只有 `console.error`。

## 三、官方升级后要做的验收（每次内核大版本更新都跑一遍）

```powershell
# 1) 版本探测是否选到最新的官方内核
node tools/probe-env-threads.cjs            # 打印 env + 内核路径与版本
# 2) 历史三层兜底（列表 / 项目 / 正文）
node tools/dump-env-projects.cjs            # 项目 + 归属会话是否读得到
node tools/verify-card-hover.mjs            # UI 回归（顺带验证会话能打开）
# 3) 应用内：横幅是否显示内核版本/兼容性状态；日志 logs/timeline.jsonl 里
#    是否有 kernel/selected、kernel/health、kernel/attempt-failed 记录
```

## 四、明确不做的事（避免误导用户）

- **不自动下载/替换官方内核**（那是官方安装器的职责），只做「探测 + 选择 + 回退」。
- **不写官方数据目录**（`~/.codex` 及官方状态库一律只读）；本地环境通过 SQLite online backup 建立应用托管运行快照，避免把官方应用搞坏。
- **不追求同时兼容所有历史版本**：只保证「本机最新内核 + 自带兜底」这两条路可用。
