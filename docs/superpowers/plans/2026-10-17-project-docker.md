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
- [x] 准备文件已审查并通过 d6e2034 同步个人仓库 main 和服务器；明确区分准备与实际运行。

## Task 2：经确认安装系统前提

- [x] 用户确认继续执行并提供管理员账号；通过 SSH 密码提示及 sudo 验证。密码不写入项目。
- [x] 管理员身份运行 `apt-get update`，再模拟指定版本的安装；实际清单仍仅新增 uidmap，无升级/删除。
- [x] 不使用 -y，安装 uidmap 1:4.8.1-2ubuntu2.2 成功；本次 APT 没有额外 Y/n 问题。验证两项辅助程序权限后退出管理员会话。
- [x] 用 hanwen 运行 `sh scripts/check-docker-rootless.sh`，前提全部通过。

## Task 3：启动和最小容器验证

- [x] 新增 start-project-docker.sh 和 project-docker.sh，固定项目路径与临时目录；外层目录私有，拒绝重定向和重复启动。
- [x] 以 hanwen 启动官方 dockerd-rootless.sh；完成正常停止与重启验证。根据真实重启结果修正 data-root 0710 权限检查。
- [x] 通过项目 Unix socket 确认 rootless、overlay2 及正确的 DockerRootDir；客户端排除继承的其他连接设置。
- [x] 固定摘要的官方 hello-world 执行成功，退出码 0。无网络、只读根目录，接受 32 MiB 内存与 32 进程上限；不声称已验证资源耗尽或 CPU 配额。
- [x] 更新学习记录，明确 Docker 已就绪、Agent Compose 和 Pi 任务容器尚未接入；本轮实现按 main 同步流程交付。
