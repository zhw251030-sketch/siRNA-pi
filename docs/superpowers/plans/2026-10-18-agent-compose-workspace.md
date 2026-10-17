# Agent Compose 命令工作区实施计划

> 按已确认的原仓库正式架构，在 main 上逐步实施；本轮只完成控制服务与命令工作区。沿用 executing-plans 的逐项执行与实际验收，不新建分支。

**目标：** 让项目 rootless Docker 承载 Agent Compose，并由它创建、执行、查询一个真实任务容器。

**设计：** `compose.yml` 启动固定版本的控制服务；`agent-compose.yml` 描述 designer 的 Docker guest。控制服务仅挂项目 Docker socket、独立数据目录和单个任务配置。宿主端口限定 127.0.0.1:7410，内部单一 bridge 网络。使用独立管理 token，不读取 MiniMax key。本阶段空模型回调地址使 Pi 配置准备提前返回；仅执行固定命令，不启动 Pi。

**参考：** 原仓库 `compose.yml:74`、`agent-compose.yml`、`packages/agent-runtime/executor.ts` 的 up → run --detach --keep-running → inspect 路径；Agent Compose v2609.3.0 官方镜像和源码。学习仓库独立编写配置和脚本。官方 guest 的 Pi 0.82.1 不作为个人 Pi 1.2.0 兼容性证据。

**边界：** 不修改系统配置、共享 Docker、原仓库、网页执行器或模型凭据。状态全部位于 `/home/hanwen/Project/project/siNRA-pi/runtime`。不设置无法支持的 CPU 配额，不声称上游默认 guest 有资源限额。管理 token 不传入 guest。

## 执行顺序

- [x] 核查版本摘要、CLI 合同、容器自发现、路径转换、鉴权及命令分支。
- [x] 新增两种 compose 配置、私有状态准备和固定连接脚本。
- [x] 固定摘要镜像经过官方 Registry 校验与归档传输导入；配置验证，启动并确认管理鉴权。
- [x] 通过 Agent Compose 创建命令工作区；核对运行状态、真实文件和 Docker 挂载。
- [x] 停止本次测试环境并验证保留产物，记录边界；未删除用户已有数据。
- [x] 49 项离线测试和真实工作区验收通过；独立审查修正日期分层路径及 released 状态断言，更新中文学习文档。

交付采用既定 main 提交、GitHub 推送和项目内 Git bundle 同步；以三端 Git HEAD 核对结果为准。

## 验收标准

1. 控制服务健康，端口只在 loopback；无 token 的管理请求返回 401。
2. `up` 返回项目；命令 run 最终 succeeded 且 exit_code=0，获得 sandbox_id。
3. `/workspace` 的标记文件真实落入指定项目内的管理数据目录，guest 不挂 Docker socket、整仓或密钥文件。
4. guest 与 controller 同一项目网络；后者确实使用项目 socket。
5. 本次 guest 能正常停止，文件仍可检查；当前网页健康报告仍为 local-pi / taskContainers=false。

实际结果和讲解写入 `docs/07-AgentCompose与任务环境.md`。
