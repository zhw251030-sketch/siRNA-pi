# 第 5 步 A：准备项目自己的 Docker

记录日期：2026-10-17。状态：已安装获准的系统前提，项目 rootless Docker 已启动，官方 hello-world 容器运行成功。网页仍使用第 4 步的 `local-pi` 执行器；Agent Compose 尚未接入。

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

## 服务器检查与安装结果

服务器为 `39.96.171.247:1369`，账号 `hanwen`，项目根目录固定为 `/home/hanwen/Project/project/siNRA-pi`。

| 检查项 | 2026-10-17 的结果 | 意味着什么 |
| --- | --- | --- |
| 系统、内核 | Ubuntu 22.04.4、Linux 6.8 | 可继续验证已有 Docker 的 rootless 运行方式。 |
| Docker 客户端 | 28.3.0 | 已有 Docker 软件，不需要重新安装整套 Docker。 |
| rootless 相关程序 | `dockerd-rootless.sh`、RootlessKit 2.3.4、slirp4netns 1.0.1 存在 | 启动脚本和用户态网络程序已具备。 |
| UID/GID 映射辅助程序 | 初查缺少；获准后安装 `uidmap 1:4.8.1-2ubuntu2.2` | 两个程序现为 `root:root`、`-rwsr-xr-x`；安装后预检通过。 |
| `/etc/subuid`、`/etc/subgid` | 均已有 `hanwen:493216:65536` | 已分配所需的从属用户和组编号；目前没有理由修改这些系统文件。 |
| `unshare -Ur id` | 成功 | 普通用户能够创建用户命名空间；里面显示的 root 不是宿主机 root。 |
| 项目所在文件系统 | ext4，约 5.4 TB 可用 | 数据目录不是 Docker rootless 不支持的 NFS。 |
| 系统 Docker socket | `root:docker`，hanwen 无权限 | 不能直接操作这套共享 Docker。 |
| 管理员登录 | 使用用户提供的管理员账号，通过 SSH 密码提示及 sudo 提权 | 仅执行获准的系统安装，完成后失效本次 sudo 缓存并退出；密码没有写入项目文件。 |

`uidmap` 提供两个特殊权限辅助程序，把容器里的用户编号映射到管理员已经分配给 `hanwen` 的编号范围。普通用户启动 Docker 的大部分过程不需要 root，但安装这两个系统程序需要管理员权限。见 [Docker 官方 rootless 前提](https://docs.docker.com/engine/security/rootless/)。

## 本轮文件分别做什么

- `scripts/check-docker-rootless.sh`：只读检查程序、编号范围和用户命名空间。缺少条件就明确失败；不会自动安装软件或启动服务。
- `.gitattributes`：让 shell 脚本保持 Linux 使用的 LF 换行，避免在 Windows 编辑和 Git 同步后出现换行兼容问题。
- `config/docker/daemon.json`：实际使用的 Docker 配置。只监听项目内 Unix socket；镜像、容器数据、执行状态和 PID 文件都指定到 `runtime/docker/`。每个容器使用 local 日志驱动，每个日志文件最多 10 MB、保留 3 个。
- `scripts/start-project-docker.sh`：以 hanwen 检查前提和目录，固定运行状态、配置、缓存及临时目录，最后启动官方 `dockerd-rootless.sh`。该脚本在前台运行；本次由 nohup 放到后台并将输出写入项目日志。
- `scripts/project-docker.sh`：调用系统已有的 Docker 客户端，并显式连接项目 socket。清除继承的其他 Docker 连接设置，不切换全局 context。入口要求先写子命令，例如 `info`、`pull`、`run`。
- `docs/superpowers/plans/2026-10-17-project-docker.md`：安装、验证和继续执行的检查点。

这些配置使用用户指定的服务器绝对路径。更换服务器或工作目录时必须先调整配置，不能直接假定可移植。`runtime/` 已被 Git 忽略，真实容器数据不提交到 GitHub。

## 经用户确认完成的系统安装

最初的只读模拟显示仅新增 uidmap。用户随后提供管理员账号并要求继续执行，授权了此前列明的系统安装。刷新索引后再次模拟，实际安装仍是新增 **1 个包 uidmap**，版本 `1:4.8.1-2ubuntu2.2`，升级 0、删除 0。

助手通过管理员账号的 sudo 执行了以下命令：

```sh
apt-get update
apt-get -s --no-remove --no-upgrade --no-install-recommends install uidmap=1:4.8.1-2ubuntu2.2
apt-get --no-remove --no-upgrade --no-install-recommends install uidmap=1:4.8.1-2ubuntu2.2
```

索引刷新和安装均返回退出码 0。下载软件包约 22.4 kB，新增磁盘占用约 147 kB；软件包正常执行了 man-db 文档索引触发器。命令没有使用 `-y`；本次 APT 对这个单包事务没有提出额外的 Y/n 问题。`--no-upgrade` 不保证依赖包不会升级，因此仍以实际事务清单为准。

获准的项目目录外写入包括系统软件包数据库、APT 索引/缓存、辅助程序及包管理器处理的系统文件。本次没有运行系统升级或自动清理，也没有修改用户组、sudoers、从属 UID/GID 分配或共享 Docker 服务。

## 启动时具体发生了什么

1. `check-docker-rootless.sh` 确认程序和编号范围齐全，实际创建一个临时用户命名空间进行检查；不调用模型。
2. 启动脚本创建 `runtime/docker/` 下的运行目录。外层目录、socket 目录、配置及客户端目录为 hanwen 所有、权限 0700；拒绝符号链接重定向。`HOME` 保持原值。
3. 脚本设置 `XDG_RUNTIME_DIR`、配置/数据/缓存目录、`DOCKER_CONFIG` 和临时目录。额外设置 `DOCKER_TMPDIR`，因为 Docker 自己的这个变量优先于通用 `TMPDIR`。
4. 官方 `dockerd-rootless.sh` 使用 RootlessKit 建立用户、挂载、网络等命名空间，再运行 Docker 守护进程。“守护进程”就是持续等待并处理 Docker 请求的后台程序。
5. `project-docker.sh` 通过项目内 Unix socket 连接守护进程。socket 是本机程序间通信的入口，本次没有为 Docker API 开放公网端口。
6. 客户端请求拉取固定摘要的官方镜像，再请求创建容器。守护进程启动镜像中的程序，客户端收到输出；测试容器退出并自动清理。

第一次启动成功后，重启验收发现 Docker 会把 `data-root` 设为 0710，原先只接受 0700 的检查因此拒绝重启。已修正为只有 `runtime/docker/data` 允许 0700 或 0710；其上层目录继续保持 0700。修正后成功启动，复用了已经下载的镜像，没有清空数据目录。

脚本遇到已有 PID、socket 或 RootlessKit 状态会拒绝启动，而不会自动删除。机器重启后的残留状态需要核查进程和路径再处理。这一轮没有配置开机自启或自动恢复；后台进程能在本次 SSH 会话退出后继续运行。

rootless 本身不能证明 CPU、内存配额有效；需满足相应 cgroup 与 systemd 条件。见 [官方运行与资源限制说明](https://docs.docker.com/engine/security/rootless/tips/)。本机的实际能力见下表，不根据“已经用了 Docker”推断全部资源限制均有效。

## 实际验证结果

| 验证 | 结果 |
| --- | --- |
| Shell 语法与 daemon.json | `sh -n` 通过，Docker 输出 `configuration OK`。 |
| 安装后预检 | 所有已检查程序、从属编号与用户命名空间通过，退出码 0。 |
| Docker 模式 | 服务版本 28.3.0，安全选项包含 `rootless`、默认 seccomp、cgroupns。 |
| 数据与存储 | `DockerRootDir=/home/hanwen/Project/project/siNRA-pi/runtime/docker/data`，存储驱动 `overlay2`。 |
| cgroup | `systemd` 驱动、版本 2。Docker 报告内存及进程数限制可用；CPU 配额、CPU shares/cpuset 和若干 I/O 限制不可用。 |
| 容器执行 | hello-world 输出 `Hello from Docker!`，退出码 0；实际接受 `--memory=32m --pids-limit=32`，未做资源耗尽压力实验。 |
| 测试容器范围 | 无网络、只读根文件系统、不挂载项目或宿主机目录、不开放端口；退出后自动清理。 |
| 镜像保留与重复启动 | 正常停止后重启成功，镜像仍在；运行时重复启动被明确拒绝。 |
| 客户端连接范围 | 注入无效 DOCKER_HOST/DOCKER_CONTEXT/TLS 环境变量后仍连接正确服务；传入全局 host 覆盖参数被拒绝。 |
| 原网页服务 | `/health` 返回 ready=true、busy=false、backend=local-pi、taskContainers=false。 |
| 原有离线测试 | 使用服务器 Node 24.16.0 重跑 `node --test tests/*.test.mjs`，49 项通过、0 失败；临时文件目录仍指定在项目内。 |

容器镜像来自 [Docker 官方 hello-world](https://github.com/docker-library/official-images/blob/master/library/hello-world)，固定的 Linux 镜像索引摘要为：

```text
docker.io/library/hello-world@sha256:5e22040d441e5fb3aed38368acbe8486b575d7018df38dbdfbc7311fbb2ef3a9
```

摘要可以理解为镜像内容的指纹。固定摘要让这次验证能准确说明用的是哪一份内容，避免只写 `latest` 后内容发生变化。服务器的镜像检查与拉取结果均匹配这个摘要。

## 怎样自己查看

在服务器进入指定目录，然后运行只读命令：

```sh
cd /home/hanwen/Project/project/siNRA-pi
sh scripts/check-docker-rootless.sh
sh scripts/project-docker.sh info
sh scripts/project-docker.sh ps -a
sh scripts/project-docker.sh images
```

`ps -a` 查看容器，`images` 查看镜像。现在前者为空、后者有 hello-world 是正常结果：测试容器退出后清理了，但作为模板的镜像仍保留。

此次实际执行的容器命令为：

```sh
sh scripts/project-docker.sh run --rm --pull=never \
  --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges:true --memory=32m --pids-limit=32 \
  docker.io/library/hello-world@sha256:5e22040d441e5fb3aed38368acbe8486b575d7018df38dbdfbc7311fbb2ef3a9
```

`--pull=never` 要求使用已经拉取的镜像，`--rm` 让这个没有持久数据的测试容器退出后自行清理。守护进程日志位于 `runtime/docker-start-20261017.log`；镜像和容器数据在 `runtime/docker/data/`。这些真实运行状态均被 Git 忽略，不应在 Docker 运行时直接搬动或删除。

## 当前边界

已完成 Docker 基础运行验证。没有部署 Agent Compose、没有把 Pi 放入任务容器、没有切换网页执行器，也没有调用模型。hello-world 成功仅证明容器基础可用，不证明任务隔离、工具能力或自进化已经完成。

下一小步是按照原仓库准备 Agent Compose 控制服务与 guest 镜像，先检查控制服务能创建、查询任务环境，再验证 Pi 1.2.0 与该环境的兼容性，最后接回现有网页任务接口。CPU 配额及开机自启如需系统配置变更，另行报告具体影响并取得确认。
