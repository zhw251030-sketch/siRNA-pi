# siRNA-pi

通过亲手逐步重建一个 Pi Agent 应用，理解参考项目中每一层为什么存在、如何连接，以及怎样验证它确实工作。

这是独立的学习仓库。每次只增加一个可以解释、运行和检查的小功能，并用 Git 提交保存学习过程。

## 当前进度

- 2026-10-15：建立仓库说明、学习路线和协作规则。
- 2026-10-15：在指定服务器目录安装 Pi Coding Agent `1.2.0`，使用已有 Node.js `24.16.0`；依赖检查、版本输出和隔离环境下的帮助命令均通过。
- 下一步：选择并配置模型，在单独练习目录中运行原生 Pi，观察一次“读取文件 → 执行任务 → 保存结果”的过程。
- 当前没有可启动的网页服务，没有执行模型调用，也没有开展自进化实验。

安装位置、文件解释和验证记录见 [第 1 步 A：安装与运行 Pi](docs/01-安装与运行Pi.md)。服务器项目目录是 `/home/hanwen/Project/project/siNRA-pi/`，按用户指定拼写保留。

## 第一个目标

逐步完成“通过网页操作 Pi”：

1. 认识原生 Pi 已经提供的模型连接、工具与执行循环。
2. 用一小段程序创建 Pi 会话、提交任务并接收结果。
3. 增加最小后端和网页，走通“网页输入 → 后端 → Pi → 网页输出”。
4. 再逐项加入执行过程展示、多轮会话、历史记录和停止操作。

完成这个目标以后，再学习专业工具接入、工具版本管理、受控改进及人类反馈。详细安排见 [学习路线](docs/学习路线.md)。

## 每一步怎样学习

每一步都回答六个问题：

1. 当前缺少什么能力，为什么需要增加它？
2. 参考仓库在哪些文件中实现了相关职责？
3. Pi 自带什么，我们需要新增什么？
4. 本次新增或修改的每个文件负责什么？
5. 怎样运行，应该看到什么，失败时如何定位？
6. 实际观察到了什么，还没有验证什么？

先解释当前的小步骤，再实现并验证，最后提交代码和学习记录。后续功能按学习进度展开。

## 参考来源与版本

- 原始参考仓库：[ZhxinMath/sirna-pi-agent-service-refactor](https://github.com/ZhxinMath/sirna-pi-agent-service-refactor)。
- 自己账号下的参考副本：[zhw251030-sketch/sirna-pi-agent-service-refactor](https://github.com/zhw251030-sketch/sirna-pi-agent-service-refactor)。
- 已阅读代码基准：`965c53fba4eaa23996f54aa0532c7f6e1064bfd8`；含贡献核查笔记的参考提交：`67d275494c50f1e5c205b96b72a7b1623acfbe1d`。
- 参考项目使用 Pi `0.85.1`；学习版以 [Pi 1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) 为起点，通过 npm 使用时要求 Node.js `>=22.19.0`。
- 新版已提供 [MCP 接入](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/mcp.md)，具体接入代码按新版接口验证。

参考项目用于理解问题、职责和实现思路。初始提交没有复制其应用代码；以后引用或改编具体实现时，记录来源、版本和修改内容，并核对相应许可。

## 分支与同步

- 本仓库由个人独立管理，只使用 `main`；日常学习、实现和阶段记录均提交并推送到 `origin/main`。
- 参考仓库 `sirna-pi-agent-service-refactor` 有独立的协作与分支安排，不沿用到本仓库。
- 每次提交聚焦一个学习步骤；推送前检查改动和验证结果。
- 凭据、真实会话记录、运行产物和依赖目录不进入版本控制。

## 目录

```text
README.md                   项目目标、当前进度和学习方式
AGENTS.md                   与编程助手协作时遵守的规则
.gitignore                  排除凭据、依赖和运行产物
.nvmrc                      项目使用的 Node.js 版本
.npmrc                      npm 安装规则
package.json                Pi 依赖和命令入口
package-lock.json           npm 生成的精确依赖记录
docs/学习路线.md             分阶段目标、参考文件和验收方式
docs/01-安装与运行Pi.md       本轮安装说明与实际结果
docs/superpowers/plans/      安装步骤与执行记录
```

服务器的 `node_modules/` 保存已安装依赖，不进入 Git。我们自己的应用代码目录在后续对应学习步骤开始时建立。
