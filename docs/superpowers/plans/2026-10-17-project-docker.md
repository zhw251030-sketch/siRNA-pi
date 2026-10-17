# 项目 Docker 运行前提实施计划

> **For agentic workers:** Follow superpowers:executing-plans task by task. 用户已授权助手完成项目工作及管理员操作，但风险命令必须先确认；授权范围优先于技能默认流程。只使用 main。

**Goal:** 在指定项目目录下验证普通用户 Docker，为随后接入 Agent Compose 建立真实可用的基础。

**Architecture:** 复用服务器现有 rootless Docker 程序，以 hanwen 启动独立守护进程，客户端显式使用项目 socket。系统只申请安装缺失的 uidmap；网页本阶段仍由 local-pi 执行。

**Tech Stack:** Ubuntu 22.04.4、Docker 28.3.0、RootlessKit 2.3.4、POSIX shell。

**Spec:** [第 5 步 A 的设计、配置和边界](../../06-Docker运行环境.md)。

## Global Constraints

- 远端工作根目录：`/home/hanwen/Project/project/siNRA-pi`。
- 用户提供的模型凭据不参与本步骤，不读取、不打印、不复制。
- 不改变 HOME，不操作共享 Docker，不添加用户组，不写入主目录配置。
- 系统安装、系统权限调整、破坏性命令等先报告具体命令和影响，取得用户确认。

## Task 1：可检查的安装准备

Files: `scripts/check-docker-rootless.sh`、`config/docker/daemon.json`、`docs/06-Docker运行环境.md`、本计划、README.md、AGENTS.md。

- [x] 读取参考项目和官方说明，核对现有程序、系统版本、文件系统、用户命名空间和软件包模拟结果。
- [x] 准备只读检查脚本和指定绝对路径的 daemon.json；记录系统安装命令及其目录外影响。
- [x] 在服务器用 `sh -n` 检查脚本、用 `dockerd --validate --config-file` 检查配置，并实际运行只读预检。配置检查通过；预检如实报告缺少 newuidmap/newgidmap，以退出码 1 停止，没有启动服务。
- [ ] 审查改动并同步个人仓库 main；文档明确记录仍待完成的事项。

## Task 2：经确认安装系统前提

- [ ] 用户确认 docs/06 中列出的 apt 命令和系统写入范围；确认可用的管理员身份验证方式。没有确认不执行安装。
- [ ] 管理员身份运行 `apt-get update`，再模拟指定版本的安装；只接受 uidmap 一个新增包，范围变化则停止再确认。
- [ ] 保留实际 apt 交互确认，核对事务列表后安装。记录包版本与验证结果，不记录密码。
- [ ] 用 hanwen 运行 `sh scripts/check-docker-rootless.sh`，确认前提通过。

## Task 3：启动和最小容器验证

- [ ] 确认项目内状态路径无重定向、目录私有；检查旧 PID/socket 后准备启动入口，将临时文件、日志及 Docker 状态限制在项目目录。
- [ ] 以 hanwen 直接启动官方 dockerd-rootless.sh；不使用全局服务安装器，不增加公网监听端口。
- [ ] 通过项目 Unix socket 检查 rootless 安全选项与 DockerRootDir；失败则记录实际错误，不更改系统安全配置绕过。
- [ ] 使用来源已核对的小型官方镜像运行容器，记录实际 digest、输出、退出码及资源限制的可用程度。
- [ ] 更新学习记录并提交 main。只有本项通过后再推进 Agent Compose，不能将 Docker 配置验收写成正式任务架构已经完成。
