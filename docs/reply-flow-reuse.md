# 回复流程：开源复用与验收记录

日期：2026-09-30（Asia/Shanghai）。

本次已把下列上游源码接入现有 Electron/React 的 ThreadView。不是仅下载备用，也不是把整个应用替换成另一个客户端。

## 已复用的源码

| 上游 | 固定提交 | 接入内容 | 本地文件 |
| --- | --- | --- | --- |
| [lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui) | f84909859d6f80e40aeaa984d329dd00dcc8e59d | 命令安全分类、运行/完成/失败标签、工具分组摘要、分组主图标选择 | src/renderer/src/vendor/codex-webui/activity.js |
| 同一 codex-webui 提交 | f84909859d6f80e40aeaa984d329dd00dcc8e59d | 25 条 Markdown 与 9 条 Shell 样式，限定作用域并映射现有主题 | src/renderer/src/vendor/codex-webui/conversation.css |
| [Dimillian/CodexMonitor](https://github.com/Dimillian/CodexMonitor) | dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5 | 思考摘要首行解析、Markdown 标记清理、长标题截断 | src/renderer/src/vendor/codex-monitor/reasoning.ts |

codex-webui 的 activity group/item 展开状态持久化方式另外适配为 React hook：src/renderer/src/lib/useActivityDisclosure.ts。单条工具直接显示，多条连续工具才出现分组；中间说明保留原顺序。

src/renderer/src/lib/activityModel.ts 是当前项目的协议适配层，处理 Windows PowerShell 包装、字段别名、服务端 commandActions，以及中断/拒绝状态。上游分组函数仅增加可注入分类器；上游分类和摘要解析主体保留。具体函数清单见 src/renderer/src/vendor/flow-sources.json。

两个来源均保留 MIT 版权及许可文本，发行包随带 THIRD_PARTY_NOTICES.md。没有导入上游提取自官方客户端的品牌或动画资源。

## 资料与选择依据

- 官方 [App Server 文档](https://developers.openai.com/codex/app-server)（2026-09-30 实际打开，重定向到 learn.chatgpt.com/docs/app-server）：agentMessage.phase 区分 commentary / final_answer；item/started、delta、item/completed 驱动条目状态，turn/completed 结束回合。turn/start 支持逐回合覆盖 model、effort、approvalPolicy、sandboxPolicy。具体枚举以当前内置内核生成的 ../_research/codex-schema/v2/TurnStartParams.json 为准。文档不规定所有桌面布局细节。
- codex-webui 直接接入 app-server，已有工具活动及会话浏览器测试，最适合复用当前回复流程逻辑。其完整服务端依赖 Bun，README 说明 Windows 尚未充分测试，因此本次保留当前可运行的 Electron/IPC 外壳，仅移植所需模块。
- CodexMonitor 是 Tauri/React 客户端；复用独立摘要解析，不引入其 Tauri 运行时。

## 已通过的验证

- npm run check：TypeScript 检查通过。
- npm run test:flow：52 项检查通过，无页面异常；包含发送即时 Thinking、消息确认去重、工具增量保留、commentary/final 分离、流式期间保留活动、完成收起、重连/中断/失败、图片/上下文压缩、KaTeX、上游分类/分组、展开状态重开恢复；新增事件顺序、首个正文增量计时、交错消息增量、内核退出、长命令/diff、审批跳过/重试/答案隔离、真实发送参数和中断 ID 验证。结果：artifacts/flow-observation/replay/results.json。默认不截图。
- npm run test:transport：13 项后端检查通过。直接加载当前生产 TypeScript，替换外部进程/网络边界，覆盖 JSONL UTF-8 分块、并发 RPC、超时清理、审批异常、重启隔离、管道退出、兼容层保留消息 phase 和工具输出、SSE 原样透传、取消请求和流中错误。结果：artifacts/flow-observation/transport/results.json。没有连接模型服务。
- 已成功编译最新 renderer，运行窗口已刷新到新 bundle。
- 编译后的项目验收：node tools/verify-installed-flow.cjs。只连接 file:////project/codex-app/.vite/renderer/main_window/，验证 project-react 标记、真实历史会话、展开/刷新恢复、排版边界、KaTeX 和后端 thread/list。结果：artifacts/flow-observation/installed/results.json。没有截图或再次发起模型请求。
- 前序鼠标/键盘验收保留在 artifacts/flow-observation/upstream-desktop。本轮改为代码检查与自动化逻辑验证，不把旧截图当作最新验证。
- 本轮逻辑检查及项目验证结束后，仅截取一张最终项目窗口：artifacts/flow-observation/project-final.png。已检查工具行、Shell、正文、输入框没有横向溢出；画面是已展开的历史工作过程，最终答案在下方可滚动区域。截图不是全流程动态覆盖证据。
- 前序真实短提示测试逐帧记录位于 artifacts/flow-observation/acceptance-live。该次从 Thinking 到 Worked 完整结束；随后上游模块接入用本地事件回放和真实历史复核。不能把这段前序录像称为上游接入后的完整实跑。

## 验证边界

开源模块并非官方桌面应用完整源码，也不代表所有状态已经与官方逐像素一致。模型配置不同会改变实际思考、工具次数和耗时。重连、拒绝、子任务等稀有状态主要由协议回放覆盖，未对每一类再次消耗模型做实跑。

本次没有替换项目的 Electron 外壳，没有启动官方客户端。前序错误加入的 native launcher 文件已撤去。本轮修复范围是当前项目的发送、流式展示、活动/计时、审批及通信链路；附件菜单内仍有明确标为“即将推出”的独立功能，不属于本次已验证功能。

## 后续维护

tools/import-flow-upstream.py 可从固定提交重新提取上游模块。更新上游时先审查 commit 和许可，再修改固定版本及回归用例。tools/integrate-flow-upstream.py 是已执行的一次性迁移脚本，检测到接入后会拒绝重复执行。
tools/import-conversation-style.py 负责固定提交的 CSS 提取。运行后再次执行 npm run check、npm run test:flow、npm run test:transport。
