# Pi 运行环境安装计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户指定的服务器目录安装项目级 Pi 1.2.0，验证命令入口，将配置和学习记录同步到个人仓库 main。

**Architecture:** Windows 保存和推送源码；通过已有 SSH 连接把 Git bundle 传到服务器。服务器在项目内安装 npm 依赖，使用已有的 Node.js 24，不替换系统 Node。

**Tech Stack:** Git、OpenSSH、Node.js 24.16.0、npm 11.13.0、@earendil-works/pi-coding-agent 1.2.0。

**Spec:** 用户已批准本轮安装；学习边界见 [学习路线](../../学习路线.md) 的第 1 步。此次只完成安装子阶段。

## Global Constraints

- 个人仓库只使用 main；参考仓库及其 hw 分支保持独立。
- 目标为 hanwen@39.96.171.247:1369 的 /home/hanwen/Project/project/siNRA-pi/；保留用户指定的目录拼写。
- 使用 /home/hanwen/.nvm/versions/node/v24.16.0 的已有运行环境。
- 安装固定版本的项目依赖；不修改系统 Node，不全局安装 Pi。
- 本轮不配置模型、不发送模型请求、不启动网页服务。
- 不读取或复制凭据，不创建新的 GitHub 凭据；使用本地 GitHub 授权推送，再经 SSH 同步服务器。
- 写入前核实目录和 Git 状态；不覆盖已有用户改动。

## Task 1：固定运行依赖

**Files:** 新增 package.json、package-lock.json、.nvmrc、.npmrc。

**Input:** 已有空学习仓库、服务器 Node 24.16.0、官方 Pi 1.2.0 包信息。

**Output:** 可由 npm ci 复现的固定依赖和命令入口。

- [x] package.json 使用 private=true、type=module、engines.node=>=22.19.0、dependencies 中的 @earendil-works/pi-coding-agent=1.2.0。
- [x] 提供 pi、pi:version、pi:help 三个 npm scripts，分别执行 pi、pi --version、pi --help。
- [x] .nvmrc 写入 24.16.0；.npmrc 启用 engine-strict 和 save-exact。
- [x] 在服务器临时目录用 Node 24/npm 11 运行 npm install --package-lock-only --ignore-scripts --no-audit --no-fund，将生成的锁文件取回本地。
- [x] 核对锁文件版本、来源、JSON 和 git diff --check 后提交安装配置到 main。

## Task 2：安装、验证和同步

**Files:** 修改 README.md、AGENTS.md、docs/学习路线.md、本计划；新增 docs/01-安装与运行Pi.md。

**Input:** Task 1 的 main 提交及锁文件。

**Output:** 指定目录中的已安装 Pi、可重现命令和实际验证记录。

- [x] 本地创建 main 的 Git bundle，经 SSH 传输；再次核实目标为空，然后在指定目录克隆 main。
- [x] 将服务器 origin 设为个人 GitHub 仓库地址；明确服务器直接 GitHub 认证本轮未配置。
- [x] 选用 Node 24，运行 npm ci --ignore-scripts --no-audit --no-fund。
- [x] 运行 npm run pi:version、npm run pi:help、npm ls --depth=0；前两个命令使用空凭据环境、独立配置目录和 PI_OFFLINE=1，帮助命令关闭资源发现。确认 Pi 版本为 1.2.0、帮助可显示且命令成功退出。
- [x] 根据实际结果更新中文文档：文件作用、运行位置、命令、参考仓库对应关系、已验证和未验证内容。
- [x] 独立检查改动；验证无凭据或依赖目录入库，然后提交并推送 origin/main。
- [x] 用新的 Git bundle 在服务器快进 main；确认本地、GitHub、服务器提交一致，两个工作区干净，参考仓库未改动。

## 检查说明

本轮没有新增应用行为，不添加只重复配置内容的单元测试。验证重点是锁文件、真实安装、CLI 入口和三处 Git 状态。版本与帮助测试不代表模型连接、工具执行或网页功能已经完成。

## 执行记录

- 2026-10-15：已确认服务器目录为空且可写，已有 Node 24.16.0/npm 11.13.0。按照用户要求直接在 main 完成此学习步骤，不新建分支。
- 源码核查发现 --help 会创建内部运行对象，因此验收时隔离配置、关闭扩展等资源发现并开启离线模式；不把帮助可显示描述成模型任务已运行。
- 首次依赖解析停在 retry 包的请求，单独 curl 返回 HTTP 200；终止已核对工作目录的本次 npm 进程，重试时将单请求超时设为 30 秒、重试次数设为 2。
- 安装配置提交为 611c0b8。服务器 npm ci 安装 118 个包；Node 24.16.0、npm 11.13.0、Pi 1.2.0；依赖列表、版本和隔离帮助检查全部退出码 0。
- 独立审查通过；验证记录提交 8f89eed 已推送 GitHub 并同步服务器，三处提交一致且工作区干净。参考仓库仍为 67d2754、hw 分支，未发生改动。本计划的完成标记随后作为文档提交同步。
