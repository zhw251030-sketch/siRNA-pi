# 第 5 步 A：准备项目自己的 Docker

记录日期：2026-10-17。状态：已完成只读预检，准备好配置；系统依赖安装、Docker 启动与容器运行尚未完成。网页仍使用第 4 步的 `local-pi` 执行器。

## 为什么先做这一步

现在网页已经能够把消息交给 Pi，但 Pi 仍直接运行在服务器的 Node 进程中。原仓库的正式路径是：网页后端把任务交给 Agent Compose，Agent Compose 再使用 Docker 创建和管理任务容器，Pi 在任务容器里工作。

Docker 可以理解为负责准备和运行独立工作环境的基础设施。Agent Compose 是在这个基础设施上管理 Agent 任务的程序。它与用于启动一组服务的 Docker Compose 不是同一个软件。

这一小步只把 Docker 的前提准备好。完成它以后才能证明“服务器能够启动容器”；还需要后续接入和验证，才能说“网页任务已经进入容器”。

## 原仓库怎样处理

参考版本：`sirna-pi-agent-service-refactor` 的 `67d275494c50f1e5c205b96b72a7b1623acfbe1d`。以下路径相对参考仓库：

| 文件 | 负责什么 |
| --- | --- |
| `compose.yml` 的 `agent-compose` 服务 | 启动 Agent Compose 控制服务，把 Docker socket 挂给它，使它能管理任务容器。 |
| `agent-compose.yml` | 声明 Agent 的提供方、模型、容器镜像及工作目录挂载。 |
| `containers/agent-compose-guest/Dockerfile` | 制作任务容器镜像，在上游 guest 环境中加入 Pi 和专业工具依赖。 |
| `packages/agent-runtime/agent-compose-runtime.ts` | 将网页任务运行接口转接到 Agent Compose。 |
| `packages/agent-runtime/executor.ts` | 调用 Agent Compose，准备任务工作目录并执行任务。 |

我们的目标仍然是这套职责分层。当前服务器是多人使用的环境，`hanwen` 不能访问系统 Docker，因此先为本项目准备由普通用户运行的 rootless Docker。这里调整的是服务器部署方式，不是放弃 Agent Compose 架构。

## 服务器实际检查结果

服务器为 `39.96.171.247:1369`，账号 `hanwen`，项目根目录固定为 `/home/hanwen/Project/project/siNRA-pi`。

| 检查项 | 2026-10-17 的结果 | 意味着什么 |
| --- | --- | --- |
| 系统、内核 | Ubuntu 22.04.4、Linux 6.8 | 可继续验证已有 Docker 的 rootless 运行方式。 |
| Docker 客户端 | 28.3.0 | 已有 Docker 软件，不需要重新安装整套 Docker。 |
| rootless 相关程序 | `dockerd-rootless.sh`、RootlessKit 2.3.4、slirp4netns 1.0.1 存在 | 启动脚本和用户态网络程序已具备。 |
| UID/GID 映射辅助程序 | 缺少 `newuidmap`、`newgidmap` | 需要管理员安装提供它们的 `uidmap` 包。 |
| `/etc/subuid`、`/etc/subgid` | 均已有 `hanwen:493216:65536` | 已分配所需的从属用户和组编号；目前没有理由修改这些系统文件。 |
| `unshare -Ur id` | 成功 | 普通用户能够创建用户命名空间；里面显示的 root 不是宿主机 root。 |
| 项目所在文件系统 | ext4，约 5.4 TB 可用 | 数据目录不是 Docker rootless 不支持的 NFS。 |
| 系统 Docker socket | `root:docker`，hanwen 无权限 | 不能直接操作这套共享 Docker。 |
| 管理员登录 | `sudo -n -l` 要求密码；现有 SSH key 不能登录 root | 管理员身份验证尚未完成，不能视为已经得到 root。 |

`uidmap` 提供两个特殊权限辅助程序，把容器里的用户编号映射到管理员已经分配给 `hanwen` 的编号范围。普通用户启动 Docker 的大部分过程不需要 root，但安装这两个系统程序需要管理员权限。见 [Docker 官方 rootless 前提](https://docs.docker.com/engine/security/rootless/)。

## 本轮文件分别做什么

- `scripts/check-docker-rootless.sh`：只读检查程序、编号范围和用户命名空间。缺少条件就明确失败；不会自动安装软件或启动服务。
- `.gitattributes`：让 shell 脚本保持 Linux 使用的 LF 换行，避免在 Windows 编辑和 Git 同步后出现换行兼容问题。
- `config/docker/daemon.json`：拟使用的 Docker 配置。只监听项目内 Unix socket；镜像、容器数据、执行状态和 PID 文件都指定到 `runtime/docker/`。每个容器使用 local 日志驱动，并限制单个日志文件大小和保留数量。
- `docs/superpowers/plans/2026-10-17-project-docker.md`：安装、验证和继续执行的检查点。

这些配置使用用户指定的服务器绝对路径。更换服务器或工作目录时必须先调整配置，不能直接假定可移植。`runtime/` 已被 Git 忽略，真实容器数据不提交到 GitHub。

## 需要确认的系统安装

只读模拟 `apt-get -s install --no-install-recommends uidmap` 的结果：新增 **1 个包 uidmap**，版本 `1:4.8.1-2ubuntu2.2`，升级 0、删除 0。这个结果来自刷新软件源之前的索引，不能保证刷新后仍完全相同。

拟由助手使用管理员身份执行的命令：

```sh
apt-get update
apt-get -s --no-remove --no-upgrade --no-install-recommends install uidmap=1:4.8.1-2ubuntu2.2
apt-get --no-remove --no-upgrade --no-install-recommends install uidmap=1:4.8.1-2ubuntu2.2
```

先刷新索引，再重新模拟。实际安装保留交互确认，检查其事务列表后才接受。如果发现额外安装、升级、删除、版本变化或安装脚本要求改变其他服务，停止并向用户说明。`--no-upgrade` 不保证依赖包不会升级，因此不能只依靠命令参数判断范围。

这一步会修改系统软件包数据库、APT 索引/缓存，并由软件包安装程序写入系统目录。这是唯一已提出的项目目录外写入申请；用户确认之前不执行。不顺带运行系统升级、自动清理、修改 Docker 用户组或调整共享 Docker 服务。

## 安装后如何继续

1. 再运行只读检查，核对 `uidmap` 版本和辅助程序的系统权限。
2. 以 `hanwen` 创建项目私有的运行目录，目录权限为 0700；配置 `XDG_RUNTIME_DIR`、`XDG_CONFIG_HOME`、`DOCKER_CONFIG` 和临时文件目录。保持原来的 `HOME`。
3. 使用系统已有的 `dockerd-rootless.sh --config-file <项目>/config/docker/daemon.json` 启动进程，输出日志放入项目目录。这里尚未准备或执行启动命令，不使用会写入主目录并切换 Docker context 的自动安装脚本。
4. 客户端显式连接项目 socket，检查 `docker info` 的安全选项确有 `rootless`，且 `DockerRootDir` 正好是项目的 `runtime/docker/data`。
5. 拉取一个小型官方镜像并实际运行容器，检查输出与退出码。成功后再做 Agent Compose 的控制服务与 guest 兼容性验证。

实际启动前还要处理 `XDG_RUNTIME_DIR` 的临时性：机器重启后可能留下旧 PID/socket，必须核查进程和路径再处理，不能盲目删除整个运行目录。普通启动和后台运行也不等于已经配置开机自启。

rootless 本身不能证明 CPU、内存配额有效；Docker 官方要求满足 cgroup v2 与 systemd 等条件。需通过实际 `docker info` 和容器检查确定本机能力。见 [官方运行与资源限制说明](https://docs.docker.com/engine/security/rootless/tips/)。

## 当前边界

实际验证：服务器 `sh -n` 语法检查通过；Docker 28.3.0 对拟用配置执行 `dockerd --validate --config-file ...` 返回 `configuration OK`。只读预检按预期以退出码 1 停止，列出缺少 `newuidmap`、`newgidmap`，其余已检查程序、从属编号和用户命名空间通过；没有尝试安装或启动 Docker。`stat -f` 把 ext4 所属的文件系统家族显示为 `ext2/ext3`，挂载信息已另行核对为 ext4。

未安装 `uidmap`，未启动本项目 Docker，未拉取容器镜像，未部署 Agent Compose，未切换网页执行器，未调用模型。配置通过检查也不等于容器已能运行。安装、启动和后续结果各自补充真实证据。
