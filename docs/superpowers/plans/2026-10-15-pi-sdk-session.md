# Pi SDK 最小会话 Implementation Plan

> **For agentic workers:** 使用当前会话执行和独立只读审查；步骤用勾选框记录。用户已批准本方案，并明确只在 main 开发，不创建额外分支或工作树。

**Goal:** 使用已安装的 Pi 1.2.0 SDK 创建会话、订阅事件、提交同一个统计任务并独立验证。

**Architecture:** 新增单文件 SDK 入口，复用公开模型配置和原 CSV。通过显式模型、目录、工具及内存会话设置控制 SDK；SDK 事件与结果使用新路径，保留 CLI 阶段证据。检查脚本支持明确的 CLI/SDK 两种练习。

**Tech Stack:** Node.js 24.16.0、Pi Coding Agent 1.2.0、MiniMax-M3、Node 内置测试工具。

**Spec:** 本次对话中用户批准的“创建会话 → 订阅事件 → 提交任务 → 检查并结束会话”；此前已说明文件入口和验收结果。

## Global Constraints

- 远端唯一工作根目录：`/home/hanwen/Project/project/siNRA-pi`。
- 不修改参考仓库；个人仓库只使用 `main`。
- 凭据只读取服务器 `docs/auth.json`，不打印、复制到本地或提交。
- 复用 MiniMax 国内接口和 read/write；禁用自动资源发现、重试、压缩、遥测和模型目录网络更新。
- 不新增依赖，不实现网页，不将 SDK 示例称为自行开发的 SDK。
- 一次真实成功运行后，以离线验证为主，不为重复检查额外调用模型。

## Task 1: SDK 示例和可重复验收

**Files:** 新建 `scripts/pi-sdk.mjs`、`examples/02-sdk-task/prompt.txt`、`tests/verify-file-task.test.mjs`；修改 `scripts/verify-first-task.mjs`、`package.json`。

**Interfaces:** `npm run pi:sdk -- --check` 仅建立和检查配置；`npm run pi:sdk` 执行固定练习；`npm run verify:sdk-task` 离线检查 `runtime/sdk-task.events.jsonl` 和 `workspaces/sdk-task/result.json`。

- [x] 核对已安装 SDK 的 ModelRuntime、ResourceLoader、SessionManager 和事件接口。
- [x] 先写行为测试：SDK 证据通过；错误平均值、错误路径、缺少结束事件和未知练习参数被拒绝；确认现有检查器无法通过 SDK 证据测试。
- [x] 实现显式目录、凭据和会话配置；创建会话后先订阅事件，再 prompt，finally 取消订阅并 dispose。
- [x] 保存独立 SDK 事件记录；输出文字增量和工具状态；错误退出不能被报告为成功。
- [x] 扩展现有检查器选择固定练习路径，运行行为测试和语法检查。
- [x] 上传公开源码至同一服务器项目；运行不调用模型的 `--check`。
- [x] 在 180 秒外部超时内执行真实 SDK 任务，然后运行两种练习的离线检查，保留原 CLI 记录。

## Task 2: 讲解、审查和同步

**Files:** 新建 `docs/03-SDK创建会话.md`；更新 `README.md`、`AGENTS.md`、`docs/学习路线.md`。

- [x] 记录实际模型/工具次数、输入输出和代码职责，不预先填写成功结果。
- [x] 独立审查代码与目录边界；审查未发现实质问题。
- [x] 检查 Git 差异和凭据忽略规则。

交付流程：提交并推送 main，通过项目内 Git bundle 对齐服务器提交，确认工作区干净且已有结果仍通过验证；最后结合准确代码行号向用户讲解。提交前已完成的验证证据为：7 项离线测试通过，SDK 4 次模型响应、3 次工具调用、5778 个累计 usage token，结果为 count=4、sum=100、mean=25；原 CLI 文件哈希未变化。最终同步状态以交付时的 Git 提交核对为准。
